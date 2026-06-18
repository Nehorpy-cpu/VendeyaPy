/**
 * billing/priceMap.ts — Mapeo Stripe Price ID → planId (Fase 5B-i)
 * ===============================================================
 * Fuente BACKEND: env `STRIPE_PRICE_TO_PLAN` (JSON: { "<priceId>": "<planId>" }). El
 * frontend nunca decide el plan: el plan efectivo sale del Price ID confirmado por Stripe.
 * (Opcional: `plans/{id}.stripePriceId` solo como referencia/display.) Funciones puras.
 */

/** Parsea el JSON del env a un mapa priceId→planId (tolerante: inválido → {}). */
export function parsePriceMap(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch {
    /* JSON inválido → mapa vacío (fail-safe; el webhook no cambia el plan) */
  }
  return {};
}

/** Mapa activo (desde el entorno de Functions). */
export function getStripePriceToPlan(): Record<string, string> {
  return parsePriceMap(process.env.STRIPE_PRICE_TO_PLAN);
}

/** Resuelve el planId para un Price ID, o null si no está mapeado. */
export function planIdForPrice(priceId: string | null | undefined, map: Record<string, string>): string | null {
  if (!priceId) return null;
  return map[priceId] ?? null;
}
