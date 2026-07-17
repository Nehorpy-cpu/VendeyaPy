/**
 * orders/createPendingOrder.ts — Crea una orden pendiente de pago (F6.1)
 * ======================================================================
 * Toma el carrito de la sesión y crea una Order en Firestore con estado
 * PENDING_PAYMENT. El cobro es por TRANSFERENCIA (ver checkoutConfig): el cliente
 * transfiere y manda comprobante; un vendedor confirma (F6b). Crear la orden NO
 * cobra dinero: persiste el estado del checkout antes del pago (innegociable de
 * backend: persistir antes de operaciones importantes).
 */

import { Timestamp, type Transaction } from 'firebase-admin/firestore';
import { newOrderId, newOrderItemId } from '@vpw/shared';
import type { Cart, Order, OrderItem, OrderFinancials, OrderFinancialsItem, Address } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { getProductCost } from '../catalog/financials.js';

// Dirección vacía: la recolección de domicilio es de la fase de logística (futuro).
function emptyAddress(): Address {
  return {
    street: '',
    houseNumber: '',
    city: '',
    neighborhood: '',
    reference: '',
    coordinates: null,
  };
}

/** COVERAGE-1D: opciones para la reanudación idempotente del checkout. */
export interface CreatePendingOrderOpts {
  /** orderId RESERVADO previamente (idempotencia del worker de reanudación). */
  orderId?: string;
  /** Referencia auditable a la cobertura aprobada (jamás coordenadas). */
  coverage?: { requestId: string; locationFingerprint: string | null };
  /** Dirección TEXTUAL del cliente (la exacta con coordenadas vive solo en coverageRequests). */
  deliveryAddress?: Address;
  /**
   * KILL-SWITCH-1 (cobertura): precondición evaluada DENTRO de la transacción que crea la orden
   * (lecturas antes de escrituras — misma creación idempotente, ahora atómica con el guard).
   * false ⇒ NO se crea nada (ni orden ni finanzas) y se devuelve null.
   */
  guard?: (tx: Transaction) => Promise<boolean>;
}

