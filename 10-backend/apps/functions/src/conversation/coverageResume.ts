/**
 * COVERAGE-1D — Consumidor idempotente del outbox de reanudación.
 * ================================================================
 * Procesa `tenants/{t}/coverageResumeJobs/{coverageRequestId}` tras la decisión humana (1C):
 *  - approved: libera el takeover SOLO si sigue siendo coverage_review de ESTE request, reserva
 *    checkoutAttemptId+orderId UNA vez, crea la orden con el flujo seguro existente
 *    (createPendingOrder: precios congelados, dirección TEXTUAL, cero coordenadas, jamás PAID,
 *    sin tocar stock), persiste AWAITING_PAYMENT+pendingOrderId ANTES de mandar y envía las
 *    instrucciones por el MISMO receivedVia vía el outbox de mensajería.
 *  - rejected: sin orden/banco/carrito; libera con el mismo candado; mensaje honesto SIN la nota
 *    interna; limpia el puntero activo para permitir un request nuevo.
 *
 * Idempotencia/carreras: claim transaccional con lease+attempts (tope duro — sin retries
 * infinitos); takeover ajeno ⇒ `held_by_seller` (la liberación manual re-encola); mensajería con
 * outbox propio (`prepared→sending→sent|failed|unknown`): un ACK perdido queda `unknown` y JAMÁS
 * se reenvía solo. Ante cualquier duda se degrada a estado recuperable: nunca segunda orden,
 * nunca pago automático.
 *
 * ======================= REGLAS NORMATIVAS PARA SHIPPING-CHAT-3C (diseño 3A-HARDEN) =======================
 *  1. Un job/pipeline anterior en `send_unknown`/`send_failed`/`held_by_seller` o cualquier estado
 *     NO terminal JAMÁS se cancela automáticamente para iniciar otro checkout: debe quedar terminal
 *     (`done`/`cancelled`) o ser RECONCILIADO EXPLÍCITAMENTE (acción humana auditada) antes de crear
 *     un coverageRequest nuevo. La transacción del request nuevo lo VERIFICA y, si no se cumple,
 *     BLOQUEA/RECHAZA la creación — nunca cancela por conveniencia.
 *  2. La saga de cotización creará su outbox en 'prepared' (TX-A), NUNCA en 'sending'; el claim
 *     prepared→sending ocurre inmediatamente antes de Meta. Un crash post-TX-A queda 'prepared'
 *     recuperable — jamás se clasifica unknown sin haber claimeado.
 *  3. TX-C (aprobación) conserva el pointer ante fallos TRANSITORIOS (la re-invocación recupera
 *     sin reenviar); solo un mismatch DETERMINÍSTICO post-send commitea `sent_not_applied`.
 *  4. El OUTBOX es la única fuente de verdad del estado del envío; el pointer del request no
 *     duplica estado/lease/attempts.
 * ==========================================================================================================
 */
import { Timestamp } from 'firebase-admin/firestore';
import type {
  Address,
  CoverageCartItem,
  CoverageOutboxMessage,
  CoverageRequest,
  CoverageResumeJob,
  CoverageResumeStatus,
  OrderCartInput,
  Session,
} from '@vpw/shared';
import { newId, ID_PREFIX, newOrderId, coverageActivationOf, shippingQuotePolicyOf, maskPhone } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../audit/audit.js';
import { coverageSettings } from './coverage.js';
import { coverageHold } from './coverageTestHooks.js';
import { getCheckoutConfig, formatTransferInstructions } from '../orders/checkoutConfig.js';
import { createPendingOrder } from '../orders/createPendingOrder.js';
import { getWhatsAppClient } from '../messaging/whatsappClient.js';
import { appendMessage } from './messages.js';

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;

export const MENSAJE_COBERTURA_APROBADA_INTRO = '¡Buenas noticias! Confirmamos la cobertura para tu zona ✅';

export const MENSAJE_COBERTURA_RECHAZADA_DEFAULT =
  'Por ahora no podemos confirmar cobertura para esa ubicación. Si querés, podés enviarnos otra dirección.';

export const MENSAJE_CARRITO_VACIO_APROBADO =
  'Confirmamos la cobertura para tu zona ✅ Tu carrito quedó vacío: escribí *catálogo* para elegir tus productos y después *pagar*.';

export const MENSAJE_COBERTURA_VENCIDA =
  'Tu solicitud de cobertura venció ⏳ Escribí *pagar* para retomar tu compra.';

const jobRef = (t: string, id: string) => db().doc(`tenants/${t}/coverageResumeJobs/${id}`);
const reqRef = (t: string, id: string) => db().doc(`tenants/${t}/coverageRequests/${id}`);
const outboxRef = (t: string, id: string) => db().doc(`tenants/${t}/coverageMessageOutbox/${id}`);

/** Fixture SOLO-emulador: pausa el consumidor (verify-coverage-review necesita decisiones puras). */
async function resumePausado(tenantId: string): Promise<boolean> {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return false;
  try {
    const fx = await db().doc(`tenants/${tenantId}/_debug/coverageFixtures`).get();
    return fx.data()?.pauseResume === true;
  } catch {
    return false;
  }
}

/**
 * Dirección TEXTUAL para la orden: jamás coordenadas, y tampoco el `name` del lugar (review:
 * la purga de 30 días no alcanza a la orden — solo se copia lo operativamente necesario).
 */
export function direccionTextualDe(req: Pick<CoverageRequest, 'location'>): Address {
  return {
    street: (req.location?.addressText ?? '').slice(0, 512),
    houseNumber: '',
    city: '',
    neighborhood: '',
    reference: '',
    coordinates: null,
  };
}

