/**
 * Sesión activa de conversación de un cliente.
 * Solo existe una sesión activa por cliente (documentId = "active").
 * Ver ARCHITECTURE.md §4.5.
 */

import type { SessionState } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface CartItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  imageUrl: string;
}

export interface Cart {
  items: CartItem[];
  subtotal: number;
}

export interface SessionContext {
  lastMessageAt: Timestamp;
  currentPage: number;
  currentCategoryId: string | null;
  pendingOrderId: string | null;
  pendingPaymentId: string | null;
  /** SKUs de los productos mostrados al cliente en el último listado (para "agregá el primero"). */
  lastShownSkus: string[];
  /** Si está en true, un vendedor humano tomó el chat y el bot NO responde. */
  humanTakeover: boolean;
}

export interface Session {
  id: string;
  tenantId: string;
  customerId: string;
  state: SessionState;
  cart: Cart;
  context: SessionContext;
  expiresAt: Timestamp;
  updatedAt: Timestamp;
}
