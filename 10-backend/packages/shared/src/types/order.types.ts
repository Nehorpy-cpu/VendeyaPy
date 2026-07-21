/**
 * Órdenes (pedidos).
 * Ver ARCHITECTURE.md §4.6.
 */

import type { OrderStatus, PaymentMethod, Channel, Currency } from '../enums.js';
import type { Address, Timestamp } from './common.types.js';
import type { Attribution } from './attribution.types.js';

export interface OrderItem {
  itemId: string;
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
  // El costo/ganancia por ítem se movió a `orderFinancials/{orderId}.items` (privado). Ver ADR-0008.
}

/**
 * SHIPPING-CHAT-3C — Entrada MÍNIMA de carrito que acepta `createPendingOrder`: solo los campos
 * que la orden realmente usa (jamás imageUrl como autoridad de nada). `Cart` (sesión) es
 * estructuralmente asignable; el snapshot congelado de cobertura (CoverageCartItem[]) también.
 */
export interface OrderCartInput {
  items: Array<{ productId: string; name: string; price: number; quantity: number }>;
  subtotal: number;
}

export interface OrderTotals {
  subtotal: number;
  discount: number;
  /**
   * SHIPPING-CHAT (ADR-0011): cargo de envío. **Opcional SOLO por compatibilidad de LECTURA** de
   * órdenes viejas (ausente ⇒ 0; usar `normalizeOrderTotals`). Cuando se implemente SHIPPING-CHAT-4,
   * todos los pedidos NUEVOS deberán persistirlo. Nunca se suma a `subtotal` ni a
   * `orderFinancials.subtotal` (la ganancia de productos no se infla). `total = subtotal - discount + shipping`.
   */
  shipping?: number;
  total: number;
  currency: Currency;
  // El costo total y la ganancia se movieron a `orderFinancials/{orderId}` (privado). Ver ADR-0008.
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
  /** Atribución a la campaña que trajo al cliente (D5). */
  attribution?: Attribution;
  /** COVERAGE-1D: la orden nació de una cobertura APROBADA (referencia auditable; SIN coordenadas). */
  coverage?: { requestId: string; locationFingerprint: string | null };
  notes: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
