/**
 * devComputeTracking — Calcula la atribución del tracking propio (P11, dev/job)
 * ===========================================================================
 *   POST { tenantId? }  → ese tenant, o TODOS. En prod: job / al confirmar pagos.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { computeTrackingAttribution } from '../../tracking/tracking.js';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';

export const devComputeTracking = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Usá POST' }); return; }
  const body = (req.body ?? {}) as { tenantId?: string };
  try {
    let tenants: string[];
    if (body.tenantId) tenants = [body.tenantId];
    else tenants = (await db().collection(paths.tenants()).get()).docs.map((d) => d.id);
    const out: Record<string, number> = {};
    for (const t of tenants) out[t] = await computeTrackingAttribution(t);
    res.json({ ok: true, tracked: out });
  } catch (e) {
    logger.error('Error en devComputeTracking', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});
