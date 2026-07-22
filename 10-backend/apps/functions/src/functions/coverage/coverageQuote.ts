/**
 * SHIPPING-CHAT-3C — Saga de cotización de envío (TX-A → claim → Meta → TX-C).
 * ============================================================================
 * `coverageQuoteAndApprove`: el vendedor confirma un costo de envío detectado por el parser
 * compartido; el server RE-PARSEA el borrador (autoridad), envía UN mensaje canónico por el
 * MISMO número que recibió la conversación, y SOLO después de que Meta acepta el mensaje
 * (wamid) aprueba la cobertura, persiste el `shippingQuote` estructurado y encola EXACTAMENTE
 * un resume job (con el carrito CONGELADO y el envío separado para la orden).
 *
 * Garantías (diseño 3A-HARDEN aprobado):
 *  - TX-A crea el outbox en 'prepared' (nunca 'sending'); un crash post-TX-A queda recuperable.
 *  - El OUTBOX es la única fuente de verdad del envío; el pointer `shippingQuotePending` del
 *    request identifica el intento y congela el ACTOR ORIGINAL (sin estado/lease/attempts).
 *  - Producción solo aprueba con transporte {live, credentials:'tenant'} por el receivedVia
 *    EXACTO (sin fallback al principal); mock/global_fallback ⇒ channel_unavailable.
 *  - 'accepted' exige wamid; 'rejected' ⇒ failed + pointer liberado (reintento EXPLÍCITO =
 *    intento nuevo); 'unknown' ⇒ congelado (JAMÁS reenvío automático; resolución manual).
 *  - Mismatch determinístico post-envío ⇒ `sent_not_applied` (terminal auditable, sin aprobar).
 *  - Fallo transitorio de TX-C ⇒ pointer y outbox `sent` intactos: la re-invocación recupera
 *    SIN volver a Meta (la recuperación corre ANTES de resolver el transporte).
 *  - `sellerDraft` JAMÁS se persiste ni se loguea. El texto enviado es SOLO el canónico.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { Timestamp, type Transaction } from 'firebase-admin/firestore';
import type {
  CoverageOutboxMessage,
  CoverageOutboxQuoteMessage,
  CoverageQuoteAndApproveInput,
  CoverageRequest,
  CoverageResumeJob,
  CoverageSessionPointer,
  Session,
  ShippingQuoteAttemptPhase,
  ShippingQuotePending,
} from '@vpw/shared';
import {
  coverageActivationOf,
  shippingQuotePolicyOf,
  parseShippingCost,
  formatCanonicalShippingMessage,
  computeOrderTotals,
  newQuoteAttemptId,
  maskPhone,
  PARSER_VERSION,
} from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../audit/audit.js';
import { purgeAtFrom, shippingCartFingerprintOf, cartSnapshotOf } from '../../conversation/coverage.js';
import { coverageHold } from '../../conversation/coverageTestHooks.js';
import { appendMessage } from '../../conversation/messages.js';
import { getWhatsAppClientExact } from '../../messaging/whatsappClient.js';
import {
  assertCoverageActor,
  resolveTenant,
  assertFlujoVigente,
  outboxIdDeQuote,
  MENSAJE_FLUJO_DESHABILITADO,
  MENSAJE_QUOTE_CONFIG_INVALIDA,
} from './coverageCallables.js';

const REGION = 'us-central1';
const QUOTE_LEASE_MS = 60_000;
const NOTE_MAX = 300;

const reqRef = (t: string, id: string) => db().doc(`tenants/${t}/coverageRequests/${id}`);
const outboxRef = (t: string, id: string) => db().doc(`tenants/${t}/coverageMessageOutbox/${id}`);
const jobRef = (t: string, id: string) => db().doc(`tenants/${t}/coverageResumeJobs/${id}`);
const configRef = (t: string) => db().doc(`tenants/${t}/config/checkout`);

export { outboxIdDeQuote }; // definido en coverageCallables (la decisión también lee el outbox); los tests importan de acá

/** Error tipado de la saga: `details.kind` estable para el panel (2B/3D). Sin datos sensibles. */
function qerr(code: 'failed-precondition' | 'permission-denied' | 'not-found' | 'invalid-argument' | 'unavailable' | 'internal', msg: string, kind: string, extra?: Record<string, unknown>): HttpsError {
  return new HttpsError(code, msg, { kind, ...(extra ?? {}) });
}

interface QuoteActor {
  uid: string;
  role: 'TENANT_OWNER' | 'TENANT_MANAGER' | 'SELLER';
  name: string;
}

/**
 * HARDEN-1 (B) — Fase DERIVADA del outbox (única fuente de verdad; jamás se persiste). PURA:
 *  - prepared ⇒ 'preparing' · sending con lease vigente ⇒ 'in_progress' · sent ⇒
 *    'sent_pending_approval' · failed/sent_not_applied ⇒ 'failed' · unknown o sending con
 *    lease vencido ⇒ 'unknown' (el mensaje PUDO salir — la mutación a unknown la hace la saga
 *    en su próxima transacción, nunca una consulta read-only).
 */
export function faseDeIntentoQuote(
  status: CoverageOutboxMessage['status'],
  leaseUntilMs: number | null,
  nowMs: number,
): ShippingQuoteAttemptPhase {
  if (status === 'prepared') return 'preparing';
  if (status === 'sending') return leaseUntilMs !== null && leaseUntilMs > nowMs ? 'in_progress' : 'unknown';
  if (status === 'sent') return 'sent_pending_approval';
  // `sent_applied` con pointer vivo es una invariante rota (TX-C limpia el pointer en el MISMO
  // commit que aplica) ⇒ se reporta como 'failed' (fail-closed accionable), igual que los terminales.
  if (status === 'failed' || status === 'sent_not_applied' || status === 'sent_applied') return 'failed';
  return 'unknown';
}

/**
 * HARDEN-1 (G) — Total con envío por la ÚNICA fuente compartida (`computeOrderTotals`), jamás
 * una suma directa: subtotal+envío fuera del rango entero seguro (o entradas corruptas) ⇒
 * failed-precondition `total_invalido`. El mismo helper valida en TX-A (antes de enviar nada)
 * y en TX-C (revalidación post-envío).
 */
export function totalConEnvioSeguro(subtotalGs: number, shippingGs: number): number {
  try {
    return computeOrderTotals({ subtotalGs, discountGs: 0, shippingGs }).total;
  } catch {
    throw qerr('failed-precondition', 'El total con envío no es un monto válido: revisá el carrito y el costo antes de continuar.', 'total_invalido');
  }
}

const notifSentNaRef = (tenantId: string, requestId: string, attemptId: string) =>
  db().doc(`${paths.notifications(tenantId)}/covsentna-${requestId}-${attemptId}`);

/**
 * HARDEN-1 (E) — Campana idempotente al equipo EN LA MISMA transacción que cierra un intento en
 * `sent_not_applied`: el cliente PUDO recibir un costo que finalmente no se aplicó y el equipo
 * debe enterarse aunque nadie mire el error de la callable. Id determinístico por
 * request+quoteAttemptId + guard tx.get ⇒ exactamente UNA notificación aunque haya reintentos.
 * Sin PII (cliente enmascarado; jamás dirección/coordenadas/texto del vendedor).
 * OJO Firestore: llamar SIEMPRE antes de la primera escritura de la transacción (reads→writes).
 */
