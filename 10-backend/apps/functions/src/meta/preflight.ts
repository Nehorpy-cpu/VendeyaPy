/**
 * meta/preflight.ts — Validación del canal WhatsApp del tenant (Fase 4B)
 * =====================================================================
 * Sin enviar mensajes ni acciones destructivas: valida el token (debug_token) y el
 * número (getPhoneNumber) vía MetaGraphClient, y actualiza el estado de la conexión
 * (active / expired / permission_missing / error) + lastVerifiedAt. El token NUNCA se loguea.
 * NO registra el número (POST /register con PIN queda fuera de 4B, por decisión).
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaConnection, MetaConnectionStatus, MetaAsset } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { getSecretStore } from '../lib/secretStore.js';
import { logger } from '../lib/logger.js';
import { META_REQUIRED_SCOPES } from './scopes.js';
import type { MetaGraphClient } from './graphClient.js';

export type PreflightReason = 'ok' | 'not_connected' | 'token_unavailable' | 'token_invalid' | 'permission_missing' | 'no_phone_asset';

export interface PreflightDecision {
  status: MetaConnectionStatus;
  ready: boolean;
  reason: PreflightReason;
}

/** Decisión PURA del estado de la conexión según token + scopes + número. */
export function decidePreflightStatus(input: { tokenValid: boolean; scopes: string[]; requiredScopes: readonly string[]; phoneFound: boolean }): PreflightDecision {
  if (!input.tokenValid) return { status: 'expired', ready: false, reason: 'token_invalid' };
  const missing = input.requiredScopes.filter((s) => !input.scopes.includes(s));
  if (missing.length) return { status: 'permission_missing', ready: false, reason: 'permission_missing' };
  if (!input.phoneFound) return { status: 'error', ready: false, reason: 'no_phone_asset' };
  return { status: 'active', ready: true, reason: 'ok' };
}

export interface PreflightResult {
  ready: boolean;
  reason: PreflightReason;
  status: MetaConnectionStatus;
  phoneNumber?: string;
}

async function updateConnectionStatus(tenantId: string, status: MetaConnectionStatus, errorMessage: string): Promise<void> {
  await db().doc(paths.metaConnection(tenantId, 'main')).set(
    { status, lastVerifiedAt: Timestamp.now(), errorMessage, updatedAt: Timestamp.now() },
    { merge: true },
  );
}

/** Valida el canal WhatsApp del tenant y actualiza su estado. No envía ni registra nada. */
export async function verifyWhatsappChannel(tenantId: string, graph: MetaGraphClient): Promise<PreflightResult> {
  const conn = (await db().doc(paths.metaConnection(tenantId, 'main')).get()).data() as MetaConnection | undefined;
  if (!conn || !conn.tokenSecretRef) {
    return { ready: false, reason: 'not_connected', status: conn?.status ?? 'not_connected' };
  }

  let token: string | null = null;
  try {
    token = await getSecretStore().get(conn.tokenSecretRef);
  } catch (e) {
    logger.error('verifyWhatsappChannel: no se pudo recuperar el token', e, { tenantId });
    token = null;
  }
  if (!token) {
    await updateConnectionStatus(tenantId, 'expired', 'token no disponible');
    return { ready: false, reason: 'token_unavailable', status: 'expired' };
  }

  const assetSnap = await db()
    .collection(paths.metaAssets(tenantId))
    .where('assetType', '==', 'whatsapp_phone_number')
    .where('selected', '==', true)
    .limit(1)
    .get();
  const pnid = (assetSnap.docs[0]?.data() as MetaAsset | undefined)?.externalId;

  const dbg = await graph.debugToken(token);
  let phoneFound = false;
  let phoneNumber: string | undefined;
  if (pnid) {
    const ph = await graph.getPhoneNumber(pnid, token);
    if (ph) {
      phoneFound = true;
      phoneNumber = ph.displayPhoneNumber || undefined;
    }
  }

  const decision = decidePreflightStatus({ tokenValid: dbg.isValid, scopes: dbg.scopes, requiredScopes: META_REQUIRED_SCOPES, phoneFound });
  await updateConnectionStatus(tenantId, decision.status, decision.reason === 'ok' ? '' : decision.reason);
  logger.info('Preflight WhatsApp', { tenantId, status: decision.status, ready: decision.ready });
  return { ready: decision.ready, reason: decision.reason, status: decision.status, phoneNumber };
}
