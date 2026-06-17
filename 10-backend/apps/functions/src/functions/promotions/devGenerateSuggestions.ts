/**
 * devGenerateSuggestions — Genera las sugerencias de promo por reglas (P8, dev/job)
 * =================================================================================
 *   POST { tenantId? }  → ese tenant, o TODOS si no viene.
 * En producción esto corre como job programado (Cloud Scheduler). Acá es manual.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { generatePromotionSuggestions } from '../../promotions/suggest.js';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';

export const devGenerateSuggestions = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
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
    const out: Record<string, number> = {};
    for (const t of tenants) out[t] = await generatePromotionSuggestions(t);
    res.json({ ok: true, generated: out });
  } catch (e) {
    logger.error('Error en devGenerateSuggestions', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});
