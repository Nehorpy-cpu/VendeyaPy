/**
 * functions/products/productUpsert.ts — Alta/edición de producto con cuota (Fase 5A)
 * ==================================================================================
 * Gate backend PREPARADO para que el frontend migre del write directo a este callable
 * (la migración del panel es Fase 5C). Autoriza por rol (manager+ gestiona catálogo) y,
 * al CREAR, valida la cuota `maxProducts` del plan. El write directo sigue activo hasta 5C
 * → NO se debe considerar esto "seguro" hasta que las escrituras críticas pasen por backend.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { resolvePanelAuth } from '../../panel/auth.js';
import { assertWithinLimit } from '../../entitlements/entitlements.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';

function authorizeTenant(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

export const productUpsert = onCall<{ tenantId?: string; id?: string; data?: Record<string, unknown> }>(
  { region: 'us-central1' },
  async (req) => {
    const tenantId = authorizeTenant(req, req.data?.tenantId);
    const data = (req.data?.data ?? {}) as Record<string, unknown>;
    const id = req.data?.id;
    const now = Timestamp.now();

    if (!id) {
      // Crear → valida la cuota de productos del plan (cuenta actual + 1 <= maxProducts).
      await assertWithinLimit(tenantId, 'products', { actorUid: req.auth?.uid });
      const ref = db().collection(paths.products(tenantId)).doc();
      await ref.set({ ...data, id: ref.id, tenantId, createdAt: now, updatedAt: now });
      await recordAudit({ tenantId, action: 'product.created', actorUid: req.auth?.uid ?? null, targetType: 'product', targetId: ref.id, summary: 'Producto creado (callable)' });
      logger.info('Producto creado (callable)', { tenantId, productId: ref.id });
      return { ok: true, id: ref.id, created: true };
    }

    // Actualizar → no suma productos (sin cuota).
    await db().doc(paths.product(tenantId, id)).set({ ...data, id, tenantId, updatedAt: now }, { merge: true });
    await recordAudit({ tenantId, action: 'product.updated', actorUid: req.auth?.uid ?? null, targetType: 'product', targetId: id, summary: 'Producto actualizado (callable)' });
    return { ok: true, id, created: false };
  },
);
