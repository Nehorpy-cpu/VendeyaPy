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

/** Decisión humana (1C). */
export interface CoverageDecision {
  action: 'approved' | 'rejected';
  byUid: string;
  byName: string;
  byRole: string;
  at: Timestamp;
  /** Nota interna opcional (rechazo). JAMÁS se envía al cliente ni va a logs/auditoría. */
  note: string | null;
  /** Huella EXACTA de la ubicación decidida (leída dentro de la transacción — auditable). */
  locationFingerprint: string | null;
}

/**
 * Outbox de reanudación (1C lo crea al decidir; 1D lo consume). Doc-id = coverageRequestId
 * (determinístico: una decisión jamás encola dos jobs). Solo backend (rules deny total).
 */
export interface CoverageResumeJob {
  id: string;
  tenantId: string;
  coverageRequestId: string;
  customerId: string;
  action: 'approved' | 'rejected';
  status: CoverageResumeStatus;
  channel: MessageChannel;
  receivedVia: string | null;
  /** 1D: idempotencia del pedido (reservado ANTES de crear la orden). */
  checkoutAttemptId?: string | null;
  /** 1D: orderId reservado/creado (una sola vez por checkoutAttemptId). */
  orderId?: string | null;
  /** 1D: lease del worker (claim transaccional; vencido ⇒ recuperable). */
  leaseUntil?: Timestamp | null;
  /** 1D: reintentos consumidos (tope duro — jamás retries infinitos). */
  attempts?: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Outbox de MENSAJERÍA de la reanudación (1D). Doc-id determinístico
 * `{coverageRequestId}_{action}[_{checkoutAttemptId}]` — reduce la ventana envío→persistencia:
 * el mensaje queda `prepared` ANTES de llamar a Meta; `sent` guarda el wamid del proveedor;
 * `unknown` (timeout/ACK perdido) JAMÁS se reenvía automáticamente. Solo backend (rules deny).
 * No contiene secretos: el texto es exactamente lo que el cliente recibe.
 */
export interface CoverageOutboxMessage {
  id: string;
  tenantId: string;
  coverageRequestId: string;
  action: 'approved' | 'rejected' | 'expired' | 'empty_cart';
  checkoutAttemptId: string | null;
  customerId: string;
  channel: MessageChannel;
  receivedVia: string | null;
  text: string;
  status: 'prepared' | 'sending' | 'sent' | 'failed' | 'unknown';
  providerMessageId: string | null;
  attempts: number;
  leaseUntil: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Estados del ciclo de reanudación (job del outbox y espejo en el request). */
export type CoverageResumeStatus =
  | 'pending'
  | 'processing'
  | 'held_by_seller'
  | 'send_failed'
  | 'send_unknown'
  | 'done'
  | 'cancelled';

/** Reanudación del checkout post-decisión (1D). */
export interface CoverageResume {
  status: CoverageResumeStatus;
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
  /** 1C: momento del último "Solicitar más información" (idempotencia de doble clic). */
  infoRequestedAt?: Timestamp | null;
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
