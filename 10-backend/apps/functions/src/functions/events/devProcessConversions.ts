/**
 * devProcessConversions — Capa de eventos → Conversions API (D6, dev/job)
 * ======================================================================
 *   POST { tenantId? }  → backfill de eventos Purchase (de pedidos PAID) + envío
 *   a Meta (demo). En prod: el envío corre como job tras cada evento.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { guardDevEndpoint } from '../../middleware/devGuard.js';
import { backfillBusinessEvents, sendConversionEvents } from '../../events/businessEvents.js';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';

export const devProcessConversions = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (!guardDevEndpoint(req, res)) return;
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Usá POST' }); return; }
  const body = (req.body ?? {}) as { tenantId?: string };
  try {
    let tenants: string[];
    if (body.tenantId) tenants = [body.tenantId];
    else tenants = (await db().collection(paths.tenants()).get()).docs.map((d) => d.id);
    const out: Record<string, unknown> = {};
    for (const t of tenants) {
      const events = await backfillBusinessEvents(t);
      const send = await sendConversionEvents(t);
      out[t] = { events, ...send };
    }
    res.json({ ok: true, processed: out });
  } catch (e) {
    logger.error('Error en devProcessConversions', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});
