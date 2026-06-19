/**
 * functions/growth/deliveryCallables.ts — Repartidores por callable (Fase 5C-C2)
 * =============================================================================
 * deliveryPersonUpsert (crear/editar, cuota maxDeliveryPersons en CREATE) y deliveryPersonDelete
 * (bloquea si tiene entregas activas; si no, SOFT: isActive=false + status=OFFLINE). Rol manager+.
 * Validación estricta (descarta currentLocation/stats/activeDeliveryIds). Audita. Rules NO cerradas.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { resolvePanelAuth } from '../../panel/auth.js';
import { assertWithinLimit } from '../../entitlements/entitlements.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { validateDeliveryPersonPatch } from '../../growth/validate.js';

function authorizeTenant(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

export const deliveryPersonUpsert = onCall<{ tenantId?: string; id?: string; data?: unknown }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  const now = Timestamp.now();
  let patch: Record<string, unknown>;
  try {
    patch = validateDeliveryPersonPatch(req.data?.data ?? {}, { requireCreate: !id });
  } catch (e) {
    throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Repartidor inválido.');
  }

  if (!id) {
    // Crear → cuota de repartidores (cuenta solo isActive==true).
    await assertWithinLimit(tenantId, 'deliveryPersons', { actorUid: req.auth?.uid });
    const ref = db().collection(paths.deliveryPersons(tenantId)).doc();
    await ref.set({
      isActive: true, status: 'OFFLINE', area: '',
      ...patch,
      id: ref.id, tenantId,
      currentLocation: null,
      stats: { deliveriesToday: 0, deliveriesTotal: 0, successRate: 0, rating: 0 },
      activeDeliveryIds: [],
      createdAt: now, updatedAt: now,
    });
    await recordAudit({ tenantId, action: 'deliveryPerson.created', actorUid: req.auth?.uid ?? null, targetType: 'deliveryPerson', targetId: ref.id, summary: 'Repartidor creado (callable)' });
    logger.info('Repartidor creado (callable)', { tenantId, driverId: ref.id });
    return { ok: true, id: ref.id, created: true };
  }
  await db().doc(paths.deliveryPerson(tenantId, id)).set({ ...patch, id, tenantId, updatedAt: now }, { merge: true });
  await recordAudit({ tenantId, action: 'deliveryPerson.updated', actorUid: req.auth?.uid ?? null, targetType: 'deliveryPerson', targetId: id, summary: 'Repartidor actualizado (callable)' });
  return { ok: true, id, created: false };
});

export const deliveryPersonDelete = onCall<{ tenantId?: string; id?: string }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  if (!id || typeof id !== 'string') throw new HttpsError('invalid-argument', 'Falta el id del repartidor.');
  const ref = db().doc(paths.deliveryPerson(tenantId, id));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Repartidor no encontrado.');

  const active = snap.data()?.activeDeliveryIds;
  if (Array.isArray(active) && active.length > 0) {
    throw new HttpsError('failed-precondition', 'El repartidor tiene entregas activas. Reasignalas antes de darlo de baja.');
  }
  // Soft: desactivar (no hard-delete; libera cupo de la cuota).
  await ref.set({ isActive: false, status: 'OFFLINE', updatedAt: Timestamp.now() }, { merge: true });
  await recordAudit({ tenantId, action: 'deliveryPerson.deactivated', actorUid: req.auth?.uid ?? null, targetType: 'deliveryPerson', targetId: id, summary: 'Repartidor desactivado (soft-delete)' });
  logger.info('Repartidor desactivado (callable)', { tenantId, driverId: id });
  return { ok: true, id, deactivated: true };
});
