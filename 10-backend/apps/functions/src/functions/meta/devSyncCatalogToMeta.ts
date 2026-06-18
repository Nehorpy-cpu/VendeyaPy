/**
 * devSyncCatalogToMeta — Sincroniza el catálogo al Meta Catalog (D4, dev/job)
 * ==========================================================================
 *   POST { tenantId? }  → ese tenant, o TODOS. En prod: job / al editar productos.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { syncProductsToMetaDemo } from '../../meta/catalog.js';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';

export const devSyncCatalogToMeta = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Usá POST' }); return; }
  const body = (req.body ?? {}) as { tenantId?: string };
  try {
    let tenants: string[];
    if (body.tenantId) tenants = [body.tenantId];
    else tenants = (await db().collection(paths.tenants()).get()).docs.map((d) => d.id);
    const out: Record<string, unknown> = {};
    for (const t of tenants) out[t] = await syncProductsToMetaDemo(t);
    res.json({ ok: true, synced: out });
  } catch (e) {
    logger.error('Error en devSyncCatalogToMeta', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});
