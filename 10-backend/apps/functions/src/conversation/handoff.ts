/**
 * conversation/handoff.ts — Tomar / devolver el chat (F6b · P5)
 * ============================================================
 * El vendedor "toma" el chat para atender en persona (el bot se calla) y lo
 * "libera" cuando termina (recién ahí el bot vuelve a responder, no al confirmar
 * el pago). Ver decisión 2026-06-16. Estos eventos quedan en el historial como
 * mensajes 'system' para que se vean en la conversación.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { appendMessage, markConversationRead } from './messages.js';

export interface HandoffResult {
  ok: boolean;
  message: string;
}

/** Mantengo el alias por compatibilidad con código existente. */
export type ReleaseResult = HandoffResult;

/** Un vendedor toma el chat: el bot deja de responder y la conversación queda asignada a él. */
export async function takeoverChat(
  tenantId: string,
  customerId: string,
  by?: string,
  sellerUid?: string | null,
): Promise<HandoffResult> {
  const ref = db().doc(paths.session(tenantId, customerId));
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, message: 'No hay conversación para ese cliente todavía.' };
  }
  await ref.update({
    'context.humanTakeover': true,
    // F3: la oferta del bot muere al entrar un humano — un "sí" dirigido al vendedor jamás
    // debe agregar el producto que el bot había ofrecido antes de la pausa.
    'context.pendingCartConfirmation': null,
    updatedAt: Timestamp.now(),
  });
  // Asignar la conversación al vendedor que la tomó (P9).
  await db().doc(paths.customer(tenantId, customerId)).set(
    { assignedSellerId: sellerUid ?? null, assignedSellerName: by ?? null, updatedAt: Timestamp.now() },
    { merge: true },
  );
  await appendMessage(tenantId, customerId, {
    direction: 'out',
    author: 'system',
    text: by ? `🧑‍💼 ${by} tomó la conversación.` : '🧑‍💼 Un vendedor tomó la conversación.',
    humanTakeover: true,
  });
  // El vendedor ya está mirando: limpiar el contador de "sin leer".
  await markConversationRead(tenantId, customerId);
  logger.info('Chat tomado por un humano', { tenantId, customerId });
  return { ok: true, message: 'Tomaste la conversación. El bot queda en pausa para este cliente.' };
}

/** El vendedor libera el chat: el bot vuelve a responder al próximo mensaje. */
export async function releaseToBot(tenantId: string, customerId: string): Promise<HandoffResult> {
  const ref = db().doc(paths.session(tenantId, customerId));
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, message: 'No hay sesión para ese cliente.' };
  }
  await ref.update({
    'context.humanTakeover': false,
    'context.pendingCartConfirmation': null, // F3: el bot retoma con contexto de oferta limpio
    state: 'IDLE', // próximo mensaje del cliente: el bot retoma con un saludo de "vuelta"
    updatedAt: Timestamp.now(),
  });
  await appendMessage(tenantId, customerId, {
    direction: 'out',
    author: 'system',
    text: '🤖 El chat volvió al asistente.',
    humanTakeover: false,
    state: 'IDLE',
  });
  logger.info('Chat liberado al bot', { tenantId, customerId });
  return {
    ok: true,
    message: 'Chat devuelto al bot. El asistente vuelve a responder a este cliente.',
  };
}
