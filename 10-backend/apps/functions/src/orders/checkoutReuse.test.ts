import { describe, it, expect, vi } from 'vitest';
import type { Cart, Order } from '@vpw/shared';
import {
  resolveCheckoutReuse,
  sameCartAsOrder,
  REUSE_RECENT_WINDOW_MS,
  type CheckoutReuseDeps,
} from './checkoutReuse.js';

/**
 * F5 (IDEMPOTENT-CHECKOUT): el bug real — "Para pagar cual es" 17 s después de "quiero pagar"
 * creó la orden duplicada ord_X72Sjqiytiok. Estos tests fijan la decisión de reuso.
 */
const NOW = 10_000_000;
const ts = (ms: number) => ({ toMillis: () => ms }) as never;

const cart = (items: Array<[string, number, number]>): Cart => ({
  items: items.map(([productId, quantity, price]) => ({ productId, name: 'P ' + productId, price, quantity, imageUrl: '' })),
  subtotal: items.reduce((n, [, q, p]) => n + q * p, 0),
});

const order = (over: Partial<Order> = {}): Order =>
  ({
    id: 'ord_A',
    tenantId: 'arfagi',
    customerId: 'c1',
    status: 'PENDING_PAYMENT',
    items: [{ itemId: 'i1', productId: 'sup', productName: 'Supremacy', unitPrice: 250000, quantity: 1, subtotal: 250000 }],
    totals: { subtotal: 250000, discount: 0, total: 250000, currency: 'PYG' },
    createdAt: ts(NOW - 60_000),
    ...over,
  }) as unknown as Order;

function deps(over: Partial<CheckoutReuseDeps> = {}) {
  const getOrder = vi.fn(async () => order());
  const findRecentPendingPayment = vi.fn(async () => null);
  return {
    getOrder: getOrder as unknown as CheckoutReuseDeps['getOrder'],
    findRecentPendingPayment: findRecentPendingPayment as unknown as CheckoutReuseDeps['findRecentPendingPayment'],
    nowMs: NOW,
    ...over,
  } as CheckoutReuseDeps & { getOrder: typeof getOrder; findRecentPendingPayment: typeof findRecentPendingPayment };
}

const CART_SUP = cart([['sup', 1, 250000]]);

describe('orders/checkoutReuse sameCartAsOrder', () => {
  it('mismos productos y cantidades (en cualquier orden) → true', () => {
    const c = cart([['a', 2, 100], ['b', 1, 50]]);
    const o = order({ items: [
      { itemId: 'x', productId: 'b', productName: 'B', unitPrice: 50, quantity: 1, subtotal: 50 },
      { itemId: 'y', productId: 'a', productName: 'A', unitPrice: 100, quantity: 2, subtotal: 200 },
    ] as never });
    expect(sameCartAsOrder(c, o)).toBe(true);
  });
  it('cantidad distinta / producto distinto / carrito vacío → false', () => {
    expect(sameCartAsOrder(cart([['sup', 2, 250000]]), order())).toBe(false);
    expect(sameCartAsOrder(cart([['otro', 1, 250000]]), order())).toBe(false);
    expect(sameCartAsOrder(cart([]), order())).toBe(false);
  });
});

describe('orders/checkoutReuse resolveCheckoutReuse', () => {
  it('1-2. BUG REAL: pendingOrderId → PENDING_PAYMENT del mismo carrito → REUSE (mismo orderId, sin crear)', async () => {
    const d = deps();
    const r = await resolveCheckoutReuse('arfagi', 'c1', 'ord_A', CART_SUP, d);
    expect(r).toEqual({ kind: 'reuse', order: expect.objectContaining({ id: 'ord_A' }), repaired: false });
    expect(d.findRecentPendingPayment).not.toHaveBeenCalled();
  });

  it('3. puntero PERDIDO pero hay PENDING_PAYMENT reciente del mismo carrito → REUSE + repaired', async () => {
    const d = deps({ findRecentPendingPayment: vi.fn(async () => order()) as never });
    const r = await resolveCheckoutReuse('arfagi', 'c1', null, CART_SUP, d);
    expect(r).toMatchObject({ kind: 'reuse', repaired: true });
  });

  it('4. orden PENDING_VERIFICATION → "comprobante en revisión", jamás crear otra', async () => {
    const d = deps({ getOrder: vi.fn(async () => order({ status: 'PENDING_VERIFICATION' })) as never });
    const r = await resolveCheckoutReuse('arfagi', 'c1', 'ord_A', CART_SUP, d);
    expect(r.kind).toBe('verification');
  });

  it.each(['PAID', 'PREPARING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED'] as const)(
    '5. orden %s (grupo pagado) con el MISMO carrito → "ya figura pagado", sin crear',
    async (status) => {
      const d = deps({ getOrder: vi.fn(async () => order({ status })) as never });
      const r = await resolveCheckoutReuse('arfagi', 'c1', 'ord_A', CART_SUP, d);
      expect(r.kind).toBe('paid');
    },
  );

  it('5b. REVIEW: orden pagada pero carrito NUEVO → new (jamás bloquear la próxima compra en loop)', async () => {
    const d = deps({ getOrder: vi.fn(async () => order({ status: 'PAID' })) as never });
    const r = await resolveCheckoutReuse('arfagi', 'c1', 'ord_A', cart([['otro', 1, 100000]]), d);
    expect(r.kind).toBe('new');
  });

  it('6. orden CANCELLED/REFUNDED → NEW (el cliente puede volver a comprar)', async () => {
    for (const status of ['CANCELLED', 'REFUNDED'] as const) {
      const d = deps({ getOrder: vi.fn(async () => order({ status })) as never });
      const r = await resolveCheckoutReuse('arfagi', 'c1', 'ord_A', CART_SUP, d);
      expect(r.kind).toBe('new');
    }
  });

  it('7. PENDING_PAYMENT pero el carrito CAMBIÓ → new_cart_changed (nueva orden con aviso)', async () => {
    const d = deps();
    const r = await resolveCheckoutReuse('arfagi', 'c1', 'ord_A', cart([['sup', 2, 250000]]), d);
    expect(r).toMatchObject({ kind: 'new_cart_changed', previous: expect.objectContaining({ id: 'ord_A' }) });
  });

  it('8. sin puntero y sin PENDING_PAYMENT reciente → new', async () => {
    const d = deps({ getOrder: vi.fn(async () => null) as never });
    const r = await resolveCheckoutReuse('arfagi', 'c1', null, CART_SUP, d);
    expect(r.kind).toBe('new');
  });

  it('9. SEGURIDAD: pendingOrderId de OTRO cliente se ignora (no se reusa ni se filtra info)', async () => {
    const d = deps({ getOrder: vi.fn(async () => order({ customerId: 'OTRO' })) as never });
    const r = await resolveCheckoutReuse('arfagi', 'c1', 'ord_A', CART_SUP, d);
    expect(r.kind).toBe('new'); // findRecent devolvió null
    expect(d.findRecentPendingPayment).toHaveBeenCalled(); // intentó reparar, no reusar la ajena
  });

  it('10. la reparación usa la ventana reciente (sinceMs = now - 24h)', async () => {
    const find = vi.fn(async () => null);
    const d = deps({ getOrder: vi.fn(async () => null) as never, findRecentPendingPayment: find as never });
    await resolveCheckoutReuse('arfagi', 'c1', 'ord_perdida', CART_SUP, d);
    expect(find).toHaveBeenCalledWith('arfagi', 'c1', NOW - REUSE_RECENT_WINDOW_MS);
  });
});
