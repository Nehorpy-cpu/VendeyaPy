/**
 * stripeWebhook — Webhook REAL de Stripe (Fase 3)
 * ===============================================
 * 1) Verifica la firma `Stripe-Signature` sobre el RAW body (anti-forgery + anti-replay).
 * 2) Procesa el evento UNA sola vez (idempotente, claimEventOnce).
 * 3) Confirma la orden con confirmPayment (ya idempotente → registra el evento Purchase).
 *
 * Requiere STRIPE_WEBHOOK_SECRET (fail-closed: sin secreto → 401). La sesión de pago se
 * crea con metadata { tenantId, orderId } al generar el link de pago (ver docs/integrations.md).
 */
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from '../../lib/logger.js';
import { paths } from '../../lib/firebase.js';
import { verifyStripeSignature } from '../../payments/stripeSignature.js';
import { claimEventOnce } from '../../payments/idempotency.js';
import { confirmPayment } from '../../orders/confirmPayment.js';

const RELEVANT = new Set(['checkout.session.completed', 'payment_intent.succeeded']);

interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: { metadata?: { tenantId?: string; orderId?: string } } };
}

export const stripeWebhook = onRequest({ region: 'us-central1', cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('stripeWebhook: falta STRIPE_WEBHOOK_SECRET; se rechaza por seguridad');
    res.status(401).json({ ok: false, error: 'not configured' });
    return;
  }

  // 1) Firma sobre el RAW body.
  try {
    verifyStripeSignature(req.rawBody, req.get('stripe-signature'), secret);
  } catch {
    logger.warn('stripeWebhook: firma inválida, rechazado');
    res.status(401).json({ ok: false, error: 'invalid signature' });
    return;
  }

  // 2) Parse + idempotencia + confirmación.
  try {
    const event = JSON.parse(req.rawBody.toString('utf8')) as StripeEvent;
    if (!event.id || !event.type) {
      res.status(400).json({ ok: false, error: 'evento sin id/type' });
      return;
    }
    if (!RELEVANT.has(event.type)) {
      res.status(200).json({ ok: true, ignored: event.type });
      return;
    }
    const first = await claimEventOnce(paths.stripeWebhookEvents(), event.id, { type: event.type });
    if (!first) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    const md = event.data?.object?.metadata ?? {};
    if (!md.tenantId || !md.orderId) {
      logger.warn('stripeWebhook: evento sin metadata tenantId/orderId', { eventId: event.id });
      res.status(200).json({ ok: true, warning: 'sin metadata tenantId/orderId' });
      return;
    }
    const result = await confirmPayment(md.tenantId, md.orderId);
    logger.info('stripeWebhook procesado', { tenantId: md.tenantId, orderId: md.orderId, ok: result.ok });
    res.status(200).json({ ok: true });
  } catch (e) {
    logger.error('Error en stripeWebhook', e);
    // 200 para no disparar reintentos infinitos de Stripe ante errores de negocio.
    res.status(200).json({ ok: false });
  }
});
