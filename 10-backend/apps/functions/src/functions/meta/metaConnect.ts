/**
 * functions/meta/metaConnect.ts — Callables de conexión REAL de Meta (Fase 4B)
 * ===========================================================================
 * Flujo Embedded Signup (sin endpoint público de redirect):
 *   startMetaConnect → emite un nonce de un solo uso (TTL corto, atado a tenant+uid).
 *   connectMeta → consume el nonce, intercambia el code, valida, descubre assets y conecta.
 *   verifyMetaChannel → preflight (revalida token/número y actualiza estado).
 *   selectMetaPhoneNumber → elige el phone_number_id activo para el envío.
 *   metaDisconnect → desconecta y borra assets/índice/secreto.
 *
 * Autorización ESTRICTA (meta/authz.ts): solo PLATFORM_ADMIN (con tenant) o TENANT_OWNER
 * de su empresa. TENANT_MANAGER/VIEWER/SELLER: denegado. Nunca se loguean code ni tokens.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { resolveMetaConnectAuth } from '../../meta/authz.js';
import { createMetaConnectNonce, consumeMetaConnectNonce } from '../../meta/nonce.js';
import { runMetaConnect, type ConnectFailReason } from '../../meta/connectFlow.js';
import { verifyWhatsappChannel } from '../../meta/preflight.js';
import { selectTenantPhoneNumber } from '../../meta/discovery.js';
import { disconnectMeta } from '../../meta/connect.js';
import { getMetaGraphClient } from '../../meta/graphClient.js';
import { assertWhatsappNumbersEntitled } from '../../entitlements/entitlements.js';
import { logger } from '../../lib/logger.js';

interface Authorized {
  tenantId: string;
  uid: string;
}

/** Valida auth + rol/tenant ESTRICTO (owner/admin) y devuelve { tenantId, uid }. */
function authorize(req: CallableRequest<unknown>, requestedTenantId?: string): Authorized {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const result = resolveMetaConnectAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!result.ok) throw new HttpsError(result.code, result.message);
  return { tenantId: result.tenantId, uid: req.auth.uid };
}

const CONNECT_FAIL_MESSAGE: Record<ConnectFailReason, string> = {
  exchange_failed: 'No se pudo validar la autorización de Meta. Reintentá el proceso.',
  token_invalid: 'El token de Meta no es válido. Reconectá la cuenta.',
  scopes_insuficientes: 'Faltan permisos de WhatsApp. Aceptá todos los permisos al conectar.',
  no_waba: 'No se encontró una cuenta de WhatsApp Business en tu Meta Business.',
  no_phone_number: 'No se encontró un número de WhatsApp en tu cuenta.',
};

export const startMetaConnect = onCall<{ tenantId?: string }>({ region: 'us-central1' }, async (req) => {
  const { tenantId, uid } = authorize(req, req.data?.tenantId);
  const nonce = await createMetaConnectNonce(tenantId, uid);
  logger.info('Meta connect: nonce emitido', { tenantId });
  return { ok: true, nonce };
});

export const connectMeta = onCall<{
  tenantId?: string;
  nonce?: string;
  code?: string;
  wabaId?: string;
  phoneNumberId?: string;
  businessId?: string;
  businessName?: string;
}>({ region: 'us-central1' }, async (req) => {
  const { tenantId, uid } = authorize(req, req.data?.tenantId);
  const d = req.data ?? {};
  if (!d.code) throw new HttpsError('invalid-argument', 'Falta el code de Meta.');

  // Entitlements (Fase 5A): el plan debe permitir números de WhatsApp.
  await assertWhatsappNumbersEntitled(tenantId, { actorUid: uid });

  const nonceOk = await consumeMetaConnectNonce(d.nonce ?? '', { tenantId, uid });
  if (!nonceOk) throw new HttpsError('failed-precondition', 'Sesión de conexión inválida o expirada. Reiniciá el proceso.');

  const graph = await getMetaGraphClient();
  const result = await runMetaConnect(
    tenantId,
    { code: d.code, wabaId: d.wabaId, phoneNumberId: d.phoneNumberId, businessId: d.businessId, businessName: d.businessName },
    uid,
    graph,
  );
  if (!result.ok) {
    logger.warn('Meta connect: falló', { tenantId, reason: result.reason, status: result.status });
    throw new HttpsError('failed-precondition', CONNECT_FAIL_MESSAGE[result.reason]);
  }
  return { ok: true, status: result.status, phoneNumberId: result.selectedPhoneNumberId, phoneNumber: result.phoneNumber, assets: result.assetsCount };
});

export const verifyMetaChannel = onCall<{ tenantId?: string }>({ region: 'us-central1' }, async (req) => {
  const { tenantId } = authorize(req, req.data?.tenantId);
  const graph = await getMetaGraphClient();
  const result = await verifyWhatsappChannel(tenantId, graph);
  return { ok: true, ...result };
});

export const selectMetaPhoneNumber = onCall<{ tenantId?: string; phoneNumberId?: string }>({ region: 'us-central1' }, async (req) => {
  const { tenantId, uid } = authorize(req, req.data?.tenantId);
  const phoneNumberId = req.data?.phoneNumberId;
  if (!phoneNumberId) throw new HttpsError('invalid-argument', 'Falta phoneNumberId.');
  await assertWhatsappNumbersEntitled(tenantId, { actorUid: uid });
  const ok = await selectTenantPhoneNumber(tenantId, phoneNumberId);
  if (!ok) throw new HttpsError('not-found', 'Ese número no pertenece a la cuenta conectada.');
  return { ok: true, phoneNumberId };
});

export const metaDisconnect = onCall<{ tenantId?: string }>({ region: 'us-central1' }, async (req) => {
  const { tenantId } = authorize(req, req.data?.tenantId);
  await disconnectMeta(tenantId);
  return { ok: true };
});
