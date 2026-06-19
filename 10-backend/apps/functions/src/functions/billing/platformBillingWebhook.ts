/**
 * platformBillingWebhook — Webhook de billing de plataforma (Stripe Billing) — Fase 4 · 5B
 * =======================================================================================
 * Cobro de la SUSCRIPCIÓN del SaaS vía Stripe. Verifica firma + idempotente. Sincroniza el
 * plan desde el Price ID confirmado por Stripe (price→plan), el estado, el período y la
 * ventana de gracia (pastDueSince) y delega la escritura en applySubscriptionUpdate
 * (compartido con PayPal, Fase 5B-ii). NO suspende la cuenta; el frontend nunca decide el plan.
 */
import { onRequest } from 'firebase-functions/v2/https';
import type { Tenant } from '@vpw/shared';
import { logger } from '../../lib/logger.js';
import { db, paths } from '../../lib/firebase.js';
import { verifyStripeSignature } from '../../payments/stripeSignature.js';
import { claimEventOnce } from '../../payments/idempotency.js';
import { getStripePriceToPlan } from '../../billing/priceMap.js';
import { deriveSubscriptionUpdate, type StripeSubEvent } from '../../billing/subscriptionSync.js';
import { applySubscriptionUpdate } from '../../billing/applySubscription.js';

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

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
    const event = JSON.parse(req.rawBody.toString('utf8')) as StripeSubEvent;
    if (!event.id || !event.type) {
      res.status(400).json({ ok: false, error: 'evento sin id/type' });
      return;
    }
    if (!SUBSCRIPTION_EVENTS.has(event.type)) {
      res.status(200).json({ ok: true, ignored: event.type });
      return;
    }
    if (!(await claimEventOnce(paths.platformBillingEvents(), event.id, { type: event.type, provider: 'stripe' }))) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    const tenantIdHint = event.data?.object?.metadata?.tenantId;
    if (!tenantIdHint) {
      res.status(200).json({ ok: true, warning: 'suscripción sin metadata.tenantId' });
      return;
    }
    const tenant = (await db().doc(paths.tenant(tenantIdHint)).get()).data() as Partial<Tenant> | undefined;
    const prevPastDueSinceMs = tenant?.subscription?.pastDueSince ? tenant.subscription.pastDueSince.toMillis() : null;

    const upd = deriveSubscriptionUpdate(event, getStripePriceToPlan(), { pastDueSinceMs: prevPastDueSinceMs }, Date.now());
    const tenantId = upd.tenantId ?? tenantIdHint;
    await applySubscriptionUpdate(tenantId, upd);

    logger.info('Billing de plataforma: suscripción Stripe sincronizada', { tenantId, status: upd.status, planId: upd.planId ?? tenant?.planId, pastDue: !!upd.pastDueSinceMs });
    res.status(200).json({ ok: true, status: upd.status, planId: upd.planId ?? tenant?.planId ?? 'free' });
  } catch (e) {
    logger.error('Error en platformBillingWebhook', e);
    res.status(200).json({ ok: false });
  }
});
