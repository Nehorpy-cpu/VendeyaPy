/**
 * devReleaseChat — Endpoint de PRUEBA: el vendedor devuelve el chat al bot (F6b)
 * =============================================================================
 *   POST { from } | { orderId } [, tenantId]  → { ok, message }
 *
 * En producción esto lo dispara el vendedor desde el panel/inbox (un botón
 * "devolver al bot"). Acá lo simulamos con un endpoint.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { guardDevEndpoint } from '../../middleware/devGuard.js';
import { releaseToBot } from '../../conversation/handoff.js';
import { reactivarResumeTrasLiberacion } from '../../conversation/coverageResume.js';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import type { Order } from '@vpw/shared';

export const devReleaseChat = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    if (!guardDevEndpoint(req, res)) return;
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Usá POST' });
      return;
    }
    const body = (req.body ?? {}) as { from?: string; orderId?: string; tenantId?: string };
    if (!body.tenantId) { res.status(400).json({ ok: false, error: 'Falta tenantId' }); return; }
    const tenantId = body.tenantId;

    let customerId: string | undefined;
    if (body.from) {
      customerId = body.from.replace(/[^0-9]/g, '');
    } else if (body.orderId) {
      const orderSnap = await db().doc(paths.order(tenantId, body.orderId)).get();
      customerId = (orderSnap.data() as Order | undefined)?.customerId;
    }
    if (!customerId) {
      res.status(400).json({ ok: false, error: 'Falta from u orderId válido' });
      return;
    }

    try {
      const result = await releaseToBot(tenantId, customerId);
      // COVERAGE-1D: si había una reanudación retenida por este takeover, re-encolarla.
      if (result.ok) await reactivarResumeTrasLiberacion(tenantId, customerId);
      res.status(result.ok ? 200 : 404).json(result);
    } catch (e) {
      logger.error('Error en devReleaseChat', e, { tenantId, customerId });
      res.status(500).json({ ok: false, error: 'internal' });
    }
  },
);