interface ClaimOk {
  kind: 'claimed';
  job: CoverageResumeJob;
  req: CoverageRequest;
}
type ClaimResult =
  | ClaimOk
  | { kind: 'skip'; motivo: string }
  | { kind: 'stale'; job: CoverageResumeJob; sellerUid: string | null };

/**
 * Claim transaccional del job: dos triggers concurrentes → UN solo procesador efectivo.
 * Valida job↔request (tenant, decisión, fingerprint decidido, estado terminal correcto).
 * Inconsistencias ⇒ `cancelled` (no-op seguro y auditable), jamás procesamiento a ciegas.
 * HARDEN-1 (review): el flag/activación se leen EN ESTA transacción (sin TOCTOU flag→claim,
 * mismo estándar que las callables). Un job de una activación ANTERIOR se marca `cancelled`
 * — inerte permanente, sin orden/mensaje/liberación — y EN LA MISMA transacción se limpia la
 * marca anti-doble-checkout y se espeja `resume: cancelled` (review: la limpieza best-effort
 * fuera de la tx podía perderse y dejar el checkout congelado para siempre).
 */
async function claimJob(tenantId: string, jobId: string): Promise<ClaimResult> {
  const now = Timestamp.now();
  return db().runTransaction(async (tx) => {
    const cfgSnap = await tx.get(db().doc(`tenants/${tenantId}/config/checkout`));
    const act = coverageActivationOf((cfgSnap.data() as { coverage?: unknown } | undefined)?.coverage);
    if (!act.enabled) return { kind: 'skip' as const, motivo: 'feature off (leído en el claim)' };
    const jSnap = await tx.get(jobRef(tenantId, jobId));
    const job = jSnap.exists ? (jSnap.data() as CoverageResumeJob) : null;
    if (!job) return { kind: 'skip' as const, motivo: 'job inexistente' };
    if (job.tenantId !== tenantId) return { kind: 'skip' as const, motivo: 'tenant mismatch' };
    const lease = job.leaseUntil?.toMillis?.() ?? 0;
    const reclamable = job.status === 'pending' || (job.status === 'processing' && lease <= now.toMillis());
    if (!reclamable) return { kind: 'skip' as const, motivo: `status ${job.status}` };
    if ((job.activationId ?? null) !== act.activationId) {
      // Admin SDK: TODAS las lecturas antes de cualquier escritura.
      const sesRef = db().doc(paths.session(tenantId, job.customerId));
      const ses = (await tx.get(sesRef)).data() as Session | undefined;
      const rSnap = await tx.get(reqRef(tenantId, job.coverageRequestId));
      tx.update(jSnap.ref, { status: 'cancelled', leaseUntil: null, updatedAt: now });
      if (ses?.context?.coverageResumeInProgress === job.coverageRequestId) {
        tx.update(sesRef, { 'context.coverageResumeInProgress': null, updatedAt: now });
      }
      if (rSnap.exists) {
        tx.update(rSnap.ref, { resume: { status: 'cancelled', orderId: job.orderId ?? null }, updatedAt: now });
      }
      const reqStale = rSnap.exists ? (rSnap.data() as CoverageRequest) : null;
      return { kind: 'stale' as const, job, sellerUid: reqStale?.sellerUid ?? null };
    }
    if ((job.attempts ?? 0) >= MAX_ATTEMPTS) {
      tx.update(jSnap.ref, { status: 'send_failed', leaseUntil: null, updatedAt: now });
      // Review: si la marca anti-doble-checkout quedó puesta, se limpia — sin esto el gate
      // respondería "estamos preparando tu pedido" PARA SIEMPRE (checkout muerto).
      tx.set(db().doc(paths.session(tenantId, job.customerId)), { context: { coverageResumeInProgress: null }, updatedAt: now }, { merge: true });
      return { kind: 'skip' as const, motivo: 'tope de intentos' };
    }
    const rSnap = await tx.get(reqRef(tenantId, job.coverageRequestId));
    const req = rSnap.exists ? (rSnap.data() as CoverageRequest) : null;
    const esperado = job.action === 'approved' ? 'coverage_approved' : 'coverage_rejected';
    if (
      !req ||
      req.tenantId !== tenantId ||
      req.customerId !== job.customerId ||
      req.status !== esperado ||
      req.decision?.action !== job.action ||
      (req.decision?.locationFingerprint ?? null) !== (req.locationFingerprint ?? null)
    ) {
      tx.update(jSnap.ref, { status: 'cancelled', leaseUntil: null, updatedAt: now });
      return { kind: 'skip' as const, motivo: 'job/request inconsistentes' };
    }
    tx.update(jSnap.ref, {
      status: 'processing',
      leaseUntil: Timestamp.fromMillis(now.toMillis() + LEASE_MS),
      attempts: (job.attempts ?? 0) + 1,
      updatedAt: now,
    });
    return { kind: 'claimed' as const, job: { ...job, attempts: (job.attempts ?? 0) + 1 }, req };
  });
}

const setJob = (tenantId: string, jobId: string, campos: Partial<CoverageResumeJob> & { status: CoverageResumeStatus }) =>
  jobRef(tenantId, jobId).update({ ...campos, leaseUntil: null, updatedAt: Timestamp.now() });

/**
 * HARDEN-1 (review) — Señal al equipo cuando un job quedó cancelado por cambio de activación:
 * auditoría + campana idempotente (id determinístico por request: un solo aviso por job).
 * Best-effort: el aviso jamás rompe la cancelación (que ya quedó persistida en el claim).
 * Sin PII: cliente enmascarado, sin dirección/coordenadas.
 */
