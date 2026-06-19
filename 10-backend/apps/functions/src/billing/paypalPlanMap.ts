/**
 * billing/paypalPlanMap.ts — Mapeo PayPal plan_id ↔ planId (Fase 5B-ii)
 * ====================================================================
 * Config BACKEND (JSON env), el frontend nunca decide el plan:
 *   - PAYPAL_PLAN_TO_PLAN: { "<paypalPlanId>": "<planId>" }  → lo usa el WEBHOOK (confirmación).
 *   - PLAN_TO_PAYPAL_PLAN: { "<planId>": "<paypalPlanId>" }  → lo usa createPayPalSubscriptionSession.
 * Reusa parsePriceMap/planIdForPrice (mapa genérico string→string).
 */
import { parsePriceMap, planIdForPrice } from './priceMap.js';

export function getPaypalPlanToPlan(): Record<string, string> {
  return parsePriceMap(process.env.PAYPAL_PLAN_TO_PLAN);
}
export function getPlanToPaypalPlan(): Record<string, string> {
  return parsePriceMap(process.env.PLAN_TO_PAYPAL_PLAN);
}

/** PayPal plan_id → planId interno (o null si no está mapeado). */
export function planIdForPaypalPlan(paypalPlanId: string | null | undefined, map: Record<string, string>): string | null {
  return planIdForPrice(paypalPlanId, map);
}
/** planId interno → PayPal plan_id (o null si no está mapeado). */
export function paypalPlanForPlan(planId: string | null | undefined, map: Record<string, string>): string | null {
  return planIdForPrice(planId, map);
}
