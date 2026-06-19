/**
 * billing/subscriptionSync.ts — Derivación PURA del update de suscripción (Fase 5B-i)
 * ==================================================================================
 * A partir de un evento de Stripe (customer.subscription.*) y el mapa price→plan, calcula
 * qué escribir en tenant.subscription/planId/limits. Maneja `pastDueSince` (inicio de la
 * ventana de gracia): se setea al entrar en past_due y se limpia al volver a activo. PURO/testeable.
 */
import type { SubscriptionStatus, PaymentProvider } from '@vpw/shared';
import { normalizeStripeStatus } from './platformBilling.js';
import { planIdForPrice } from './priceMap.js';

export interface StripeSubObject {
  id?: string;
  status?: string;
  customer?: string;
  current_period_end?: number; // unix sec
  metadata?: { tenantId?: string };
  items?: { data?: Array<{ price?: { id?: string } }> };
}
export interface StripeSubEvent {
  id?: string;
  type?: string;
  data?: { object?: StripeSubObject };
}

/**
 * Update NORMALIZADO de suscripción, AGNÓSTICO del proveedor (Fase 5B-ii). Lo producen los
 * derivers por proveedor (Stripe/PayPal) y lo aplica applySubscriptionUpdate.
 */
export interface SubscriptionUpdate {
  tenantId: string | null;
  provider: PaymentProvider;
  status: SubscriptionStatus;
  planId: string | null; // null = no cambiar el plan (ref no mapeada)
  currentPeriodEndMs: number | null;
  externalCustomerId: string | null;
  externalSubscriptionId: string | null;
  externalPlanRef: string | null; // priceId (Stripe) | plan_id (PayPal)
  providerMetadata?: Record<string, unknown>;
  pastDueSinceMs: number | null;
}

/** Deriva el update a aplicar. `current.pastDueSinceMs` es el valor previo (para preservarlo). */
export function deriveSubscriptionUpdate(
  event: StripeSubEvent,
  priceMap: Record<string, string>,
  current: { pastDueSinceMs?: number | null },
  nowMs: number,
): SubscriptionUpdate {
  const obj = event.data?.object ?? {};
  const status: SubscriptionStatus = event.type === 'customer.subscription.deleted' ? 'canceled' : normalizeStripeStatus(obj.status ?? 'active');
  const priceId = obj.items?.data?.[0]?.price?.id ?? null;
  const planId = planIdForPrice(priceId, priceMap);
  const currentPeriodEndMs = typeof obj.current_period_end === 'number' && obj.current_period_end > 0 ? obj.current_period_end * 1000 : null;

  // Ventana de gracia: marca el inicio de past_due la primera vez; lo limpia al salir.
  let pastDueSinceMs: number | null;
  if (status === 'past_due') pastDueSinceMs = current.pastDueSinceMs ?? nowMs;
  else pastDueSinceMs = null;

  return {
    tenantId: obj.metadata?.tenantId ?? null,
    provider: 'stripe' as PaymentProvider,
    status,
    planId,
    currentPeriodEndMs,
    externalCustomerId: obj.customer ?? null,
    externalSubscriptionId: obj.id ?? null,
    externalPlanRef: priceId,
    providerMetadata: { eventType: event.type ?? '' },
    pastDueSinceMs,
  };
}
