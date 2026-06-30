/**
 * meta/connectFlow.ts — Orquestación de la conexión REAL de Meta por tenant (Fase 4B)
 * ==================================================================================
 * exchange(code) → debug_token (valida + scopes + WABA + expiración) → guarda token en
 * SecretStore (naming seguro) → escribe MetaConnection → discovery de assets + índice →
 * subscribe_apps → preflight. Falla seguro: ante token inválido / scopes faltantes / sin
 * WABA / sin phone_number, escribe el estado correspondiente y NO guarda token. El token
 * y el code NUNCA se loguean. Las llamadas a Graph pasan por MetaGraphClient (inyectable).
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaConnection, MetaConnectionStatus, MetaConnectionSource } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { getSecretStore } from '../lib/secretStore.js';
import { logger } from '../lib/logger.js';
import { metaTokenSecretName } from './secretName.js';
import { META_REQUIRED_SCOPES } from './scopes.js';
import { buildMetaAssets, writeDiscoveredAssets } from './discovery.js';
import { verifyWhatsappChannel } from './preflight.js';
import { resolveEntitlements } from '../entitlements/entitlements.js';
import type { MetaGraphClient, MetaPhoneNumber } from './graphClient.js';

// ---------------- Helpers PUROS (testeables) ----------------

export function missingScopes(scopes: string[], required: readonly string[]): string[] {
  return required.filter((s) => !scopes.includes(s));
}

/** Elige el phone_number_id: el pedido si existe entre los del WABA; si no, el primero. */
export function pickSelectedPhone(phones: MetaPhoneNumber[], requestedId?: string): string | null {
  if (requestedId && phones.some((p) => p.id === requestedId)) return requestedId;
  return phones[0]?.id ?? null;
}

// ---------------- Orquestación (E/S) ----------------

export interface ConnectInput {
  code: string;
  wabaId?: string;
  phoneNumberId?: string;
  businessId?: string;
  businessName?: string;
  wabaName?: string;
}

export type ConnectFailReason = 'exchange_failed' | 'token_invalid' | 'scopes_insuficientes' | 'no_waba' | 'no_phone_number' | 'over_number_limit';

export type ConnectResult =
  | { ok: true; status: 'active'; selectedPhoneNumberId: string; phoneNumber: string | null; assetsCount: number }
  | { ok: false; reason: ConnectFailReason; status: MetaConnectionStatus };

async function writeFailureStatus(tenantId: string, status: MetaConnectionStatus, errorMessage: string): Promise<void> {
  // NO escribe token: solo deja el estado de error para que el panel lo muestre.
  await db().doc(paths.metaConnection(tenantId, 'main')).set(
    { id: 'main', tenantId, status, errorMessage, tokenSecretRef: '', lastVerifiedAt: Timestamp.now(), updatedAt: Timestamp.now() },
    { merge: true },
  );
}

/**
 * Escribe el doc determinista metaConnections/main (merge). Helper COMPARTIDO entre el flujo
 * Embedded Signup (defaults: status 'active', tokenType 'live') y el alta manual (WM-1), que pasa
 * `status`/`source` propios. Nunca escribe el token: solo `tokenSecretRef`.
 */
export async function writeActiveConnection(
  tenantId: string,
  fields: {
    byUid?: string | null;
    tokenSecretRef: string;
    tokenExpiresAtMs: number | null;
    scopes: string[];
    businessId?: string;
    businessName?: string;
    status?: MetaConnectionStatus;
    tokenType?: string;
    source?: MetaConnectionSource;
  },
): Promise<void> {
  const ref = db().doc(paths.metaConnection(tenantId, 'main'));
  const existing = (await ref.get()).data() as MetaConnection | undefined;
  const now = Timestamp.now();
  const conn: Partial<MetaConnection> = {
    id: 'main',
    tenantId,
    metaBusinessId: fields.businessId ?? existing?.metaBusinessId ?? '',
    metaBusinessName: fields.businessName ?? existing?.metaBusinessName ?? '',
    connectedUserId: fields.byUid ?? existing?.connectedUserId ?? '',
    tokenSecretRef: fields.tokenSecretRef,
    tokenType: fields.tokenType ?? 'live',
    tokenExpiresAt: fields.tokenExpiresAtMs ? Timestamp.fromMillis(fields.tokenExpiresAtMs) : null,
    scopes: fields.scopes,
    status: fields.status ?? 'active',
    lastVerifiedAt: now,
    errorMessage: '',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(fields.source ? { source: fields.source } : {}),
  };
  await ref.set(conn, { merge: true });
}

