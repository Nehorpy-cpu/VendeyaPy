/**
 * chatHandoff — Callables del panel para tomar/devolver una conversación (P5)
 * ===========================================================================
 * Las usa el panel (httpsCallable) con la sesión del usuario. Validan que el
 * usuario pertenezca al tenant y tenga rol de staff (owner/manager/vendedor) o
 * sea platform admin. El núcleo vive en conversation/handoff.ts.
 */

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { takeoverChat, releaseToBot } from '../../conversation/handoff.js';

interface HandoffData {
  tenantId?: string;
  customerId?: string;
}

const STAFF_ROLES = ['PLATFORM_ADMIN', 'TENANT_OWNER', 'TENANT_MANAGER', 'SELLER'];

/** Valida tenant + rol; devuelve un nombre legible del actor para el log/historial. */
function assertStaff(req: CallableRequest<HandoffData>, tenantId: string): string | undefined {
  const auth = req.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const token = auth.token as { tenantId?: string; role?: string; name?: string; email?: string };
  const isPlatformAdmin = token.role === 'PLATFORM_ADMIN';
  if (!isPlatformAdmin && token.tenantId !== tenantId) {
    throw new HttpsError('permission-denied', 'No tenés acceso a esta empresa.');
  }
  if (!STAFF_ROLES.includes(token.role ?? '')) {
    throw new HttpsError('permission-denied', 'Tu rol no puede atender conversaciones.');
  }
  return token.name || token.email || undefined;
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
  const by = assertStaff(req, tenantId);
  return takeoverChat(tenantId, customerId, by);
});

export const chatRelease = onCall<HandoffData>({ region: 'us-central1' }, async (req) => {
  const { tenantId, customerId } = readArgs(req);
  assertStaff(req, tenantId);
  return releaseToBot(tenantId, customerId);
});
