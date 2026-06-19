/**
 * functions/products/productUpsert.ts — Alta/edición de producto + costo privado (Fase 5A · 5C-B)
 * ==============================================================================================
 * Callable con gate de backend para el catálogo. Rol manager+ (resolvePanelAuth), cuota
 * `maxProducts` en CREATE, validación ESTRICTA (whitelist; descarta campos server/sync/
 * entitlements) y, opcionalmente, escribe el costo PRIVADO `productFinancials/{id}` en el MISMO
 * batch (único callable producto + costos). El `costPrice` NUNCA se loguea. Convive con el write
 * directo del panel (rules NO cerradas todavía) hasta la migración del frontend.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { resolvePanelAuth } from '../../panel/auth.js';
import { assertWithinLimit } from '../../entitlements/entitlements.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { validateProductPatch, validateProductFinancials } from '../../products/validate.js';

function authorizeTenant(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

export const productUpsert = onCall<{ tenantId?: string; id?: string; data?: unknown; financials?: unknown }>(
  { region: 'us-central1' },
  async (req) => {
    const tenantId = authorizeTenant(req, req.data?.tenantId);
    const id = req.data?.id;
    const now = Timestamp.now();

    let product: Record<string, unknown>;
    let financials: Record<string, unknown> | null;
    try {
      product = validateProductPatch(req.data?.data ?? {}, { requireName: !id });
      financials = req.data?.financials !== undefined ? validateProductFinancials(req.data.financials) : null;
    } catch (e) {
      throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Producto inválido.');
    }
    const hasFinancials = !!financials && Object.keys(financials).length > 0;

    if (!id) {
      // Crear → valida la cuota de productos del plan (cuenta actual + 1 <= maxProducts).
      await assertWithinLimit(tenantId, 'products', { actorUid: req.auth?.uid });
      const ref = db().collection(paths.products(tenantId)).doc();
      const batch = db().batch();
      batch.set(ref, { ...product, id: ref.id, tenantId, createdAt: now, updatedAt: now });
      if (hasFinancials) batch.set(db().doc(paths.productFinancial(tenantId, ref.id)), { ...financials, productId: ref.id, tenantId, updatedAt: now }, { merge: true });
      await batch.commit();
      await recordAudit({ tenantId, action: 'product.created', actorUid: req.auth?.uid ?? null, targetType: 'product', targetId: ref.id, summary: 'Producto creado (callable)', metadata: { hasFinancials } });
      logger.info('Producto creado (callable)', { tenantId, productId: ref.id });
      return { ok: true, id: ref.id, created: true };
    }

    // Actualizar → no suma productos (sin cuota).
    const batch = db().batch();
    batch.set(db().doc(paths.product(tenantId, id)), { ...product, id, tenantId, updatedAt: now }, { merge: true });
    if (hasFinancials) batch.set(db().doc(paths.productFinancial(tenantId, id)), { ...financials, productId: id, tenantId, updatedAt: now }, { merge: true });
    await batch.commit();
    await recordAudit({ tenantId, action: 'product.updated', actorUid: req.auth?.uid ?? null, targetType: 'product', targetId: id, summary: 'Producto actualizado (callable)', metadata: { hasFinancials } });
    return { ok: true, id, created: false };
  },
);
