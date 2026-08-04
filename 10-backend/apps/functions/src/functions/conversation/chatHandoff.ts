/**
 * chatHandoff — Callables del panel para tomar/devolver una conversación (P5)
 * ===========================================================================
 * Las usa el panel (httpsCallable) con la sesión del usuario. Validan que el
 * usuario pertenezca al tenant y tenga rol de staff (owner/manager/vendedor) o
 * sea platform admin. El núcleo vive en conversation/handoff.ts.
 */

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { takeoverChat, releaseToBot } from '../../conversation/handoff.js';
import { CanalIndeterminadoError, resolverCanalDeConversacion } from '../../conversation/canal.js';
import { reactivarResumeTrasLiberacion } from '../../conversation/coverageResume.js';
import { assertStaffAccess } from './staffAuth.js';
import { recordAudit } from '../../audit/audit.js';

interface HandoffData {
  tenantId?: string;
  customerId?: string;
}

function readArgs(req: CallableRequest<HandoffData>): { tenantId: string; customerId: string } {
  const { tenantId, customerId } = req.data ?? {};
  if (!tenantId || !customerId) {
    throw new HttpsError('invalid-argument', 'Faltan tenantId y customerId.');
  }
  return { tenantId, customerId };
}

/**
 * ADR-0017 §2 — el panel no conoce el canal: lo resuelve por el `receivedVia` de la conversación.
 * Si la lectura del permiso se cae, esto LANZA en vez de caer a `active`: tomar (o devolverle al
 * bot) la conversación del número que está vendiendo por un hipo de Firestore es peor que pedirle
 * al vendedor que reintente. El mensaje no nombra el número ni ningún dato del cliente.
 */
async function canalDe(tenantId: string, customerId: string): Promise<string> {
  try {
    return await resolverCanalDeConversacion(tenantId, customerId);
  } catch (e) {
    if (e instanceof CanalIndeterminadoError) {
      throw new HttpsError('unavailable', 'No pudimos identificar el número de esta conversación. Probá de nuevo en un momento.');
    }
    throw e;
  }
}

export const chatTakeover = onCall<HandoffData>({ region: 'us-central1' }, async (req) => {
  const { tenantId, customerId } = readArgs(req);
  const actor = assertStaffAccess(req.auth, tenantId);
  const result = await takeoverChat(tenantId, customerId, actor.name, actor.uid, await canalDe(tenantId, customerId));
  await recordAudit({ tenantId, action: 'chat.takeover', actorUid: actor.uid, targetType: 'customer', targetId: customerId, summary: `${actor.name ?? 'Staff'} tomó la conversación` });
  return result;
});

export const chatRelease = onCall<HandoffData>({ region: 'us-central1' }, async (req) => {
  const { tenantId, customerId } = readArgs(req);
  const actor = assertStaffAccess(req.auth, tenantId);
  const sessionKey = await canalDe(tenantId, customerId);
  const result = await releaseToBot(tenantId, customerId, sessionKey);
  // HUMAN-HANDOFF-1: acción de audit con el nombre pedido por el programa (antes 'chat.released').
  await recordAudit({ tenantId, action: 'conversation.returned_to_bot', actorUid: actor.uid, targetType: 'customer', targetId: customerId, summary: `${actor.name ?? 'Staff'} devolvió la conversación al bot` });
  // COVERAGE-1D: si había una reanudación retenida por este takeover, re-encolarla — la del
  // MISMO canal que se acaba de liberar (el puntero de cobertura vive en esa sesión).
  await reactivarResumeTrasLiberacion(tenantId, customerId, sessionKey);
  return result;
});
