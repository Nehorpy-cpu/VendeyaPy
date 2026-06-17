/**
 * meta/connect.ts — Conexión con Meta (Track D / D1)
 * ==================================================
 * En modo DEMO (Meta bloqueado) simula una conexión: crea la conexión con estado
 * `connected_limited` + activos de ejemplo. El token NUNCA va a Firestore: solo se
 * guarda `tokenSecretRef` (referencia a Secret Manager). Cuando se habilite el OAuth
 * real de Meta, esto se reemplaza por el intercambio real de tokens (ADR-0009).
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { MetaConnection } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

const DEMO_ASSETS: Array<{ type: string; ext: string; name: string }> = [
  { type: 'business', ext: 'biz-1', name: 'Mi Negocio (demo)' },
  { type: 'whatsapp_business_account', ext: 'waba-100', name: 'WhatsApp Business (demo)' },
  { type: 'whatsapp_phone_number', ext: 'wa-595', name: '+595 98x xxx-xxx (demo)' },
  { type: 'instagram_account', ext: 'ig-200', name: '@minegocio (demo)' },
  { type: 'facebook_page', ext: 'fb-300', name: 'Mi Negocio — Página (demo)' },
  { type: 'ad_account', ext: 'act_400', name: 'Cuenta de Anuncios (demo)' },
  { type: 'catalog', ext: 'cat-500', name: 'Catálogo Meta (demo)' },
  { type: 'pixel', ext: 'px-600', name: 'Pixel (demo)' },
];

/** Simula una conexión a Meta (demo): conexión + activos. */
export async function connectMetaDemo(tenantId: string, byUid?: string | null): Promise<void> {
  const now = Timestamp.now();
  const conn: MetaConnection = {
    id: 'main',
    tenantId,
    metaBusinessId: 'demo-1234567890',
    metaBusinessName: 'Mi Negocio (demo)',
    connectedUserId: byUid ?? '',
    tokenSecretRef: 'secret://demo/meta-token', // referencia, NUNCA el token real
    tokenType: 'demo',
    tokenExpiresAt: null,
    scopes: ['business_management', 'whatsapp_business_messaging', 'instagram_basic', 'pages_show_list', 'ads_read', 'catalog_management'],
    status: 'connected_limited',
    lastVerifiedAt: now,
    errorMessage: '',
    createdAt: now,
    updatedAt: now,
  };
  await db().doc(paths.metaConnection(tenantId, 'main')).set(conn);

  const batch = db().batch();
  const old = await db().collection(paths.metaAssets(tenantId)).get();
  old.docs.forEach((d) => batch.delete(d.ref));
  for (const a of DEMO_ASSETS) {
    batch.set(db().doc(paths.metaAsset(tenantId, a.ext)), {
      id: a.ext, tenantId, connectionId: 'main', assetType: a.type, externalId: a.ext, name: a.name, status: 'active', selected: true, createdAt: now, updatedAt: now,
    });
  }
  await batch.commit();
  logger.info('Conexión Meta (demo) creada', { tenantId, assets: DEMO_ASSETS.length });
}

/** Desconecta: estado not_connected + borra los activos. */
export async function disconnectMeta(tenantId: string): Promise<void> {
  await db().doc(paths.metaConnection(tenantId, 'main')).set(
    { status: 'not_connected', tokenSecretRef: '', tokenType: '', scopes: [], lastVerifiedAt: null, updatedAt: Timestamp.now() },
    { merge: true },
  );
  const assets = await db().collection(paths.metaAssets(tenantId)).get();
  const batch = db().batch();
  assets.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  logger.info('Conexión Meta desconectada', { tenantId });
}
