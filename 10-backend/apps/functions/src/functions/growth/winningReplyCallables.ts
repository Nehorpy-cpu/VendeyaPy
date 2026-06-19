/**
 * functions/growth/winningReplyCallables.ts — Respuestas ganadoras por callable (Fase 5C-C2)
 * =========================================================================================
 * winningReplyUpsert gestiona SOLO respuestas manuales (force source='manual', conversions=0;
 * rechaza editar las 'auto' minadas por el job). winningReplyDelete = SOFT-archive (status='ARCHIVED').
 * Rol manager+. Validación estricta (descarta source/conversions). Audita. Rules NO cerradas.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { resolvePanelAuth } from '../../panel/auth.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { validateWinningReplyPatch } from '../../growth/validate.js';

function authorizeTenant(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

export const winningReplyUpsert = onCall<{ tenantId?: string; id?: string; data?: unknown }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  const now = Timestamp.now();
  let patch: Record<string, unknown>;
  try {
    patch = validateWinningReplyPatch(req.data?.data ?? {}, { requireCreate: !id });
  } catch (e) {
    throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Respuesta inválida.');
  }

  if (!id) {
    const ref = db().collection(paths.winningReplies(tenantId)).doc();
    await ref.set({ category: '', status: 'ACTIVE', ...patch, id: ref.id, tenantId, source: 'manual', conversions: 0, createdAt: now, updatedAt: now });
    await recordAudit({ tenantId, action: 'winningReply.created', actorUid: req.auth?.uid ?? null, targetType: 'winningReply', targetId: ref.id, summary: 'Respuesta manual creada (callable)' });
    logger.info('Respuesta ganadora creada (callable)', { tenantId, replyId: ref.id });
    return { ok: true, id: ref.id, created: true };
  }

  const ref = db().doc(paths.winningReply(tenantId, id));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Respuesta no encontrada.');
  if (snap.data()?.source === 'auto') {
    throw new HttpsError('failed-precondition', 'No se pueden editar respuestas automáticas (las genera el sistema).');
  }
  await ref.set({ ...patch, id, tenantId, updatedAt: now }, { merge: true });
  await recordAudit({ tenantId, action: 'winningReply.updated', actorUid: req.auth?.uid ?? null, targetType: 'winningReply', targetId: id, summary: 'Respuesta manual actualizada (callable)' });
  return { ok: true, id, created: false };
});

export const winningReplyDelete = onCall<{ tenantId?: string; id?: string }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  if (!id || typeof id !== 'string') throw new HttpsError('invalid-argument', 'Falta el id de la respuesta.');
  const ref = db().doc(paths.winningReply(tenantId, id));
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Respuesta no encontrada.');

  // Soft: archivar (no hard-delete).
  await ref.set({ status: 'ARCHIVED', updatedAt: Timestamp.now() }, { merge: true });
  await recordAudit({ tenantId, action: 'winningReply.archived', actorUid: req.auth?.uid ?? null, targetType: 'winningReply', targetId: id, summary: 'Respuesta archivada (soft-delete)' });
  logger.info('Respuesta ganadora archivada (callable)', { tenantId, replyId: id });
  return { ok: true, id, archived: true };
});
