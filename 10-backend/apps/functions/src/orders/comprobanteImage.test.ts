import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { pickTargetOrder } from './comprobanteImage.js';
import type { Order } from '@vpw/shared';

/**
 * ORDER-1B: elección de la orden destino del comprobante — NUNCA se adjunta a ciegas.
 */
const order = (id: string, status: string, createdAtMs: number) =>
  ({ id, status, createdAt: Timestamp.fromMillis(createdAtMs) } as unknown as Order);

describe('orders/comprobanteImage pickTargetOrder', () => {
  it('pendingOrderId de la sesión gana si la orden sigue sin pagar', () => {
    const target = order('o-sess', 'PENDING_PAYMENT', 1000);
    const r = pickTargetOrder(target, [order('o-otra', 'PENDING_PAYMENT', 2000)]);
    expect(r).toEqual({ kind: 'target', order: target });
  });

  it('pendingOrderId también vale en PENDING_VERIFICATION (reenvío del comprobante)', () => {
    const target = order('o-sess', 'PENDING_VERIFICATION', 1000);
    expect(pickTargetOrder(target, [])).toEqual({ kind: 'target', order: target });
  });

  it('pendingOrderId STALE (ya pagada/cancelada) → cae a la búsqueda por cliente', () => {
    const stale = order('o-pagada', 'PAID', 1000);
    const pendiente = order('o-nueva', 'PENDING_PAYMENT', 2000);
    const r = pickTargetOrder(stale, [pendiente, order('o-vieja', 'DELIVERED', 500)]);
    expect(r).toEqual({ kind: 'target', order: pendiente });
  });

  it('sin sesión y UNA sola PENDING_PAYMENT → esa (la más reciente si hay pagadas viejas)', () => {
    const pendiente = order('o1', 'PENDING_PAYMENT', 3000);
    const r = pickTargetOrder(null, [order('x', 'CANCELLED', 1000), pendiente]);
    expect(r).toEqual({ kind: 'target', order: pendiente });
  });

  it('sin ninguna orden pendiente → none (respuesta segura, sin adjuntar)', () => {
    expect(pickTargetOrder(null, [order('x', 'PAID', 1000)])).toEqual({ kind: 'none' });
    expect(pickTargetOrder(null, [])).toEqual({ kind: 'none' });
  });

  it('múltiples PENDING_PAYMENT sin sesión → ambiguous (se pregunta, no se adjunta)', () => {
    const r = pickTargetOrder(null, [order('a', 'PENDING_PAYMENT', 1000), order('b', 'PENDING_PAYMENT', 2000)]);
    expect(r).toEqual({ kind: 'ambiguous', count: 2 });
  });
});
