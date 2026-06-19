/**
 * functions/growth/promotionCallables.ts — Promociones por callable (Fase 5C-C1)
 * =============================================================================
 * promotionUpsert (crear/editar) y promotionDelete (SOFT: status='FINISHED', conserva historial).
 * Rol manager+ (resolvePanelAuth). Validación estricta (whitelist; descarta server-only). Audita.
 * Sin cuota ni feature gate (edición básica). Convive con el write directo (rules NO cerradas).
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { resolvePanelAuth } from '../../panel/auth.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { validatePromotionPatch } from '../../growth/validate.js';

function authorizeTenant(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

/** Pasa los campos de fecha (ms|null) a Timestamp. */
function withDates(patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...patch };
  for (const k of ['startDate', 'endDate']) {
    if (k in out) out[k] = out[k] === null ? null : Timestamp.fromMillis(out[k] as number);
  }
  return out;
}

export const promotionUpsert = onCall<{ tenantId?: string; id?: string; data?: unknown }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  const now = Timestamp.now();
  let patch: Record<string, unknown>;
  try {
    patch = withDates(validatePromotionPatch(req.data?.data ?? {}, { requireCreate: !id }));
  } catch (e) {
    throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Promoción inválida.');
  }

  if (!id) {
    const ref = db().collection(paths.promotions(tenantId)).doc();
    await ref.set({ ...patch, id: ref.id, tenantId, createdAt: now, updatedAt: now });
    await recordAudit({ tenantId, action: 'promotion.created', actorUid: req.auth?.uid ?? null, targetType: 'promotion', targetId: ref.id, summary: 'Promoción creada (callable)' });
    logger.info('Promoción creada (callable)', { tenantId, promotionId: ref.id });
    return { ok: true, id: ref.id, created: true };
  }
  await db().doc(paths.promotion(tenantId, id)).set({ ...patch, id, tenantId, updatedAt: now }, { merge: true });
  await recordAudit({ tenantId, action: 'promotion.updated', actorUid: req.auth?.uid ?? null, targetType: 'promotion', targetId: id, summary: 'Promoción actualizada (callable)' });
  return { ok: true, id, created: false };
});

export const promotionDelete = onCall<{ tenantId?: string; id?: string }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  if (!id || typeof id !== 'string') throw new HttpsError('invalid-argument', 'Falta el id de la promoción.');
  const ref = db().doc(paths.promotion(tenantId, id));
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Promoción no encontrada.');

  // Soft: finalizar (conserva historial). No hard-delete.
  await ref.set({ status: 'FINISHED', updatedAt: Timestamp.now() }, { merge: true });
  await recordAudit({ tenantId, action: 'promotion.finished', actorUid: req.auth?.uid ?? null, targetType: 'promotion', targetId: id, summary: 'Promoción finalizada (soft-delete)' });
  logger.info('Promoción finalizada (callable)', { tenantId, promotionId: id });
  return { ok: true, id, finished: true };
});