async function campanaSentNotApplied(
  tx: Transaction,
  tenantId: string,
  requestId: string,
  attemptId: string,
  customerId: string,
  motivo: string,
  sellerUid: string | null,
  now: Timestamp,
): Promise<void> {
  const ref = notifSentNaRef(tenantId, requestId, attemptId);
  if ((await tx.get(ref)).exists) return;
  const id = ref.id;
  tx.create(ref, {
    id,
    tenantId,
    category: 'handoff',
    type: 'handoff_coverage_stale',
    title: '📦 Un costo de envío enviado NO se aplicó',
    body: `El cliente ${maskPhone(customerId)} pudo haber recibido un costo de envío que finalmente no se aplicó (${motivo}). Revisá la conversación desde Conversaciones y recotizá si corresponde.`,
    dedupeKey: id,
    customerId,
    ...(sellerUid ? { targetUid: sellerUid } : {}),
    read: false,
    readAt: null,
    createdAt: now,
  });
}

/** Validación PURA del input (exportada para tests). JAMÁS loguea/persiste sellerDraft. */
export function validarQuoteInput(data: CoverageQuoteAndApproveInput | undefined): {
  requestId: string;
  sellerDraft: string;
  confirmedShippingGs: number;
  expectedLocationFingerprint: string;
  expectedCartFingerprint: string;
} {
  const requestId = typeof data?.requestId === 'string' ? data.requestId.trim() : '';
  if (!/^covr_[0-9A-Za-z]{12}$/.test(requestId)) throw qerr('invalid-argument', 'Solicitud de cobertura inválida.', 'invalid_input');
  const sellerDraft = typeof data?.sellerDraft === 'string' ? data.sellerDraft : '';
  if (sellerDraft.trim() === '' || sellerDraft.length > 4096) throw qerr('invalid-argument', 'Borrador de cotización inválido.', 'invalid_input');
  const gs = data?.confirmedShippingGs;
  if (typeof gs !== 'number' || !Number.isSafeInteger(gs) || gs < 0) {
    throw qerr('invalid-argument', 'Monto de envío confirmado inválido.', 'invalid_input');
  }
  const loc = typeof data?.expectedLocationFingerprint === 'string' ? data.expectedLocationFingerprint.trim() : '';
  const cart = typeof data?.expectedCartFingerprint === 'string' ? data.expectedCartFingerprint.trim() : '';
  if (loc === '' || loc.length > 64 || cart === '' || cart.length > 64) {
    throw qerr('invalid-argument', 'Faltan las huellas de la revisión mostrada.', 'invalid_input');
  }
  return { requestId, sellerDraft, confirmedShippingGs: gs, expectedLocationFingerprint: loc, expectedCartFingerprint: cart };
}

type QuoteInput = ReturnType<typeof validarQuoteInput>;

type TxAOutcome =
  | { kind: 'send'; attemptId: string }
  | { kind: 'goto_txc'; attemptId: string }
  | { kind: 'ok_idempotente'; shippingGs: number; totalGs: number }
  | { kind: 'error'; err: HttpsError };

/**
 * TX-A — Reservar el intento (UNA transacción; lecturas antes de escrituras). Recuperación
 * (pointer+outbox) se evalúa ANTES de los gates de huellas. Las transiciones que deben
 * PERSISTIR (expiración, refresh de snapshot, sent_not_applied, unknown por lease) se
 * commitean y el HttpsError se lanza DESPUÉS, fuera de la transacción.
 */
