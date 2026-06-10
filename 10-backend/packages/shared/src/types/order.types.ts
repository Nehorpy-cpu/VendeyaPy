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
}

export interface OrderTotals {
  subtotal: number;
  discount: number;
  total: number;
  currency: Currency;
}

export interface OrderPayment {
  method: PaymentMethod;
  paymentId: string;
  paidAt: Timestamp | null;
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
  notes: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
