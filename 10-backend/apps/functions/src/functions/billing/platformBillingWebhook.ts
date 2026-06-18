/**
 * platformBillingWebhook — Webhook de billing de plataforma (Stripe Billing) — Fase 4
 * ===================================================================================
 * Cobro de la SUSCRIPCIÓN del SaaS a cada empresa. Verifica firma + idempotente, y
 * SUSPENDE/REACTIVA la empresa según el estado de su suscripción (subscription.metadata.tenantId).
 * Reusa la verificación de firma de Stripe (Fase 3). Fail-closed sin secreto → 401.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from '../../lib/logger.js';
import { db, paths } from '../../lib/firebase.js';
import { verifyStripeSignature } from '../../payments/stripeSignature.js';
import { claimEventOnce } from '../../payments/idempotency.js';
import { normalizeStripeStatus, tenantStatusForSubscription } from '../../billing/platformBilling.js';
import { setTenantStatus } from '../../tenants/lifecycle.js';

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

interface SubEvent {
  id?: string;
  type?: string;
  data?: { object?: { id?: string; status?: string; customer?: string; metadata?: { tenantId?: string } } };
}

export const platformBillingWebhook = onRequest({ region: 'us-central1', cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }
  const secret = process.env.PLATFORM_BILLING_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('platformBillingWebhook: falta el secreto de firma; se rechaza');
    res.status(401).json({ ok: false, error: 'not configured' });
    return;
  }
  try {
    verifyStripeSignature(req.rawBody, req.get('stripe-signature'), secret);
  } catch {
    logger.warn('platformBillingWebhook: firma inválida');
    res.status(401).json({ ok: false, error: 'invalid signature' });
    return;
  }
  try {
    const event = JSON.parse(req.rawBody.toString('utf8')) as SubEvent;
    if (!event.id || !event.type) {
      res.status(400).json({ ok: false, error: 'evento sin id/type' });
      return;
    }
    if (!SUBSCRIPTION_EVENTS.has(event.type)) {
      res.status(200).json({ ok: true, ignored: event.type });
      return;
    }
    if (!(await claimEventOnce(paths.platformBillingEvents(), event.id, { type: event.type }))) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    const obj = event.data?.object ?? {};
    const tenantId = obj.metadata?.tenantId;
    if (!tenantId) {
      res.status(200).json({ ok: true, warning: 'suscripción sin metadata.tenantId' });
      return;
    }
    const subStatus = event.type === 'customer.subscription.deleted' ? 'canceled' : normalizeStripeStatus(obj.status ?? 'active');
    const tenantStatus = tenantStatusForSubscription(subStatus);
    const now = Timestamp.now();
    await db().doc(paths.tenant(tenantId)).set(
      {
        subscription: { status: subStatus, stripeSubscriptionId: obj.id ?? null, stripeCustomerId: obj.customer ?? null, updatedAt: now },
        updatedAt: now,
      },
      { merge: true },
    );
    await setTenantStatus(tenantId, tenantStatus);
    logger.info('Billing de plataforma: empresa actualizada', { tenantId, subStatus, tenantStatus });
    res.status(200).json({ ok: true, tenantStatus });
  } catch (e) {
    logger.error('Error en platformBillingWebhook', e);
    res.status(200).json({ ok: false });
  }
});
