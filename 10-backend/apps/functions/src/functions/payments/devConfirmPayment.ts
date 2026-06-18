/**
 * devConfirmPayment — Endpoint de PRUEBA para confirmar un pago (F6.2)
 * ====================================================================
 * Simula el webhook de la pasarela sin necesidad de credenciales reales.
 *   POST { orderId } | { from } [, tenantId]
 *   → { ok, message, status }
 *
 * Si se pasa `from` (teléfono) en vez de `orderId`, busca la orden pendiente
 * de ese cliente en su sesión. En producción, el webhook real de Bancard/Stripe
 * (con validación de firma) llamará a confirmPayment() en su lugar.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { guardDevEndpoint } from '../../middleware/devGuard.js';
import { confirmPayment } from '../../orders/confirmPayment.js';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';

export const devConfirmPayment = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    if (!guardDevEndpoint(req, res)) return;
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Usá POST' });
      return;
    }
    const body = (req.body ?? {}) as { orderId?: string; from?: string; tenantId?: string };
    if (!body.tenantId) { res.status(400).json({ ok: false, error: 'Falta tenantId' }); return; }
    const tenantId = body.tenantId;

    let orderId = body.orderId;
    // Si no dieron orderId, buscar la orden pendiente del cliente por su teléfono.
    if (!orderId && body.from) {
      const customerId = body.from.replace(/[^0-9]/g, '');
      const sessionSnap = await db().doc(paths.session(tenantId, customerId)).get();
      orderId = sessionSnap.data()?.context?.pendingOrderId ?? undefined;
    }
    if (!orderId) {
      res.status(400).json({ ok: false, error: 'Falta orderId (o from con orden pendiente)' });
      return;
    }

    try {
      const result = await confirmPayment(tenantId, orderId);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      logger.error('Error en devConfirmPayment', e, { tenantId, orderId });
      res.status(500).json({ ok: false, error: 'internal' });
    }
  },
);
