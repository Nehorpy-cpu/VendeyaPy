/**
 * COVERAGE-1C — Revisión humana de cobertura desde el panel.
 * ==========================================================
 * `coverageApprove` / `coverageReject` / `coverageRequestInfo`: decisión EXCLUSIVAMENTE humana
 * sobre un `coverageRequest` en `pending_coverage_review`.
 *
 * Autorización (server-side, jamás del frontend):
 *  - TENANT_OWNER / TENANT_MANAGER: cualquier request de SU tenant (claims).
 *  - SELLER: solo requests con `sellerUid == uid`.
 *  - PLATFORM_ADMIN: NO decide cobertura (soporte = solo lectura por rules).
 *
 * Garantías transaccionales:
 *  - Doble clic / approve+reject concurrentes → un solo ganador; el segundo failed-precondition.
 *  - `expectedFingerprint` obligatorio: si el cliente actualizó la ubicación en el medio, la
 *    decisión NO aplica sobre la versión vieja (failed-precondition `location_changed`).
 *  - La decisión persiste actor/rol/timestamp + el fingerprint EXACTO leído en la transacción.
 *  - Aprobar/rechazar crea EXACTAMENTE UNA VEZ el outbox `coverageResumeJobs/{requestId}`
 *    (doc-id determinístico; 1D lo consume). Acá NO se libera el chat, NO se crea orden,
 *    NO se muestran datos bancarios y NO se envían mensajes (salvo requestInfo, manual).
 *  - Auditoría SIN ubicación ni nota (solo ids/actor).
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { CoverageRequest, CoverageResumeJob, CoverageSessionPointer, CoverageFlowState, ShippingQuotePolicy } from '@vpw/shared';
import { coverageActivationOf, shippingQuotePolicyOf, type CoverageActivation } from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../audit/audit.js';
import { purgeAtFrom } from '../../conversation/coverage.js';
import { sendManualMessage } from '../../conversation/manualMessage.js';
import type { AuthLike } from '../conversation/staffAuth.js';

const REGION = 'us-central1';
const NOTE_MAX = 300;
const INFO_DEDUPE_MS = 60_000; // doble clic / repetición inmediata de "más información"

/** Texto determinístico del pedido de más información (sin IA, definido por el programa). */
export const MENSAJE_MAS_INFORMACION =
  'Necesitamos un poco más de detalle de tu ubicación: ciudad, barrio, calle y una referencia.';

interface CoverageActor {
  uid: string;
  role: 'TENANT_OWNER' | 'TENANT_MANAGER' | 'SELLER';
  name: string;
}

/**
 * Roles que DECIDEN cobertura. PLATFORM_ADMIN queda afuera a propósito: soporte lee por rules,
 * pero la decisión comercial es del tenant (owner/manager, o el seller ASIGNADO al request).
 */
