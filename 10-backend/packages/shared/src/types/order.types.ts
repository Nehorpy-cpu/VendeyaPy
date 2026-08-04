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
   * órdenes viejas (ausente ⇒ 0; usar `normalizeOrderTotals`). Desde SHIPPING-CHAT-3C todos los
   * pedidos NUEVOS lo persisten (0 sin cotización). Nunca se suma a `subtotal` ni a
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

/**
 * ADR-0016 §1/§5 — Adjuntos de conversación asociados a ESTE pedido. Es la superficie que el
 * panel de Pedidos lee para saber que hay un comprobante: los bytes NO viven acá y el pedido
 * jamás guarda una ruta de Storage — solo ids OPACOS que se abren por `attachmentGetViewUrl`.
 *
 * POR QUÉ existe además de `payment.comprobanteUrl`: ese campo es de UN solo valor y nació para
 * los comprobantes legacy (`tenants/{t}/orders/{o}/comprobantes/…`). El contrato nuevo es
 * MULTI-ADJUNTO —«un segundo envío acumula, no reemplaza»— y separa dos cosas que no son lo
 * mismo: lo que el sistema SUGIRIÓ y lo que una persona DECIDIÓ. Meter las dos en un campo de
 * un valor obligaba a elegir cuál gana y a mantener dos fuentes de la misma verdad.
 */
export interface OrderReceiptAttachments {
  /**
   * SUGERENCIAS del gate determinístico. **No son comprobante**: el pedido no se movió por
   * estar acá y nadie confirmó nada. El panel debe mostrarlas como propuesta a revisar.
   */
  candidateIds: string[];
  /** Vinculados por una PERSONA autorizada (owner/manager/seller). Son la evidencia elegida. */
  linkedIds: string[];
  /** Cuál de los vinculados produjo el `PENDING_VERIFICATION` vigente (null = lo produjo otra cosa). */
  statusDrivenBy: string | null;
  /** Última vez que cambió esta metadata (server-set). */
  updatedAt?: Timestamp;
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
  /**
   * ADR-0017 §2 — CANAL de la conversación que armó este pedido (`active` = número heredado).
   *
   * Se PERSISTE en vez de recalcularse porque quien cierra el checkout no tiene el turno a mano:
   * el webhook de la pasarela, el callable del panel y el endpoint de prueba solo conocen el
   * `orderId`. Sin este campo, `confirmPayment` vaciaba el carrito de `sessions/active` — con dos
   * números, el de la conversación equivocada.
   *
   * OPCIONAL y retrocompatible: un pedido sin el campo es del canal heredado.
   */
  sessionKey?: string;
  /** Vendedor asignado (null hasta el handoff/asignación). */
  sellerId: string | null;
  /** Origen del pedido para tracking (ej: 'whatsapp-bot', campaña). Prep Track C. */
  source: string | null;
  /** Atribución a la campaña que trajo al cliente (D5). */
  attribution?: Attribution;
  /** COVERAGE-1D: la orden nació de una cobertura APROBADA (referencia auditable; SIN coordenadas). */
  coverage?: { requestId: string; locationFingerprint: string | null };
  /**
   * ADR-0016 §5: adjuntos propuestos/vinculados como comprobante. OPCIONAL: los pedidos
   * anteriores al ADR no lo tienen y siguen renderizando. Leer SIEMPRE con
   * `readOrderReceiptAttachments` (proyección defensiva compartida), nunca campo por campo.
   */
  receiptAttachments?: OrderReceiptAttachments;
  notes: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
