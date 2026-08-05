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
import { ASSET_STATUS_DESCONECTADO } from './discovery.js';
import { getSecretStore } from '../lib/secretStore.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../audit/audit.js';

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
  // Índice global: resuelve qué empresa es cada id externo cuando llega un webhook.
  const PLATFORM_BY_ASSET: Record<string, string> = { whatsapp_phone_number: 'whatsapp', instagram_account: 'instagram', facebook_page: 'messenger' };
  for (const a of DEMO_ASSETS) {
    const platform = PLATFORM_BY_ASSET[a.type];
    if (!platform) continue;
    const id = `${platform}_${a.ext}`;
    batch.set(db().doc(paths.metaExternalIndexEntry(id)), { id, tenantId, connectionId: 'main', assetType: a.type, platform, externalId: a.ext, status: 'active', updatedAt: now });
  }
  await batch.commit();
  logger.info('Conexión Meta (demo) creada', { tenantId, assets: DEMO_ASSETS.length });
  await recordAudit({ tenantId, action: 'meta.connected', actorUid: byUid ?? null, targetType: 'meta', summary: 'Conexión Meta creada (demo)' });
}

/**
 * Desconecta: estado not_connected + saca del ruteo + borra el secreto del token.
 *
 * ADR-0017 — LOS NÚMEROS DE WHATSAPP NO SE BORRAN. Este callable es una operación NORMAL del panel
 * (un click de TENANT_OWNER en Integraciones) y hasta este cambio borraba todos los `metaAssets`
 * del tenant. Desde que el permiso de automatización vive en el asset, eso significaba que al
 * reconectar `writeDiscoveredAssets` no encontraba NADA que preservar: el número que está
 * atendiendo clientes se reescribía sin `automationMode` ⇒ `inactive` por fail-closed ⇒ mudo, con
 * cada inbound cerrándose sin respuesta hasta que alguien lo volviera a habilitar a mano.
 *
 * Ahora el asset del número se MARCA (merge, sin tocar `automationMode` ni `sessionKey`) con un
 * estado propio, distinto del que deja apagar un número a mano — ver `ASSET_STATUS_DESCONECTADO`,
 * que es donde vive el porqué de la distinción.
 *
 * LO QUE APAGA AL NÚMERO SIGUE SIENDO LO MISMO QUE ANTES, y por eso desconectar no se afloja:
 * sin entrada en `metaExternalIndex` el inbound no resuelve empresa y no se procesa; sin token y
 * con la conexión en `not_connected` no salen credenciales para enviar. El permiso queda guardado,
 * pero no habilita nada por sí solo.
 *
 * El resto de los activos (WABA, página, catálogo, pixel…) se sigue borrando: no llevan permiso ni
 * estado de conversación, así que conservarlos solo dejaría basura.
 */
export async function disconnectMeta(tenantId: string): Promise<void> {
  const connRef = db().doc(paths.metaConnection(tenantId, 'main'));
  const prevTokenRef = (await connRef.get()).data()?.tokenSecretRef as string | undefined;
  await connRef.set(
    { status: 'not_connected', tokenSecretRef: '', tokenType: '', scopes: [], lastVerifiedAt: null, updatedAt: Timestamp.now() },
    { merge: true },
  );
  // Borra el secreto cifrado del tenant (evita huérfanos en `secrets`). No-op si la
  // referencia no es de SecretStore (p.ej. la demo usa secret://demo/...).
  if (prevTokenRef) {
    await getSecretStore().remove(prevTokenRef).catch(() => logger.warn('disconnectMeta: no se pudo borrar el secreto referenciado', { tenantId }));
  }
  const assets = await db().collection(paths.metaAssets(tenantId)).get();
  const idx = await db().collection(paths.metaExternalIndex()).where('tenantId', '==', tenantId).get();
  const now = Timestamp.now();
  const batch = db().batch();
  // «Desconectar» es una operación sobre la conexión MAIN, no sobre el tenant entero. Los números
  // de otras conexiones (`wa_{pnid}`, Coexistence/multi-número) tienen su propio ciclo de vida
  // (`deactivateWhatsappNumber`) y NO se tocan: borrarles el ruteo acá dejaba mudo, con un solo
  // click del panel, a un número que esta conexión ni administra — en `shadow` la observación
  // moría en silencio, y después del cutover ese número es EL QUE VENDE. Mismo criterio
  // `connectionId ?? 'main'` que usa la limpieza del discovery.
  const esDeMain = (data: { connectionId?: unknown }): boolean => (data.connectionId ?? 'main') === 'main';
  assets.docs.forEach((d) => {
    const data = d.data() as { assetType?: unknown; connectionId?: unknown };
    if (!esDeMain(data)) return;
    if (data.assetType === 'whatsapp_phone_number') {
      // MERGE a propósito: `automationMode` y `sessionKey` no se nombran, así que no se tocan.
      // Escribirlos —aunque fuera con su valor actual— convertiría esto en una decisión sobre el
      // permiso del número, y desconectar no es eso.
      batch.set(d.ref, { status: ASSET_STATUS_DESCONECTADO, updatedAt: now }, { merge: true });
      return;
    }
    batch.delete(d.ref);
  });
  // El índice SÍ se borra — pero solo el de ESTA conexión: es su ruteo, y es lo que deja al
  // número de main efectivamente callado.
  idx.docs.forEach((d) => {
    if (esDeMain(d.data() as { connectionId?: unknown })) batch.delete(d.ref);
  });
  await batch.commit();
  logger.info('Conexión Meta desconectada', { tenantId });
  await recordAudit({ tenantId, action: 'meta.disconnected', targetType: 'meta', summary: 'Conexión Meta desconectada' });
}
