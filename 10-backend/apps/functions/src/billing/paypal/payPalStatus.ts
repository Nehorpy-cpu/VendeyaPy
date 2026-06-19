/**
 * billing/paypal/payPalStatus.ts — Mapeo PayPal → estado interno (Fase 5B-ii)
 * ==========================================================================
 * Convierte el evento/estado de PayPal a nuestro SubscriptionStatus. PURO/testeable.
 * Decisiones (5B-ii): ACTIVE→active; APPROVAL_PENDING/APPROVED→incomplete; SUSPENDED→past_due
 * (gracia, recuperable); CANCELLED/EXPIRED→canceled; PAYMENT.FAILED→past_due; SALE.COMPLETED→active.
 */
import type { SubscriptionStatus } from '@vpw/shared';

/** Estado del recurso suscripción de PayPal → interno. */
export function mapPaypalResourceStatus(status: string | undefined): SubscriptionStatus {
  switch ((status ?? '').toUpperCase()) {
    case 'ACTIVE':
      return 'active';
    case 'APPROVAL_PENDING':
    case 'APPROVED':
      return 'incomplete';
    case 'SUSPENDED':
      return 'past_due';
    case 'CANCELLED':
    case 'EXPIRED':
      return 'canceled';
    default:
      return 'none';
  }
}

/** Evento de webhook de PayPal → interno (el tipo de evento manda; si no, usa el estado del recurso). */
export function payPalEventToStatus(eventType: string | undefined, resourceStatus: string | undefined): SubscriptionStatus {
  switch (eventType) {
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
    case 'PAYMENT.SALE.COMPLETED':
      return 'active';
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
      return 'past_due';
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
      return 'canceled';
    case 'BILLING.SUBSCRIPTION.CREATED':
      return 'incomplete';
    case 'BILLING.SUBSCRIPTION.UPDATED':
    default:
      return mapPaypalResourceStatus(resourceStatus);
  }
}
