/**
 * orders/createPendingOrder.ts — Crea una orden pendiente de pago (F6.1)
 * ======================================================================
 * Toma el carrito de la sesión y crea una Order en Firestore con estado
 * PENDING_PAYMENT. El cobro es por TRANSFERENCIA (ver checkoutConfig): el cliente
 * transfiere y manda comprobante; un vendedor confirma (F6b). Crear la orden NO
 * cobra dinero: persiste el estado del checkout antes del pago (innegociable de
 * backend: persistir antes de operaciones importantes).
 */

import { Timestamp } from 'firebase-admin/firestore';
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

export async function createPendingOrder(
  tenantId: string,
  customerId: string,
  cart: Cart,
): Promise<Order> {
  const now = Timestamp.now();
  const orderId = newOrderId();

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

  const order: Order = {
    id: orderId,
    tenantId,
    customerId,
    status: 'PENDING_PAYMENT',
    items,
    totals: { subtotal: cart.subtotal, discount: 0, total: cart.subtotal, currency: 'PYG' },
    payment: { method: 'BANCARD', paymentId: '', paidAt: null, comprobanteUrl: null }, // provisional; se confirma al pagar
    delivery: { deliveryId: null, address: emptyAddress() }, // domicilio: fase logística
    invoice: { invoiceId: null, number: null },
    channel: 'WHATSAPP',
    sellerId: null, // se asigna en el handoff
    source: 'whatsapp-bot', // tracking (prep Track C)
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

  // Persistir orden visible + finanzas privadas (la orden primero, por si falla el 2º write).
  await db().doc(paths.order(tenantId, orderId)).set(order);
  await db().doc(paths.orderFinancial(tenantId, orderId)).set(orderFinancials);

  logger.info('Pre-orden creada', { tenantId, customerId, orderId });
  return order;
}
