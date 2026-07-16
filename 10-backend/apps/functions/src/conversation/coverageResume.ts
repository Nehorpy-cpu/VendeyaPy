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
 */
import { Timestamp } from 'firebase-admin/firestore';
import type {
  Address,
  CoverageOutboxMessage,
  CoverageRequest,
  CoverageResumeJob,
  CoverageResumeStatus,
  Session,
} from '@vpw/shared';
import { newId, ID_PREFIX, newOrderId, coverageActivationOf } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../audit/audit.js';
import { coverageSettings } from './coverage.js';
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
  const cliente = `…${job.customerId.slice(-4)}`;
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
 */
async function liberarSesionGuardado(
  tenantId: string,
  customerId: string,
  requestId: string,
  marcas: { resumeInProgress?: boolean; limpiarPuntero?: boolean },
): Promise<'liberado' | 'sin_takeover' | 'ajeno'> {
  const sesRef = db().doc(paths.session(tenantId, customerId));
  const now = Timestamp.now();
  const out = await db().runTransaction(async (tx) => {
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
  /** HARDEN-1: activación bajo la que se genera el mensaje (trazabilidad; el gate es del caller). */
  activationId: string | null;
  text: string;
}): Promise<'sent' | 'already_sent' | 'failed' | 'unknown'> {
  const { tenantId } = input;
  const id = `${input.coverageRequestId}_${input.action}${input.checkoutAttemptId ? `_${input.checkoutAttemptId}` : ''}`;
  const ref = outboxRef(tenantId, id);
  const now = Timestamp.now();

  // 1) Preparar/claimear en UNA transacción (create-si-falta + estado → sending).
  const claim = await db().runTransaction(async (tx) => {
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
  if (claim === 'already_sent') return 'already_sent';
  if (claim === 'unknown') return 'unknown';
  if (claim === 'failed') return 'failed';
  if (claim === 'busy') return 'unknown'; // otro worker enviando: no dupliquen — se resuelve por lease

  // 2) Envío real (mock/live según config del tenant, por el MISMO receivedVia).
  try {
    const client = await getWhatsAppClient(tenantId, undefined, input.receivedVia);
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
    // Falla devuelta por el cliente. Con instrucciones bancarias en juego, SOLO se clasifica
    // `failed` (reintenta) ante un RECHAZO CONFIRMADO de Meta (códigos de error definidos);
    // cualquier ambigüedad de red (timeout, reset, 5xx sin cuerpo) queda `unknown` (review).
    const confirmada = /"code":\s*\d+/.test(r.error ?? '');
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

/** Procesa un job del outbox de reanudación. Idempotente y re-ejecutable. */
export async function processCoverageResumeJob(tenantId: string, jobId: string): Promise<void> {
  // Feature flag: apagado ⇒ CERO procesamiento (el job queda pending por si se reactiva).
  const cfg = coverageSettings(await getCheckoutConfig(tenantId));
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

  try {
    if (job.action === 'rejected') {
      const liberacion = await liberarSesionGuardado(tenantId, customerId, req.id, { limpiarPuntero: true });
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
        activationId: job.activationId ?? null,
        text: texto,
      });
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

    if (cart.items.length === 0) {
      // Carrito vacío: liberar con candado, avisar y dejar la aprobación VIGENTE (sin orden).
      const liberacion = await liberarSesionGuardado(tenantId, customerId, req.id, {});
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
        activationId: job.activationId ?? null,
        text: MENSAJE_CARRITO_VACIO_APROBADO,
      });
      const final = estadoPorEnvio(envio);
      await setJob(tenantId, jobId, { status: final });
      await setResume(tenantId, req.id, final, null);
      return;
    }

    const liberacion = await liberarSesionGuardado(tenantId, customerId, req.id, { resumeInProgress: true });
    if (liberacion === 'ajeno') {
      await setJob(tenantId, jobId, { status: 'held_by_seller' });
      await setResume(tenantId, req.id, 'held_by_seller', orderId);
      return;
    }

    // 3) Crear la orden UNA sola vez (orderId reservado; si ya existe, se reusa tal cual).
    const orderSnap = await db().doc(paths.order(tenantId, orderId)).get();
    const order = orderSnap.exists
      ? (orderSnap.data() as { totals: { total: number } })
      : await createPendingOrder(tenantId, customerId, cart, {
          orderId,
          coverage: { requestId: req.id, locationFingerprint: req.locationFingerprint ?? null },
          deliveryAddress: direccionTextualDe(req),
        });

    // 4) Sesión AWAITING_PAYMENT + pendingOrderId ANTES de mandar instrucciones (guardado:
    //    si un humano tomó el chat en el medio, no se pisa — queda held y sin mensaje).
    const sesionLista = await db().runTransaction(async (tx) => {
      const fresh = (await tx.get(sesRef)).data() as Session | undefined;
      if (fresh?.context?.humanTakeover === true) return false;
      tx.update(sesRef, {
        state: 'AWAITING_PAYMENT',
        'context.pendingOrderId': orderId,
        'context.pendingCartConfirmation': null,
        'context.coverageResumeInProgress': null,
        updatedAt: Timestamp.now(),
      });
      return true;
    });
    if (!sesionLista) {
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
      activationId: job.activationId ?? null,
      text: texto,
    });
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
    logger.warn('Cobertura: no se pudo reactivar el resume tras la liberación', { tenantId, customer: `…${customerId.slice(-4)}` });
    return false;
  }
}
