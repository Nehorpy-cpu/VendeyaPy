/**
 * chatHandoff — Callables del panel para tomar/devolver una conversación (P5)
 * ===========================================================================
 * Las usa el panel (httpsCallable) con la sesión del usuario. Validan que el
 * usuario pertenezca al tenant y tenga rol de staff (owner/manager/vendedor) o
 * sea platform admin. El núcleo vive en conversation/handoff.ts.
 */

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { takeoverChat, releaseToBot } from '../../conversation/handoff.js';
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

export const chatTakeover = onCall<HandoffData>({ region: 'us-central1' }, async (req) => {
  const { tenantId, customerId } = readArgs(req);
  const actor = assertStaffAccess(req.auth, tenantId);
  const result = await takeoverChat(tenantId, customerId, actor.name, actor.uid);
  await recordAudit({ tenantId, action: 'chat.takeover', actorUid: actor.uid, targetType: 'customer', targetId: customerId, summary: `${actor.name ?? 'Staff'} tomó la conversación` });
  return result;
});

export const chatRelease = onCall<HandoffData>({ region: 'us-central1' }, async (req) => {
  const { tenantId, customerId } = readArgs(req);
  const actor = assertStaffAccess(req.auth, tenantId);
  const result = await releaseToBot(tenantId, customerId);
  // HUMAN-HANDOFF-1: acción de audit con el nombre pedido por el programa (antes 'chat.released').
  await recordAudit({ tenantId, action: 'conversation.returned_to_bot', actorUid: actor.uid, targetType: 'customer', targetId: customerId, summary: `${actor.name ?? 'Staff'} devolvió la conversación al bot` });
  return result;
});
