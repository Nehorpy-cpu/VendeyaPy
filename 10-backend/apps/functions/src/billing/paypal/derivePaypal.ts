/**
 * billing/paypal/derivePaypal.ts — Derivación PURA del update PayPal (Fase 5B-ii)
 * ==============================================================================
 * A partir de un evento de webhook de PayPal (BILLING.SUBSCRIPTION.* / PAYMENT.*) y el mapa
 * plan→plan, produce el mismo SubscriptionUpdate agnóstico que aplica applySubscriptionUpdate.
 * Maneja pastDueSince (gracia). El tenant se enlaza por custom_id de la suscripción. PURO/testeable.
 */
import { planIdForPaypalPlan } from '../paypalPlanMap.js';
import { payPalEventToStatus } from './payPalStatus.js';
import type { SubscriptionUpdate } from '../subscriptionSync.js';

export interface PayPalResource {
  id?: string;
  status?: string;
  plan_id?: string;
  custom_id?: string;
  custom?: string;
  billing_agreement_id?: string; // en eventos PAYMENT.SALE.*
  subscriber?: { payer_id?: string };
  billing_info?: { next_billing_time?: string };
}
export interface PayPalEvent {
  id?: string;
  event_type?: string;
  resource?: PayPalResource;
}

export function derivePayPalSubscriptionUpdate(
  event: PayPalEvent,
  planMap: Record<string, string>,
  current: { pastDueSinceMs?: number | null },
  nowMs: number,
): SubscriptionUpdate {
  const r = event.resource ?? {};
  const status = payPalEventToStatus(event.event_type, r.status);
  const planId = planIdForPaypalPlan(r.plan_id, planMap);

  const nextMs = r.billing_info?.next_billing_time ? Date.parse(r.billing_info.next_billing_time) : NaN;
  const currentPeriodEndMs = Number.isFinite(nextMs) ? nextMs : null;

  const pastDueSinceMs = status === 'past_due' ? current.pastDueSinceMs ?? nowMs : null;

  return {
    tenantId: r.custom_id ?? r.custom ?? null,
    provider: 'paypal',
    status,
    planId,
    currentPeriodEndMs,
    externalCustomerId: r.subscriber?.payer_id ?? null,
    externalSubscriptionId: r.id ?? r.billing_agreement_id ?? null,
    externalPlanRef: r.plan_id ?? null,
    providerMetadata: { eventType: event.event_type ?? '', resourceStatus: r.status ?? '' },
    pastDueSinceMs,
  };
}
