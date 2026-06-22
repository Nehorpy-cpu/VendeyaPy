/**
 * functions/growth/agentTestCaseCallables.ts — Casos del simulador por callable (Fase 5C-C2)
 * =========================================================================================
 * agentTestCaseUpsert gestiona SOLO la definición editable (name/scenario/userMessage/
 * expectedBehavior/status). NUNCA escribe `lastResult`/`lastRunAt` (son server-only).
 * agentTestCaseRun (GB-B) corre el MOTOR REAL del bot (handleMessage) con un `from` sintético
 * reservado/efímero y persiste `lastResult`/`lastRunAt` (Admin SDK); NO cambia `status` ni consume
 * cuota (es simulador interno, no un mensaje real). Comparte el motor real: cada corrida crea una
 * sesión/cliente sintético efímero (por eso el `from` es reservado, para no colisionar con clientes reales).
 * agentTestCaseDelete = HARD-delete (datos efímeros del simulador). Rol manager+. Audita.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { resolvePanelAuth } from '../../panel/auth.js';
import { db } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { handleMessage } from '../../conversation/engine.js';
import { ANTHROPIC_API_KEY } from '../../ai/aiSecret.js';
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

// agentTestCaseRun corre el MOTOR REAL del bot (handleMessage → sales agent IA): bindea el secret.
export const agentTestCaseRun = onCall<{ tenantId?: string; id?: string }>({ region: 'us-central1', secrets: [ANTHROPIC_API_KEY] }, async (req) => {
  const tenantId = authorizeTenant(req, req.data?.tenantId);
  const id = req.data?.id;
  if (!id || typeof id !== 'string') throw new HttpsError('invalid-argument', 'Falta el id del caso.');
  const ref = db().doc(DOC(tenantId, id));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Caso de prueba no encontrado.');

  const userMessage = String(snap.data()?.userMessage ?? '').trim();
  if (!userMessage) throw new HttpsError('failed-precondition', 'El caso no tiene mensaje del cliente para simular.');

  // `from` sintético RESERVADO y EFÍMERO (solo dígitos; el motor deriva el id de cliente de los
  // dígitos del teléfono). Prefijo 0000 = rango del simulador (los teléfonos reales E.164 no arrancan
  // en 0000); timestamp+aleatorio evita colisiones con clientes reales y acumular historial entre corridas.
  const from = `0000${Date.now()}${Math.floor(Math.random() * 1000)}`;

  // Corre el MOTOR REAL del bot (mismo pipeline que WhatsApp / simulateAgentMessage): dos turnos
  // (saludo + userMessage), igual que el simulador del frontend. NO consume cuota (no es mensaje real).
  let result: Awaited<ReturnType<typeof handleMessage>>;
  try {
    await handleMessage({ tenantId, from, text: 'hola', channel: 'whatsapp' });
    result = await handleMessage({ tenantId, from, text: userMessage, channel: 'whatsapp' });
  } catch (e) {
    logger.error('Error corriendo el caso de prueba', e, { tenantId, testId: id });
    throw new HttpsError('internal', 'No se pudo correr el caso de prueba.');
  }

  // Misma derivación que el simulador del frontend: si el bot está en pausa → texto fijo.
  const lastResult = result.reply || (result.handledByHuman ? '(el bot está en pausa)' : '(sin respuesta)');
  const now = Timestamp.now();
  // Persistir SOLO lastResult/lastRunAt (server-only); NO tocar `status` (lo marca el usuario a mano).
  await ref.set({ lastResult, lastRunAt: now, updatedAt: now }, { merge: true });
  await recordAudit({ tenantId, action: 'agentTestCase.run', actorUid: req.auth?.uid ?? null, targetType: 'agentTestCase', targetId: id, summary: 'Caso de prueba ejecutado (callable)' });
  logger.info('Caso de prueba ejecutado (callable)', { tenantId, testId: id });
  return { ok: true, id, lastResult, lastRunAt: now, handledByHuman: !!result.handledByHuman };
});
