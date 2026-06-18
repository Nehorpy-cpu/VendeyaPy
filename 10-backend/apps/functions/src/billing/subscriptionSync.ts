/**
 * billing/subscriptionSync.ts — Derivación PURA del update de suscripción (Fase 5B-i)
 * ==================================================================================
 * A partir de un evento de Stripe (customer.subscription.*) y el mapa price→plan, calcula
 * qué escribir en tenant.subscription/planId/limits. Maneja `pastDueSince` (inicio de la
 * ventana de gracia): se setea al entrar en past_due y se limpia al volver a activo. PURO/testeable.
 */
import type { SubscriptionStatus } from '@vpw/shared';
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

export interface SubscriptionUpdate {
  tenantId: string | null;
  status: SubscriptionStatus;
  planId: string | null; // null = no cambiar el plan (precio no mapeado)
  currentPeriodEndMs: number | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
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
    status,
    planId,
    currentPeriodEndMs,
    stripeCustomerId: obj.customer ?? null,
    stripeSubscriptionId: obj.id ?? null,
    pastDueSinceMs,
  };
}