export function assertCoverageActor(auth: AuthLike | undefined | null, tenantId: string): CoverageActor {
  if (!auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const token = auth.token ?? {};
  const role = token.role ?? '';
  if (role === 'PLATFORM_ADMIN') {
    throw new HttpsError('permission-denied', 'El soporte de plataforma no decide cobertura: lo hace el equipo del negocio.');
  }
  if (role !== 'TENANT_OWNER' && role !== 'TENANT_MANAGER' && role !== 'SELLER') {
    throw new HttpsError('permission-denied', 'Tu rol no puede revisar cobertura.');
  }
  if (token.tenantId !== tenantId) {
    throw new HttpsError('permission-denied', 'No tenés acceso a esta empresa.');
  }
  return { uid: auth.uid, role, name: token.name || token.email || 'Staff' };
}

/** El tenant SIEMPRE sale de los claims; el del frontend solo puede coincidir. */
export function resolveTenant(auth: AuthLike | undefined | null, requested?: string): string {
  const claimed = auth?.token?.tenantId;
  if (typeof claimed !== 'string' || claimed === '') throw new HttpsError('permission-denied', 'Tu usuario no pertenece a una empresa.');
  if (requested !== undefined && requested !== claimed) throw new HttpsError('permission-denied', 'No tenés acceso a esa empresa.');
  return claimed;
}

interface DecisionInput {
  tenantId?: string;
  requestId?: string;
  /** Huella mostrada al revisor: si el cliente actualizó la ubicación, la decisión no aplica. */
  expectedFingerprint?: string;
  note?: string;
}

export function validarInput(data: DecisionInput | undefined): { requestId: string; expectedFingerprint: string; note: string | null } {
  const requestId = typeof data?.requestId === 'string' ? data.requestId.trim() : '';
  if (!/^covr_[0-9A-Za-z]{12}$/.test(requestId)) throw new HttpsError('invalid-argument', 'Solicitud de cobertura inválida.');
  const expectedFingerprint = typeof data?.expectedFingerprint === 'string' ? data.expectedFingerprint.trim() : '';
  if (expectedFingerprint === '' || expectedFingerprint.length > 64) throw new HttpsError('invalid-argument', 'Falta la huella de la ubicación revisada.');
  let note: string | null = null;
  if (data?.note !== undefined) {
    if (typeof data.note !== 'string') throw new HttpsError('invalid-argument', 'Nota inválida.');
    note = data.note.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) || null;
  }
  return { requestId, expectedFingerprint, note };
}

const requestRef = (tenantId: string, requestId: string) => db().doc(`tenants/${tenantId}/coverageRequests/${requestId}`);
const jobRef = (tenantId: string, requestId: string) => db().doc(`tenants/${tenantId}/coverageResumeJobs/${requestId}`);
const configRef = (tenantId: string) => db().doc(`tenants/${tenantId}/config/checkout`);

/**
 * SHIPPING-CHAT-3C — Id determinístico del outbox de cotización (`{requestId}_quote_{qat}`; jamás
 * colisiona con los legacy `{requestId}_{action}[_{atm}]`). Vive ACÁ (y coverageQuote lo
 * re-exporta) porque la decisión humana también necesita leer el outbox del intento — la saga ya
 * importa de este módulo y la dirección inversa crearía un ciclo.
 */
export const outboxIdDeQuote = (requestId: string, quoteAttemptId: string) => `${requestId}_quote_${quoteAttemptId}`;

export const MENSAJE_FLUJO_DESHABILITADO =
  'El flujo de cobertura está deshabilitado: no se pueden tomar acciones sobre esta solicitud.';
export const MENSAJE_ACTIVACION_ANTERIOR =
  'Esta solicitud pertenece a una activación anterior del flujo de cobertura: queda en solo lectura.';

/**
 * HARDEN-1 — Gate server-side del flag DENTRO de la transacción (misma lectura atómica que la
 * decisión: sin ventana flag→mutación). Lanza failed-precondition ANTES de cualquier escritura
 * si el flujo está apagado o el request pertenece a otra activación. El estado visual del panel
 * NO es autoridad: este gate corre siempre.
 */
export function assertFlujoVigente(act: CoverageActivation, req: Pick<CoverageRequest, 'activationId'>): void {
  if (!act.enabled || !act.activationId) throw new HttpsError('failed-precondition', MENSAJE_FLUJO_DESHABILITADO);
  if ((req.activationId ?? null) !== act.activationId) throw new HttpsError('failed-precondition', MENSAJE_ACTIVACION_ANTERIOR);
}

export const MENSAJE_QUOTE_REQUERIDO =
  'Esta aprobación requiere informar el costo de envío desde el chat (cotización obligatoria).';
export const MENSAJE_QUOTE_CONFIG_INVALIDA =
  'La configuración de cotización de envío del negocio no es válida: avisá al administrador antes de aprobar.';

/**
 * SHIPPING-CHAT-3B — Gate del APPROVE VIEJO según la política de cotización (fail-closed).
 * Se evalúa sobre el MISMO snapshot de config que el flag (dentro de la transacción — sin
 * TOCTOU ni doble fuente). PURO → testeable:
 *  - off      ⇒ comportamiento actual (approve permitido).
 *  - required ⇒ el approve viejo se RECHAZA SIEMPRE (aunque exista un quote preexistente:
 *               la única vía de aprobación será coverageQuoteAndApprove, 3C).
 *  - invalid  ⇒ rechazo fail-closed (lockout hasta corregir la config; jamás degrada a off).
 * `coverageReject` NO pasa por acá (rechazar sigue permitido).
 */
