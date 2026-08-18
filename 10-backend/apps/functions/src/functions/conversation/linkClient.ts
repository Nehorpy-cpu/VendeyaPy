/**
 * Callables del VÍNCULO conversación ↔ ficha de cliente (ADR-0021 §4/§7)
 * =======================================================================
 * Vincular a ficha existente, quitar vínculo y crear ficha CRM desde datos confirmados (crea Y
 * vincula en la misma operación atómica). Solo TENANT_MANAGER/TENANT_OWNER/PLATFORM_ADMIN (lo
 * verifica el núcleo `conversation/linking.ts`, junto con los bloqueos: destino inexistente/
 * softDeleted, auto-vínculo, cadenas). Auditoría solo de acciones efectivas.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  createAndLinkClient,
  linkConversationToClient,
  unlinkConversationClient,
} from '../../conversation/linking.js';
import { db } from '../../lib/firebase.js';
import { assertStaffAccess } from './staffAuth.js';
import { recordAudit } from '../../audit/audit.js';

interface LinkData {
  tenantId?: string;
  customerId?: string;
  clientId?: string;
}

export const conversationLinkClient = onCall<LinkData>({ region: 'us-central1' }, async (req) => {
  const { tenantId, customerId, clientId } = req.data ?? {};
  if (!tenantId || !customerId || !clientId) {
    throw new HttpsError('invalid-argument', 'Faltan tenantId, customerId o clientId.');
  }
  const actor = assertStaffAccess(req.auth, tenantId);
  const result = await linkConversationToClient(db(), { tenantId, customerId, clientId }, {
    uid: actor.uid,
    role: actor.role,
    name: actor.name,
  });
  if (result.changed) {
    await recordAudit({
      tenantId,
      action: 'conversation.client_linked',
      actorUid: actor.uid,
      targetType: 'customer',
      targetId: customerId,
      summary: `${actor.name ?? 'Staff'} vinculó la conversación a una ficha de cliente`,
      metadata: { clientId },
    });
  }
  return { ok: true };
});

export const conversationUnlinkClient = onCall<LinkData>({ region: 'us-central1' }, async (req) => {
  const { tenantId, customerId } = req.data ?? {};
  if (!tenantId || !customerId) {
    throw new HttpsError('invalid-argument', 'Faltan tenantId y customerId.');
  }
  const actor = assertStaffAccess(req.auth, tenantId);
  const result = await unlinkConversationClient(db(), { tenantId, customerId }, {
    uid: actor.uid,
    role: actor.role,
    name: actor.name,
  });
  if (result.changed) {
    await recordAudit({
      tenantId,
      action: 'conversation.client_unlinked',
      actorUid: actor.uid,
      targetType: 'customer',
      targetId: customerId,
      summary: `${actor.name ?? 'Staff'} quitó el vínculo de la conversación con su ficha de cliente`,
    });
  }
  return { ok: true };
});

interface CreateClientData {
  tenantId?: string;
  customerId?: string;
  name?: string;
  notes?: string;
}

export const conversationCreateClient = onCall<CreateClientData>({ region: 'us-central1' }, async (req) => {
  const { tenantId, customerId, name, notes } = req.data ?? {};
  if (!tenantId || !customerId || typeof name !== 'string') {
    throw new HttpsError('invalid-argument', 'Faltan tenantId, customerId o name.');
  }
  const actor = assertStaffAccess(req.auth, tenantId);
  const result = await createAndLinkClient(
    db(),
    { tenantId, customerId, name, ...(typeof notes === 'string' ? { notes } : {}) },
    { uid: actor.uid, role: actor.role, name: actor.name },
  );
  // El audit NO incluye el name ni las notes (dato CRM del negocio): solo el id opaco.
  await recordAudit({
    tenantId,
    action: 'conversation.client_created',
    actorUid: actor.uid,
    targetType: 'customer',
    targetId: customerId,
    summary: `${actor.name ?? 'Staff'} creó una ficha de cliente y la vinculó a la conversación`,
    metadata: { clientId: result.clientId },
  });
  return { ok: true, clientId: result.clientId };
});
