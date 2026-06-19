/**
 * functions/billing/paypalBillingWebhook.ts — Webhook de billing PayPal (Fase 5B-ii)
 * =================================================================================
 * Recibe los eventos de suscripción de PayPal. Verifica la firma con el método OFICIAL
 * (POST /v1/notifications/verify-webhook-signature vía el provider; en emulador, fake) usando
 * PAYPAL_WEBHOOK_ID. Idempotente por event.id (doc `paypal_{id}` en platformBillingEvents).
 * Enlaza la suscripción al tenant por custom_id; si falta, lo resuelve por externalSubscriptionId.
 * Si no se puede resolver el tenant, NO aplica cambios (warning seguro). Delega la escritura en
 * applySubscriptionUpdate (compartido). Nunca loguea firma/payloads sensibles.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from '../../lib/logger.js';
import { db, paths } from '../../lib/firebase.js';
import { claimEventOnce } from '../../payments/idempotency.js';
import { getPaypalPlanToPlan } from '../../billing/paypalPlanMap.js';
import { derivePayPalSubscriptionUpdate, type PayPalEvent } from '../../billing/paypal/derivePaypal.js';
import { applySubscriptionUpdate } from '../../billing/applySubscription.js';
import { getPayPalProvider } from '../../billing/paypal/paypalProvider.js';

const isRelevant = (type: string): boolean => type.startsWith('BILLING.SUBSCRIPTION') || type === 'PAYMENT.SALE.COMPLETED';
const sanitizeId = (s: string): string => `paypal_${s}`.replace(/[^\w.:=+-]/g, '_').slice(0, 256);

async function resolveTenantId(custom: string | null, subscriptionId: string | null): Promise<string | null> {
  if (custom) return custom;
  if (!subscriptionId) return null;
  const snap = await db().collection(paths.tenants()).where('subscription.externalSubscriptionId', '==', subscriptionId).limit(1).get();
  return snap.docs[0]?.id ?? null;
}

export const paypalBillingWebhook = onRequest({ region: 'us-central1', cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    logger.error('paypalBillingWebhook: falta PAYPAL_WEBHOOK_ID; se rechaza');
    res.status(401).json({ ok: false, error: 'not configured' });
    return;
  }

  const rawBody = req.rawBody.toString('utf8');
  const headers = req.headers as Record<string, string | undefined>;
  const provider = getPayPalProvider();
  const valid = await provider.verifyWebhook(headers, rawBody, webhookId);
  if (!valid) {
    logger.warn('paypalBillingWebhook: firma inválida');
    res.status(401).json({ ok: false, error: 'invalid signature' });
    return;
  }

  try {
    const event = JSON.parse(rawBody) as PayPalEvent;
    if (!event.id || !event.event_type) {
      res.status(400).json({ ok: false, error: 'evento sin id/type' });
      return;
    }
    if (!isRelevant(event.event_type)) {
      res.status(200).json({ ok: true, ignored: event.event_type });
      return;
    }
    if (!(await claimEventOnce(paths.platformBillingEvents(), sanitizeId(event.id), { type: event.event_type, provider: 'paypal' }))) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    const r = event.resource ?? {};
    const subscriptionId = r.id ?? r.billing_agreement_id ?? null;
    const tenantId = await resolveTenantId(r.custom_id ?? r.custom ?? null, subscriptionId);
    if (!tenantId) {
      logger.warn('paypalBillingWebhook: no se pudo resolver el tenant (sin custom_id ni match por subscription)', { eventType: event.event_type });
      res.status(200).json({ ok: true, warning: 'tenant no resuelto' });
      return;
    }

    const tenant = (await db().doc(paths.tenant(tenantId)).get()).data();
    const prevPastDueSinceMs = tenant?.subscription?.pastDueSince ? tenant.subscription.pastDueSince.toMillis() : null;

    const upd = derivePayPalSubscriptionUpdate(event, getPaypalPlanToPlan(), { pastDueSinceMs: prevPastDueSinceMs }, Date.now());
    await applySubscriptionUpdate(tenantId, upd);

    logger.info('Billing de plataforma: suscripción PayPal sincronizada', { tenantId, status: upd.status, planId: upd.planId ?? tenant?.planId, pastDue: !!upd.pastDueSinceMs });
    res.status(200).json({ ok: true, status: upd.status, planId: upd.planId ?? tenant?.planId ?? 'free' });
  } catch (e) {
    logger.error('Error en paypalBillingWebhook', e);
    res.status(200).json({ ok: false });
  }
});
