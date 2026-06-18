/**
 * devSyncMetaAds — Sincroniza Meta Ads en modo demo (D3, dev/job)
 * ==============================================================
 *   POST { tenantId? }  → ese tenant, o TODOS. En prod: job programado (Cloud Scheduler).
 */

import { onRequest } from 'firebase-functions/v2/https';
import { guardDevEndpoint } from '../../middleware/devGuard.js';
import { syncMetaAdsDemo } from '../../meta/ads.js';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';

export const devSyncMetaAds = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (!guardDevEndpoint(req, res)) return;
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Usá POST' }); return; }
  const body = (req.body ?? {}) as { tenantId?: string };
  try {
    let tenants: string[];
    if (body.tenantId) tenants = [body.tenantId];
    else tenants = (await db().collection(paths.tenants()).get()).docs.map((d) => d.id);
    const out: Record<string, unknown> = {};
    for (const t of tenants) out[t] = await syncMetaAdsDemo(t);
    res.json({ ok: true, synced: out });
  } catch (e) {
    logger.error('Error en devSyncMetaAds', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});
