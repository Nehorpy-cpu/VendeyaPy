/**
 * functions/products/categoryCallables.ts — Categorías por callable (Fase 5C-B)
 * ============================================================================
 * categoryUpsert (crear/editar) y categoryDelete (bloquea si hay productos asociados, para no
 * dejar productos huérfanos por categoryId). Rol manager+. Validación estricta (whitelist). Audita.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { resolvePanelAuth } from '../../panel/auth.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { validateCategoryPatch } from '../../products/validate.js';

function authorizeTenant(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

export const categoryUpsert = onCall<{ tenantId?: string; id?: string; data?: unknown }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  const now = Timestamp.now();
  let cat: Record<string, unknown>;
  try {
    cat = validateCategoryPatch(req.data?.data ?? {}, { requireName: !id });
  } catch (e) {
    throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Categoría inválida.');
  }

  if (!id) {
    const ref = db().collection(paths.categories(tenantId)).doc();
    await ref.set({ ...cat, id: ref.id, tenantId, createdAt: now, updatedAt: now });
    await recordAudit({ tenantId, action: 'category.created', actorUid: req.auth?.uid ?? null, targetType: 'category', targetId: ref.id, summary: 'Categoría creada (callable)' });
    logger.info('Categoría creada (callable)', { tenantId, categoryId: ref.id });
    return { ok: true, id: ref.id, created: true };
  }
  await db().doc(paths.category(tenantId, id)).set({ ...cat, id, tenantId, updatedAt: now }, { merge: true });
  await recordAudit({ tenantId, action: 'category.updated', actorUid: req.auth?.uid ?? null, targetType: 'category', targetId: id, summary: 'Categoría actualizada (callable)' });
  return { ok: true, id, created: false };
});

export const categoryDelete = onCall<{ tenantId?: string; id?: string }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  if (!id || typeof id !== 'string') throw new HttpsError('invalid-argument', 'Falta el id de la categoría.');

  // Bloquear si hay productos en la categoría (evita huérfanos por categoryId).
  const used = await db().collection(paths.products(tenantId)).where('categoryId', '==', id).limit(1).get();
  if (!used.empty) {
    throw new HttpsError('failed-precondition', 'No podés borrar una categoría con productos. Reasigná o archivá los productos primero.');
  }
  await db().doc(paths.category(tenantId, id)).delete();
  await recordAudit({ tenantId, action: 'category.deleted', actorUid: req.auth?.uid ?? null, targetType: 'category', targetId: id, summary: 'Categoría eliminada (callable)' });
  logger.info('Categoría eliminada (callable)', { tenantId, categoryId: id });
  return { ok: true, id, deleted: true };
});
