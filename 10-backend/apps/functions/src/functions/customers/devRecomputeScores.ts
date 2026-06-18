/**
 * devRecomputeScores — Recalcula score/segmento de clientes (P12, dev/job)
 * =======================================================================
 *   POST { tenantId? }  → ese tenant, o TODOS. En prod: job programado.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { guardDevEndpoint } from '../../middleware/devGuard.js';
import { recomputeCustomerScores } from '../../customers/score.js';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';

export const devRecomputeScores = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (!guardDevEndpoint(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Usá POST' });
    return;
  }
  const body = (req.body ?? {}) as { tenantId?: string };
  try {
    let tenants: string[];
    if (body.tenantId) tenants = [body.tenantId];
    else tenants = (await db().collection(paths.tenants()).get()).docs.map((d) => d.id);
    const out: Record<string, number> = {};
    for (const t of tenants) out[t] = await recomputeCustomerScores(t);
    res.json({ ok: true, scored: out });
  } catch (e) {
    logger.error('Error en devRecomputeScores', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});
