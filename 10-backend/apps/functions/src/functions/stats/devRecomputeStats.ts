/**
 * devRecomputeStats — Recálculo manual de agregados (P7, dev/backfill)
 * ===================================================================
 *   POST { tenantId? }  → si viene tenantId recalcula ese; si no, TODOS.
 *   Siempre recalcula además platformStats (Super Admin).
 *
 * En producción este recálculo lo mantiene el trigger onOrderWriteStats y/o un
 * job programado (Cloud Scheduler). Este endpoint sirve para backfill y pruebas.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { guardDevEndpoint } from '../../middleware/devGuard.js';
import { recomputeTenantStats, recomputePlatformStats } from '../../stats/computeStats.js';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';

export const devRecomputeStats = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (!guardDevEndpoint(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Usá POST' });
    return;
  }
  const body = (req.body ?? {}) as { tenantId?: string };
  try {
    let tenants: string[];
    if (body.tenantId) {
      tenants = [body.tenantId];
    } else {
      const snap = await db().collection(paths.tenants()).get();
      tenants = snap.docs.map((d) => d.id);
    }
    for (const t of tenants) await recomputeTenantStats(t);
    await recomputePlatformStats();
    res.json({ ok: true, tenants });
  } catch (e) {
    logger.error('Error en devRecomputeStats', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});
