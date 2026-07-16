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
import type { CoverageRequest, CoverageResumeJob, CoverageSessionPointer } from '@vpw/shared';
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
    const snap = await tx.get(requestRef(tenantId, input.requestId));
    const req = snap.exists ? (snap.data() as CoverageRequest) : null;
    if (!req || req.tenantId !== tenantId) throw new HttpsError('not-found', 'La solicitud de cobertura no existe.');
    if (actor.role === 'SELLER' && req.sellerUid !== actor.uid) {
      throw new HttpsError('permission-denied', 'Esta revisión está asignada a otra persona del equipo.');
    }
    if (req.status !== 'pending_coverage_review') {
      const por = req.decision?.byName ? ` por ${req.decision.byName}` : '';
      throw new HttpsError('failed-precondition', req.decision ? `Esta solicitud ya fue decidida${por}.` : 'Esta solicitud no está pendiente de revisión.');
    }
    if (req.expiresAt.toMillis() <= now.toMillis()) {
      // OJO: lanzar acá ABORTARÍA la transacción y la marca de expirado se perdería (review).
      // La transición se commitea y el error al usuario sale DESPUÉS, fuera de la transacción.
      tx.update(snap.ref, { status: 'coverage_expired', updatedAt: now, coordinatesPurgeAt: purgeAtFrom(now, req) });
      tx.set(db().doc(paths.session(tenantId, req.customerId)), { context: { coverage: null }, updatedAt: now }, { merge: true });
      return { kind: 'expirado' as const };
    }
    if ((req.locationFingerprint ?? '') !== input.expectedFingerprint) {
      // El cliente actualizó su ubicación mientras se revisaba: NUNCA decidir sobre la vieja.
      throw new HttpsError('failed-precondition', 'El cliente actualizó su ubicación: revisá la versión más reciente antes de decidir.');
    }
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
    const snap = await tx.get(requestRef(tenantId, requestId));
    const cov = snap.exists ? (snap.data() as CoverageRequest) : null;
    if (!cov || cov.tenantId !== tenantId) throw new HttpsError('not-found', 'La solicitud de cobertura no existe.');
    if (actor.role === 'SELLER' && cov.sellerUid !== actor.uid) {
      throw new HttpsError('permission-denied', 'Esta revisión está asignada a otra persona del equipo.');
    }
    if (cov.status !== 'pending_coverage_review') throw new HttpsError('failed-precondition', 'La solicitud no está pendiente de revisión.');
    if (cov.expiresAt.toMillis() <= now.toMillis()) throw new HttpsError('failed-precondition', 'La solicitud venció.');
    const last = cov.infoRequestedAt?.toMillis?.() ?? 0;
    if (now.toMillis() - last < INFO_DEDUPE_MS) return { already: true as const, customerId: cov.customerId };
    tx.update(snap.ref, { infoRequestedAt: now, updatedAt: now });
    return { already: false as const, customerId: cov.customerId };
  });
  if (claim.already) return { ok: true, already: true };

  // Review: re-chequeo best-effort ANTES de enviar — si alguien decidió en la ventana
  // claim→send, no se le pide más información a un cliente ya resuelto (achica la carrera).
  const fresco = (await requestRef(tenantId, requestId).get()).data() as CoverageRequest | undefined;
  if (fresco?.status !== 'pending_coverage_review') {
    throw new HttpsError('failed-precondition', 'La solicitud ya no está pendiente de revisión.');
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
