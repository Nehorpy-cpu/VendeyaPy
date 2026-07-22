/**
 * COVERAGE-1B — Revisión manual de cobertura de envío ANTES del pago.
 * ===================================================================
 * Cuando el flag `coverage.enabled` del tenant está activo, "quiero pagar" NO crea la orden ni
 * muestra datos bancarios: primero se pide la ubicación (nativa de WhatsApp o dirección escrita)
 * y un humano aprueba/rechaza la cobertura desde el panel (1C). La aprobación vale para la
 * UBICACIÓN (locationFingerprint) durante su vigencia — cambiar el carrito no re-abre la revisión.
 *
 * Colección: `tenants/{tenantId}/coverageRequests/{requestId}` (id `covr_{nanoid12}`, inmutable).
 * PRIVACIDAD: las coordenadas exactas y el `name` del lugar viven SOLO acá — ninguna orden los copia.
 * La dirección TEXTUAL saneada (`location.addressText`) SÍ se copia a `Order.delivery.address` tras la
 * aprobación (necesaria para cumplir el envío; ver ADR-0011). Jamás en mensajes al cliente, quote de
 * envío, outbox, logs, prompts de IA ni notificaciones. La sesión guarda apenas un puntero sin PII.
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

/**
 * SHIPPING-CHAT (ADR-0011) — Costo de envío confirmado por el vendedor durante la revisión.
 * El monto ESTRUCTURADO (`chargeGs`, entero PYG) es la autoridad financiera — NUNCA el texto libre
 * ni una respuesta de IA. Detectado por el parser determinístico compartido, confirmado por un
 * humano y re-parseado server-side. Sin PII: jamás lleva dirección ni coordenadas.
 */
export interface CoverageShippingQuote {
  /** Cargo de envío al cliente, entero en guaraníes (0 solo con frase inequívoca de gratuidad). */
  chargeGs: number;
  currency: 'PYG';
  /** Origen del quote (por ahora solo el chat del vendedor). */
  source: 'seller_chat';
  /** Id del outbox del mensaje canónico del vendedor (idempotencia de la saga; SHIPPING-CHAT-3). */
  sourceOutboxId: string;
  /** wamid de Meta si el envío del mensaje del vendedor fue live y se confirmó. */
  providerMessageId?: string | null;
  /** La cotización vale para ESTA ubicación (cambiar ubicación la invalida). */
  locationFingerprint: string;
  /** La cotización vale para ESTE carrito (cambiar el carrito invalida el precio de envío). */
  cartFingerprint: string;
  quotedByUid: string;
  quotedByName: string;
  quotedByRole: string;
  quotedAt: Timestamp;
  /** Versión del parser que produjo el monto (auditabilidad; ver PARSER_VERSION). */
  parserVersion: string;
}

/**
 * SHIPPING-CHAT-3B (diseño 3A-HARDEN) — Pointer del INTENTO de cotización en curso.
 * Lo escribe la saga de SHIPPING-CHAT-3C (`coverageQuote.ts`). Sin estado, lease ni attempts
 * A PROPÓSITO: la ÚNICA fuente de verdad del envío es el outbox — este pointer solo identifica
 * el intento y congela el actor original (una recuperación por otro OWNER/MANAGER completa la
 * saga pero jamás reemplaza a `quotedBy*`).
 */
