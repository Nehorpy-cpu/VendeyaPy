/**
 * SHIPPING-CHAT-1 (ADR-0011) — Helpers PUROS de totales de pedido con envío.
 * ==========================================================================
 * Fuente única de la fórmula de totales para web y backend. Modelo canónico (ADR-0011):
 *   productNetRevenue = subtotal - discount
 *   total (= totalCollected) = subtotal - discount + shipping
 * El envío NUNCA se suma a `subtotal` (la ganancia de productos, anclada en subtotal, no se infla).
 *
 * Consumidores reales (SHIPPING-CHAT-3C): `createPendingOrder` (backend, totales de toda orden
 * nueva) y la saga de cotización (`coverageQuote.ts`, validación de overflow del total).
 */

import type { OrderTotals } from './types/order.types.js';

/** Formatea guaraníes enteros con separador de miles es-PY ('.'), sin depender de ICU. 30000 → "30.000". */
export function formatGuaranies(gs: number): string {
  if (!Number.isSafeInteger(gs) || gs < 0) {
    throw new Error('formatGuaranies: se esperaba un entero de guaraníes no negativo');
  }
  return String(gs).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function assertEnteroNoNegativo(n: number, campo: string): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`computeOrderTotals: ${campo} debe ser un entero no negativo`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new Error(`computeOrderTotals: ${campo} excede el rango entero seguro`);
  }
}

/**
 * Calcula los totales de un pedido a partir de montos enteros en guaraníes.
 * `total = subtotal - discount + shipping`. `discount` no puede superar al `subtotal`.
 * El envío se guarda aparte y jamás contamina `subtotal`.
 */
export function computeOrderTotals(input: { subtotalGs: number; discountGs: number; shippingGs: number }): OrderTotals {
  const { subtotalGs, discountGs, shippingGs } = input;
  assertEnteroNoNegativo(subtotalGs, 'subtotalGs');
  assertEnteroNoNegativo(discountGs, 'discountGs');
  assertEnteroNoNegativo(shippingGs, 'shippingGs');
  if (discountGs > subtotalGs) {
    throw new Error('computeOrderTotals: el descuento no puede superar al subtotal');
  }
  const total = subtotalGs - discountGs + shippingGs;
  // HARDEN-1: aunque cada entrada sea válida, la SUMA puede salirse del rango entero seguro.
  if (!Number.isSafeInteger(total)) {
    throw new Error('computeOrderTotals: el total excede el rango entero seguro');
  }
  return {
    subtotal: subtotalGs,
    discount: discountGs,
    shipping: shippingGs,
    total,
    currency: 'PYG',
  };
}

/**
 * Compatibilidad de LECTURA de pedidos viejos: si `shipping` está ausente, lo trata como 0.
 * Devuelve un OBJETO NUEVO (no muta el original). No recalcula `total` (los pedidos viejos ya tienen
 * `total = subtotal - discount` con envío 0, así que su total sigue siendo correcto).
 */
export function normalizeOrderTotals(totals: OrderTotals): OrderTotals {
  return { ...totals, shipping: totals.shipping ?? 0 };
}

/**
 * Mensaje canónico del vendedor con el costo de envío. SIN dirección/coordenadas/PII ni texto libre.
 * `shippingGs` debe ser un entero no negativo (0 solo tras un quote de gratuidad inequívoco).
 */
export function formatCanonicalShippingMessage(shippingGs: number): string {
  if (!Number.isSafeInteger(shippingGs) || shippingGs < 0) {
    throw new Error('formatCanonicalShippingMessage: se esperaba un entero de guaraníes no negativo');
  }
  if (shippingGs === 0) {
    return 'El envío para tu ubicación es sin costo.';
  }
  return `El costo de envío para tu ubicación es ₲${formatGuaranies(shippingGs)}.`;
}
