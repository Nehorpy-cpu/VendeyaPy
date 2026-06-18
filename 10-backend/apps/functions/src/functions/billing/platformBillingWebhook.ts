/**
 * platformBillingWebhook — Webhook de billing de plataforma (Stripe Billing) — Fase 4 · 5B-i
 * =========================================================================================
 * Cobro de la SUSCRIPCIÓN del SaaS. Verifica firma + idempotente. Sincroniza el plan desde el
 * Price ID confirmado por Stripe (price→plan), el estado, el período y la ventana de gracia
 * (pastDueSince). Escribe tenant.subscription + tenant.planId + tenant.limits (caché) e invalida
 * los entitlements. NO suspende la cuenta (datos/acceso básico preservados; premium vía posture).
 * Nunca confía en datos del frontend: el plan efectivo sale del precio que Stripe confirmó.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { Tenant } from '@vpw/shared';
import { logger } from '../../lib/logger.js';
import { db, paths } from '../../lib/firebase.js';
import { verifyStripeSignature } from '../../payments/stripeSignature.js';
import { claimEventOnce } from '../../payments/idempotency.js';
import { getStripePriceToPlan } from '../../billing/priceMap.js';
import { deriveSubscriptionUpdate, type StripeSubEvent } from '../../billing/subscriptionSync.js';
import { getPlan } from '../../plans/plans.js';
import { effectiveLimits } from '../../entitlements/decide.js';
import { invalidateEntitlements } from '../../entitlements/entitlements.js';

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
    if (!(await claimEventOnce(paths.platformBillingEvents(), event.id, { type: event.type }))) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    // Estado previo del tenant (para preservar pastDueSince y resolver el plan denormalizado).
    const map = getStripePriceToPlan();
    const tenantIdHint = event.data?.object?.metadata?.tenantId;
    if (!tenantIdHint) {
      res.status(200).json({ ok: true, warning: 'suscripción sin metadata.tenantId' });
      return;
    }
    const tenant = (await db().doc(paths.tenant(tenantIdHint)).get()).data() as Partial<Tenant> | undefined;
    const prevPastDueSinceMs = tenant?.subscription?.pastDueSince ? tenant.subscription.pastDueSince.toMillis() : null;

    const upd = deriveSubscriptionUpdate(event, map, { pastDueSinceMs: prevPastDueSinceMs }, Date.now());
    const tenantId = upd.tenantId ?? tenantIdHint;
    const now = Timestamp.now();
    const newPlanId = upd.planId ?? tenant?.planId ?? 'free';

    // Límites denormalizados del plan SELECCIONADO (caché de display; la fuente real es
    // resolveEntitlements, que degrada a free el plan EFECTIVO si el billing no permite premium).
    const plan = await getPlan(newPlanId);
    const cachedLimits = plan ? effectiveLimits(plan.limits, tenant?.limitOverrides) : undefined;

    await db().doc(paths.tenant(tenantId)).set(
      {
        planId: newPlanId,
        ...(cachedLimits ? { limits: cachedLimits } : {}),
        subscription: {
          status: upd.status,
          planId: newPlanId,
          stripeCustomerId: upd.stripeCustomerId,
          stripeSubscriptionId: upd.stripeSubscriptionId,
          currentPeriodEnd: upd.currentPeriodEndMs ? Timestamp.fromMillis(upd.currentPeriodEndMs) : null,
          pastDueSince: upd.pastDueSinceMs ? Timestamp.fromMillis(upd.pastDueSinceMs) : null,
          updatedAt: now,
        },
        updatedAt: now,
      },
      { merge: true },
    );
    invalidateEntitlements(tenantId);

    logger.info('Billing de plataforma: suscripción sincronizada', { tenantId, status: upd.status, planId: newPlanId, pastDue: !!upd.pastDueSinceMs });
    res.status(200).json({ ok: true, status: upd.status, planId: newPlanId });
  } catch (e) {
    logger.error('Error en platformBillingWebhook', e);
    res.status(200).json({ ok: false });
  }
});
