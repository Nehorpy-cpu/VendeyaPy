/**
 * messaging/resolveWhatsappCreds.ts — Credenciales de WhatsApp POR TENANT (Fase 4A)
 * ================================================================================
 * Junta tres piezas que ya existen por tenant pero no estaban cableadas al envío:
 *   1. MetaConnection (tenants/{t}/metaConnections/main): estado + tokenSecretRef.
 *   2. metaAsset whatsapp_phone_number (selected): el phone_number_id real.
 *   3. SecretStore.get(tokenSecretRef): el access_token en claro (nunca en Firestore).
 *
 * La DECISIÓN es pura (decideWhatsappCreds) y testeable; el wrapper hace la E/S y
 * NUNCA loguea el token. Si algo falla, devuelve un motivo claro (→ el caller usa Mock).
 *
 * Discovery real del phone_number_id (poblar metaAssets vía Graph al conectar) y el
 * OAuth/Embedded Signup self-service quedan para Fase 4B; aquí se usan assets ya seedeados.
 */

import type { MetaConnection, MetaAsset } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { getSecretStore } from '../lib/secretStore.js';
import { logger } from '../lib/logger.js';

export type WhatsappCredsReason =
  | 'no_tenant'
  | 'not_connected'
  | 'token_expired'
  | 'no_phone_asset'
  | 'token_unavailable';

export type WhatsappCredsResult =
  | { ok: true; phoneNumberId: string; accessToken: string; tokenExpiresAtMs: number | null }
  | { ok: false; reason: WhatsappCredsReason };

export interface DecideInput {
  tenantId?: string;
  connectionStatus?: string | null;
  tokenExpiresAtMs?: number | null;
  phoneNumberId?: string | null;
  token?: string | null;
  nowMs: number;
}

/** Decisión PURA (sin E/S, sin secretos) → unit-testeable. */
export function decideWhatsappCreds(i: DecideInput): WhatsappCredsResult {
  if (!i.tenantId) return { ok: false, reason: 'no_tenant' };
  if (i.connectionStatus !== 'active') return { ok: false, reason: 'not_connected' };
  if (i.tokenExpiresAtMs != null && i.tokenExpiresAtMs <= i.nowMs) return { ok: false, reason: 'token_expired' };
  if (!i.phoneNumberId) return { ok: false, reason: 'no_phone_asset' };
  if (!i.token) return { ok: false, reason: 'token_unavailable' };
  return { ok: true, phoneNumberId: i.phoneNumberId, accessToken: i.token, tokenExpiresAtMs: i.tokenExpiresAtMs ?? null };
}

/** Resuelve las credenciales reales del tenant (E/S). No lanza: errores → motivo claro. */
export async function resolveTenantWhatsappCreds(tenantId?: string): Promise<WhatsappCredsResult> {
  const nowMs = Date.now();
  if (!tenantId) return decideWhatsappCreds({ nowMs });
  try {
    const conn = (await db().doc(paths.metaConnection(tenantId, 'main')).get()).data() as MetaConnection | undefined;
    const connectionStatus = conn?.status ?? null;
    const tokenExpiresAtMs = conn?.tokenExpiresAt ? conn.tokenExpiresAt.toMillis() : null;
    if (connectionStatus !== 'active') return decideWhatsappCreds({ tenantId, connectionStatus, nowMs });

    const assetSnap = await db()
      .collection(paths.metaAssets(tenantId))
      .where('assetType', '==', 'whatsapp_phone_number')
      .where('selected', '==', true)
      .limit(1)
      .get();
    const phoneNumberId = (assetSnap.docs[0]?.data() as MetaAsset | undefined)?.externalId ?? null;

    let token: string | null = null;
    if (conn?.tokenSecretRef) {
      try {
        token = await getSecretStore().get(conn.tokenSecretRef);
      } catch (e) {
        // El secreto no se pudo recuperar/descifrar; NO exponer el token en el log.
        logger.error('resolveTenantWhatsappCreds: no se pudo recuperar el token', e, { tenantId });
        token = null;
      }
    }
    return decideWhatsappCreds({ tenantId, connectionStatus, tokenExpiresAtMs, phoneNumberId, token, nowMs });
  } catch (e) {
    logger.error('resolveTenantWhatsappCreds: error resolviendo credenciales', e, { tenantId });
    return { ok: false, reason: 'token_unavailable' };
  }
}

/**
 * Credenciales de UN número específico del tenant (MULTI-NUMBER-1): el asset del pnid
 * (doc id = externalId) → su conexión (main o wa_{pnid}) → su token. Así la respuesta
 * sale por el MISMO número que recibió el mensaje. No lanza; motivo claro → Mock.
 */
export async function resolveTenantWhatsappCredsFor(tenantId: string, phoneNumberId: string): Promise<WhatsappCredsResult> {
  const nowMs = Date.now();
  try {
    const asset = (await db().doc(paths.metaAsset(tenantId, phoneNumberId)).get()).data() as
      | (MetaAsset & { connectionId?: string })
      | undefined;
    if (!asset || asset.assetType !== 'whatsapp_phone_number' || asset.status !== 'active') {
      return decideWhatsappCreds({ tenantId, connectionStatus: null, nowMs }); // → not_connected
    }
    const connectionId = asset.connectionId ?? 'main';
    const conn = (await db().doc(paths.metaConnection(tenantId, connectionId)).get()).data() as MetaConnection | undefined;
    const connectionStatus = conn?.status ?? null;
    const tokenExpiresAtMs = conn?.tokenExpiresAt ? conn.tokenExpiresAt.toMillis() : null;
    if (connectionStatus !== 'active') return decideWhatsappCreds({ tenantId, connectionStatus, nowMs });
    let token: string | null = null;
    if (conn?.tokenSecretRef) {
      try {
        token = await getSecretStore().get(conn.tokenSecretRef);
      } catch (e) {
        logger.error('resolveTenantWhatsappCredsFor: no se pudo recuperar el token', e, { tenantId, phoneNumberId });
        token = null;
      }
    }
    return decideWhatsappCreds({ tenantId, connectionStatus, tokenExpiresAtMs, phoneNumberId, token, nowMs });
  } catch (e) {
    logger.error('resolveTenantWhatsappCredsFor: error resolviendo credenciales', e, { tenantId, phoneNumberId });
    return { ok: false, reason: 'token_unavailable' };
  }
}
