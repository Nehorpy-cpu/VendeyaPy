/**
 * conversation/handoff.ts — Devolver el chat al bot (F6b)
 * ======================================================
 * El vendedor "libera" el chat cuando terminó de atender al cliente. Recién ahí
 * el bot vuelve a responder (no al confirmar el pago). Ver decisión 2026-06-16.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

export interface ReleaseResult {
  ok: boolean;
  message: string;
}

export async function releaseToBot(tenantId: string, customerId: string): Promise<ReleaseResult> {
  const ref = db().doc(paths.session(tenantId, customerId));
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, message: 'No hay sesión para ese cliente.' };
  }
  await ref.update({
    'context.humanTakeover': false,
    state: 'IDLE', // próximo mensaje del cliente: el bot retoma con un saludo de "vuelta"
    updatedAt: Timestamp.now(),
  });
  logger.info('Chat liberado al bot', { tenantId, customerId });
  return { ok: true, message: 'Chat devuelto al bot. El asistente vuelve a responder a este cliente.' };
}
