/**
 * devSubmitComprobante — Endpoint de PRUEBA: el cliente "envía" el comprobante (F6b.2)
 * ====================================================================================
 * Simula la recepción del comprobante de transferencia sin WhatsApp real.
 *   POST { from } | { orderId } [, tenantId, comprobanteUrl]
 *   → { ok, message, sellerName }
 *
 * En producción, el webhook de WhatsApp (F1) detecta la imagen entrante mientras la
 * orden está AWAITING_PAYMENT, la sube a Storage y llama a submitComprobante().
 */

import { onRequest } from 'firebase-functions/v2/https';
import { submitComprobante } from '../../orders/submitComprobante.js';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';

export const devSubmitComprobante = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Usá POST' });
      return;
    }
    const body = (req.body ?? {}) as {
      orderId?: string;
      from?: string;
      tenantId?: string;
      comprobanteUrl?: string;
    };
    const tenantId = body.tenantId ?? 'perfumeria';

    let orderId = body.orderId;
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
      const result = await submitComprobante(tenantId, orderId, body.comprobanteUrl);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      logger.error('Error en devSubmitComprobante', e, { tenantId, orderId });
      res.status(500).json({ ok: false, error: 'internal' });
    }
  },
);