export async function createPendingOrder(
  tenantId: string,
  customerId: string,
  cart: Cart,
  opts?: CreatePendingOrderOpts & { guard?: undefined },
): Promise<Order>;
export async function createPendingOrder(
  tenantId: string,
  customerId: string,
  cart: Cart,
  opts: CreatePendingOrderOpts & { guard: NonNullable<CreatePendingOrderOpts['guard']> },
): Promise<Order | null>;
export async function createPendingOrder(
  tenantId: string,
  customerId: string,
  cart: Cart,
  opts: CreatePendingOrderOpts = {},
): Promise<Order | null> {
  const now = Timestamp.now();
  const orderId = opts.orderId ?? newOrderId();

  // COVERAGE-1D (review): con un orderId RESERVADO, un worker stale jamás pisa la orden que
  // otro worker ya creó (ni sus finanzas congeladas) — si existe, se reusa tal cual.
  if (opts.orderId) {
    const existente = await db().doc(paths.order(tenantId, orderId)).get();
    if (existente.exists) return existente.data() as Order;
  }

  // El costo (privado) se lee de productFinancials y se "congela" en orderFinancials.
  // La orden visible NO lleva costo/ganancia (legible por el vendedor). Ver ADR-0008.
  const rows = await Promise.all(
    cart.items.map(async (i) => {
      const unitCost = await getProductCost(tenantId, i.productId);
      const subtotal = i.price * i.quantity;
      const item: OrderItem = {
        itemId: newOrderItemId(),
        productId: i.productId,
        productName: i.name,
        unitPrice: i.price,
        quantity: i.quantity,
        subtotal,
      };
      const fin: OrderFinancialsItem = {
        productId: i.productId,
        quantity: i.quantity,
        unitCostSnapshot: unitCost,
        totalCostSnapshot: unitCost == null ? null : unitCost * i.quantity,
      };
      return { item, fin };
    }),
  );
  const items = rows.map((r) => r.item);
  const finItems = rows.map((r) => r.fin);

  // Totales financieros (privados): si algún ítem no tiene costo, la ganancia queda incompleta.
  const costoIncompleto = finItems.some((fi) => fi.totalCostSnapshot == null);
  const totalCost = costoIncompleto ? null : finItems.reduce((s, fi) => s + (fi.totalCostSnapshot ?? 0), 0);
  const grossProfit = totalCost == null ? null : cart.subtotal - totalCost;
  const grossMarginPercentage =
    grossProfit == null || cart.subtotal <= 0 ? null : (grossProfit / cart.subtotal) * 100;

  // Atribución (D5): el pedido hereda de qué campaña vino el cliente.
  const custData = (await db().doc(paths.customer(tenantId, customerId)).get()).data() as { attribution?: Order['attribution'] } | undefined;
  const attribution = custData?.attribution;

  const order: Order = {
    id: orderId,
    tenantId,
    customerId,
    status: 'PENDING_PAYMENT',
    items,
    totals: { subtotal: cart.subtotal, discount: 0, total: cart.subtotal, currency: 'PYG' },
    payment: { method: 'BANCARD', paymentId: '', paidAt: null, comprobanteUrl: null }, // provisional; se confirma al pagar
    delivery: { deliveryId: null, address: opts.deliveryAddress ?? emptyAddress() },
    invoice: { invoiceId: null, number: null },
    channel: 'WHATSAPP',
    sellerId: null, // se asigna en el handoff
    source: 'whatsapp-bot', // tracking (prep Track C)
    ...(attribution ? { attribution } : {}),
    ...(opts.coverage ? { coverage: opts.coverage } : {}),
    notes: '',
    createdAt: now,
    updatedAt: now,
  };

  const orderFinancials: OrderFinancials = {
    orderId,
    tenantId,
    subtotal: cart.subtotal,
    totalCost,
    grossProfit,
    grossMarginPercentage,
    items: finItems,
    createdAt: now,
    updatedAt: now,
  };

  // KILL-SWITCH-1: con guard, la precondición y la creación idempotente van en UNA transacción
  // (lecturas primero): si el guard da false, no se escribe NADA — ni orden ni finanzas.
  if (opts.guard) {
    const creado = await db().runTransaction(async (tx) => {
      const oSnap = await tx.get(db().doc(paths.order(tenantId, orderId)));
      if (oSnap.exists) return oSnap.data() as Order; // reserva 1D: la orden existente se reusa intacta
      if (!(await opts.guard!(tx))) return null;
      tx.set(db().doc(paths.orderFinancial(tenantId, orderId)), orderFinancials);
      tx.create(db().doc(paths.order(tenantId, orderId)), order);
      return order;
    });
    if (creado) logger.info('Pre-orden creada', { tenantId, customerId, orderId });
    return creado;
  }

  // Finanzas privadas PRIMERO: así el trigger de stats (que escucha la orden) ya las encuentra.
  // Un orphan de orderFinancials (si fallara el 2º write) es inofensivo: no hay orden visible.
  await db().doc(paths.orderFinancial(tenantId, orderId)).set(orderFinancials);
  if (opts.orderId) {
    // Reserva 1D: `create()` — si otro worker ganó la carrera, se devuelve SU orden intacta.
    try {
      await db().doc(paths.order(tenantId, orderId)).create(order);
    } catch (e) {
      const code = (e as { code?: number | string }).code;
      if (code === 6 || code === 'already-exists') {
        return (await db().doc(paths.order(tenantId, orderId)).get()).data() as Order;
      }
      throw e;
    }
  } else {
    await db().doc(paths.order(tenantId, orderId)).set(order);
  }

  logger.info('Pre-orden creada', { tenantId, customerId, orderId });
  return order;
}
