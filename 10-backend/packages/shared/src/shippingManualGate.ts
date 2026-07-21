/**
 * SHIPPING-CHAT-3B (ADR-0011) — Clasificación COMPARTIDA del gate de mensajes manuales.
 * =====================================================================================
 * ÚNICA fuente de verdad para web (ayuda de UI) y backend (autoridad server-side en
 * `sendManualMessage`): un texto del staff que contiene un costo de envío NO puede salir
 * como mensaje manual común en modo quote-obligatorio — el cliente vería un precio que
 * jamás llegaría al pedido. El costo se informa por el flujo canónico (SHIPPING-CHAT-3C).
 *
 * PRIVACIDAD: funciones PURAS, sin logging. Los callers JAMÁS deben loguear el texto.
 *
 * RESIDUAL DOCUMENTADO: montos escritos completamente en PALABRAS ("veinticinco mil
 * guaraníes") no llevan dígitos ⇒ el parser no los ve y el gate no los bloquea. Cobertura
 * parcial del lado bot: COVERAGE-GUARD-1 + regla de prompt. Aceptado como límite conocido.
 */
import { parseShippingCost, DEFAULT_MAX_SHIPPING_GS } from './shippingCostParser.js';
import type { ShippingParseReason, ShippingParseResult } from './shippingCostParser.js';
import type { ShippingQuotePolicy } from './shippingQuotePolicy.js';

/** Motivos `none` que INDICAN intención de informar un costo ⇒ bloquean el envío manual crudo. */
export const MANUAL_BLOCKING_REASONS: ReadonlySet<ShippingParseReason> = new Set<ShippingParseReason>([
  'monto_ambiguo',
  'monto_invalido',
  'monto_no_exacto',
  'monto_negado',
  'excede_maximo',
  'cero_sin_gratuidad',
  'gratis_con_monto',
  'gratuidad_negada',
  'gratuidad_condicional',
]);

/**
 * ¿El resultado del parser indica un costo (o intento de costo) que no debe salir como mensaje
 * manual crudo? true para matched/free y para los 9 motivos de intento no-limpio; false para
 * texto común (vacio / sin_contexto_envio / sin_monto) y para `limite_invalido` (error de
 * CONFIG, no del vendedor — la re-clasificación de intención es responsabilidad del caller).
 */
export function blocksByParseResult(r: ShippingParseResult): boolean {
  if (r.kind === 'matched' || r.kind === 'free') return true;
  return MANUAL_BLOCKING_REASONS.has(r.reason);
}

/** Palabras de contexto de envío (espejo del parser; normalización mínima local, sin estado). */
const CONTEXTO_GATE_RE = /\b(envios?|env[ií]os?|delivery|entregas?|fletes?|traslados?)\b/i;
/**
 * Señal monetaria "evidente": marcador ₲/Gs, multiplicador mil/k pegado a dígitos, agrupación
 * de miles con punto O coma, o un entero de 4+ dígitos crudo ("30000" — forma natural en chat).
 * Deliberadamente laxa (modo censor): acá un falso positivo solo obliga al vendedor a usar el
 * flujo canónico — nunca decide dinero (review 3B: "30000"/"30,000" evadían el gate).
 */
const SENIAL_GATE_RE = /₲|\bgs\b|\bgs\.|\d\s?(?:mil|k)\b|\d{1,3}(?:\.\d{3})+|\d{1,3}(?:,\d{3})+|\d{4,}/i;

/**
 * Detección ENDURECIDA de intento evidente (review 3A, hallazgo H7): contexto de envío +
 * señal monetaria en CUALQUIER parte del mensaje — incluye montos en otra línea o cláusula
 * ("el costo de envío es:\n₲25.000") que el parser, conservador para MATCHING, clasifica
 * como sin_monto. En modo GATE la asimetría se invierte: ante duda, bloquear.
 */
export function hasEvidentShippingAttempt(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false;
  return CONTEXTO_GATE_RE.test(text) && SENIAL_GATE_RE.test(text);
}

/**
 * Gate manual compartido: ¿este texto debe BLOQUEARSE como mensaje manual común bajo la
 * política dada? (Solo clasificación — la política/alcance del gate la decide el caller.)
 *
 * - policy off      ⇒ false (sin gate).
 * - policy required ⇒ parser con el máximo del tenant + detección endurecida.
 * - policy invalid  ⇒ re-clasifica SOLO la intención con DEFAULT_MAX_SHIPPING_GS (jamás
 *                     amplía el tope real ni produce un monto aprobable) + detección endurecida.
 */
export function blocksManualShippingSend(text: string, policy: ShippingQuotePolicy): boolean {
  if (policy.status === 'off') return false;
  const max = policy.status === 'required' ? policy.maxChargeGs : DEFAULT_MAX_SHIPPING_GS;
  const parsed = parseShippingCost(text, { maxChargeGs: max });
  // Con config inválida el parse con max defensivo ya clasifica la intención directamente
  // (max = DEFAULT). Nunca se usa el resultado para aprobar: solo para bloquear.
  if (blocksByParseResult(parsed)) return true;
  return hasEvidentShippingAttempt(text);
}
