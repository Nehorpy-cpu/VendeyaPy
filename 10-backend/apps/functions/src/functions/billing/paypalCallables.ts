/**
 * functions/billing/paypalCallables.ts — Callables de suscripción PayPal (Fase 5B-ii)
 * ==================================================================================
 *   createPayPalSubscriptionSession({ tenantId?, planId }) → crea la suscripción en PayPal y
 *     devuelve SOLO { approvalUrl }. No activa el plan (eso lo confirma el webhook al aprobarse).
 *   syncPayPalSubscription({ tenantId? }) → consulta PayPal y reconcilia el estado.
 * Autorización ESTRICTA owner/admin (nunca SELLER/MANAGER/VIEWER). Sin tokens/secretos en la
 * respuesta. El dinero va a la cuenta PayPal Business de la PLATAFORMA, no del tenant.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { Tenant } from '@vpw/shared';
import { resolveOwnerAdminAuth } from '../../lib/ownerAdminAuth.js';
import { db, paths } from '../../lib/firebase.js';
import { applySubscriptionUpdate } from '../../billing/applySubscription.js';
import { getPlanToPaypalPlan, getPaypalPlanToPlan, paypalPlanForPlan, planIdForPaypalPlan } from '../../billing/paypalPlanMap.js';
import { mapPaypalResourceStatus } from '../../billing/paypal/payPalStatus.js';
import { getPayPalProvider } from '../../billing/paypal/paypalProvider.js';
import { logger } from '../../lib/logger.js';

function authorize(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolveOwnerAdminAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId, {
    deniedMessage: 'Solo el dueño de la empresa o un administrador pueden gestionar el billing.',
  });
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

export const createPayPalSubscriptionSession = onCall<{ tenantId?: string; planId?: string }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorize(req, req.data?.tenantId);
  const planId = req.data?.planId;
  if (!planId) throw new HttpsError('invalid-argument', 'Falta planId.');
  const paypalPlanRef = paypalPlanForPlan(planId, getPlanToPaypalPlan());
  if (!paypalPlanRef) throw new HttpsError('failed-precondition', 'Ese plan no está disponible para PayPal.');

  const provider = getPayPalProvider();
  const { subscriptionId, approvalUrl } = await provider.createSubscription(paypalPlanRef, {
    tenantId,
    returnUrl: process.env.PAYPAL_RETURN_URL,
    cancelUrl: process.env.PAYPAL_CANCEL_URL,
  });

  // Estado provisional: 'incomplete' (aún no aprobado/pagado). NO cambia el plan efectivo.
  await applySubscriptionUpdate(tenantId, {
    tenantId,
    provider: 'paypal',
    status: 'incomplete',
    planId: null,
    currentPeriodEndMs: null,
    externalCustomerId: null,
    externalSubscriptionId: subscriptionId,
    externalPlanRef: paypalPlanRef,
    providerMetadata: { phase: 'session_created' },
    pastDueSinceMs: null,
  });

  logger.info('PayPal: sesión de suscripción creada', { tenantId }); // sin tokens/secretos
  return { ok: true, approvalUrl };
});

export const syncPayPalSubscription = onCall<{ tenantId?: string }>({ region: 'us-central1' }, async (req) => {
  const tenantId = authorize(req, req.data?.tenantId);
  const tenant = (await db().doc(paths.tenant(tenantId)).get()).data() as Partial<Tenant> | undefined;
  const sub = tenant?.subscription;
  const subscriptionId = sub?.externalSubscriptionId ?? sub?.stripeSubscriptionId ?? null;
  if (!subscriptionId || sub?.paymentProvider !== 'paypal') {
    throw new HttpsError('failed-precondition', 'La empresa no tiene una suscripción PayPal para reconciliar.');
  }

  const provider = getPayPalProvider();
  const remote = await provider.getSubscription(subscriptionId);
  const status = mapPaypalResourceStatus(remote.status);
  const prevPastDueSinceMs = sub?.pastDueSince ? sub.pastDueSince.toMillis() : null;

  await applySubscriptionUpdate(tenantId, {
    tenantId,
    provider: 'paypal',
    status,
    planId: planIdForPaypalPlan(remote.planRef, getPaypalPlanToPlan()),
    currentPeriodEndMs: remote.nextBillingTimeMs ?? null,
    externalCustomerId: remote.customerId ?? null,
    externalSubscriptionId: remote.id,
    externalPlanRef: remote.planRef ?? null,
    providerMetadata: { phase: 'manual_sync' },
    pastDueSinceMs: status === 'past_due' ? prevPastDueSinceMs ?? Date.now() : null,
  });

  logger.info('PayPal: suscripción reconciliada', { tenantId, status });
  return { ok: true, status };
});
