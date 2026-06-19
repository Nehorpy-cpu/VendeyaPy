/**
 * functions/growth/agentTestCaseCallables.ts — Casos del simulador por callable (Fase 5C-C2)
 * =========================================================================================
 * agentTestCaseUpsert gestiona SOLO la definición editable (name/scenario/userMessage/
 * expectedBehavior/status). NO toca `lastResult`/`lastRunAt` (los setea el run, fuera de 5C-C2).
 * agentTestCaseDelete = HARD-delete (datos efímeros del simulador). Rol manager+. Audita.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { resolvePanelAuth } from '../../panel/auth.js';
import { db } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { validateAgentTestCasePatch } from '../../growth/validate.js';

const COLL = (t: string): string => `tenants/${t}/agentTestCases`;
const DOC = (t: string, id: string): string => `tenants/${t}/agentTestCases/${id}`;

function authorizeTenant(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

export const agentTestCaseUpsert = onCall<{ tenantId?: string; id?: string; data?: unknown }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  const now = Timestamp.now();
  let patch: Record<string, unknown>;
  try {
    patch = validateAgentTestCasePatch(req.data?.data ?? {}, { requireCreate: !id });
  } catch (e) {
    throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Caso de prueba inválido.');
  }

  if (!id) {
    const ref = db().collection(COLL(tenantId)).doc();
    await ref.set({ scenario: '', userMessage: '', expectedBehavior: '', status: 'UNTESTED', ...patch, id: ref.id, tenantId, lastResult: '', lastRunAt: null, createdAt: now, updatedAt: now });
    await recordAudit({ tenantId, action: 'agentTestCase.created', actorUid: req.auth?.uid ?? null, targetType: 'agentTestCase', targetId: ref.id, summary: 'Caso de prueba creado (callable)' });
    logger.info('Caso de prueba creado (callable)', { tenantId, testId: ref.id });
    return { ok: true, id: ref.id, created: true };
  }
  await db().doc(DOC(tenantId, id)).set({ ...patch, id, tenantId, updatedAt: now }, { merge: true });
  await recordAudit({ tenantId, action: 'agentTestCase.updated', actorUid: req.auth?.uid ?? null, targetType: 'agentTestCase', targetId: id, summary: 'Caso de prueba actualizado (callable)' });
  return { ok: true, id, created: false };
});

export const agentTestCaseDelete = onCall<{ tenantId?: string; id?: string }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  if (!id || typeof id !== 'string') throw new HttpsError('invalid-argument', 'Falta el id del caso.');
  const ref = db().doc(DOC(tenantId, id));
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Caso de prueba no encontrado.');

  // Hard-delete (dato efímero del simulador).
  await ref.delete();
  await recordAudit({ tenantId, action: 'agentTestCase.deleted', actorUid: req.auth?.uid ?? null, targetType: 'agentTestCase', targetId: id, summary: 'Caso de prueba eliminado (callable)' });
  logger.info('Caso de prueba eliminado (callable)', { tenantId, testId: id });
  return { ok: true, id, deleted: true };
});
