/**
 * devTakeoverChat — Endpoint de PRUEBA: un vendedor toma el chat (P5)
 * ==================================================================
 *   POST { from } | { orderId } [, tenantId, by]  → { ok, message }
 *
 * En producción esto lo dispara el callable `chatTakeover` desde el panel.
 * Este endpoint es solo para pruebas locales sin autenticación.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { takeoverChat } from '../../conversation/handoff.js';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import type { Order } from '@vpw/shared';

export const devTakeoverChat = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Usá POST' });
    return;
  }
  const body = (req.body ?? {}) as { from?: string; orderId?: string; tenantId?: string; by?: string };
  const tenantId = body.tenantId ?? 'perfumeria';

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
    const result = await takeoverChat(tenantId, customerId, body.by ?? 'Vendedor (prueba)');
    res.status(result.ok ? 200 : 404).json(result);
  } catch (e) {
    logger.error('Error en devTakeoverChat', e, { tenantId, customerId });
    res.status(500).json({ ok: false, error: 'internal' });
  }
});