export function assertShippingPolicyPermitsApprove(policy: ShippingQuotePolicy): void {
  if (policy.status === 'required') {
    throw new HttpsError('failed-precondition', MENSAJE_QUOTE_REQUERIDO, { kind: 'shipping_quote_required' });
  }
  if (policy.status === 'invalid') {
    throw new HttpsError('failed-precondition', MENSAJE_QUOTE_CONFIG_INVALIDA, { kind: 'shipping_quote_config_invalid' });
  }
}

/**
 * Núcleo transaccional de la decisión. Devuelve el request YA decidido.
 * Todos los caminos de error usan mensajes seguros (jamás filtran datos de otro tenant:
 * el path está fijado al tenant del actor — un id ajeno simplemente "no existe").
 */
async function decidirCobertura(
  tenantId: string,
  actor: CoverageActor,
  input: { requestId: string; expectedFingerprint: string; note: string | null },
  action: 'approved' | 'rejected',
): Promise<CoverageRequest> {
  const now = Timestamp.now();
  const resultado = await db().runTransaction(async (tx) => {
    // HARDEN-1: el flag se lee EN LA MISMA transacción que decide (sin ventana TOCTOU
    // flag→mutación) y se valida ANTES de cualquier escritura: apagado ⇒ failed-precondition.
    const cfgSnap = await tx.get(configRef(tenantId));
    const act = coverageActivationOf((cfgSnap.data() as { coverage?: unknown } | undefined)?.coverage);
    if (!act.enabled) throw new HttpsError('failed-precondition', MENSAJE_FLUJO_DESHABILITADO);
    const snap = await tx.get(requestRef(tenantId, input.requestId));
    const req = snap.exists ? (snap.data() as CoverageRequest) : null;
    if (!req || req.tenantId !== tenantId) throw new HttpsError('not-found', 'La solicitud de cobertura no existe.');
    if (actor.role === 'SELLER' && req.sellerUid !== actor.uid) {
      throw new HttpsError('permission-denied', 'Esta revisión está asignada a otra persona del equipo.');
    }
    // SHIPPING-CHAT-3C-HARDEN-1 (C/review): el outbox del intento de cotización se lee ACÁ
    // (todas las lecturas antes de cualquier escritura de la tx) para el gate de más abajo.
    const pendingQuote = req.shippingQuotePending ?? null;
    const obQuoteSnap = pendingQuote
      ? await tx.get(db().doc(`tenants/${tenantId}/coverageMessageOutbox/${outboxIdDeQuote(input.requestId, pendingQuote.quoteAttemptId)}`))
      : null;
    const obQuoteStatus = obQuoteSnap?.exists ? ((obQuoteSnap.data() as { status?: string }).status ?? null) : null;
    if (req.status !== 'pending_coverage_review') {
      const por = req.decision?.byName ? ` por ${req.decision.byName}` : '';
      throw new HttpsError('failed-precondition', req.decision ? `Esta solicitud ya fue decidida${por}.` : 'Esta solicitud no está pendiente de revisión.');
    }
    assertFlujoVigente(act, req); // request de una activación anterior ⇒ solo lectura (sin mutación)
    if (req.expiresAt.toMillis() <= now.toMillis()) {
      // OJO: lanzar acá ABORTARÍA la transacción y la marca de expirado se perdería (review).
      // La transición se commitea y el error al usuario sale DESPUÉS, fuera de la transacción.
      tx.update(snap.ref, { status: 'coverage_expired', updatedAt: now, coordinatesPurgeAt: purgeAtFrom(now, req) });
      tx.set(db().doc(paths.session(tenantId, req.customerId)), { context: { coverage: null }, updatedAt: now }, { merge: true });
      return { kind: 'expirado' as const };
    }
    // SHIPPING-CHAT-3C-HARDEN-1 (C + review): con un intento de cotización EN CURSO, la decisión
    // vieja no procede — decidir por conveniencia escondería un mensaje financiero que pudo salir
    // al cliente. Reglas:
    //  - REJECT: bloqueado con CUALQUIER pointer vivo (el intento se resuelve por la saga —
    //    reemplazo, reconciliación manual o cierre — y recién entonces se puede rechazar).
    //  - APPROVE viejo: la política required/invalid ya lo bloquea; con política OFF solo se
    //    bloquea si el intento está en fase IRREVERSIBLE (sent/sending/unknown — el cliente pudo
    //    recibir un costo): un 'prepared' que jamás salió no impide aprobar (y el retry de la
    //    saga lo cierra terminal sobre el request decidido).
    // Sin escrituras: nada se limpia ni se cancela automáticamente.
    if (pendingQuote) {
      const irreversible = obQuoteStatus === 'sent' || obQuoteStatus === 'sending' || obQuoteStatus === 'unknown';
      if (action === 'rejected' || irreversible) {
        throw new HttpsError('failed-precondition', 'Hay una cotización de envío en curso para esta solicitud: resolvela antes de decidir.', { kind: 'quote_en_curso' });
      }
    }
    if ((req.locationFingerprint ?? '') !== input.expectedFingerprint) {
      // El cliente actualizó su ubicación mientras se revisaba: NUNCA decidir sobre la vieja.
      throw new HttpsError('failed-precondition', 'El cliente actualizó su ubicación: revisá la versión más reciente antes de decidir.');
    }
    // SHIPPING-CHAT-3B: con política required/invalid, el approve VIEJO se rechaza fail-closed
    // (mismo cfgSnap que el flag — un solo snapshot, sin TOCTOU). Va DESPUÉS del bloque de
    // expiración (review 3B): un request vencido debe commitear su transición a expirado aunque
    // la política bloquee el approve. Rechazar sigue permitido.
    if (action === 'approved') assertShippingPolicyPermitsApprove(shippingQuotePolicyOf((cfgSnap.data() as { coverage?: unknown } | undefined)?.coverage));
    const decision = {
      action,
      byUid: actor.uid,
      byName: actor.name,
      byRole: actor.role,
      at: now,
      note: action === 'rejected' ? input.note : null,
      locationFingerprint: req.locationFingerprint ?? null,
    };
    tx.update(snap.ref, {
      status: action === 'approved' ? 'coverage_approved' : 'coverage_rejected',
      decision,
      resume: { status: 'pending', orderId: null },
      updatedAt: now,
    });
    // Outbox 1D — doc-id determinístico = requestId: imposible encolar dos veces (además la
    // transición de estado de arriba ya es única por transacción).
    const job: CoverageResumeJob = {
      id: input.requestId,
      tenantId,
      coverageRequestId: input.requestId,
      customerId: req.customerId,
      action,
      status: 'pending',
      channel: req.channel,
      receivedVia: req.receivedVia ?? null,
      activationId: act.activationId,
      createdAt: now,
      updatedAt: now,
    };
    tx.create(jobRef(tenantId, input.requestId), job);
    // Puntero de la sesión: estado nuevo (el gate y el panel lo leen coherentes).
    const ptr: CoverageSessionPointer = {
      requestId: req.id,
      status: action === 'approved' ? 'coverage_approved' : 'coverage_rejected',
      locationFingerprint: req.locationFingerprint ?? null,
      createdAt: req.createdAt,
      updatedAt: now,
    };
    tx.set(db().doc(paths.session(tenantId, req.customerId)), { context: { coverage: ptr }, updatedAt: now }, { merge: true });
    return { kind: 'decidido' as const, req: { ...req, status: ptr.status, decision } as CoverageRequest };
  });
  if (resultado.kind === 'expirado') {
    throw new HttpsError('failed-precondition', 'La solicitud venció: el cliente tiene que retomar la compra.');
  }
  const decidido = resultado.req;
  // Auditoría SIN ubicación y SIN nota (la nota es interna del request).
  await recordAudit({
    tenantId,
    action: action === 'approved' ? 'coverage.approved' : 'coverage.rejected',
    actorUid: actor.uid,
    actorRole: actor.role,
    targetType: 'coverageRequest',
    targetId: input.requestId,
    summary: `Cobertura ${action === 'approved' ? 'aprobada' : 'rechazada'} para el cliente …${decidido.customerId.slice(-4)}`,
  });
  logger.info('Cobertura decidida', { tenantId, requestId: input.requestId, action, rol: actor.role });
  return decidido;
}

