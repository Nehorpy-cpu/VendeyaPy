/**
 * functions/growth/trackingCallables.ts — Fuentes de tracking propio por callable (Fase 5C-C1)
 * ===========================================================================================
 * trackingSourceUpsert (crear/editar) y trackingSourceDelete (SOFT: active=false, conserva el
 * rollup de atribución). Rol manager+. Validación estricta (descarta `attribution`/server-only).
 * Audita (sin loguear el código completo). Sin cuota ni feature gate. Rules NO cerradas todavía.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { resolvePanelAuth } from '../../panel/auth.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { validateTrackingSourcePatch } from '../../growth/validate.js';

function authorizeTenant(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

export const trackingSourceUpsert = onCall<{ tenantId?: string; id?: string; data?: unknown }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  const now = Timestamp.now();
  let patch: Record<string, unknown>;
  try {
    patch = validateTrackingSourcePatch(req.data?.data ?? {}, { requireCreate: !id });
  } catch (e) {
    throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Fuente de tracking inválida.');
  }

  if (!id) {
    const ref = db().collection(paths.trackingSources(tenantId)).doc();
    await ref.set({ ...patch, id: ref.id, tenantId, createdAt: now, updatedAt: now });
    await recordAudit({ tenantId, action: 'trackingSource.created', actorUid: req.auth?.uid ?? null, targetType: 'trackingSource', targetId: ref.id, summary: 'Fuente de tracking creada (callable)' });
    logger.info('Fuente de tracking creada (callable)', { tenantId, trackingId: ref.id });
    return { ok: true, id: ref.id, created: true };
  }
  await db().doc(paths.trackingSource(tenantId, id)).set({ ...patch, id, tenantId, updatedAt: now }, { merge: true });
  await recordAudit({ tenantId, action: 'trackingSource.updated', actorUid: req.auth?.uid ?? null, targetType: 'trackingSource', targetId: id, summary: 'Fuente de tracking actualizada (callable)' });
  return { ok: true, id, created: false };
});

export const trackingSourceDelete = onCall<{ tenantId?: string; id?: string }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  if (!id || typeof id !== 'string') throw new HttpsError('invalid-argument', 'Falta el id de la fuente.');
  const ref = db().doc(paths.trackingSource(tenantId, id));
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Fuente de tracking no encontrada.');

  // Soft: desactivar (conserva el rollup de atribución). No hard-delete.
  await ref.set({ active: false, updatedAt: Timestamp.now() }, { merge: true });
  await recordAudit({ tenantId, action: 'trackingSource.deactivated', actorUid: req.auth?.uid ?? null, targetType: 'trackingSource', targetId: id, summary: 'Fuente de tracking desactivada (soft-delete)' });
  logger.info('Fuente de tracking desactivada (callable)', { tenantId, trackingId: id });
  return { ok: true, id, deactivated: true };
});
