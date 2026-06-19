/**
 * billing/applySubscription.ts — Escritura COMPARTIDA de la suscripción (Fase 5B-ii)
 * =================================================================================
 * Aplica un SubscriptionUpdate (agnóstico del proveedor) al tenant: escribe
 * tenant.subscription (refs genéricas external* + legacy stripe* si aplica), tenant.planId y
 * tenant.limits (caché denormalizada del plan seleccionado), e invalida los entitlements. Lo
 * usan el webhook Stripe (5B-i) y el de PayPal (5B-ii). NO suspende la cuenta.
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { Tenant, PaymentProvider } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { getPlan } from '../plans/plans.js';
import { effectiveLimits } from '../entitlements/decide.js';
import { invalidateEntitlements } from '../entitlements/entitlements.js';
import type { SubscriptionUpdate } from './subscriptionSync.js';

/**
 * Deriva el proveedor de una suscripción existente (Fase 5B-ii):
 *   1. si tiene `paymentProvider`, usarlo;
 *   2. si no, y hay stripeSubscriptionId/stripeCustomerId → 'stripe';
 *   3. si no hay billing externo → 'manual'.
 */
export function resolvePaymentProvider(sub: { paymentProvider?: PaymentProvider; stripeSubscriptionId?: string | null; stripeCustomerId?: string | null } | undefined): PaymentProvider {
  if (sub?.paymentProvider) return sub.paymentProvider;
  if (sub?.stripeSubscriptionId || sub?.stripeCustomerId) return 'stripe';
  return 'manual';
}

/** Aplica el update al tenant. `update.tenantId` se ignora: se usa el `tenantId` del argumento. */
export async function applySubscriptionUpdate(tenantId: string, update: SubscriptionUpdate): Promise<void> {
  const tenant = (await db().doc(paths.tenant(tenantId)).get()).data() as Partial<Tenant> | undefined;
  const newPlanId = update.planId ?? tenant?.planId ?? 'free';
  const plan = await getPlan(newPlanId);
  const cachedLimits = plan ? effectiveLimits(plan.limits, tenant?.limitOverrides) : undefined;
  const now = Timestamp.now();

  const subscription: Record<string, unknown> = {
    status: update.status,
    planId: newPlanId,
    paymentProvider: update.provider,
    externalCustomerId: update.externalCustomerId,
    externalSubscriptionId: update.externalSubscriptionId,
    externalPlanRef: update.externalPlanRef,
    providerMetadata: update.providerMetadata ?? {},
    currentPeriodEnd: update.currentPeriodEndMs ? Timestamp.fromMillis(update.currentPeriodEndMs) : null,
    pastDueSince: update.pastDueSinceMs ? Timestamp.fromMillis(update.pastDueSinceMs) : null,
    updatedAt: now,
  };
  // Compat legacy: para Stripe también se escriben los campos stripe*.
  if (update.provider === 'stripe') {
    subscription.stripeCustomerId = update.externalCustomerId;
    subscription.stripeSubscriptionId = update.externalSubscriptionId;
  }

  await db().doc(paths.tenant(tenantId)).set(
    { planId: newPlanId, ...(cachedLimits ? { limits: cachedLimits } : {}), subscription, updatedAt: now },
    { merge: true },
  );
  invalidateEntitlements(tenantId);
}
