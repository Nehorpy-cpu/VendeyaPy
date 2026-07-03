/**
 * orders/lifecycle.ts — Máquina de estados del ciclo de vida de pedidos (ORDER-1)
 * ================================================================================
 * PURO (sin E/S). Fuente única de verdad sobre qué transiciones/acciones son válidas
 * y para quién. Las callables (functions/orders/orderCallables.ts) la hacen cumplir;
 * las rules cierran el update directo (firestore.rules: orders update=false).
 *
 * Grupos:
 *   UNPAID    = PENDING_PAYMENT, PENDING_VERIFICATION  → el tenant puede editar/cancelar.
 *   OPERATIVE = PAID, PREPARING, ASSIGNED, IN_TRANSIT  → solo avance forward por staff.
 *   TERMINAL  = DELIVERED, CANCELLED, REFUNDED         → registro permanente (solo admin corrige).
 *
 * Un pedido PAGADO es un hecho contable: alimenta stats/attribution/Conversions API
 * (eventos ya enviados a Meta, irreversibles) — por eso el tenant nunca lo edita ni cancela.
 */
import type { OrderStatus } from '@vpw/shared';

export const UNPAID_STATUSES: readonly OrderStatus[] = ['PENDING_PAYMENT', 'PENDING_VERIFICATION'];
export const OPERATIVE_STATUSES: readonly OrderStatus[] = ['PAID', 'PREPARING', 'ASSIGNED', 'IN_TRANSIT'];
export const TERMINAL_STATUSES: readonly OrderStatus[] = ['DELIVERED', 'CANCELLED', 'REFUNDED'];

/**
 * Estados que cuentan como "venta concretada" (ganancia/stats/atribución).
 * Fuente única lado functions (antes duplicada literal en computeStats/businessEvents/
 * attribution/score/tracking). El panel (apps/web/src/lib/orders.ts) tiene su copia —
 * no se toca acá (modo convivencia); unificar cuando se toque ese archivo.
 */
export const PAID_ORDER_STATUSES: readonly OrderStatus[] = ['PAID', 'PREPARING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED'];

/** Cadena de avance operativo (forward-only, permite saltos hacia adelante). */
const ADVANCE_CHAIN: readonly OrderStatus[] = ['PAID', 'PREPARING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED'];

export function isPaidStatus(s: OrderStatus): boolean {
  return PAID_ORDER_STATUSES.includes(s);
}

export function isTerminal(s: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/** El tenant (owner/manager) solo puede EDITAR datos mientras el pedido no está pagado. */
export function canTenantEdit(s: OrderStatus): boolean {
  return UNPAID_STATUSES.includes(s);
}

/** El tenant (owner/manager) solo puede CANCELAR mientras el pedido no está pagado. */
export function canTenantCancel(s: OrderStatus): boolean {
  return UNPAID_STATUSES.includes(s);
}

/**
 * ¿El staff puede avanzar `from` → `to`?
 *  - UNPAID → PAID (confirmación de pago; la callable la envuelve en confirmPayment).
 *  - Avance forward dentro de la cadena operativa (saltos hacia adelante permitidos:
 *    PAID → DELIVERED directo es válido para negocios sin tracking de envío).
 *  - NUNCA retrocesos, NUNCA hacia CANCELLED/REFUNDED (eso va por orderCancel/admin).
 */
export function canAdvanceStatus(from: OrderStatus, to: OrderStatus): boolean {
  if (UNPAID_STATUSES.includes(from) && to === 'PAID') return true;
  const i = ADVANCE_CHAIN.indexOf(from);
  const j = ADVANCE_CHAIN.indexOf(to);
  return i !== -1 && j !== -1 && j > i;
}
