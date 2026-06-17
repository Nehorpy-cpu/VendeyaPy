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
import type { Message, MessageDirection, MessageAuthor, SessionState } from '@vpw/shared';
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
  const msg: Message = {
    id: ref.id,
    tenantId,
    customerId,
    direction: input.direction,
    author: input.author,
    text: input.text,
    createdAt: now,
  };
  await ref.set(msg);

  // Resumen denormalizado (deep-merge sobre el doc del cliente).
  const conv: Record<string, unknown> = {
    lastMessageAt: now,
    lastMessagePreview: preview(input.text),
    lastMessageDirection: input.direction,
  };
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

/** Marca como leídos los mensajes entrantes (resetea el contador del vendedor). */
export async function markConversationRead(tenantId: string, customerId: string): Promise<void> {
  await db()
    .doc(paths.customer(tenantId, customerId))
    .set({ conversation: { unreadForSeller: 0 } }, { merge: true });
}