async function notificarResumeCancelado(tenantId: string, job: CoverageResumeJob, sellerUid: string | null): Promise<void> {
  const cliente = maskPhone(job.customerId);
  await recordAudit({
    tenantId,
    action: 'coverage.resume_cancelled',
    actorUid: 'system',
    actorRole: 'SYSTEM',
    targetType: 'coverageRequest',
    targetId: job.coverageRequestId,
    summary: `Reanudación de cobertura cancelada por cambio de activación para el cliente ${cliente} (atención manual)`,
  }).catch(() => {});
  const id = `covstale-${job.customerId}-${job.coverageRequestId}`;
  try {
    await db().doc(`${paths.notifications(tenantId)}/${id}`).create({
      id,
      tenantId,
      category: 'handoff',
      type: 'handoff_coverage_stale',
      title: '📍 Una decisión de cobertura necesita atención manual',
      body: `La decisión de cobertura del cliente ${cliente} no pudo reanudarse (el flujo cambió de activación). Revisá la conversación desde Conversaciones y atendé el pedido a mano.`,
      dedupeKey: id,
      customerId: job.customerId,
      ...(sellerUid ? { targetUid: sellerUid } : {}),
      read: false,
      readAt: null,
      createdAt: Timestamp.now(),
    });
  } catch (e) {
    const code = (e as { code?: number | string }).code;
    if (code !== 6 && code !== 'already-exists') {
      logger.warn('Cobertura: no se pudo avisar la cancelación por activación', { tenantId, requestId: job.coverageRequestId });
    }
  }
}

const setResume = (tenantId: string, requestId: string, status: CoverageResumeStatus, orderId: string | null) =>
  reqRef(tenantId, requestId).update({ resume: { status, orderId }, updatedAt: Timestamp.now() });

/**
 * Liberación GUARDADA dentro de una transacción de sesión: solo si el takeover vigente sigue
 * siendo coverage_review de ESTE request. Devuelve el estado del takeover encontrado.
 * KILL-SWITCH-1: el flag/activación se leen EN ESTA transacción — un apagado que commiteó antes
 * gana: 'apagado' sin NINGUNA escritura (ni liberación ni marcas).
 */
async function liberarSesionGuardado(
  tenantId: string,
  customerId: string,
  requestId: string,
  jobActivationId: string | null,
  marcas: { resumeInProgress?: boolean; limpiarPuntero?: boolean },
): Promise<'liberado' | 'sin_takeover' | 'ajeno' | 'apagado'> {
  const sesRef = db().doc(paths.session(tenantId, customerId));
  const now = Timestamp.now();
  const out = await db().runTransaction(async (tx) => {
    const act = coverageActivationOf(((await tx.get(db().doc(`tenants/${tenantId}/config/checkout`))).data() as { coverage?: unknown } | undefined)?.coverage);
    if (!act.enabled || act.activationId !== jobActivationId) return 'apagado' as const;
    const ses = (await tx.get(sesRef)).data() as Session | undefined;
    const ctx = ses?.context;
    const marca: Record<string, unknown> = {};
    if (marcas.resumeInProgress) marca['context.coverageResumeInProgress'] = requestId;
    if (marcas.limpiarPuntero) marca['context.coverage'] = null;
    if (ctx?.humanTakeover !== true) {
      if (Object.keys(marca).length) tx.update(sesRef, { ...marca, updatedAt: now });
      return 'sin_takeover' as const;
    }
    if (ctx.handoffReason !== 'coverage_review' || ctx.handoffSourceId !== requestId) {
      return 'ajeno' as const; // jamás pisar un takeover de otra razón/otro request
    }
    tx.update(sesRef, {
      'context.humanTakeover': false,
      'context.handoffReason': null,
      'context.handoffSellerName': null,
      'context.handoffAt': null,
      'context.handoffSourceId': null,
      'context.pendingCartConfirmation': null,
      ...marca,
      updatedAt: now,
    });
    return 'liberado' as const;
  });
  if (out === 'liberado') {
    await db()
      .doc(paths.customer(tenantId, customerId))
      .set({ conversation: { humanTakeover: false }, assignedSellerId: null, assignedSellerName: null, updatedAt: Timestamp.now() }, { merge: true })
      .catch(() => {});
  }
  return out;
}

/**
 * KILL-SWITCH-1 — El flujo se apagó (o cambió de activación) a MITAD del procesamiento: el job
 * vuelve a `pending` (estado de espera seguro: con el flag off nadie lo procesa; al re-encender
 * la MISMA activación el mantenimiento lo re-drivea; una activación NUEVA lo cancela) y se
 * limpia la marca anti-doble-checkout SOLO si es de este request — todo en UNA transacción.
 * Auditable por log; jamás datos bancarios ni mensajes.
 */
async function pausarJobPorApagado(tenantId: string, jobId: string, requestId: string, customerId: string, punto: string): Promise<void> {
  try {
    const pausado = await db().runTransaction(async (tx) => {
      // Review: se RE-LEE el job en la tx — solo se pausa si sigue 'processing' (nuestro claim en
      // vuelo). Un lease vencido pudo dejar que otro worker lo llevara a un estado TERMINAL
      // (cancelled/done) o held_by_seller: jamás se resucita a 'pending'.
      const job = (await tx.get(jobRef(tenantId, jobId))).data() as CoverageResumeJob | undefined;
      const sesRef = db().doc(paths.session(tenantId, customerId));
      const ses = (await tx.get(sesRef)).data() as Session | undefined;
      if (job?.status !== 'processing') return false;
      tx.update(jobRef(tenantId, jobId), { status: 'pending', leaseUntil: null, updatedAt: Timestamp.now() });
      if (ses?.context?.coverageResumeInProgress === requestId) {
        tx.update(sesRef, { 'context.coverageResumeInProgress': null, updatedAt: Timestamp.now() });
      }
      return true;
    });
    if (pausado) logger.info('Cobertura: kill-switch a mitad de la reanudación — job en espera segura', { tenantId, jobId, punto });
    else logger.info('Cobertura: kill-switch a mitad de la reanudación — el job ya no era nuestro (sin cambios)', { tenantId, jobId, punto });
  } catch (e) {
    logger.warn('Cobertura: no se pudo pausar el job tras el apagado', { tenantId, jobId, punto });
  }
}

