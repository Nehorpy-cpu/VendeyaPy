/**
 * Órdenes (pedidos).
 * Ver ARCHITECTURE.md §4.6.
 */

import type { OrderStatus, PaymentMethod, Channel, Currency } from '../enums.js';
import type { Address, Timestamp } from './common.types.js';

export interface OrderItem {
  itemId: string;
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
  /** Costo unitario al momento de la venta (null si el producto no tenía costo cargado). */
  unitCost: number | null;
  totalCost: number | null;
  grossProfit: number | null;
}

export interface OrderTotals {
  subtotal: number;
  discount: number;
  total: number;
  currency: Currency;
  /** Costo total y ganancia bruta. null si algún producto no tenía costo (ganancia incompleta). */
  totalCost: number | null;
  grossProfit: number | null;
}

export interface OrderPayment {
  method: PaymentMethod;
  paymentId: string;
  paidAt: Timestamp | null;
  /** URL/ref del comprobante de transferencia que envió el cliente (null hasta recibirlo). */
  comprobanteUrl: string | null;
}

export interface OrderDelivery {
  deliveryId: string | null;
  address: Address;
}

export interface OrderInvoice {
  invoiceId: string | null;
  number: string | null;
}

export interface Order {
  id: string;
  tenantId: string;
  customerId: string;
  status: OrderStatus;
  items: OrderItem[];
  totals: OrderTotals;
  payment: OrderPayment;
  delivery: OrderDelivery;
  invoice: OrderInvoice;
  channel: Channel;
  /** Vendedor asignado (null hasta el handoff/asignación). */
  sellerId: string | null;
  /** Origen del pedido para tracking (ej: 'whatsapp-bot', campaña). Prep Track C. */
  source: string | null;
  notes: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