async function txPrepararIntento(tenantId: string, actor: QuoteActor, input: QuoteInput): Promise<TxAOutcome> {
  const now = Timestamp.now();
  return db().runTransaction(async (tx): Promise<TxAOutcome> => {
    const cfgSnap = await tx.get(configRef(tenantId));
    const rawCoverage = (cfgSnap.data() as { coverage?: unknown } | undefined)?.coverage;
    const act = coverageActivationOf(rawCoverage);
    if (!act.enabled || !act.activationId) return { kind: 'error', err: qerr('failed-precondition', MENSAJE_FLUJO_DESHABILITADO, 'flow_off') };
    const policy = shippingQuotePolicyOf(rawCoverage);

    const reqSnap = await tx.get(reqRef(tenantId, input.requestId));
    const req = reqSnap.exists ? (reqSnap.data() as CoverageRequest) : null;
    if (!req || req.tenantId !== tenantId) return { kind: 'error', err: qerr('not-found', 'La solicitud de cobertura no existe.', 'not_found') };
    if (actor.role === 'SELLER' && req.sellerUid !== actor.uid) {
      return { kind: 'error', err: qerr('permission-denied', 'Esta revisión está asignada a otra persona del equipo.', 'not_assigned') };
    }
    const sesSnap = await tx.get(db().doc(paths.session(tenantId, req.customerId)));
    const ses = sesSnap.data() as Session | undefined;

    // Idempotencia de ÉXITO: la MISMA cotización ya se aplicó (re-invocación tras commit de TX-C).
    if (
      req.status === 'coverage_approved' &&
      req.shippingQuote &&
      req.shippingQuote.chargeGs === input.confirmedShippingGs &&
      req.shippingQuote.locationFingerprint === input.expectedLocationFingerprint &&
      req.shippingQuote.cartFingerprint === input.expectedCartFingerprint
    ) {
      // HARDEN-2 (C): también el reporte idempotente pasa por la ÚNICA fuente compartida — nada
      // desplegado tiene aprobaciones pre-harden, así que un overflow acá es un estado corrupto
      // real: total_invalido (error sin escrituras; el dinero persistido no se toca).
      const subtotal = req.cartSnapshot?.subtotal ?? 0;
      return { kind: 'ok_idempotente', shippingGs: req.shippingQuote.chargeGs, totalGs: totalConEnvioSeguro(subtotal, req.shippingQuote.chargeGs) };
    }
    assertFlujoVigente(act, req); // activación anterior ⇒ failed-precondition (sin escrituras)

    // ---- RECUPERACIÓN: pointer + outbox ANTES de la política, del estado del request, de la
    // expiración y de los gates de huellas (diseño H2 + reviews 3C y HARDEN-1): un envío que
    // PUDO llegar al cliente (sent/sending/unknown) JAMÁS se abandona sin estado terminal
    // auditable — ni siquiera si el request fue decidido/vencido por FUERA de la saga o la
    // política cambió: el retry rutea a TX-C, que terminaliza con campana (sent_not_applied)
    // o aprueba solo si TODO sigue válido. El vencimiento de esos caminos jamás es un expire ciego.
    const pending = req.shippingQuotePending ?? null;
    let obPend: CoverageOutboxMessage | null = null;
    let coincide = false;
    const obPendRef = pending ? outboxRef(tenantId, outboxIdDeQuote(input.requestId, pending.quoteAttemptId)) : null;
    if (pending && obPendRef) {
      const obSnap = await tx.get(obPendRef);
      obPend = obSnap.exists ? (obSnap.data() as CoverageOutboxMessage) : null;
      coincide =
        pending.chargeGs === input.confirmedShippingGs &&
        pending.locationFingerprint === input.expectedLocationFingerprint &&
        pending.cartFingerprint === input.expectedCartFingerprint;
      if (!obPend) {
        // Invariante rota (pointer huérfano): liberar y que el vendedor reintente.
        tx.update(reqSnap.ref, { shippingQuotePending: null, updatedAt: now });
        return { kind: 'error', err: qerr('unavailable', 'El intento anterior quedó incompleto: volvé a intentar.', 'generic') };
      }
      if (obPend.status === 'sent') {
        // Request YA no pendiente (decidido/vencido por fuera de la saga): el retry va DIRECTO a
        // TX-C, que jamás aprueba en ese estado — commitea sent_not_applied + campana + pointer
        // libre (cierre del hallazgo "zombi sent" del review HARDEN-1). El monto del input es
        // irrelevante: TX-C solo usa el pending congelado.
        if (req.status !== 'pending_coverage_review') return { kind: 'goto_txc', attemptId: pending.quoteAttemptId };
        if (!coincide) {
          return { kind: 'error', err: qerr('failed-precondition', 'Hay una cotización enviada pendiente de aplicar: completala o resolvela antes de cotizar otro monto.', 'quote_en_curso') };
        }
        // Verificación de viabilidad de TX-C (huellas vivas). Mismatch ⇒ sent_not_applied (commit)
        // + campana idempotente EN LA MISMA tx (HARDEN-1 E — el equipo debe enterarse).
        const locOk = (req.locationFingerprint ?? '') === pending.locationFingerprint;
        const fp2 = shippingCartFingerprintOf(ses?.cart ?? { items: [], subtotal: 0 });
        const cartOk = fp2 !== null && fp2 === pending.cartFingerprint;
        if (!locOk || !cartOk) {
          await campanaSentNotApplied(tx, tenantId, input.requestId, pending.quoteAttemptId, req.customerId, locOk ? 'el carrito cambió después del envío' : 'la ubicación cambió después del envío', req.sellerUid ?? null, now);
          tx.update(obPendRef, { status: 'sent_not_applied', leaseUntil: null, updatedAt: now });
          tx.update(reqSnap.ref, { shippingQuotePending: null, updatedAt: now });
          return {
            kind: 'error',
            err: qerr('failed-precondition', locOk ? 'El carrito cambió después del envío: el costo enviado no se aplicó. Recotizá.' : 'El cliente cambió su ubicación después del envío: el costo enviado no se aplicó.', locOk ? 'cart_changed_post_send' : 'location_changed'),
          };
        }
        return { kind: 'goto_txc', attemptId: pending.quoteAttemptId };
      }
      if (obPend.status === 'sending') {
        const lease = obPend.leaseUntil?.toMillis?.() ?? 0;
        if (lease > now.toMillis()) return { kind: 'error', err: qerr('failed-precondition', 'Hay un envío de cotización en curso: esperá un momento.', 'in_progress') };
        // Crash entre claim y persistencia: el mensaje PUDO salir ⇒ unknown (at-most-once).
        tx.update(obPendRef, { status: 'unknown', leaseUntil: null, updatedAt: now });
        return { kind: 'error', err: qerr('unavailable', 'No pudimos confirmar si el mensaje salió. Revisá el chat de WhatsApp del negocio antes de intentar otra acción.', 'unknown') };
      }
      if (obPend.status === 'unknown') {
        return { kind: 'error', err: qerr('unavailable', 'Hay un envío sin confirmar: un encargado debe resolverlo (entregado / no entregado) antes de continuar.', 'unknown') };
      }
      // prepared / failed / sent_not_applied siguen abajo: nada irreversible en vuelo.
    }

    if (req.status !== 'pending_coverage_review') {
      // Un 'prepared' que jamás salió sobre un request ya decidido/vencido se cierra TERMINAL
      // acá mismo (review HARDEN-1: sin esto quedaba pointer+prepared para siempre).
      if (obPendRef && obPend?.status === 'prepared') {
        tx.update(obPendRef, { status: 'failed', leaseUntil: null, updatedAt: now });
        tx.update(reqSnap.ref, { shippingQuotePending: null, updatedAt: now });
        const porPrep = req.decision?.byName ? ` por ${req.decision.byName}` : '';
        return { kind: 'error', err: qerr('failed-precondition', req.decision ? `Esta solicitud ya fue decidida${porPrep}.` : 'Esta solicitud no está pendiente de revisión.', 'already_decided') };
      }
      const por = req.decision?.byName ? ` por ${req.decision.byName}` : '';
      return { kind: 'error', err: qerr('failed-precondition', req.decision ? `Esta solicitud ya fue decidida${por}.` : 'Esta solicitud no está pendiente de revisión.', 'already_decided') };
    }

    // Gates de POLÍTICA — DESPUÉS de la recuperación (un sent bajo política ya cambiada debe
    // poder rutear a TX-C para terminalizar) y ANTES de cualquier envío/creación (jamás se
    // envía ni se prepara nada con la cotización deshabilitada o inválida).
    if (policy.status === 'off') return { kind: 'error', err: qerr('failed-precondition', 'La cotización de envío no está habilitada para este negocio.', 'quote_not_required') };
    if (policy.status === 'invalid') return { kind: 'error', err: qerr('failed-precondition', MENSAJE_QUOTE_CONFIG_INVALIDA, 'config_invalida') };

    if (req.expiresAt.toMillis() <= now.toMillis()) {
      // Outcome COMMIT: la expiración persiste (incluye limpiar el pointer del intento) y el
      // error sale post-commit (patrón commit-expire de decidirCobertura). Un 'prepared' que
      // jamás salió queda TERMINAL ('failed') en la misma tx — nunca un sent varado, porque
      // sent/sending/unknown ya retornaron arriba.
      if (obPendRef && obPend?.status === 'prepared') tx.update(obPendRef, { status: 'failed', leaseUntil: null, updatedAt: now });
      tx.update(reqSnap.ref, { status: 'coverage_expired', shippingQuotePending: null, updatedAt: now, coordinatesPurgeAt: purgeAtFrom(now, req) });
      tx.set(db().doc(paths.session(tenantId, req.customerId)), { context: { coverage: null }, updatedAt: now }, { merge: true });
      return { kind: 'error', err: qerr('failed-precondition', 'La solicitud venció: el cliente tiene que retomar la compra.', 'expired') };
    }

    if (obPendRef && obPend?.status === 'prepared' && pending) {
      if (coincide) return { kind: 'send', attemptId: pending.quoteAttemptId }; // re-drive del MISMO intento
      // Monto/huellas distintos: intento NUEVO reemplaza al preparado (que nunca salió). El
      // viejo queda TERMINAL ('failed') EN ESTA MISMA tx: un claim en vuelo del intento viejo
      // ya no puede enviarlo (cierre del hallazgo de reemplazo del review adversarial).
      tx.update(obPendRef, { status: 'failed', leaseUntil: null, updatedAt: now });
    }
    // failed / sent_not_applied / prepared-reemplazado ⇒ el pointer se libera y se sigue como intento nuevo.

    // ---- Gates estándar (intento nuevo) ----
    // HARDEN-1 (D + review): canal/receivedVia se validan ANTES de crear el intento — un request
    // que JAMÁS podrá enviarse (Instagram/Messenger, o sin número receptor) no genera pointer ni
    // outbox: sin esto, el gate de reject (quote_en_curso) dejaba la solicitud indecidible hasta
    // el vencimiento. El mismo gate se re-verifica en enviarQuote para intentos preexistentes.
    if (req.channel !== 'whatsapp' || (req.receivedVia ?? '').trim() === '') {
      return { kind: 'error', err: qerr('failed-precondition', 'La cotización solo puede salir por el número de WhatsApp que recibió la conversación del cliente.', 'channel_unavailable') };
    }
    if ((req.locationFingerprint ?? '') !== input.expectedLocationFingerprint) {
      return { kind: 'error', err: qerr('failed-precondition', 'El cliente actualizó su ubicación: revisá la versión más reciente antes de cotizar.', 'location_changed') };
    }
    const cart = ses?.cart ?? { items: [], subtotal: 0 };
    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      // Refresh del snapshot (self-healing del panel) + error accionable.
      tx.update(reqSnap.ref, { cartSnapshot: cartSnapshotOf({ items: [], subtotal: 0 }), cartFingerprint: 'cart2:empty', shippingQuotePending: null, updatedAt: now });
      return { kind: 'error', err: qerr('failed-precondition', 'El carrito del cliente quedó vacío: no hay nada que cotizar.', 'cart_changed') };
    }
    const fp2 = shippingCartFingerprintOf(cart);
    if (fp2 === null) {
      return { kind: 'error', err: qerr('failed-precondition', 'El carrito del cliente tiene datos inválidos: no se puede cotizar con seguridad.', 'cart_invalid') };
    }
    if (fp2 !== input.expectedCartFingerprint) {
      // Huella vieja (cart: v1) o carrito cambiado: REFRESH del snapshot financiero en la misma
      // tx (el panel se auto-cura con el poll) + error accionable. Fail-closed: jamás se cotiza
      // sobre una huella no financiera.
      tx.update(reqSnap.ref, { cartSnapshot: cartSnapshotOf(cart), cartFingerprint: fp2, shippingQuotePending: null, updatedAt: now });
      return { kind: 'error', err: qerr('failed-precondition', 'El carrito cambió: revisá el detalle actualizado y volvé a cotizar.', 'cart_changed') };
    }

    // RE-PARSE server-side (autoridad): el borrador debe producir EXACTAMENTE el monto confirmado.
    const parsed = parseShippingCost(input.sellerDraft, { maxChargeGs: policy.maxChargeGs });
    const parseOk = (parsed.kind === 'matched' || parsed.kind === 'free') && parsed.shippingGs === input.confirmedShippingGs;
    if (!parseOk) {
      return {
        kind: 'error',
        err: qerr('failed-precondition', 'El texto no confirma ese costo exacto: revisá el borrador y el monto.', 'parse_mismatch', {
          parseReason: parsed.kind === 'none' ? parsed.reason : 'monto_distinto',
        }),
      };
    }

    // HARDEN-1 (G): el total subtotal+envío se valida por la ÚNICA fuente compartida ANTES de
    // preparar nada — un desborde jamás crea intento, pointer ni mensaje (lanza total_invalido
    // y la transacción aborta sin escrituras: ninguna hubo en este camino).
    totalConEnvioSeguro(cart.subtotal, input.confirmedShippingGs);

    // ---- Crear intento: pointer (actor ORIGINAL congelado) + outbox en 'prepared' ----
    const attemptId = newQuoteAttemptId();
    const canonical = formatCanonicalShippingMessage(input.confirmedShippingGs);
    const pointer: ShippingQuotePending = {
      quoteAttemptId: attemptId,
      chargeGs: input.confirmedShippingGs,
      locationFingerprint: req.locationFingerprint ?? '',
      cartFingerprint: fp2,
      quotedByUid: actor.uid,
      quotedByName: actor.name,
      quotedByRole: actor.role,
      createdAt: now,
    };
    const outbox: CoverageOutboxQuoteMessage = {
      id: outboxIdDeQuote(input.requestId, attemptId),
      tenantId,
      coverageRequestId: input.requestId,
      action: 'quote',
      checkoutAttemptId: null,
      customerId: req.customerId,
      channel: req.channel,
      receivedVia: req.receivedVia ?? null,
      activationId: act.activationId,
      text: canonical, // SOLO el canónico — jamás el sellerDraft
      status: 'prepared',
      providerMessageId: null,
      attempts: 0,
      leaseUntil: null,
      quote: {
        quoteAttemptId: attemptId,
        chargeGs: input.confirmedShippingGs,
        quotedByUid: actor.uid,
        quotedByName: actor.name,
        quotedByRole: actor.role,
        expectedLocationFingerprint: req.locationFingerprint ?? '',
        expectedCartFingerprint: fp2,
      },
      reconciled: null,
      stuckNotifiedAt: null, // HARDEN-3: presente-en-null SIEMPRE (la query del sweep exige el campo)
      createdAt: now,
      updatedAt: now,
    };
    tx.create(outboxRef(tenantId, outbox.id), outbox);
    tx.update(reqSnap.ref, { shippingQuotePending: pointer, updatedAt: now });
    return { kind: 'send', attemptId };
  });
}

