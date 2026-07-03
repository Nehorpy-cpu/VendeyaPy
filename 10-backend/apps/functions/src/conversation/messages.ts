/**
 * conversation/messages.ts — Historial de mensajes (P5)
 * =====================================================
 * Persiste cada mensaje del chat en tenants/{t}/customers/{c}/messages y mantiene
 * un resumen denormalizado en el doc del cliente (conversation.*) para poder
 * armar la bandeja/lista de clientes sin leer toda la subcolección.
 *
 * Channel-agnostic: lo usa el motor del bot y (a futuro) el webhook de WhatsApp.
 */

import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import type { Message, MessageDirection, MessageAuthor, SessionState, MessageChannel } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';

export interface AppendMessageInput {
  direction: MessageDirection;
  author: MessageAuthor;
  text: string;
  /** Momento del mensaje (default: ahora). Permite agrupar in/out con el mismo reloj. */
  now?: Timestamp;
  /** Estado de la sesión a reflejar en la meta del cliente. */
  state?: SessionState | null;
  /** Si se define, fija conversation.humanTakeover en la meta. */
  humanTakeover?: boolean;
  /** true = suma 1 a "sin leer" del vendedor (solo cuando el bot no atiende). */
  countUnread?: boolean;
  /** Canal del mensaje (omnicanal, D2). Default 'whatsapp'. */
  channel?: MessageChannel;
  /** MULTI-NUMBER-1: phone_number_id del número del NEGOCIO por el que entró/salió el mensaje. */
  receivedVia?: string | null;
  /** HUMAN-HANDOFF-1: uid del staff que escribió (author 'seller'). */
  senderUid?: string | null;
  /** HUMAN-HANDOFF-1: nombre legible del staff (para la burbuja del panel). */
  senderName?: string | null;
  /** HUMAN-HANDOFF-1: wamid de Meta si el envío fue live. */
  waMessageId?: string | null;
  /** HUMAN-HANDOFF-1: true = el outbound quedó retenido por modo mock (no salió a Meta). */
  viaMock?: boolean;
}

function preview(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
}

/** Guarda un mensaje y actualiza el resumen de conversación del cliente. */
export async function appendMessage(
  tenantId: string,
  customerId: string,
  input: AppendMessageInput,
): Promise<Message> {
  const now = input.now ?? Timestamp.now();
  const ref = db().collection(paths.messages(tenantId, customerId)).doc();
  const channel: MessageChannel = input.channel ?? 'whatsapp';
  const msg: Message = {
    id: ref.id,
    tenantId,
    customerId,
    direction: input.direction,
    author: input.author,
    text: input.text,
    channel,
    createdAt: now,
  };
  // Metadata adicional opcional (MULTI-NUMBER-1 / HUMAN-HANDOFF-1): solo los campos presentes.
  const extra: Record<string, unknown> = {};
  if (input.receivedVia) extra['receivedVia'] = input.receivedVia;
  if (input.senderUid) extra['senderUid'] = input.senderUid;
  if (input.senderName) extra['senderName'] = input.senderName;
  if (input.waMessageId) extra['waMessageId'] = input.waMessageId;
  if (input.viaMock) extra['viaMock'] = true;
  await ref.set(Object.keys(extra).length ? { ...msg, ...extra } : msg);

  // Resumen denormalizado (deep-merge sobre el doc del cliente).
  const conv: Record<string, unknown> = {
    lastMessageAt: now,
    lastMessagePreview: preview(input.text),
    lastMessageDirection: input.direction,
    channel,
  };
  if (input.receivedVia) conv['receivedVia'] = input.receivedVia; // para el badge de /conversations
  if (input.state !== undefined) conv['state'] = input.state ?? null;
  if (input.humanTakeover !== undefined) conv['humanTakeover'] = input.humanTakeover;
  // "Sin leer" para el vendedor: solo cuando el bot no está atendiendo (handoff/bot off).
  if (input.countUnread) {
    conv['unreadForSeller'] = FieldValue.increment(1);
  }

  await db()
    .doc(paths.customer(tenantId, customerId))
    .set({ id: customerId, tenantId, conversation: conv, updatedAt: now }, { merge: true });

  return msg;
}

/** Lee el historial de mensajes (orden cronológico ascendente). */
export async function listMessages(
  tenantId: string,
  customerId: string,
  max = 200,
): Promise<Message[]> {
  const snap = await db()
    .collection(paths.messages(tenantId, customerId))
    .orderBy('createdAt', 'asc')
    .limit(max)
    .get();
  return snap.docs.map((d) => d.data() as Message);
}

/** Últimos `max` mensajes en orden cronológico ascendente (historial para el sales agent IA, F1). */
export async function listRecentMessages(
  tenantId: string,
  customerId: string,
  max = 6,
): Promise<Message[]> {
  const snap = await db()
    .collection(paths.messages(tenantId, customerId))
    .orderBy('createdAt', 'desc')
    .limit(max)
    .get();
  return snap.docs.map((d) => d.data() as Message).reverse();
}

/** Marca como leídos los mensajes entrantes (resetea el contador del vendedor). */
export async function markConversationRead(tenantId: string, customerId: string): Promise<void> {
  await db()
    .doc(paths.customer(tenantId, customerId))
    .set({ conversation: { unreadForSeller: 0 } }, { merge: true });
}
