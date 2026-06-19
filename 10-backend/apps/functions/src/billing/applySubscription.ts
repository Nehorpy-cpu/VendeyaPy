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

/** Opciones de applySubscriptionUpdate (Billing manual por WhatsApp, MB-1). */
export interface ApplySubscriptionOpts {
  /**
   * Permite PISAR una suscripción manual confirmada (`paymentProvider === 'manual_whatsapp'`).
   * Default `false`: los updates EXTERNOS (webhooks Stripe/PayPal, syncPayPalSubscription) NO pisan
   * una activación manual vigente. Solo el flujo admin manual lo pasa en `true`.
   */
  allowOverrideManual?: boolean;
}

/** Resultado de applySubscriptionUpdate: `applied=false` + `skipped='manual_override'` si la guarda omitió. */
export interface ApplySubscriptionResult {
  applied: boolean;
  skipped?: 'manual_override';
}

/** Aplica el update al tenant. `update.tenantId` se ignora: se usa el `tenantId` del argumento. */
export async function applySubscriptionUpdate(
  tenantId: string,
  update: SubscriptionUpdate,
  opts: ApplySubscriptionOpts = {},
): Promise<ApplySubscriptionResult> {
  const tenant = (await db().doc(paths.tenant(tenantId)).get()).data() as Partial<Tenant> | undefined;

  // Guarda de precedencia (MB-1): si la suscripción vigente es una activación manual confirmada,
  // un update externo (sin override) NO la pisa. Solo el flujo admin manual (allowOverrideManual) gana.
  const currentProvider = tenant?.subscription?.paymentProvider;
  if (currentProvider === 'manual_whatsapp' && !opts.allowOverrideManual) {
    return { applied: false, skipped: 'manual_override' };
  }

  const newPlanId = update.planId ?? tenant?.planId ?? 'free';
  const plan = await getPlan(newPlanId);
  const cachedLimits = plan ? effectiveLimits(plan.limits, tenant?.limitOverrides) : undefined;
  const now = Timestamp.now();

  // Si una acción admin (override) pisa otro proveedor, conservar el anterior para trazabilidad.
  const providerMetadata: Record<string, unknown> = { ...(update.providerMetadata ?? {}) };
  if (opts.allowOverrideManual && currentProvider && currentProvider !== update.provider) {
    providerMetadata.previousProvider = currentProvider;
  }

  const subscription: Record<string, unknown> = {
    status: update.status,
    planId: newPlanId,
    paymentProvider: update.provider,
    externalCustomerId: update.externalCustomerId,
    externalSubscriptionId: update.externalSubscriptionId,
    externalPlanRef: update.externalPlanRef,
    providerMetadata,
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
  return { applied: true };
}