/**
 * Outbox de mensajería (ETAPA D): prepara ANTES de llamar a Meta; claim transaccional; `sent`
 * guarda el providerMessageId; `unknown` jamás se reenvía automáticamente.
 */
export async function enviarPorOutbox(input: {
  tenantId: string;
  coverageRequestId: string;
  action: CoverageOutboxMessage['action'];
  checkoutAttemptId: string | null;
  customerId: string;
  channel: CoverageOutboxMessage['channel'];
  receivedVia: string | null;
  /**
   * KILL-SWITCH-1: activación bajo la que se genera el mensaje — se RE-VALIDA dentro del claim
   * del outbox y de nuevo inmediatamente antes de llamar a Meta (además de la trazabilidad).
   */
  activationId: string | null;
  text: string;
}): Promise<'sent' | 'already_sent' | 'failed' | 'unknown' | 'apagado'> {
  const { tenantId } = input;
  const id = `${input.coverageRequestId}_${input.action}${input.checkoutAttemptId ? `_${input.checkoutAttemptId}` : ''}`;
  const ref = outboxRef(tenantId, id);
  const now = Timestamp.now();

  await coverageHold(tenantId, 'outbox_pre_claim'); // solo-emulador: test del kill-switch

  // 1) Preparar/claimear en UNA transacción (create-si-falta + estado → sending).
  //    KILL-SWITCH-1: flag/activación leídos EN la transacción del claim — un apagado que
  //    commiteó antes gana y el mensaje ni se prepara ni se claimea.
  const claim = await db().runTransaction(async (tx) => {
    const act = coverageActivationOf(((await tx.get(db().doc(`tenants/${tenantId}/config/checkout`))).data() as { coverage?: unknown } | undefined)?.coverage);
    if (!act.enabled || act.activationId !== input.activationId) return 'apagado' as const;
    const snap = await tx.get(ref);
    const msg = snap.exists ? (snap.data() as CoverageOutboxMessage) : null;
    if (msg) {
      if (msg.status === 'sent') return 'already_sent' as const;
      if (msg.status === 'unknown') return 'unknown' as const; // ACK perdido: NUNCA reenvío automático
      const lease = msg.leaseUntil?.toMillis?.() ?? 0;
      if (msg.status === 'sending') {
        if (lease > now.toMillis()) return 'busy' as const;
        // Review (at-most-once): un `sending` con lease vencido = crash entre el envío y la
        // persistencia — el mensaje PUDO haber salido. Se degrada a `unknown`, jamás re-claim.
        tx.update(ref, { status: 'unknown', leaseUntil: null, updatedAt: now });
        return 'unknown' as const;
      }
      if (msg.attempts >= MAX_ATTEMPTS) return 'failed' as const;
      tx.update(ref, { status: 'sending', leaseUntil: Timestamp.fromMillis(now.toMillis() + LEASE_MS), attempts: msg.attempts + 1, updatedAt: now });
      return 'go' as const;
    }
    const nuevo: CoverageOutboxMessage = {
      id,
      tenantId,
      coverageRequestId: input.coverageRequestId,
      action: input.action,
      checkoutAttemptId: input.checkoutAttemptId,
      customerId: input.customerId,
      channel: input.channel,
      receivedVia: input.receivedVia,
      activationId: input.activationId,
      text: input.text,
      status: 'sending',
      providerMessageId: null,
      attempts: 1,
      leaseUntil: Timestamp.fromMillis(now.toMillis() + LEASE_MS),
      createdAt: now,
      updatedAt: now,
    };
    tx.create(ref, nuevo);
    return 'go' as const;
  });
  if (claim === 'apagado') return 'apagado';
  if (claim === 'already_sent') return 'already_sent';
  if (claim === 'unknown') return 'unknown';
  if (claim === 'failed') return 'failed';
  if (claim === 'busy') return 'unknown'; // otro worker enviando: no dupliquen — se resuelve por lease

  await coverageHold(tenantId, 'outbox_pre_meta'); // solo-emulador: test del kill-switch

  // 2) Envío real (mock/live según config del tenant, por el MISMO receivedVia).
  try {
    // El cliente (resolución de credenciales: lecturas de Firestore/Secret Manager) se construye
    // ANTES del re-chequeo para que la validación del flag sea la ÚLTIMA operación antes de
    // client.sendText — sin E/S en el medio que ensanche la ventana (review).
    const client = await getWhatsAppClient(tenantId, undefined, input.receivedVia);

    // KILL-SWITCH-1: re-chequeo INMEDIATO antes de llamar a Meta. Nada salió todavía: si el flag
    // se apagó tras el claim, el mensaje vuelve a `prepared` (reclamable si se reactiva la misma
    // activación) y NO se llama a Meta. La ÚNICA ventana externa residual del sistema es un
    // request que ya entró a client.sendText (HTTP en vuelo hacia Meta) cuando el flag commitea.
    const actPreMeta = coverageActivationOf(((await db().doc(`tenants/${tenantId}/config/checkout`).get()).data() as { coverage?: unknown } | undefined)?.coverage);
    if (!actPreMeta.enabled || actPreMeta.activationId !== input.activationId) {
      await ref.update({ status: 'prepared', leaseUntil: null, updatedAt: Timestamp.now() }).catch(() => {});
      logger.info('Cobertura: envío frenado por kill-switch antes de llamar a Meta', { tenantId, outboxId: id });
      return 'apagado';
    }

    const r = await client.sendText(input.customerId, input.text, { tenantId, channel: input.channel });
    if (r.ok) {
      await ref.update({ status: 'sent', providerMessageId: r.id ?? null, leaseUntil: null, updatedAt: Timestamp.now() });
      // El historial es best-effort: un fallo acá JAMÁS degrada un envío exitoso ya persistido
      // (review: la contabilidad exactly-once del outbox no se corrompe por el espejo del chat).
      try {
        await appendMessage(tenantId, input.customerId, {
          direction: 'out',
          author: 'bot',
          text: input.text,
          humanTakeover: false,
          channel: input.channel,
          receivedVia: input.receivedVia,
          ...(r.id ? { waMessageId: r.id } : {}),
          ...(r.viaMock ? { viaMock: true } : {}),
        });
      } catch (e) {
        logger.warn('Cobertura: envío OK pero el historial no se pudo espejar', { tenantId, outboxId: id });
      }
      return 'sent';
    }
    // Falla devuelta por el cliente (SHIPPING-CHAT-3B: SendResult DISCRIMINADO, sin regex).
    // Con instrucciones bancarias en juego, SOLO 'rejected' (rechazo CONFIRMADO de Meta,
    // HTTP 4xx tipado) reintenta como `failed`; cualquier ambigüedad ('unknown': 5xx,
    // timeout, reset, 2xx sin wamid) queda `unknown` y JAMÁS se reenvía sola.
    const confirmada = r.outcome === 'rejected';
    await ref.update({ status: confirmada ? 'failed' : 'unknown', leaseUntil: null, updatedAt: Timestamp.now() });
    return confirmada ? 'failed' : 'unknown';
  } catch (e) {
    // Excepción no clasificable DESPUÉS de iniciar el envío: resultado desconocido — no reenviar.
    logger.error('Cobertura: resultado de envío desconocido', e, { tenantId, outboxId: id });
    await ref.update({ status: 'unknown', leaseUntil: null, updatedAt: Timestamp.now() }).catch(() => {});
    return 'unknown';
  }
}