/**
 * Envío exactly-once conservador. El transporte se resuelve ANTES del claim (toda excepción de
 * resolución deja el outbox en 'prepared', recuperable — jamás un unknown falso pre-claim).
 */
async function enviarQuote(tenantId: string, requestId: string, attemptId: string): Promise<void> {
  const obId = outboxIdDeQuote(requestId, attemptId);
  const obPre = (await outboxRef(tenantId, obId).get()).data() as CoverageOutboxMessage | undefined;
  if (!obPre) throw qerr('internal', 'El intento de cotización no existe.', 'generic');
  if (obPre.status === 'sent' || obPre.status === 'sent_applied') return; // otro worker completó el envío (y quizá la aprobación)

  // HARDEN-1 (D): SOLO WhatsApp con el número EXACTO que recibió la conversación. Canal distinto
  // o receivedVia ausente ⇒ channel_unavailable SIN escrituras (el outbox queda 'prepared',
  // pointer intacto): jamás se degrada al número principal ni se trata un id de
  // Instagram/Messenger como si fuera un teléfono de WhatsApp.
  const receivedVia = (obPre.receivedVia ?? '').trim();
  if (obPre.channel !== 'whatsapp' || receivedVia === '') {
    throw qerr('failed-precondition', 'La cotización solo puede salir por el número de WhatsApp que recibió la conversación del cliente.', 'channel_unavailable');
  }

  // 1) Transporte estricto: mismo receivedVia (garantizado no vacío), credenciales del PROPIO
  //    tenant, live — getWhatsAppClientExact con pnid concreto jamás resuelve el principal.
  const client = await getWhatsAppClientExact(tenantId, receivedVia);
  const info = client.transportInfo;
  const esEmulador = process.env.FUNCTIONS_EMULATOR === 'true';
  const habilitado =
    info.transport === 'live'
      ? info.credentials === 'tenant'
      : esEmulador && info.mode === 'live' && info.tokenPresent; // emulador: mock solo con resolución live-válida
  if (!habilitado) {
    // CERO escrituras: el outbox queda 'prepared' y el pointer intacto (recuperable al arreglar el canal).
    throw qerr('failed-precondition', 'El canal de WhatsApp del negocio no está disponible para cotizar (se necesita el número propio en modo live).', 'channel_unavailable');
  }

  await coverageHold(tenantId, 'outbox_pre_claim'); // solo-emulador: kill-switch en la frontera

  // 2) Claim prepared→sending (transaccional, kill-switch DENTRO del claim).
  const now = Timestamp.now();
  const claim = await db().runTransaction(async (tx) => {
    const act = coverageActivationOf(((await tx.get(configRef(tenantId))).data() as { coverage?: unknown } | undefined)?.coverage);
    const reqSnap = await tx.get(reqRef(tenantId, requestId));
    const req = reqSnap.exists ? (reqSnap.data() as CoverageRequest) : null;
    const obSnap = await tx.get(outboxRef(tenantId, obId));
    const ob = obSnap.exists ? (obSnap.data() as CoverageOutboxMessage) : null;
    if (!ob) return { r: 'missing' as const };
    if (!act.enabled || act.activationId !== (ob.activationId ?? null)) return { r: 'apagado' as const };
    if (ob.status === 'sent' || ob.status === 'sent_applied') return { r: 'ya_enviado' as const }; // aplicado ⇒ TX-C responde idempotente
    if (ob.status === 'unknown') return { r: 'unknown' as const };
    if (ob.status === 'failed' || ob.status === 'sent_not_applied') return { r: 'terminal' as const };
    if (ob.status === 'sending') {
      const lease = ob.leaseUntil?.toMillis?.() ?? 0;
      if (lease > now.toMillis()) return { r: 'in_progress' as const };
      tx.update(obSnap.ref, { status: 'unknown', leaseUntil: null, updatedAt: now });
      return { r: 'unknown' as const };
    }
    // SOLO se claimea el intento VIGENTE de un request vivo (review adversarial 3C): entre TX-A
    // y este claim otro intento pudo reemplazar al pointer, o el request pudo decidirse/vencer.
    // Un 'prepared' que ya no es el vigente JAMÁS se envía — queda terminal auditable acá mismo.
    if (!req || req.tenantId !== tenantId || req.status !== 'pending_coverage_review' || req.shippingQuotePending?.quoteAttemptId !== attemptId) {
      tx.update(obSnap.ref, { status: 'failed', leaseUntil: null, updatedAt: now });
      return { r: 'reemplazado' as const };
    }
    if (req.expiresAt.toMillis() <= now.toMillis()) return { r: 'expirado' as const }; // sin escrituras: TX-A expira con su patrón commit-expire
    // prepared → sending
    tx.update(obSnap.ref, { status: 'sending', leaseUntil: Timestamp.fromMillis(now.toMillis() + QUOTE_LEASE_MS), attempts: (ob.attempts ?? 0) + 1, updatedAt: now });
    return { r: 'go' as const, ob };
  });
  if (claim.r === 'missing') throw qerr('internal', 'El intento de cotización no existe.', 'generic');
  if (claim.r === 'apagado') throw qerr('failed-precondition', MENSAJE_FLUJO_DESHABILITADO, 'flow_off');
  if (claim.r === 'ya_enviado') return;
  if (claim.r === 'unknown') throw qerr('unavailable', 'No pudimos confirmar si el mensaje salió. Revisá el chat de WhatsApp del negocio antes de intentar otra acción.', 'unknown');
  if (claim.r === 'terminal') throw qerr('failed-precondition', 'El intento anterior quedó cerrado: volvé a cotizar.', 'generic');
  if (claim.r === 'reemplazado') throw qerr('failed-precondition', 'El intento fue reemplazado o la solicitud ya no está en revisión: nada se envió.', 'generic');
  if (claim.r === 'expirado') throw qerr('failed-precondition', 'La solicitud venció: el cliente tiene que retomar la compra.', 'expired');
  if (claim.r === 'in_progress') throw qerr('failed-precondition', 'Hay un envío de cotización en curso: esperá un momento.', 'in_progress');
  const ob = claim.ob;

  await coverageHold(tenantId, 'outbox_pre_meta'); // solo-emulador: kill-switch en la frontera

  // 3) Re-chequeo del flag INMEDIATO pre-Meta: apagado ⇒ revert a 'prepared' (recuperable).
  const actPre = coverageActivationOf(((await configRef(tenantId).get()).data() as { coverage?: unknown } | undefined)?.coverage);
  if (!actPre.enabled || actPre.activationId !== (ob.activationId ?? null)) {
    await outboxRef(tenantId, obId).update({ status: 'prepared', leaseUntil: null, updatedAt: Timestamp.now() });
    throw qerr('failed-precondition', MENSAJE_FLUJO_DESHABILITADO, 'flow_off');
  }

  // 4) Envío físico (sendText nunca lanza; una excepción inesperada acá es POST-inicio ⇒ unknown).
  let res: Awaited<ReturnType<typeof client.sendText>>;
  try {
    res = await client.sendText(ob.customerId, ob.text, { tenantId, channel: ob.channel });
  } catch (e) {
    logger.error('Cotización: excepción durante el envío (resultado desconocido)', e, { tenantId, outboxId: obId });
    await outboxRef(tenantId, obId).update({ status: 'unknown', leaseUntil: null, updatedAt: Timestamp.now() }).catch(() => {});
    throw qerr('unavailable', 'No pudimos confirmar si el mensaje salió. Revisá el chat de WhatsApp del negocio antes de intentar otra acción.', 'unknown');
  }

  if (res.ok) {
    await outboxRef(tenantId, obId).update({ status: 'sent', providerMessageId: res.id ?? null, leaseUntil: null, updatedAt: Timestamp.now() });
    // Espejo al historial como MENSAJE DEL VENDEDOR (actor ORIGINAL del intento — jamás el caller).
    try {
      await appendMessage(tenantId, ob.customerId, {
        direction: 'out',
        author: 'seller',
        text: ob.text,
        channel: ob.channel,
        receivedVia: ob.receivedVia,
        senderUid: ob.quote?.quotedByUid ?? undefined,
        senderName: ob.quote?.quotedByName ?? null,
        ...(res.id ? { waMessageId: res.id } : {}),
        ...(res.viaMock ? { viaMock: true } : {}),
      });
    } catch {
      logger.warn('Cotización: envío OK pero el historial no se pudo espejar', { tenantId, outboxId: obId });
    }
    return;
  }
  if (res.outcome === 'rejected') {
    // Rechazo CONFIRMADO: failed + pointer liberado EN UNA transacción (reintento explícito = intento nuevo).
    await db().runTransaction(async (tx) => {
      tx.update(outboxRef(tenantId, obId), { status: 'failed', leaseUntil: null, updatedAt: Timestamp.now() });
      tx.update(reqRef(tenantId, requestId), { shippingQuotePending: null, updatedAt: Timestamp.now() });
    });
    throw qerr('unavailable', 'WhatsApp no aceptó el mensaje de cotización. Revisá el número y volvé a intentar.', 'meta_rejected', { providerCode: res.providerCode });
  }
  await outboxRef(tenantId, obId).update({ status: 'unknown', leaseUntil: null, updatedAt: Timestamp.now() });
  throw qerr('unavailable', 'No pudimos confirmar si el mensaje salió. Revisá el chat de WhatsApp del negocio antes de intentar otra acción.', 'unknown');
}

