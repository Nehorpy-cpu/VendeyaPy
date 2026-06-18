/**
 * meta/oauth.ts — Intercambio OAuth real de Meta (Fase 3, "listo para conectar")
 * ==============================================================================
 * Cuando Meta esté habilitado (App Review/verificación — ver ADR-0010): intercambia
 * el `code` del Embedded Signup por un token de larga duración y lo guarda VÍA
 * SecretStore — sólo la REFERENCIA va a la MetaConnection (el token NUNCA en claro).
 * Env-gated: requiere META_APP_ID / META_APP_SECRET / META_OAUTH_REDIRECT_URI.
 * En modo demo se sigue usando connectMetaDemo (connect.ts), que NO llama acá.
 */
import axios from 'axios';
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaConnection } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { getSecretStore } from '../lib/secretStore.js';
import { metaTokenSecretName } from './secretName.js';
import { logger } from '../lib/logger.js';

const GRAPH = 'https://graph.facebook.com/v19.0';

export interface MetaTokenResult {
  accessToken: string;
  tokenType: string;
  expiresInSec: number | null;
}

/** Intercambia el `code` por un access token (OAuth real). Requiere META_APP_* en entorno. */
export async function exchangeCodeForToken(code: string): Promise<MetaTokenResult> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirect = process.env.META_OAUTH_REDIRECT_URI;
  if (!appId || !appSecret || !redirect) {
    throw new Error('Meta OAuth no configurado (META_APP_ID / META_APP_SECRET / META_OAUTH_REDIRECT_URI)');
  }
  const res = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: { client_id: appId, client_secret: appSecret, redirect_uri: redirect, code },
    timeout: 10_000,
  });
  return {
    accessToken: res.data.access_token,
    tokenType: res.data.token_type ?? 'bearer',
    expiresInSec: res.data.expires_in ?? null,
  };
}

/**
 * Conexión REAL de Meta: intercambia el code, guarda el token POR REFERENCIA y crea/
 * actualiza la MetaConnection con esa referencia (nunca el token). El descubrimiento de
 * assets se hace después con el token recuperado del SecretStore.
 */
export async function connectMetaReal(tenantId: string, code: string, byUid?: string | null): Promise<void> {
  const token = await exchangeCodeForToken(code);
  // Naming SEGURO (Fase 4B): sin '/', válido para SecretStore (antes rompía la ruta del doc).
  const ref = await getSecretStore().set(metaTokenSecretName(tenantId), token.accessToken);
  const now = Timestamp.now();
  const conn: Partial<MetaConnection> = {
    id: 'main',
    tenantId,
    connectedUserId: byUid ?? '',
    tokenSecretRef: ref, // sólo la referencia opaca
    tokenType: token.tokenType,
    tokenExpiresAt: token.expiresInSec ? Timestamp.fromMillis(now.toMillis() + token.expiresInSec * 1000) : null,
    status: 'active',
    lastVerifiedAt: now,
    errorMessage: '',
    updatedAt: now,
  };
  await db().doc(paths.metaConnection(tenantId, 'main')).set(conn, { merge: true });
  logger.info('Conexión Meta REAL creada (token por referencia)', { tenantId });
}