/** Mapea el resultado de mensajería al estado final del job/resume. */
const estadoPorEnvio = (r: 'sent' | 'already_sent' | 'failed' | 'unknown'): CoverageResumeStatus =>
  r === 'sent' || r === 'already_sent' ? 'done' : r === 'failed' ? 'send_failed' : 'send_unknown';

/**
 * SHIPPING-CHAT-3C — Adapter VALIDADO del snapshot congelado (TX-C) a la entrada de la orden.
 * PURO y fail-closed: enteros seguros, quantity > 0, subtotal === Σ price×quantity; cualquier
 * inconsistencia ⇒ null (jamás casts inseguros ni datos inventados; imageUrl no existe ni hace falta).
 */
export function orderCartInputFromSnapshot(
  snap: { items: CoverageCartItem[]; subtotal: number } | null | undefined,
): OrderCartInput | null {
  if (!snap || !Array.isArray(snap.items) || snap.items.length === 0) return null;
  let suma = 0;
  for (const i of snap.items) {
    if (typeof i.productId !== 'string' || i.productId === '' || typeof i.name !== 'string' || i.name === '') return null;
    if (!Number.isSafeInteger(i.quantity) || i.quantity <= 0) return null;
    if (!Number.isSafeInteger(i.price) || i.price < 0) return null;
    const linea = i.price * i.quantity;
    if (!Number.isSafeInteger(linea)) return null;
    suma += linea;
    if (!Number.isSafeInteger(suma)) return null;
  }
  if (!Number.isSafeInteger(snap.subtotal) || snap.subtotal !== suma) return null;
  return {
    items: snap.items.map((i) => ({ productId: i.productId, name: i.name, price: i.price, quantity: i.quantity })),
    subtotal: snap.subtotal,
  };
}

/**
 * SHIPPING-CHAT-3C — Guard mecánico: un job de quote inconsistente (snapshot corrupto, monto
 * inválido, o aprobación sin quote bajo política required) se CANCELA con campana — jamás una
 * orden ni instrucciones bancarias con dinero inválido. Auditado, sin PII.
 */
async function cancelarJobPorQuoteInconsistente(
  tenantId: string,
  jobId: string,
  requestId: string,
  customerId: string,
  motivo: string,
): Promise<void> {
  const now = Timestamp.now();
  await db().doc(paths.session(tenantId, customerId)).set({ context: { coverageResumeInProgress: null }, updatedAt: now }, { merge: true }).catch(() => {});
  await setJob(tenantId, jobId, { status: 'cancelled' });
  await setResume(tenantId, requestId, 'cancelled', null);
  logger.warn('Cobertura: job de quote cancelado por inconsistencia (guard mecánico)', { tenantId, jobId, motivo });
  await recordAudit({
    tenantId,
    action: 'coverage.quote_job_cancelled',
    actorUid: 'system',
    actorRole: 'SYSTEM',
    targetType: 'coverageRequest',
    targetId: requestId,
    summary: `Reanudación con cotización cancelada (${motivo}) para el cliente ${maskPhone(customerId)}`,
  }).catch(() => {});
  try {
    await db()
      .collection(paths.notifications(tenantId))
      .doc(`covquote-${customerId}-${requestId}`)
      .create({
        id: `covquote-${customerId}-${requestId}`,
        tenantId,
        category: 'handoff',
        type: 'handoff_coverage_stale',
        title: '📦 Una cotización de envío necesita atención manual',
        body: `La reanudación con cotización del cliente …${customerId.slice(-4)} se canceló por un control de consistencia. Revisá la conversación desde Conversaciones y atendé el pedido a mano.`,
        dedupeKey: `covquote-${customerId}-${requestId}`,
        customerId,
        read: false,
        readAt: null,
        createdAt: now,
      });
  } catch (e) {
    if ((e as { code?: number | string }).code !== 6 && (e as { code?: string }).code !== 'already-exists') {
      logger.warn('Cobertura: no se pudo notificar la cancelación del job de quote', { tenantId, requestId });
    }
  }
}