/**
 * TX-C — Aplicar la aprobación (SOLO tras outbox 'sent'; una transacción nueva). Fallo
 * transitorio ⇒ pointer y outbox intactos (la re-invocación recupera). Mismatch determinístico
 * ⇒ `sent_not_applied` commiteado + error accionable.
 */
async function txAplicarAprobacion(tenantId: string, requestId: string, attemptId: string): Promise<{ shippingGs: number; totalGs: number; customerId: string }> {
  const now = Timestamp.now();
  const obId = outboxIdDeQuote(requestId, attemptId);
  let out: { shippingGs: number; totalGs: number; customerId: string } | { err: HttpsError };
  try {
    out = await db().runTransaction(async (tx) => {
      const cfgSnap = await tx.get(configRef(tenantId));
      const rawCoverage = (cfgSnap.data() as { coverage?: unknown } | undefined)?.coverage;
      const act = coverageActivationOf(rawCoverage);
      // Flow OFF post-envío: CERO escrituras — recuperable si vuelve la MISMA activación.
      if (!act.enabled || !act.activationId) return { err: qerr('failed-precondition', MENSAJE_FLUJO_DESHABILITADO, 'flow_off') };
      const reqSnap = await tx.get(reqRef(tenantId, requestId));
      const req = reqSnap.exists ? (reqSnap.data() as CoverageRequest) : null;
      if (!req || req.tenantId !== tenantId) return { err: qerr('not-found', 'La solicitud de cobertura no existe.', 'not_found') };
      if ((req.activationId ?? null) !== act.activationId) return { err: qerr('failed-precondition', MENSAJE_FLUJO_DESHABILITADO, 'flow_off') };
      const obSnap = await tx.get(outboxRef(tenantId, obId));
      const ob = obSnap.exists ? (obSnap.data() as CoverageOutboxMessage) : null;
      const sesSnap = await tx.get(db().doc(paths.session(tenantId, req.customerId)));
      const ses = sesSnap.data() as Session | undefined;
      const pending = req.shippingQuotePending ?? null;

      // Idempotencia: TX-C ya commiteó para ESTE intento. HARDEN-2 (C): el total SIEMPRE pasa por
      // la única fuente compartida — un estado corrupto lanza total_invalido (sin escrituras),
      // jamás se devuelve un entero inseguro.
      if (req.status === 'coverage_approved' && req.shippingQuote?.sourceOutboxId === obId) {
        return { shippingGs: req.shippingQuote.chargeGs, totalGs: totalConEnvioSeguro(req.cartSnapshot?.subtotal ?? 0, req.shippingQuote.chargeGs), customerId: req.customerId };
      }
      if (!ob || ob.status !== 'sent') return { err: qerr('failed-precondition', 'El mensaje de cotización no está confirmado como enviado.', 'generic') };
      if (!pending || pending.quoteAttemptId !== attemptId) return { err: qerr('failed-precondition', 'El intento de cotización ya no está vigente.', 'generic') };
      // HARDEN-1 (E): TODA transición determinística a sent_not_applied avisa al equipo con una
      // campana idempotente EN ESTA MISMA transacción (el cliente pudo recibir un costo que no
      // se aplicó). Un flow_off transitorio (arriba) NO notifica: es recuperable y el intento
      // sigue sent+pendiente.
      const campana = (motivo: string) => campanaSentNotApplied(tx, tenantId, requestId, attemptId, req.customerId, motivo, req.sellerUid ?? null, now);
      const policy = shippingQuotePolicyOf(rawCoverage);
      if (policy.status !== 'required') {
        // Config cambió post-envío (determinístico): terminal auditable, sin aprobar.
        await campana(policy.status === 'invalid' ? 'la configuración de cotización quedó inválida' : 'la cotización obligatoria se deshabilitó');
        tx.update(obSnap.ref, { status: 'sent_not_applied', leaseUntil: null, updatedAt: now });
        tx.update(reqSnap.ref, { shippingQuotePending: null, updatedAt: now });
        return { err: qerr('failed-precondition', policy.status === 'invalid' ? MENSAJE_QUOTE_CONFIG_INVALIDA : 'La cotización obligatoria se deshabilitó: el costo enviado no se aplicó.', policy.status === 'invalid' ? 'config_invalida' : 'quote_not_required') };
      }
      if (pending.chargeGs > policy.maxChargeGs) {
        // Tope bajado post-envío (review adversarial 3C): mismo tratamiento que cualquier cambio
        // de config a mitad de saga — terminal auditable, jamás se aprueba por encima del límite vigente.
        await campana('el tope de envío del negocio bajó después del envío');
        tx.update(obSnap.ref, { status: 'sent_not_applied', leaseUntil: null, updatedAt: now });
        tx.update(reqSnap.ref, { shippingQuotePending: null, updatedAt: now });
        return { err: qerr('failed-precondition', 'El tope de envío bajó después del envío: el costo enviado no se aplicó. Recotizá dentro del límite vigente.', 'config_cap') };
      }
      if (req.status !== 'pending_coverage_review') {
        await campana('la solicitud ya había sido decidida por otra vía');
        tx.update(obSnap.ref, { status: 'sent_not_applied', leaseUntil: null, updatedAt: now });
        tx.update(reqSnap.ref, { shippingQuotePending: null, updatedAt: now });
        const por = req.decision?.byName ? ` por ${req.decision.byName}` : '';
        return { err: qerr('failed-precondition', `La solicitud ya fue decidida${por}: el costo enviado no se aplicó.`, 'already_decided') };
      }
      if (req.expiresAt.toMillis() <= now.toMillis()) {
        // Vencido post-envío (review adversarial 3C): NINGUNA puerta —ni la reconciliación manual
        // de un unknown— aprueba dinero sobre un request muerto. Terminal + expiración commiteadas.
        await campana('la solicitud venció antes de aplicar el costo');
        tx.update(obSnap.ref, { status: 'sent_not_applied', leaseUntil: null, updatedAt: now });
        tx.update(reqSnap.ref, { status: 'coverage_expired', shippingQuotePending: null, updatedAt: now, coordinatesPurgeAt: purgeAtFrom(now, req) });
        tx.set(db().doc(paths.session(tenantId, req.customerId)), { context: { coverage: null }, updatedAt: now }, { merge: true });
        return { err: qerr('failed-precondition', 'La solicitud venció: el costo enviado no se aplicó. El cliente tiene que retomar la compra.', 'expired') };
      }
      const locOk = (req.locationFingerprint ?? '') === pending.locationFingerprint;
      const cart = ses?.cart ?? { items: [], subtotal: 0 };
      const fp2 = shippingCartFingerprintOf(cart);
      const cartOk = fp2 !== null && fp2 === pending.cartFingerprint;
      if (!locOk || !cartOk) {
        await campana(locOk ? 'el carrito cambió después del envío' : 'la ubicación cambió después del envío');
        tx.update(obSnap.ref, { status: 'sent_not_applied', leaseUntil: null, updatedAt: now });
        tx.update(reqSnap.ref, { shippingQuotePending: null, updatedAt: now });
        return { err: qerr('failed-precondition', locOk ? 'El carrito cambió después del envío: el costo enviado no se aplicó. Recotizá.' : 'El cliente cambió su ubicación después del envío: el costo enviado no se aplicó.', locOk ? 'cart_changed_post_send' : 'location_changed') };
      }
      // HARDEN-1 (G): revalidación del total por la ÚNICA fuente compartida — un desborde
      // post-envío es un mismatch determinístico más: terminal auditable + campana, jamás un
      // job/orden/banco con dinero inválido.
      let totalAprobado: number;
      try {
        totalAprobado = totalConEnvioSeguro(cart.subtotal, pending.chargeGs);
      } catch (eTotal) {
        await campana('el total con envío quedó fuera del rango seguro');
        tx.update(obSnap.ref, { status: 'sent_not_applied', leaseUntil: null, updatedAt: now });
        tx.update(reqSnap.ref, { shippingQuotePending: null, updatedAt: now });
        return { err: eTotal instanceof HttpsError ? eTotal : qerr('failed-precondition', 'El total con envío no es un monto válido.', 'total_invalido') };
      }

      // ---- APROBACIÓN (actor ORIGINAL del intento; jamás el caller de la recuperación) ----
      const decision = {
        action: 'approved' as const,
        byUid: pending.quotedByUid,
        byName: pending.quotedByName,
        byRole: pending.quotedByRole,
        at: now,
        note: null,
        locationFingerprint: req.locationFingerprint ?? null,
      };
      const shippingQuote = {
        chargeGs: pending.chargeGs,
        currency: 'PYG' as const,
        source: 'seller_chat' as const,
        sourceOutboxId: obId,
        providerMessageId: ob.providerMessageId ?? null,
        locationFingerprint: pending.locationFingerprint,
        cartFingerprint: pending.cartFingerprint,
        quotedByUid: pending.quotedByUid,
        quotedByName: pending.quotedByName,
        quotedByRole: pending.quotedByRole,
        quotedAt: now,
        parserVersion: PARSER_VERSION,
      };
      const snapshotCongelado = cartSnapshotOf(cart); // carrito VERIFICADO (fp2 === pending.cartFingerprint)
      tx.update(reqSnap.ref, {
        status: 'coverage_approved',
        decision,
        shippingQuote,
        shippingQuotePending: null,
        cartSnapshot: snapshotCongelado,
        cartFingerprint: pending.cartFingerprint,
        resume: { status: 'pending', orderId: null },
        updatedAt: now,
      });
      const job: CoverageResumeJob = {
        id: requestId,
        tenantId,
        coverageRequestId: requestId,
        customerId: req.customerId,
        action: 'approved',
        status: 'pending',
        channel: req.channel,
        receivedVia: req.receivedVia ?? null,
        activationId: act.activationId,
        shippingGs: pending.chargeGs,
        cartSnapshot: snapshotCongelado,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(jobRef(tenantId, requestId), job); // EXACTAMENTE un job (doc-id determinístico)
      const ptr: CoverageSessionPointer = {
        requestId,
        status: 'coverage_approved',
        locationFingerprint: req.locationFingerprint ?? null,
        createdAt: req.createdAt,
        updatedAt: now,
      };
      // HARDEN-2 (review): terminal FELIZ del outbox EN el mismo commit — sin esto, los quotes
      // aplicados quedaban 'sent' para siempre y saturaban los slots del sweep (inanición).
      tx.update(obSnap.ref, { status: 'sent_applied', leaseUntil: null, updatedAt: now });
      tx.set(db().doc(paths.session(tenantId, req.customerId)), { context: { coverage: ptr }, updatedAt: now }, { merge: true });
      return { shippingGs: pending.chargeGs, totalGs: totalAprobado, customerId: req.customerId };
    });
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    // Fallo TRANSITORIO: pointer y outbox 'sent' quedan INTACTOS — la re-invocación recupera
    // por TX-A (goto_txc) SIN volver a Meta.
    logger.error('Cotización: fallo transitorio en TX-C (recuperable sin reenvío)', e, { tenantId, requestId });
    throw qerr('internal', 'No se pudo aplicar la aprobación. Reintentá: el mensaje NO se reenvía.', 'retry_tx');
  }
  if ('err' in out) throw out.err;
  return out;
}

/**
 * SHIPPING-CHAT-3C — Callable autoritativa: cotizar + enviar canónico + aprobar tras el ACK de Meta.
 */
export const coverageQuoteAndApprove = onCall<CoverageQuoteAndApproveInput>({ region: REGION }, async (req) => {
  const tenantId = resolveTenant(req.auth as Parameters<typeof resolveTenant>[0], req.data?.tenantId);
  const actor = assertCoverageActor(req.auth as Parameters<typeof assertCoverageActor>[0], tenantId) as QuoteActor;
  const input = validarQuoteInput(req.data);

  const a = await txPrepararIntento(tenantId, actor, input);
  if (a.kind === 'error') throw a.err;
  if (a.kind === 'ok_idempotente') {
    return { ok: true, status: 'coverage_approved', shippingGs: a.shippingGs, totalGs: a.totalGs };
  }
  if (a.kind === 'send') await enviarQuote(tenantId, input.requestId, a.attemptId);
  const r = await txAplicarAprobacion(tenantId, input.requestId, a.attemptId);
  await recordAudit({
    tenantId,
    action: 'coverage.quote_approved',
    actorUid: actor.uid,
    actorRole: actor.role,
    targetType: 'coverageRequest',
    targetId: input.requestId,
    summary: `Cotización de envío enviada y cobertura aprobada para el cliente ${maskPhone(r.customerId)}`,
    metadata: { chargeGs: r.shippingGs, quoteAttemptId: a.attemptId },
  }).catch(() => {});
  logger.info('Cotización aplicada', { tenantId, requestId: input.requestId, quoteAttemptId: a.attemptId, rol: actor.role });
  return { ok: true, status: 'coverage_approved', shippingGs: r.shippingGs, totalGs: r.totalGs };
});

/**
 * SHIPPING-CHAT-3C — Resolución MANUAL de un envío `unknown` (acción humana explícita y auditada;
 * jamás automática, jamás IA, jamás jobs periódicos; nunca envía mensajes).
 *  - 'delivered': el humano VERIFICÓ en la app de WhatsApp Business del número del negocio que el
 *    mensaje llegó ⇒ outbox 'sent' reconciliado (providerMessageId queda null — jamás se finge un
 *    wamid) y la MISMA invocación continúa por TX-C revalidando todo.
 *  - 'not_delivered': verificó que NO llegó ⇒ outbox 'failed' reconciliado + pointer liberado
 *    (recotizar habilitado como intento nuevo). No aprueba nada.
 */
export const coverageQuoteResolveUnknown = onCall<{
  tenantId?: string;
  requestId?: string;
  quoteAttemptId?: string;
  resolution?: string;
  note?: string;
}>({ region: REGION }, async (req) => {
  const tenantId = resolveTenant(req.auth as Parameters<typeof resolveTenant>[0], req.data?.tenantId);
  const actor = assertCoverageActor(req.auth as Parameters<typeof assertCoverageActor>[0], tenantId) as QuoteActor;
  // Autorización equivalente a la decisión financiera: SOLO OWNER/MANAGER (el SELLER cotiza,
  // pero la reconciliación de un envío dudoso es del encargado).
  if (actor.role === 'SELLER') throw qerr('permission-denied', 'La resolución de un envío sin confirmar la hace un encargado del negocio.', 'not_allowed');
  const requestId = typeof req.data?.requestId === 'string' ? req.data.requestId.trim() : '';
  if (!/^covr_[0-9A-Za-z]{12}$/.test(requestId)) throw qerr('invalid-argument', 'Solicitud de cobertura inválida.', 'invalid_input');
  const attemptId = typeof req.data?.quoteAttemptId === 'string' ? req.data.quoteAttemptId.trim() : '';
  if (!/^qat_[0-9A-Za-z]{12}$/.test(attemptId)) throw qerr('invalid-argument', 'Intento de cotización inválido.', 'invalid_input');
  const resolution = req.data?.resolution;
  if (resolution !== 'delivered' && resolution !== 'not_delivered') throw qerr('invalid-argument', 'Resolución inválida.', 'invalid_input');
  const note = typeof req.data?.note === 'string' ? req.data.note.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) : '';
  if (note === '') throw qerr('invalid-argument', 'La confirmación humana (nota) es obligatoria.', 'invalid_input');

  const obId = outboxIdDeQuote(requestId, attemptId);
  const now = Timestamp.now();
  const customerId = await db().runTransaction(async (tx) => {
    const cfgSnap = await tx.get(configRef(tenantId));
    const act = coverageActivationOf((cfgSnap.data() as { coverage?: unknown } | undefined)?.coverage);
    if (!act.enabled || !act.activationId) throw qerr('failed-precondition', MENSAJE_FLUJO_DESHABILITADO, 'flow_off');
    const reqSnap = await tx.get(reqRef(tenantId, requestId));
    const cov = reqSnap.exists ? (reqSnap.data() as CoverageRequest) : null;
    if (!cov || cov.tenantId !== tenantId) throw qerr('not-found', 'La solicitud de cobertura no existe.', 'not_found');
    assertFlujoVigente(act, cov);
    const pending = cov.shippingQuotePending ?? null;
    if (!pending || pending.quoteAttemptId !== attemptId) throw qerr('failed-precondition', 'Ese intento de cotización no está pendiente de resolución.', 'generic');
    const obSnap = await tx.get(outboxRef(tenantId, obId));
    const ob = obSnap.exists ? (obSnap.data() as CoverageOutboxMessage) : null;
    if (!ob || ob.status !== 'unknown') throw qerr('failed-precondition', 'El envío no está en estado sin-confirmar.', 'generic');
    const reconciled = { byUid: actor.uid, byName: actor.name, byRole: actor.role, at: now, note, resolution };
    if (resolution === 'delivered') {
      // providerMessageId QUEDA null: jamás se finge un wamid. quotedBy NO se toca.
      tx.update(obSnap.ref, { status: 'sent', reconciled, leaseUntil: null, updatedAt: now });
    } else {
      tx.update(obSnap.ref, { status: 'failed', reconciled, leaseUntil: null, updatedAt: now });
      tx.update(reqSnap.ref, { shippingQuotePending: null, updatedAt: now });
    }
    return cov.customerId;
  });

  await recordAudit({
    tenantId,
    action: 'coverage.quote_unknown_resolved',
    actorUid: actor.uid,
    actorRole: actor.role,
    targetType: 'coverageRequest',
    targetId: requestId,
    summary: `Envío de cotización reconciliado (${resolution}) para el cliente ${maskPhone(customerId)}`,
    metadata: { resolution, quoteAttemptId: attemptId },
  }).catch(() => {});

  if (resolution === 'not_delivered') return { ok: true, resolved: 'not_delivered' };

  // Evento de sistema en el historial (auditable, sin fingir un mensaje de WhatsApp).
  try {
    await appendMessage(tenantId, customerId, {
      direction: 'out',
      author: 'system',
      text: 'Cotización de envío verificada como entregada por el equipo (reconciliación manual).',
    });
  } catch {
    logger.warn('Cotización: no se pudo registrar el evento de reconciliación en el historial', { tenantId, requestId });
  }
  // La MISMA invocación continúa por TX-C (revalida TODO; sin reenvío).
  const r = await txAplicarAprobacion(tenantId, requestId, attemptId);
  return { ok: true, resolved: 'delivered', status: 'coverage_approved', shippingGs: r.shippingGs, totalGs: r.totalGs };
});

