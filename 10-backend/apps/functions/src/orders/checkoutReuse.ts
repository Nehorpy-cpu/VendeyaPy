/**
 * orders/checkoutReuse.ts — Checkout IDEMPOTENTE (F5)
 * ===================================================
 * Bug real (smoke F4): "quiero pagar" → orden A; 17 segundos después "Para pagar cual es"
 * volvió a matchear quierePagar y creó la orden B duplicada. Cada repregunta por los datos
 * de transferencia duplicaba pedidos.
 *
 * Este módulo decide QUÉ hacer cuando el cliente pide pagar, mirando la orden pendiente:
 *  - reuse:        hay PENDING_PAYMENT del MISMO carrito → reenviar instrucciones, mismo orderId.
 *  - verification: la orden está PENDING_VERIFICATION → "tu comprobante está en revisión".
 *  - paid:         la orden ya figura pagada (grupo PAID) → decirlo, no crear otra.
 *  - new:          no hay nada reutilizable (o la anterior está CANCELLED/REFUNDED) → crear.
 *  - new_cart_changed: hay PENDING_PAYMENT pero el carrito CAMBIÓ → crear nueva avisando.
 * Si session.pendingOrderId se perdió pero existe una PENDING_PAYMENT reciente del cliente,
 * se reutiliza y el caller repara el puntero. PURO con DI → unit-testeable.
 */
import type { Cart, Order } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { PAID_ORDER_STATUSES } from './lifecycle.js';

/** Ventana para "reciente" al reparar un pendingOrderId perdido (la sesión vive 24 h). */
export const REUSE_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CheckoutReuseDecision =
  | { kind: 'reuse'; order: Order; repaired: boolean }
  | { kind: 'verification'; order: Order }
  | { kind: 'paid'; order: Order }
  | { kind: 'new' }
  | { kind: 'new_cart_changed'; previous: Order };

/**
 * ¿El carrito actual es EXACTAMENTE lo que pide la orden? (mismos productos y cantidades).
 * Compara pares (productId, quantity) sin importar el orden. Pura, exportada para tests.
 */
export function sameCartAsOrder(cart: Cart, order: Order): boolean {
  const a = cart.items.map((i) => `${i.productId}::${i.quantity}`).sort();
  const b = (order.items ?? []).map((i) => `${i.productId}::${i.quantity}`).sort();
  return a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);
}

export interface CheckoutReuseDeps {
  getOrder: (tenantId: string, orderId: string) => Promise<Order | null>;
  /** PENDING_PAYMENT más reciente del cliente dentro de la ventana (repara puntero perdido). */
  findRecentPendingPayment: (tenantId: string, customerId: string, sinceMs: number) => Promise<Order | null>;
  nowMs?: number;
}

export const defaultCheckoutReuseDeps: CheckoutReuseDeps = {
  getOrder: async (t, id) => {
    const snap = await db().doc(paths.order(t, id)).get();
    return snap.exists ? (snap.data() as Order) : null;
  },
  findRecentPendingPayment: async (t, customerId, sinceMs) => {
    // Dos igualdades (sin orderBy) → sin índice compuesto. Pocos docs; el más nuevo se elige acá.
    const snap = await db()
      .collection(paths.orders(t))
      .where('customerId', '==', customerId)
      .where('status', '==', 'PENDING_PAYMENT')
      .limit(10)
      .get();
    const recientes = snap.docs
      .map((d) => d.data() as Order)
      .filter((o) => (o.createdAt?.toMillis?.() ?? 0) >= sinceMs)
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    return recientes[0] ?? null;
  },
};

export async function resolveCheckoutReuse(
  tenantId: string,
  customerId: string,
  pendingOrderId: string | null | undefined,
  cart: Cart,
  deps: CheckoutReuseDeps = defaultCheckoutReuseDeps,
): Promise<CheckoutReuseDecision> {
  const nowMs = deps.nowMs ?? Date.now();

  // 1. La orden apuntada por la sesión (validando que sea DE ESTE cliente — seguridad).
  let candidate = pendingOrderId ? await deps.getOrder(tenantId, pendingOrderId) : null;
  if (candidate && candidate.customerId !== customerId) candidate = null;
  let repaired = false;

  // 2. Puntero perdido o apuntando a una CANCELLED/REFUNDED → buscar una PENDING_PAYMENT
  //    reciente del cliente (el cliente vuelve a pedir pagar: reusar, no duplicar).
  if (!candidate || candidate.status === 'CANCELLED' || candidate.status === 'REFUNDED') {
    const found = await deps.findRecentPendingPayment(tenantId, customerId, nowMs - REUSE_RECENT_WINDOW_MS);
    if (found) {
      candidate = found;
      repaired = true;
    } else {
      return { kind: 'new' }; // nada reutilizable (incluye anterior cancelada → orden nueva OK)
    }
  }

  switch (candidate.status) {
    case 'PENDING_PAYMENT':
      return sameCartAsOrder(cart, candidate)
        ? { kind: 'reuse', order: candidate, repaired }
        : { kind: 'new_cart_changed', previous: candidate };
    case 'PENDING_VERIFICATION':
      return { kind: 'verification', order: candidate };
    default:
      if (PAID_ORDER_STATUSES.includes(candidate.status)) {
        // Grupo pagado: si el carrito es EXACTAMENTE lo ya pagado → informarlo (y el caller
        // limpia puntero+carrito, terminando lo que confirmPayment no llegó a hacer). Si el
        // carrito es OTRO, es una compra NUEVA: jamás bloquear al cliente con "ya figura
        // pagado" en loop (review adversarial F5 — el puntero stale-pagado era un deadlock).
        return sameCartAsOrder(cart, candidate) ? { kind: 'paid', order: candidate } : { kind: 'new' };
      }
      return { kind: 'new' }; // terminal no-pagada u estado desconocido → crear
  }
}