/** Procesa un job del outbox de reanudación. Idempotente y re-ejecutable. */
export async function processCoverageResumeJob(tenantId: string, jobId: string): Promise<void> {
  // Feature flag: apagado ⇒ CERO procesamiento (el job queda pending por si se reactiva).
  const cfgFull = await getCheckoutConfig(tenantId);
  const cfg = coverageSettings(cfgFull);
  // SHIPPING-CHAT-3C: política de cotización (mismo snapshot de config que el flag).
  const politicaQuote = shippingQuotePolicyOf((cfgFull as { coverage?: unknown }).coverage);
  if (!cfg.enabled) {
    logger.info('Cobertura: resume omitido (feature off)', { tenantId, jobId });
    return;
  }
  if (await resumePausado(tenantId)) return; // fixture de tests (solo emulador)

  const claim = await claimJob(tenantId, jobId);
  if (claim.kind === 'stale') {
    // Job de una activación ANTERIOR: quedó `cancelled` EN el claim (cero orden/mensaje/banco/
    // liberación; marca y espejo limpiados en la misma transacción). El cliente puede haber
    // quedado esperando en un takeover coverage_review: se audita y se AVISA al equipo por la
    // campana (review: sin señal, el chat quedaba mudo indefinidamente y el panel decía
    // "aprobada" como si estuviera resuelto).
    await notificarResumeCancelado(tenantId, claim.job, claim.sellerUid);
    logger.info('Cobertura: job de una activación anterior → cancelado sin efectos', { tenantId, jobId });
    return;
  }
  if (claim.kind === 'skip') {
    logger.info('Cobertura: resume no reclamado', { tenantId, jobId, motivo: claim.motivo });
    return;
  }
  const { job, req } = claim;
  const customerId = job.customerId;
  const jobAct = job.activationId ?? null;
  // KILL-SWITCH-1: cualquier revalidación que detecte el apagado deja el job en espera segura
  // (pending + marca limpia) y corta SIN efectos: ni liberación, ni orden, ni banco, ni mensaje.
  const pausar = (punto: string) => pausarJobPorApagado(tenantId, jobId, req.id, customerId, punto);

  await coverageHold(tenantId, 'resume_pre_liberar'); // solo-emulador: test del kill-switch

  try {
    if (job.action === 'rejected') {
      const liberacion = await liberarSesionGuardado(tenantId, customerId, req.id, jobAct, { limpiarPuntero: true });
      if (liberacion === 'apagado') {
        await pausar('rejected_liberar');
        return;
      }
      if (liberacion === 'ajeno') {
        await setJob(tenantId, jobId, { status: 'held_by_seller' });
        await setResume(tenantId, req.id, 'held_by_seller', null);
        return;
      }
      const texto = cfg.rejectedMessage ?? MENSAJE_COBERTURA_RECHAZADA_DEFAULT;
      const envio = await enviarPorOutbox({
        tenantId,
        coverageRequestId: req.id,
        action: 'rejected',
        checkoutAttemptId: null,
        customerId,
        channel: job.channel,
        receivedVia: job.receivedVia ?? req.receivedVia ?? null,
        activationId: jobAct,
        text: texto,
      });
      if (envio === 'apagado') {
        await pausar('rejected_envio');
        return;
      }
      const final = estadoPorEnvio(envio);
      await setJob(tenantId, jobId, { status: final });
      await setResume(tenantId, req.id, final, null);
      logger.info('Cobertura: rechazo procesado', { tenantId, requestId: req.id, envio });
      return;
    }

    // ===== APPROVED =====
    // Re-drive tardío: si la orden reservada ya AVANZÓ (comprobante en verificación o pago
    // confirmado a mano por el vendedor), no se re-fuerza AWAITING_PAYMENT ni se re-mandan
    // instrucciones bancarias — el job cierra done sin tocar nada (review).
    if (job.orderId) {
      const oPrev = (await db().doc(paths.order(tenantId, job.orderId)).get()).data() as { status?: string } | undefined;
      if (oPrev && oPrev.status !== 'PENDING_PAYMENT') {
        await db().doc(paths.session(tenantId, customerId)).set({ context: { coverageResumeInProgress: null }, updatedAt: Timestamp.now() }, { merge: true }).catch(() => {});
        await setJob(tenantId, jobId, { status: 'done' });
        await setResume(tenantId, req.id, 'done', job.orderId);
        logger.info('Cobertura: resume cerrado sin acción (la orden ya avanzó)', { tenantId, requestId: req.id, orderId: job.orderId });
        return;
      }
    }

    // SHIPPING-CHAT-3C: job con COTIZACIÓN aprobada — la orden nace del snapshot CONGELADO y
    // verificado en TX-C (jamás del carrito vivo: el quote vale para ESE carrito). Guard
    // mecánico fail-closed: snapshot/monto inconsistentes ⇒ job cancelado con campana, jamás
    // una orden ni banco con dinero inválido.
    const conQuote = typeof job.shippingGs === 'number';
    let cartCongelado: OrderCartInput | null = null;
    if (conQuote) {
      cartCongelado = orderCartInputFromSnapshot(job.cartSnapshot ?? null);
      if (!cartCongelado || !Number.isSafeInteger(job.shippingGs) || (job.shippingGs as number) < 0) {
        await cancelarJobPorQuoteInconsistente(tenantId, jobId, req.id, customerId, 'snapshot/monto del quote inválido');
        return;
      }
    } else if (politicaQuote.status !== 'off') {
      // Flip de required entre la aprobación vieja y el resume (diseño H5): un job SIN quote bajo
      // política required/invalid no crea orden sin envío — se cancela con campana (fail-closed),
      // salvo que la orden YA exista (se completa esa, totales congelados).
      const ordenPrev = job.orderId ? (await db().doc(paths.order(tenantId, job.orderId)).get()).exists : false;
      if (!ordenPrev) {
        await cancelarJobPorQuoteInconsistente(tenantId, jobId, req.id, customerId, 'aprobación sin cotización bajo política required');
        return;
      }
    }

    // 1) Reservar checkoutAttemptId + orderId UNA vez (en el job — doc-id determinístico).
    let checkoutAttemptId = job.checkoutAttemptId ?? null;
    let orderId = job.orderId ?? null;
    if (!checkoutAttemptId || !orderId) {
      checkoutAttemptId = checkoutAttemptId ?? newId(ID_PREFIX.PAYMENT).replace('pay_', 'atm_');
      orderId = orderId ?? newOrderId();
      await db().runTransaction(async (tx) => {
        const j = (await tx.get(jobRef(tenantId, jobId))).data() as CoverageResumeJob;
        // Otro worker pudo reservar en el medio: SIEMPRE gana la reserva ya persistida.
        checkoutAttemptId = j.checkoutAttemptId ?? checkoutAttemptId;
        orderId = j.orderId ?? orderId;
        tx.update(jobRef(tenantId, jobId), { checkoutAttemptId, orderId, updatedAt: Timestamp.now() });
        tx.update(reqRef(tenantId, req.id), { checkoutAttemptId, updatedAt: Timestamp.now() });
      });
    }

    // 2) Estado del takeover + carrito, con marca anti-doble-checkout ANTES de liberar.
    const sesRef = db().doc(paths.session(tenantId, customerId));
    const ses = (await sesRef.get()).data() as Session | undefined;
    const cart = ses?.cart ?? { items: [], subtotal: 0 };

    // Review (kill-switch): si en un run anterior YA se creó la orden reservada (p.ej. apagado
    // entre crear la orden y AWAITING) y el cliente vació el carrito durante la pausa, NO se
    // desvía a "carrito vacío" dejando la orden huérfana: se completa ESA orden (sus totales ya
    // están congelados). El carrito vacío solo aplica cuando todavía no hay orden.
    const ordenReservadaSnap = orderId ? await db().doc(paths.order(tenantId, orderId)).get() : null;
    const ordenYaCreada = ordenReservadaSnap?.exists === true;

    if (!conQuote && cart.items.length === 0 && !ordenYaCreada) {
      // Carrito vacío: liberar con candado, avisar y dejar la aprobación VIGENTE (sin orden).
      const liberacion = await liberarSesionGuardado(tenantId, customerId, req.id, jobAct, {});
      if (liberacion === 'apagado') {
        await pausar('empty_cart_liberar');
        return;
      }
      if (liberacion === 'ajeno') {
        await setJob(tenantId, jobId, { status: 'held_by_seller' });
        await setResume(tenantId, req.id, 'held_by_seller', null);
        return;
      }
      const envio = await enviarPorOutbox({
        tenantId,
        coverageRequestId: req.id,
        action: 'empty_cart',
        checkoutAttemptId,
        customerId,
        channel: job.channel,
        receivedVia: job.receivedVia ?? req.receivedVia ?? null,
        activationId: jobAct,
        text: MENSAJE_CARRITO_VACIO_APROBADO,
      });
      if (envio === 'apagado') {
        await pausar('empty_cart_envio');
        return;
      }
      const final = estadoPorEnvio(envio);
      await setJob(tenantId, jobId, { status: final });
      await setResume(tenantId, req.id, final, null);
      return;
    }

    const liberacion = await liberarSesionGuardado(tenantId, customerId, req.id, jobAct, { resumeInProgress: true });
    if (liberacion === 'apagado') {
      await pausar('approved_liberar');
      return;
    }
    if (liberacion === 'ajeno') {
      await setJob(tenantId, jobId, { status: 'held_by_seller' });
      await setResume(tenantId, req.id, 'held_by_seller', orderId);
      return;
    }

    await coverageHold(tenantId, 'resume_pre_orden'); // solo-emulador: test del kill-switch

    // 3) Crear la orden UNA sola vez (orderId reservado; si ya existe, se reusa tal cual).
    //    KILL-SWITCH-1: precondición de cobertura DENTRO de la transacción de creación
    //    idempotente (mismo patrón createPendingOrder — sin segunda lógica de pedidos).
    const orderSnap = await db().doc(paths.order(tenantId, orderId)).get();
    const order = orderSnap.exists
      ? (orderSnap.data() as { totals: { total: number } })
      : await createPendingOrder(tenantId, customerId, conQuote ? (cartCongelado as OrderCartInput) : cart, {
          orderId,
          coverage: { requestId: req.id, locationFingerprint: req.locationFingerprint ?? null },
          deliveryAddress: direccionTextualDe(req),
          // SHIPPING-CHAT-3C: el envío aprobado viaja separado a totals.shipping (jamás al subtotal).
          ...(conQuote ? { shippingGs: job.shippingGs as number } : {}),
          guard: async (tx) => {
            const act = coverageActivationOf(((await tx.get(db().doc(`tenants/${tenantId}/config/checkout`))).data() as { coverage?: unknown } | undefined)?.coverage);
            return act.enabled && act.activationId === jobAct;
          },
        });
    if (!order) {
      await pausar('approved_orden');
      return;
    }

    await coverageHold(tenantId, 'resume_pre_awaiting'); // solo-emulador: test del kill-switch

    // 4) Sesión AWAITING_PAYMENT + pendingOrderId ANTES de mandar instrucciones (guardado:
    //    si un humano tomó el chat en el medio, no se pisa — queda held y sin mensaje).
    //    KILL-SWITCH-1: el flag se re-lee EN esta transacción — apagado ⇒ cero escrituras.
    const sesionLista = await db().runTransaction(async (tx) => {
      const act = coverageActivationOf(((await tx.get(db().doc(`tenants/${tenantId}/config/checkout`))).data() as { coverage?: unknown } | undefined)?.coverage);
      if (!act.enabled || act.activationId !== jobAct) return 'apagado' as const;
      const fresh = (await tx.get(sesRef)).data() as Session | undefined;
      if (fresh?.context?.humanTakeover === true) return 'takeover' as const;
      tx.update(sesRef, {
        state: 'AWAITING_PAYMENT',
        'context.pendingOrderId': orderId,
        'context.pendingCartConfirmation': null,
        'context.coverageResumeInProgress': null,
        updatedAt: Timestamp.now(),
      });
      return 'ok' as const;
    });
    if (sesionLista === 'apagado') {
      await pausar('approved_awaiting');
      return;
    }
    if (sesionLista === 'takeover') {
      await setJob(tenantId, jobId, { status: 'held_by_seller' });
      await setResume(tenantId, req.id, 'held_by_seller', orderId);
      return;
    }

    // 5) Instrucciones de pago de ESA orden, exactamente una vez (outbox por attemptId).
    const config = await getCheckoutConfig(tenantId);
    const texto = `${MENSAJE_COBERTURA_APROBADA_INTRO}\n\n${formatTransferInstructions(config, order.totals.total)}`;
    const envio = await enviarPorOutbox({
      tenantId,
      coverageRequestId: req.id,
      action: 'approved',
      checkoutAttemptId,
      customerId,
      channel: job.channel,
      receivedVia: job.receivedVia ?? req.receivedVia ?? null,
      activationId: jobAct,
      text: texto,
    });
    if (envio === 'apagado') {
      await pausar('approved_envio');
      return;
    }
    const final = estadoPorEnvio(envio);
    await setJob(tenantId, jobId, { status: final, checkoutAttemptId, orderId });
    await setResume(tenantId, req.id, final, orderId);
    logger.info('Cobertura: checkout reanudado', { tenantId, requestId: req.id, orderId, envio });
  } catch (e) {
    // Degradación recuperable: el lease vence y un retrigger re-procesa (attempts acotados).
    // La marca anti-doble-checkout se limpia SIEMPRE (review: jamás debe quedar colgada).
    logger.error('Cobertura: error procesando la reanudación', e, { tenantId, jobId });
    await db().doc(paths.session(tenantId, customerId)).set({ context: { coverageResumeInProgress: null }, updatedAt: Timestamp.now() }, { merge: true }).catch(() => {});
    await setJob(tenantId, jobId, { status: 'pending' }).catch(() => {});
  }
}