/**
 * SHIPPING-CHAT-3C-HARDEN-1 (B) + HARDEN-2 (A) — Estado READ-ONLY del intento de cotización.
 * El outbox sigue siendo la ÚNICA fuente de verdad: la fase se DERIVA con faseDeIntentoQuote y
 * jamás se persiste (cero duplicación de estado, CERO mutaciones — un lease vencido se reporta
 * 'unknown' pero la transición real la hace la saga en su próxima transacción).
 *
 * HARDEN-2: request + pointer + outbox se leen en UNA transacción READ-ONLY — la respuesta
 * corresponde SIEMPRE a una única versión coherente (jamás el attemptId de un intento mezclado
 * con la fase de su reemplazo), la autorización del SELLER usa el MISMO snapshot del request, y
 * el artefacto se revalida (action 'quote', mismo tenant/request/quoteAttemptId).
 *
 * Pointer huérfano o artefacto que no coincide: `attempt:null` significa ÚNICAMENTE "no existe
 * shippingQuotePending" — una inconsistencia real se reporta FAIL-CLOSED como `phase:'failed'`
 * con el attemptId/chargeGs del pointer (accionable para 3D: "reintentá/revisá la cotización");
 * el pointer NO se limpia desde acá (lo hace la saga en su próxima transacción).
 *
 * Autorización: tenant SIEMPRE de los claims; OWNER/MANAGER consultan cualquier request de su
 * tenant; SELLER solo el asignado; PLATFORM_ADMIN queda AFUERA (assertCoverageActor) — la
 * recuperación operativa de dinero es del negocio, no del soporte de plataforma.
 *
 * Respuesta SANEADA (contrato para el panel 3D): `{ ok, attempt: null }` o
 * `{ ok, attempt: { quoteAttemptId, chargeGs, phase } }` — JAMÁS customerId, teléfono,
 * dirección, coordenadas, texto del outbox, sellerDraft, receivedVia, PNID, wamid ni datos del
 * proveedor.
 */