/**
 * HARDEN-1 (review) — Estado del flujo para el GATING DE UI del panel: {enabled, activationId},
 * SIN datos sensibles (jamás cuentas bancarias). Existe porque las rules niegan config/checkout
 * al SELLER (contiene bankAccounts) y el gating fail-closed lo dejaba sin botones con el flujo
 * ACTIVO — el server lee la config con Admin SDK y devuelve solo el estado validado.
 * Solo lectura: no muta nada; PLATFORM_ADMIN puede consultarlo (soporte, read-only por rules).
 */
export const coverageFlowState = onCall<{ tenantId?: string }>({ region: REGION }, async (req) => {
  const auth = req.auth as AuthLike | undefined;
  if (!auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const role = auth.token?.role ?? '';
  let tenantId: string;
  if (role === 'PLATFORM_ADMIN') {
    const requested = typeof req.data?.tenantId === 'string' ? req.data.tenantId.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(requested)) throw new HttpsError('invalid-argument', 'Falta un tenantId válido.');
    tenantId = requested;
  } else {
    if (role !== 'TENANT_OWNER' && role !== 'TENANT_MANAGER' && role !== 'SELLER' && role !== 'TENANT_VIEWER') {
      throw new HttpsError('permission-denied', 'Tu rol no puede consultar el flujo de cobertura.');
    }
    tenantId = resolveTenant(auth, req.data?.tenantId);
  }
  const snap = await configRef(tenantId).get();
  const rawCoverage = (snap.data() as { coverage?: unknown } | undefined)?.coverage;
  // SHIPPING-CHAT-3B: respuesta SANEADA {enabled, activationId, shippingQuote} — jamás el doc
  // completo ni cuentas bancarias. El panel normaliza la ausencia del campo (deploy skew) con
  // shippingQuoteOfFlowState (⇒ off).
  const estado: CoverageFlowState = {
    ...coverageActivationOf(rawCoverage),
    shippingQuote: shippingQuotePolicyOf(rawCoverage),
  };
  return estado;
});

