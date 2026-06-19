/**
 * functions/products/productDelete.ts — Baja de producto por SOFT-ARCHIVE (Fase 5C-B)
 * ==================================================================================
 * No hace hard-delete: marca `status='ARCHIVED'` para no romper carritos, sesiones, pedidos
 * abiertos ni referencias vivas. NO borra `productFinancials` (preserva trazabilidad de costos).
 * El job de sync podrá desactivar el item en Meta Catalog después. Rol manager+. Audita.
 * (Hard-delete real podría quedar como acción admin/platform en una fase posterior.)
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { resolvePanelAuth } from '../../panel/auth.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';

function authorizeTenant(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

export const productDelete = onCall<{ tenantId?: string; id?: string }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  if (!id || typeof id !== 'string') throw new HttpsError('invalid-argument', 'Falta el id del producto.');

  const ref = db().doc(paths.product(tenantId, id));
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Producto no encontrado.');

  await ref.set({ status: 'ARCHIVED', updatedAt: Timestamp.now() }, { merge: true });
  await recordAudit({ tenantId, action: 'product.archived', actorUid: req.auth?.uid ?? null, targetType: 'product', targetId: id, summary: 'Producto archivado (soft-delete)' });
  logger.info('Producto archivado (callable)', { tenantId, productId: id });
  return { ok: true, id, archived: true };
});