/**
 * ETAPA E — tras una liberación manual (chatRelease/devReleaseChat), re-encolar el job
 * `held_by_seller` del request de ESTE cliente (validando decisión vigente). Idempotente.
 * HARDEN-1: con el flag apagado o el job de una activación anterior NO se re-encola (queda
 * held_by_seller, inerte y preservado) — el flag se lee DENTRO de la misma transacción.
 */
export async function reactivarResumeTrasLiberacion(tenantId: string, customerId: string): Promise<boolean> {
  try {
    const ses = (await db().doc(paths.session(tenantId, customerId)).get()).data() as Session | undefined;
    const requestId = ses?.context?.coverage?.requestId;
    if (!requestId) return false;
    return await db().runTransaction(async (tx) => {
      const cfgSnap = await tx.get(db().doc(`tenants/${tenantId}/config/checkout`));
      const act = coverageActivationOf((cfgSnap.data() as { coverage?: unknown } | undefined)?.coverage);
      if (!act.enabled) return false;
      const jSnap = await tx.get(jobRef(tenantId, requestId));
      const job = jSnap.exists ? (jSnap.data() as CoverageResumeJob) : null;
      if (!job || job.status !== 'held_by_seller' || job.customerId !== customerId || job.tenantId !== tenantId) return false;
      if ((job.activationId ?? null) !== act.activationId) return false;
      const req = (await tx.get(reqRef(tenantId, requestId))).data() as CoverageRequest | undefined;
      const esperado = job.action === 'approved' ? 'coverage_approved' : 'coverage_rejected';
      if (!req || req.status !== esperado || req.decision?.action !== job.action) return false;
      tx.update(jSnap.ref, { status: 'pending', leaseUntil: null, updatedAt: Timestamp.now() });
      return true;
    });
  } catch (e) {
    logger.warn('Cobertura: no se pudo reactivar el resume tras la liberación', { tenantId, customer: maskPhone(customerId) });
    return false;
  }
}