export const coverageApprove = onCall<DecisionInput>({ region: REGION }, async (req) => {
  const tenantId = resolveTenant(req.auth as AuthLike, req.data?.tenantId);
  const actor = assertCoverageActor(req.auth as AuthLike, tenantId);
  const input = validarInput(req.data);
  await decidirCobertura(tenantId, actor, input, 'approved');
  return { ok: true, status: 'coverage_approved' };
});

export const coverageReject = onCall<DecisionInput>({ region: REGION }, async (req) => {
  const tenantId = resolveTenant(req.auth as AuthLike, req.data?.tenantId);
  const actor = assertCoverageActor(req.auth as AuthLike, tenantId);
  const input = validarInput(req.data);
  await decidirCobertura(tenantId, actor, input, 'rejected');
  return { ok: true, status: 'coverage_rejected' };
});

export const coverageRequestInfo = onCall<{ tenantId?: string; requestId?: string }>({ region: REGION }, async (req) => {
  const tenantId = resolveTenant(req.auth as AuthLike, req.data?.tenantId);
  const actor = assertCoverageActor(req.auth as AuthLike, tenantId);
  const requestId = typeof req.data?.requestId === 'string' ? req.data.requestId.trim() : '';
  if (!/^covr_[0-9A-Za-z]{12}$/.test(requestId)) throw new HttpsError('invalid-argument', 'Solicitud de cobertura inválida.');

  const now = Timestamp.now();
  // Claim transaccional (idempotencia de doble clic): si ya se pidió hace <60s, no se re-envía.
  const claim = await db().runTransaction(async (tx) => {
    // HARDEN-1: flag validado DENTRO de la transacción, antes de cualquier escritura.
    const cfgSnap = await tx.get(configRef(tenantId));
    const act = coverageActivationOf((cfgSnap.data() as { coverage?: unknown } | undefined)?.coverage);
    if (!act.enabled) throw new HttpsError('failed-precondition', MENSAJE_FLUJO_DESHABILITADO);
    const snap = await tx.get(requestRef(tenantId, requestId));
    const cov = snap.exists ? (snap.data() as CoverageRequest) : null;
    if (!cov || cov.tenantId !== tenantId) throw new HttpsError('not-found', 'La solicitud de cobertura no existe.');
    if (actor.role === 'SELLER' && cov.sellerUid !== actor.uid) {
      throw new HttpsError('permission-denied', 'Esta revisión está asignada a otra persona del equipo.');
    }
    if (cov.status !== 'pending_coverage_review') throw new HttpsError('failed-precondition', 'La solicitud no está pendiente de revisión.');
    assertFlujoVigente(act, cov); // activación anterior ⇒ solo lectura (sin claim ni mensaje)
    if (cov.expiresAt.toMillis() <= now.toMillis()) throw new HttpsError('failed-precondition', 'La solicitud venció.');
    const last = cov.infoRequestedAt?.toMillis?.() ?? 0;
    if (now.toMillis() - last < INFO_DEDUPE_MS) return { already: true as const, customerId: cov.customerId };
    tx.update(snap.ref, { infoRequestedAt: now, updatedAt: now });
    return { already: false as const, customerId: cov.customerId };
  });
  if (claim.already) return { ok: true, already: true };

  // Review: re-chequeo best-effort ANTES de enviar — si alguien decidió (o el flujo se apagó)
  // en la ventana claim→send, no se le manda nada a un cliente ya resuelto (achica la carrera).
  const [frescoSnap, cfgFrescoSnap] = await Promise.all([requestRef(tenantId, requestId).get(), configRef(tenantId).get()]);
  const fresco = frescoSnap.data() as CoverageRequest | undefined;
  if (fresco?.status !== 'pending_coverage_review') {
    throw new HttpsError('failed-precondition', 'La solicitud ya no está pendiente de revisión.');
  }
  const actFresco = coverageActivationOf((cfgFrescoSnap.data() as { coverage?: unknown } | undefined)?.coverage);
  if (!actFresco.enabled || (fresco.activationId ?? null) !== actFresco.activationId) {
    throw new HttpsError('failed-precondition', MENSAJE_FLUJO_DESHABILITADO);
  }

  try {
    // Mensaje HUMANO determinístico por el mecanismo manual existente (mismo receivedVia, sin
    // IA, no cambia el estado del bot ni libera el takeover — HUMAN-HANDOFF-1).
    await sendManualMessage(
      { tenantId, customerId: claim.customerId, text: MENSAJE_MAS_INFORMACION },
      { uid: actor.uid, role: actor.role, name: actor.name },
    );
  } catch (e) {
    // Review: NO se libera el claim — el mensaje pudo haber SALIDO a Meta aunque la persistencia
    // fallara (sendManualMessage envía primero); un reintento inmediato duplicaría el pedido al
    // cliente. El claim de 60s hace de ventana de seguridad.
    throw e instanceof HttpsError ? e : new HttpsError('unavailable', 'No se pudo confirmar el envío. Revisá el historial del chat antes de reintentar.');
  }
  await recordAudit({
    tenantId,
    action: 'coverage.info_requested',
    actorUid: actor.uid,
    actorRole: actor.role,
    targetType: 'coverageRequest',
    targetId: requestId,
    summary: `Se pidió más detalle de ubicación al cliente …${claim.customerId.slice(-4)}`,
  });
  return { ok: true, already: false };
});
