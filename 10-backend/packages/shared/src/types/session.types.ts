/**
 * Sesión activa de conversación de un cliente.
 * Solo existe una sesión activa por cliente (documentId = "active").
 * Ver ARCHITECTURE.md §4.5.
 */

import type { SessionState } from '../enums.js';
import type { Timestamp } from './common.types.js';
import type { CoverageSessionPointer } from './coverage.types.js';

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

/** Candidato de la confirmación pendiente: id + nombre (el nombre evita re-leer el catálogo). */
export interface PendingCartCandidate {
  id: string;
  name: string;
}

/**
 * F3 (CART-TARGETING): oferta de carrito VIGENTE. Cuando el bot recomienda producto(s), esto
 * registra QUÉ se le ofreció al cliente y EN QUÉ ORDEN se lo presentó (el orden del texto que
 * el cliente leyó, no el orden interno del buscador). "sí"/"el primero" se resuelven contra esto.
 */
export interface PendingCartConfirmation {
  /** Candidatos en el ORDEN PRESENTADO al cliente (products[0] = "1." del mensaje). */
  products: PendingCartCandidate[];
  /** Único candidato claro (products[0].id si hay exactamente uno); null si hay varios. */
  primaryProductId: string | null;
  source: 'ai_recommendation' | 'catalog_listing';
  createdAtMs: number;
  /** Vencida ⇒ una confirmación "sí" NO agrega: se repregunta (nunca contexto viejo). */
  expiresAtMs: number;
  /** true ⇔ hay más de un candidato: "sí" solo, no alcanza — se pide elegir. */
  needsDisambiguation: boolean;
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
  /** F3: oferta de carrito pendiente de confirmación (ausente/null = no hay oferta vigente). */
  pendingCartConfirmation?: PendingCartConfirmation | null;
  /** HANDOFF-2 / AI-FALLBACK-HONESTO-1: razón estructurada del takeover vigente (null al liberar). */
  handoffReason?: 'customer_requested' | 'payment_verification' | 'coverage_review' | 'seller_manual' | 'ai_unavailable' | null;
  /** HANDOFF-2: nombre del vendedor al que se derivó (auditoría mínima). */
  handoffSellerName?: string | null;
  /** HANDOFF-2: momento del handoff vigente. */
  handoffAt?: Timestamp | null;
  /** HANDOFF-2: id determinístico del disparador (wamid entrante / orderId) para idempotencia. */
  handoffSourceId?: string | null;
  /** COVERAGE-1B: puntero al request de cobertura vigente (SIN PII — jamás dirección/coords). */
  coverage?: CoverageSessionPointer | null;
  /** COVERAGE-1D: requestId cuya reanudación está EN CURSO — un turno concurrente no debe
   * disparar otro checkout mientras el worker crea la orden y manda las instrucciones. */
  coverageResumeInProgress?: string | null;
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