export interface ShippingQuotePending {
  /** Nonce del intento: `qat_[0-9A-Za-z]{12}` (ID_PREFIX nuevo en 3C; jamás reusa checkoutAttemptId). */
  quoteAttemptId: string;
  /** Monto del intento (para que el panel ofrezca "completar la cotización de ₲X"). */
  chargeGs: number;
  locationFingerprint: string;
  cartFingerprint: string;
  quotedByUid: string;
  quotedByName: string;
  quotedByRole: string;
  createdAt: Timestamp;
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
  /** HARDEN-1: activación bajo la que se creó. Distinta de la vigente ⇒ el job es INERTE. */
  activationId?: string | null;
  /** 1D: idempotencia del pedido (reservado ANTES de crear la orden). */
  checkoutAttemptId?: string | null;
  /** 1D: orderId reservado/creado (una sola vez por checkoutAttemptId). */
  orderId?: string | null;
  /** 1D: lease del worker (claim transaccional; vencido ⇒ recuperable). */
  leaseUntil?: Timestamp | null;
  /** 1D: reintentos consumidos (tope duro — jamás retries infinitos). */
  attempts?: number;
  /**
   * SHIPPING-CHAT-3C: costo de envío APROBADO (entero Gs) — presente solo en jobs creados por
   * la saga de cotización (TX-C). El consumidor crea la orden con este monto separado en totals.
   */
  shippingGs?: number | null;
  /**
   * SHIPPING-CHAT-3C: carrito CONGELADO y verificado en TX-C (cart2). El consumidor crea la orden
   * desde ESTE snapshot, jamás desde el carrito vivo de la sesión (el quote vale para este carrito).
   */
  cartSnapshot?: { items: CoverageCartItem[]; subtotal: number } | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Outbox de MENSAJERÍA de la reanudación (1D). Doc-id determinístico
 * `{coverageRequestId}_{action}[_{checkoutAttemptId}]` — reduce la ventana envío→persistencia:
 * el mensaje queda `prepared` ANTES de llamar a Meta; `sent` guarda el wamid del proveedor;
 * `unknown` (timeout/ACK perdido) JAMÁS se reenvía automáticamente. Solo backend (rules deny).
 * No contiene secretos: el texto es exactamente lo que el cliente recibe.
 *
 * SHIPPING-CHAT-3C-HARDEN-1: unión DISCRIMINADA por `action` — un mensaje de cotización exige
 * sus campos `quote` en compile-time; una acción legacy no puede llevarlos por accidente.
 * Compat de lectura: los docs legacy anteriores no traen los campos nuevos (opcionales/ausentes).
 */
interface CoverageOutboxMessageBase {
  id: string;
  tenantId: string;
  coverageRequestId: string;
  customerId: string;
  channel: MessageChannel;
  receivedVia: string | null;
  /** HARDEN-1: activación bajo la que se creó (trazabilidad del artefacto). */
  activationId?: string | null;
  text: string;
  /**
   * SHIPPING-CHAT-3C: `sent_not_applied` = Meta aceptó el mensaje pero un mismatch determinístico
   * post-envío impidió aplicar la aprobación (terminal auditable; jamás se reenvía).
   * HARDEN-2 (review): `sent_applied` = TX-C aplicó la aprobación (terminal FELIZ del quote) —
   * sin él, los quotes completados quedaban `sent` para siempre y saturaban los slots del sweep
   * de mantenimiento (inanición: un intento nuevo genuinamente atascado jamás entraba al lote).
   */
  status: 'prepared' | 'sending' | 'sent' | 'failed' | 'unknown' | 'sent_not_applied' | 'sent_applied';
  providerMessageId: string | null;
  attempts: number;
  leaseUntil: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** SHIPPING-CHAT-3C — datos del intento de cotización (actor ORIGINAL congelado). */
export interface CoverageOutboxQuoteInfo {
  quoteAttemptId: string;
  chargeGs: number;
  quotedByUid: string;
  quotedByName: string;
  quotedByRole: string;
  expectedLocationFingerprint: string;
  expectedCartFingerprint: string;
}

/** SHIPPING-CHAT-3C — resolución manual de un `unknown` (quién reconcilió; jamás pisa quotedBy). */
export interface CoverageOutboxReconciled {
  byUid: string;
  byName: string;
  byRole: string;
  at: Timestamp;
  note: string;
  resolution: 'delivered' | 'not_delivered';
}

/** Mensajes legacy de la reanudación (1D): jamás llevan los campos de la saga de cotización. */
export interface CoverageOutboxLegacyMessage extends CoverageOutboxMessageBase {
  action: 'approved' | 'rejected' | 'expired' | 'empty_cart';
  checkoutAttemptId: string | null;
  quote?: never;
  reconciled?: never;
}

/** Mensaje canónico de cotización (saga TX-A→send→TX-C, `coverageQuote.ts`). */
export interface CoverageOutboxQuoteMessage extends CoverageOutboxMessageBase {
  action: 'quote';
  /** SIEMPRE null en quote (el nonce del intento viaja en `quote.quoteAttemptId`). */
  checkoutAttemptId: null;
  quote: CoverageOutboxQuoteInfo;
  reconciled: CoverageOutboxReconciled | null;
}

export type CoverageOutboxMessage = CoverageOutboxLegacyMessage | CoverageOutboxQuoteMessage;

/**
 * SHIPPING-CHAT-3C-HARDEN-1 — Fase DERIVADA del intento de cotización para el panel (respuesta de
 * `coverageQuoteAttemptState`). Jamás se persiste: el outbox es la única fuente de verdad.
 */
export type ShippingQuoteAttemptPhase = 'preparing' | 'in_progress' | 'sent_pending_approval' | 'failed' | 'unknown';

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
  /**
   * HARDEN-1: activación del flujo bajo la que se creó el request. Si no coincide con la
   * activación VIGENTE del tenant, el request es histórico/inerte: no se decide ni se reanuda.
   */
  activationId?: string | null;
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
  /**
   * SHIPPING-CHAT (ADR-0011): costo de envío confirmado por el vendedor para esta revisión.
   * Ausente/null = sin cotización todavía. Lo persiste `coverageQuoteAndApprove` (SHIPPING-CHAT-3).
   */
  shippingQuote?: CoverageShippingQuote | null;
  /**
   * SHIPPING-CHAT-3B: intento de cotización EN CURSO (tipo preparatorio; el writer es la saga
   * de 3C). Ausente/null = sin intento activo. Legible por el seller asignado (sin PII).
   */
  shippingQuotePending?: ShippingQuotePending | null;
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

/**
 * Config opcional por tenant (dentro de `config/checkout`). Ausente/ inválida ⇒ deshabilitado.
 * HARDEN-1: `enabled: true` SIN `activationId` válido también ⇒ deshabilitado (fail-closed).
 * Cada reactivación futura DEBE usar un activationId nuevo (lo escribe el programa de
 * activación aprobado — el runtime jamás lo genera): los artefactos de la activación
 * anterior quedan inertes sin borrarlos.
 */
export interface CoverageConfig {
  enabled: boolean; // default false
  /** Identificador opaco de la activación (ver coverageActivation.ts). Sin él, todo queda OFF. */
  activationId?: string;
  expiryHours: number; // default 24
  requestMessage?: string;
  rejectedMessage?: string;
  /**
   * SHIPPING-CHAT (ADR-0011): cotización de envío obligatoria en la aprobación.
   * Ausente ⇒ deshabilitado (comportamiento actual). La activación futura de Arfagi deberá escribir
   * `required=true` explícitamente. Con `required=true`, el `coverageApprove` viejo rechazará
   * aprobaciones sin quote y solo `coverageQuoteAndApprove` podrá aprobar (SHIPPING-CHAT-3).
   */
  shippingQuote?: {
    required: boolean;
    /** Tope defensivo del cargo de envío (guaraníes enteros). Default de diseño ₲5.000.000. */
    maxChargeGs: number;
  };
}

/**
 * SHIPPING-CHAT (ADR-0011) — Contrato compartido de entrada de la callable `coverageQuoteAndApprove`
 * (implementada en `coverageQuote.ts`, SHIPPING-CHAT-3C). El backend resuelve el tenant y
 * el actor desde los claims: JAMÁS se aceptan `customerId`, actor, nombre, rol, subtotal ni total
 * desde el cliente. El servidor re-parsea `sellerDraft` y exige `parsed === confirmedShippingGs`.
 */
export interface CoverageQuoteAndApproveInput {
  /** Solo para coincidir con los claims (el backend usa el de los claims). */
  tenantId?: string;
  requestId: string;
  /** Borrador natural que escribió el vendedor (se re-parsea server-side; nunca se loguea). */
  sellerDraft: string;
  /** Huella de la ubicación mostrada al vendedor (si cambió, la decisión no aplica). */
  expectedLocationFingerprint: string;
  /** Huella del carrito mostrado (si cambió, hay que recotizar el envío). */
  expectedCartFingerprint: string;
  /** Monto de envío confirmado en el preview; debe coincidir con el re-parseo del servidor. */
  confirmedShippingGs: number;
}
