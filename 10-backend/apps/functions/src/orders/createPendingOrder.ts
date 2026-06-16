/**
 * orders/createPendingOrder.ts — Crea una orden pendiente de pago (F6.1)
 * ======================================================================
 * Toma el carrito de la sesión y crea una Order en Firestore con estado
 * PENDING_PAYMENT, más un link de pago.
 *
 * El link es SIMULADO por ahora — la pasarela real (Bancard/Stripe) se integra
 * cuando haya credenciales (fase posterior). Crear la orden NO cobra dinero:
 * persiste el estado del checkout antes de la operación de pago (innegociable
 * de backend: persistir antes de operaciones importantes).
 */

import { Timestamp } from 'firebase-admin/firestore';
import { newOrderId, newOrderItemId } from '@vpw/shared';
import type { Cart, Order, OrderItem, Address } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

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

export interface PendingOrderResult {
  order: Order;
  paymentLink: string;
}

export async function createPendingOrder(
  tenantId: string,
  customerId: string,
  cart: Cart,
): Promise<PendingOrderResult> {
  const now = Timestamp.now();
  const orderId = newOrderId();

  const items: OrderItem[] = cart.items.map((i) => ({
    itemId: newOrderItemId(),
    productId: i.productId,
    productName: i.name,
    unitPrice: i.price,
    quantity: i.quantity,
    subtotal: i.price * i.quantity,
  }));

  const order: Order = {
    id: orderId,
    tenantId,
    customerId,
    status: 'PENDING_PAYMENT',
    items,
    totals: { subtotal: cart.subtotal, discount: 0, total: cart.subtotal, currency: 'PYG' },
    payment: { method: 'BANCARD', paymentId: '', paidAt: null }, // provisional; se confirma al pagar
    delivery: { deliveryId: null, address: emptyAddress() }, // domicilio: fase logística
    invoice: { invoiceId: null, number: null },
    channel: 'WHATSAPP',
    notes: '',
    createdAt: now,
    updatedAt: now,
  };

  await db().doc(paths.order(tenantId, orderId)).set(order);

  // Link simulado. TODO: reemplazar por el link real de la pasarela (Bancard/Stripe).
  const paymentLink = `https://pago.perfumeriaafg.com/checkout/${orderId}`;

  logger.info('Pre-orden creada', { tenantId, customerId, orderId });
  return { order, paymentLink };
}
