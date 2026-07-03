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
}
