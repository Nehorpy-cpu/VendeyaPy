/**
 * Mensajes de una conversación (historial del chat de WhatsApp).
 * Subcolección: tenants/{t}/customers/{c}/messages/{messageId}.
 *
 * El motor del bot persiste cada mensaje entrante (cliente) y saliente (bot).
 * Cuando un vendedor toma el chat, sus mensajes se guardan como author 'seller'.
 * Eventos como "el vendedor tomó el chat" se guardan como author 'system'.
 */

import type { SessionState, MessageChannel } from '../enums.js';
import type { Timestamp } from './common.types.js';

/**
 * ADR-0021: estado de entrega de un mensaje SALIENTE, alimentado EXCLUSIVAMENTE por los
 * `value.statuses` del webhook de Meta. Nunca se infiere (si el destinatario desactivó los
 * recibos de lectura, el estado se queda honesto en 'delivered'). Los entrantes no tienen estado.
 */
export type MessageDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

/**
 * ADR-0021: orden monotónico de los estados de entrega. Un evento con rango menor o igual al
 * actual es un no-op (idempotencia; los recibos repetidos o tardíos nunca retroceden el estado).
 * 'failed' es terminal y solo aplica si el mensaje aún no alcanzó 'delivered'.
 */
export const DELIVERY_STATUS_RANK: Record<Exclude<MessageDeliveryStatus, 'failed'>, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/** ADR-0021: timestamps del proveedor por estado alcanzado (no del servidor). */
export interface MessageDeliveryAt {
  sent?: Timestamp;
  delivered?: Timestamp;
  read?: Timestamp;
  failed?: Timestamp;
}

/** ADR-0021: detalle sanitizado de una falla reportada por el proveedor (sin payload crudo). */
export interface MessageDeliveryError {
  code?: string;
  detail?: string;
}

/** 'in' = lo escribió el cliente; 'out' = se lo enviamos nosotros (bot o vendedor). */
export type MessageDirection = 'in' | 'out';

/** Quién originó el mensaje. 'system' = eventos internos (handoff, etc.). */
export type MessageAuthor = 'customer' | 'bot' | 'seller' | 'system';

export interface Message {
  id: string;
  tenantId: string;
  customerId: string;
  direction: MessageDirection;
  author: MessageAuthor;
  text: string;
  /** Canal por el que entró/salió (omnicanal, D2). Default 'whatsapp'. */
  channel?: MessageChannel;
  createdAt: Timestamp;
  /** MULTI-NUMBER: phone_number_id del número del negocio por el que entró/salió. */
  receivedVia?: string | null;
  /** HUMAN-HANDOFF: uid del staff que escribió (author 'seller'). */
  senderUid?: string | null;
  /** HUMAN-HANDOFF: nombre legible del staff que escribió. */
  senderName?: string | null;
  /** HUMAN-HANDOFF: wamid devuelto por Meta si el envío fue live. */
  waMessageId?: string | null;
  /** HUMAN-HANDOFF: true = outbound retenido por modo mock. */
  viaMock?: boolean;
  /**
   * ADR-0016: punteros a `tenants/{t}/attachments/{attachmentId}`. SOLO punteros — el adjunto
   * tiene identidad y ciclo de vida propios. OPCIONALES a propósito: los mensajes históricos no
   * los tienen y deben seguir siendo válidos y renderizables.
   */
  attachmentIds?: string[];
  /**
   * Denormalizado para listar sin resolver los punteros. El panel JAMÁS infiere un adjunto desde
   * el texto del mensaje (`📷 Imagen recibida` era falsificable escribiéndolo a mano).
   */
  hasAttachments?: boolean;
  /** ADR-0021: estado de entrega (solo salientes). Ausente en mensajes históricos y entrantes. */
  deliveryStatus?: MessageDeliveryStatus;
  /** ADR-0021: timestamps del proveedor por estado alcanzado. */
  deliveryAt?: MessageDeliveryAt;
  /** ADR-0021: falla sanitizada reportada por el proveedor. */
  deliveryError?: MessageDeliveryError | null;
}

/**
 * Resumen denormalizado de la conversación, guardado en el doc del cliente.
 * Permite listar clientes/bandeja sin leer la subcolección de mensajes.
 */
export interface CustomerConversationMeta {
  lastMessageAt: Timestamp | null;
  lastMessagePreview: string;
  lastMessageDirection: MessageDirection | null;
  /** Estado de la sesión del bot al momento del último mensaje. */
  state: SessionState | null;
  /** true = un vendedor tomó el chat (el bot no responde). */
  humanTakeover: boolean;
  /** Mensajes entrantes sin "leer" por un vendedor (para badges en la bandeja). */
  unreadForSeller: number;
  /** Canal de la conversación (omnicanal, D2). */
  channel?: MessageChannel;
  /**
   * MULTI-NUMBER (formalizado en ADR-0021): phone_number_id del número del negocio por el que
   * habló el cliente por última vez. Ya se escribía (`conversation/messages.ts`) — estaba fuera
   * del contrato y el panel lo leía con un doble cast.
   */
  receivedVia?: string | null;
  /** ADR-0021: conversación archivada (reversible; un entrante nuevo la desarchiva). */
  archived?: boolean;
  archivedAt?: Timestamp | null;
  /** uid del staff que archivó. */
  archivedBy?: string | null;
  /**
   * ADR-0021: eliminación LÓGICA reversible. Jamás borra mensajes, auditorías ni adjuntos;
   * solo oculta la conversación de la bandeja hasta restaurarla.
   */
  softDeleted?: boolean;
  softDeletedAt?: Timestamp | null;
  /** uid del staff que eliminó lógicamente. */
  softDeletedBy?: string | null;
}