export const coverageQuoteAttemptState = onCall<{ tenantId?: string; requestId?: string }>({ region: REGION }, async (req) => {
  const tenantId = resolveTenant(req.auth as Parameters<typeof resolveTenant>[0], req.data?.tenantId);
  const actor = assertCoverageActor(req.auth as Parameters<typeof assertCoverageActor>[0], tenantId) as QuoteActor;
  const requestId = typeof req.data?.requestId === 'string' ? req.data.requestId.trim() : '';
  if (!/^covr_[0-9A-Za-z]{12}$/.test(requestId)) throw qerr('invalid-argument', 'Solicitud de cobertura inválida.', 'invalid_input');

  type Estado =
    | { kind: 'not_found' }
    | { kind: 'not_assigned' }
    | { kind: 'sin_intento' }
    | { kind: 'inconsistente'; pending: ShippingQuotePending }
    | { kind: 'ok'; pending: ShippingQuotePending; status: CoverageOutboxMessage['status']; leaseUntilMs: number | null };
  // Transacción READ-ONLY real ({readOnly:true}): mismo snapshot único consistente, SIN locks —
  // el panel pollea este endpoint sobre el doc más caliente de la saga y una tx read-write
  // generaría contención evitable contra TX-A/TX-C (review HARDEN-2).
  const out = await db().runTransaction(
    async (tx): Promise<Estado> => {
      const cov = (await tx.get(reqRef(tenantId, requestId))).data() as CoverageRequest | undefined;
      if (!cov || cov.tenantId !== tenantId) return { kind: 'not_found' };
      // Autorización con el MISMO snapshot: una desasignación concurrente jamás deja pasar al
      // seller sobre una versión más nueva del request.
      if (actor.role === 'SELLER' && cov.sellerUid !== actor.uid) return { kind: 'not_assigned' };
      const pending = cov.shippingQuotePending ?? null;
      if (!pending) return { kind: 'sin_intento' };
      const ob = (await tx.get(outboxRef(tenantId, outboxIdDeQuote(requestId, pending.quoteAttemptId)))).data() as CoverageOutboxMessage | undefined;
      // Revalidación del artefacto (fail-closed): debe ser el outbox QUOTE de ESTE intento de
      // ESTE request/tenant — cualquier otra cosa (incluida corrupción parcial sin el mapa
      // `quote`) es una invariante rota, jamás un "sin intento" ni un crash.
      const coherente =
        !!ob && ob.action === 'quote' && ob.tenantId === tenantId && ob.coverageRequestId === requestId && ob.quote?.quoteAttemptId === pending.quoteAttemptId;
      if (!coherente) return { kind: 'inconsistente', pending };
      return { kind: 'ok', pending, status: ob.status, leaseUntilMs: ob.leaseUntil?.toMillis?.() ?? null };
    },
    { readOnly: true },
  );

  if (out.kind === 'not_found') throw qerr('not-found', 'La solicitud de cobertura no existe.', 'not_found');
  if (out.kind === 'not_assigned') throw qerr('permission-denied', 'Esta revisión está asignada a otra persona del equipo.', 'not_assigned');
  if (out.kind === 'sin_intento') return { ok: true, attempt: null };
  if (out.kind === 'inconsistente') {
    // Invariante rota (outbox ausente o ajeno al pointer): el panel debe poder explicar que la
    // cotización necesita reintentarse/revisarse — jamás esconderla como "sin intento".
    return { ok: true, attempt: { quoteAttemptId: out.pending.quoteAttemptId, chargeGs: out.pending.chargeGs, phase: 'failed' as ShippingQuoteAttemptPhase } };
  }
  const phase = faseDeIntentoQuote(out.status, out.leaseUntilMs, Timestamp.now().toMillis());
  return { ok: true, attempt: { quoteAttemptId: out.pending.quoteAttemptId, chargeGs: out.pending.chargeGs, phase } };
});