/** Conecta Meta REAL para un tenant. Falla seguro (estados claros) y nunca loguea secretos. */
export async function runMetaConnect(tenantId: string, input: ConnectInput, byUid: string | null, graph: MetaGraphClient): Promise<ConnectResult> {
  // 1) Intercambio del code por el token (System User de larga duración en ES).
  let token = '';
  try {
    token = (await graph.exchangeCode(input.code)).accessToken;
  } catch (e) {
    logger.error('Meta connect: el intercambio del code falló', e, { tenantId });
  }
  if (!token) {
    await writeFailureStatus(tenantId, 'error', 'no se pudo intercambiar el code');
    return { ok: false, reason: 'exchange_failed', status: 'error' };
  }

  // 2) Validación del token + scopes + WABA + expiración (debug_token con app access token).
  const dbg = await graph.debugToken(token);
  if (!dbg.isValid) {
    await writeFailureStatus(tenantId, 'expired', 'token inválido');
    return { ok: false, reason: 'token_invalid', status: 'expired' };
  }
  const missing = missingScopes(dbg.scopes, META_REQUIRED_SCOPES);
  if (missing.length) {
    await writeFailureStatus(tenantId, 'permission_missing', `faltan permisos: ${missing.join(', ')}`);
    return { ok: false, reason: 'scopes_insuficientes', status: 'permission_missing' };
  }

  // 3) WABA: del input (sessionInfo del ES) o de granular_scopes del debug_token.
  const wabaId = input.wabaId || dbg.wabaIds[0];
  if (!wabaId) {
    await writeFailureStatus(tenantId, 'error', 'sin WhatsApp Business Account');
    return { ok: false, reason: 'no_waba', status: 'error' };
  }

  // 4) Phone numbers del WABA → elegir el seleccionado.
  const phones = await graph.listWabaPhoneNumbers(wabaId, token);
  const selectedPhoneNumberId = pickSelectedPhone(phones, input.phoneNumberId);
  if (!selectedPhoneNumberId) {
    await writeFailureStatus(tenantId, 'error', 'sin phone_number_id');
    return { ok: false, reason: 'no_phone_number', status: 'error' };
  }

  // 4b) PLAN-LIMITS-3A: conteo real — el plan debe permitir AL MENOS tantos números como tiene el WABA.
  // Idempotente: reconectar el MISMO WABA repite el mismo conteo (mismo resultado del gate). Si se excede,
  // NO persistimos nada (token/conexión/assets) y NO tocamos la conexión existente → el callable lanza
  // failed-precondition. Sin override de admin (no existe ese patrón; el límite es del tenant resuelto).
  const maxNumbers = (await resolveEntitlements(tenantId)).limits.maxWhatsappNumbers;
  if (phones.length > maxNumbers) {
    logger.warn('Meta connect: bloqueado por límite de números del plan', { tenantId, phones: phones.length, limit: maxNumbers });
    return { ok: false, reason: 'over_number_limit', status: 'not_connected' };
  }

  // 5) Token por REFERENCIA (SecretStore, naming seguro). Nunca en claro en Firestore.
  const tokenSecretRef = await getSecretStore().set(metaTokenSecretName(tenantId), token);

  // 6) Conexión activa (solo la referencia).
  await writeActiveConnection(tenantId, { byUid, tokenSecretRef, tokenExpiresAtMs: dbg.expiresAtMs, scopes: dbg.scopes, businessId: input.businessId, businessName: input.businessName });

  // 7) Discovery: escribe metaAssets + metaExternalIndex (resuelve inbound por phone_number_id).
  const assets = buildMetaAssets({ businessId: input.businessId, businessName: input.businessName, wabaId, wabaName: input.wabaName, phones, selectedPhoneNumberId });
  await writeDiscoveredAssets(tenantId, 'main', assets);

  // 8) Suscribir la app a la WABA para recibir webhooks (best-effort).
  try {
    await graph.subscribeApp(wabaId, token);
  } catch (e) {
    logger.warn('Meta connect: subscribeApp falló (se continúa)', { tenantId });
  }

  // 9) Preflight: ajusta el estado final (active/expired/permission_missing/error).
  try {
    await verifyWhatsappChannel(tenantId, graph);
  } catch (e) {
    logger.warn('Meta connect: preflight falló (se continúa)', { tenantId });
  }

  const phone = phones.find((p) => p.id === selectedPhoneNumberId);
  logger.info('Meta conectado (real)', { tenantId, status: 'active', assets: assets.length });
  return { ok: true, status: 'active', selectedPhoneNumberId, phoneNumber: phone?.displayPhoneNumber ?? null, assetsCount: assets.length };
}
