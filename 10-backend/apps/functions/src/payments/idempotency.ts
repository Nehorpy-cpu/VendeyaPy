/**
 * payments/idempotency.ts — "procesar una sola vez" para webhooks (Fase 3)
 * ========================================================================
 * Usa `create()` de Firestore (falla si el doc ya existe) como cerrojo atómico:
 * el primer webhook con un eventId dado gana; los reintentos/duplicados se ignoran.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';

/**
 * Devuelve true si es la PRIMERA vez que se ve `eventId` en `collection` (y lo marca).
 * Devuelve false si ya existía (duplicado) → el llamador debe no re-procesar.
 */
export async function claimEventOnce(
  collection: string,
  eventId: string,
  meta?: Record<string, unknown>,
): Promise<boolean> {
  const ref = db().collection(collection).doc(eventId);
  try {
    await ref.create({ id: eventId, processedAt: Timestamp.now(), ...(meta ?? {}) });
    return true;
  } catch {
    return false; // ALREADY_EXISTS → duplicado
  }
}
