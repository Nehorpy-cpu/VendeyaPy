/**
 * billing/platformBilling.ts — Mapeo de la suscripción de Stripe al estado del tenant (Fase 4)
 * ============================================================================================
 * Lógica PURA (testeable): traduce el estado de una suscripción de Stripe al estado de
 * la empresa (ACTIVE / SUSPENDED). La aplica el webhook platformBillingWebhook.
 */
import type { TenantStatus, SubscriptionStatus } from '@vpw/shared';

const STRIPE_TO_SUB: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
};

/** Normaliza el `status` de una suscripción de Stripe a nuestro enum. */
export function normalizeStripeStatus(s: string): SubscriptionStatus {
  return STRIPE_TO_SUB[s] ?? 'none';
}

/**
 * Estado de la empresa según el estado de su suscripción (Fase 5B: política suavizada).
 * El billing NO suspende la cuenta: los datos y el acceso básico se preservan siempre. El
 * control de las funciones premium es por `billingPosture` (entitlements). Suspender toda la
 * cuenta queda como decisión EXPLÍCITA del admin (fuera de billing automático).
 */
export function tenantStatusForSubscription(_sub: SubscriptionStatus): TenantStatus {
  return 'ACTIVE';
}
