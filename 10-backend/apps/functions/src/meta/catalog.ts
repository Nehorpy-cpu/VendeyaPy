/**
 * meta/catalog.ts — Sincronización del catálogo al Meta Catalog (D4)
 * =================================================================
 * Nuestro panel es la fuente del catálogo; Meta RECIBE los productos. En modo demo
 * marca cada producto activo como `synced` (con su metaProductItemId) y deja un log
 * por envío. La sync real corre en Cloud Functions, nunca en el frontend (ADR-0009).
 * Idempotente.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Product, MetaCatalogSyncLog } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

const META_CATALOG_ID = 'cat-500'; // activo "catalog" del demo connect (D1)

export async function syncProductsToMetaDemo(tenantId: string): Promise<{ synced: number }> {
  const snap = await db().collection(paths.products(tenantId)).get();
  const products = snap.docs.map((d) => d.data() as Product).filter((p) => p.status === 'ACTIVE');
  const now = Timestamp.now();
  const batch = db().batch();
  let synced = 0;

  for (const p of products) {
    const itemId = `item-${p.id}`;
    const isNew = !p.metaProductItemId;
    batch.set(
      db().doc(paths.product(tenantId, p.id)),
      { syncToMeta: true, metaSyncStatus: 'synced', metaCatalogId: META_CATALOG_ID, metaProductItemId: itemId, metaLastSyncAt: now, metaSyncError: '', updatedAt: now },
      { merge: true },
    );
    const log: MetaCatalogSyncLog = { id: `log-${p.id}`, tenantId, productId: p.id, metaCatalogId: META_CATALOG_ID, metaProductItemId: itemId, action: isNew ? 'create' : 'update', status: 'success', errorMessage: '', createdAt: now };
    batch.set(db().doc(paths.metaCatalogSyncLog(tenantId, log.id)), log);
    synced++;
  }

  await batch.commit();
  logger.info('Catálogo sincronizado a Meta (demo)', { tenantId, synced });
  return { synced };
}
