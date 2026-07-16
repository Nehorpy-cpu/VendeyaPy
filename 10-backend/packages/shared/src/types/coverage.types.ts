/**
 * COVERAGE-1B — Revisión manual de cobertura de envío ANTES del pago.
 * ===================================================================
 * Cuando el flag `coverage.enabled` del tenant está activo, "quiero pagar" NO crea la orden ni
 * muestra datos bancarios: primero se pide la ubicación (nativa de WhatsApp o dirección escrita)
 * y un humano aprueba/rechaza la cobertura desde el panel (1C). La aprobación vale para la
 * UBICACIÓN (locationFingerprint) durante su vigencia — cambiar el carrito no re-abre la revisión.
 *
 * Colección: `tenants/{tenantId}/coverageRequests/{requestId}` (id `covr_{nanoid12}`, inmutable).
 * PRIVACIDAD: la ubicación exacta (coordenadas / dirección) vive SOLO acá — jamás en mensajes,
 * logs, prompts de IA ni notificaciones. La sesión guarda apenas un puntero sin PII.
 * Escritura solo por Admin SDK/callables (rules default-deny para clientes).
 */
import type { Timestamp } from './common.types.js';
import type { MessageChannel } from '../enums.js';

export type CoverageStatus =
  | 'awaiting_location'
  | 'pending_coverage_review'
  | 'coverage_approved'
  | 'coverage_rejected'
  | 'coverage_expired'
  | 'coverage_cancelled';

/** Estados en los que el request sigue vivo (todo lo demás es terminal). */
export const COVERAGE_ACTIVE_STATUSES: readonly CoverageStatus[] = ['awaiting_location', 'pending_coverage_review', 'coverage_approved'];

/** Ubicación aportada por el cliente. SOLO se persiste dentro del CoverageRequest. */
export interface CoverageLocation {
  source: 'text' | 'whatsapp_location';
  /** Dirección escrita por el cliente (o `address` del payload nativo). Saneada y con tope. */
  addressText: string | null;
  /** Nombre del lugar (payload nativo de WhatsApp; opcional). */
  name: string | null;
  /** Coordenadas exactas (payload nativo). Sujetas a purga futura (coordinatesPurgeAt). */
  coordinates: { lat: number; lng: number } | null;
}

/** Decisión humana (1C). En 1B siempre null. */
export interface CoverageDecision {
  action: 'approved' | 'rejected';
  byUid: string;
  byName: string;
  byRole: string;
  at: Timestamp;
  note: string | null;
}

/** Reanudación del checkout post-aprobación (1D). En 1B siempre null. */
export interface CoverageResume {
  status: 'pending' | 'done' | 'send_failed' | 'held_by_seller';
  orderId: string | null;
}

/** Ítem del snapshot de carrito (contexto para el revisor). SIN costos privados (ADR-0008). */
export interface CoverageCartItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

export interface CoverageRequest {
  id: string;
  tenantId: string;
  customerId: string;
  channel: MessageChannel;
  /** phone_number_id del negocio que recibió la conversación (responder por el MISMO número). */
  receivedVia: string | null;
  status: CoverageStatus;
  location: CoverageLocation | null;
  /** Huella de la ubicación: la aprobación vale para ESTA huella durante su vigencia. */
  locationFingerprint: string | null;
  /** wamid del mensaje que originó/actualizó el request (correlación; no es la idempotencia). */
  sourceMessageId: string | null;
  /** Contexto del carrito al momento de pedir la ubicación (precios públicos). */
  cartSnapshot: { items: CoverageCartItem[]; subtotal: number };
  cartFingerprint: string;
  /** Idempotencia del PEDIDO en la reanudación (1D). Separado de la aprobación de ubicación. */
  checkoutAttemptId: string | null;
  sellerUid?: string | null;
  sellerName?: string | null;
  decision: CoverageDecision | null;
  resume: CoverageResume | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Vencimiento de la revisión (expiryHours del tenant; default 24h). */
  expiresAt: Timestamp;
  /** Purga futura de coordenadas exactas (30 días post-terminal; el job llega después de 1B). */
  coordinatesPurgeAt: Timestamp | null;
}

/**
 * Puntero en la sesión (`context.coverage`). SIN PII: nunca dirección ni coordenadas —
 * solo id, estado, huella y timestamps.
 */
export interface CoverageSessionPointer {
  requestId: string;
  status: CoverageStatus;
  locationFingerprint: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Config opcional por tenant (dentro de `config/checkout`). Ausente/ inválida ⇒ deshabilitado. */
export interface CoverageConfig {
  enabled: boolean; // default false
  expiryHours: number; // default 24
  requestMessage?: string;
  rejectedMessage?: string;
}
