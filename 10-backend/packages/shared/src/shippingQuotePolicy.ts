/**
 * SHIPPING-CHAT-3B (ADR-0011) — Política de cotización de envío del tenant.
 * =========================================================================
 * Vive en `config/checkout.coverage.shippingQuote` y se valida FAIL-CLOSED con TRES estados:
 *   - off      → bloque ausente o `required === false` (booleano): comportamiento actual.
 *   - required → `required === true` + `maxChargeGs` entero seguro > 0: la aprobación de
 *                cobertura EXIGE cotización de envío (coverageQuoteAndApprove, SHIPPING-CHAT-3C).
 *   - invalid  → CUALQUIER otra forma presente (typos del programa de activación, strings,
 *                floats, arrays…): lockout deliberado — ni el approve nuevo ni el viejo pueden
 *                aprobar hasta corregir la config. `invalid` JAMÁS degrada a `off` en silencio.
 *
 * Igual que `coverageActivationOf`: helper PURO compartido por backend y panel — una sola
 * fuente de verdad, sin divergencias.
 */
import type { CoverageActivation } from './coverageActivation.js';

export type ShippingQuotePolicy =
  | { status: 'off' }
  | { status: 'required'; maxChargeGs: number }
  | { status: 'invalid' };

/**
 * Estado público SANEADO del flujo de cobertura para el panel (respuesta de la callable
 * `coverageFlowState`). Jamás incluye el doc `config/checkout` completo ni cuentas bancarias.
 */
export interface CoverageFlowState extends CoverageActivation {
  shippingQuote: ShippingQuotePolicy;
}

/**
 * Deriva la política desde el bloque `coverage` crudo de `config/checkout` (el MISMO raw que
 * recibe `coverageActivationOf` — un solo snapshot, sin doble fuente).
 *
 * Ordenamiento fail-closed EXACTO (review 3A-HARDEN, hallazgo F5):
 *   1. bloque `shippingQuote` AUSENTE (o coverage no-objeto)      ⇒ off
 *   2. `required === false` (booleano estricto)                    ⇒ off
 *   3. `required === true` + `maxChargeGs` safe-int > 0            ⇒ required
 *   4. cualquier otra forma PRESENTE (required string/num/array,
 *      max 0/negativo/float/NaN/Infinity/unsafe, bloque array…)    ⇒ invalid
 */
export function shippingQuotePolicyOf(rawCoverage: unknown): ShippingQuotePolicy {
  if (typeof rawCoverage !== 'object' || rawCoverage === null || Array.isArray(rawCoverage)) return { status: 'off' };
  const sq = (rawCoverage as { shippingQuote?: unknown }).shippingQuote;
  // `null` cuenta como AUSENTE (es el idioma de "campo limpiado" de este codebase, igual que
  // decision:null/resume:null); cualquier otra forma presente no-válida ⇒ invalid.
  if (sq === undefined || sq === null) return { status: 'off' };
  if (typeof sq !== 'object' || sq === null || Array.isArray(sq)) return { status: 'invalid' };
  const required = (sq as { required?: unknown }).required;
  if (required === false) return { status: 'off' };
  if (required !== true) return { status: 'invalid' };
  const max = (sq as { maxChargeGs?: unknown }).maxChargeGs;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max <= 0) return { status: 'invalid' };
  return { status: 'required', maxChargeGs: max };
}

/**
 * Compatibilidad del panel con una respuesta ANTIGUA de `coverageFlowState` (deploy skew:
 * panel nuevo + función vieja): `shippingQuote` ausente ⇒ `{status:'off'}`.
 * El panel debe normalizar SIEMPRE con este helper — jamás asumir el campo presente.
 */
export function shippingQuoteOfFlowState(resp: { shippingQuote?: ShippingQuotePolicy } | null | undefined): ShippingQuotePolicy {
  return resp?.shippingQuote ?? { status: 'off' };
}
