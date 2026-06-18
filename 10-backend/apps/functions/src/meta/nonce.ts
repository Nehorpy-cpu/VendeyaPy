/**
 * meta/nonce.ts — Nonce de un solo uso para el flujo de conexión Meta (Fase 4B)
 * ============================================================================
 * El Embedded Signup devuelve el `code` al frontend; antes de conectar, el frontend
 * pide un nonce (startMetaConnect) atado a (tenantId, uid) con TTL corto, y lo manda
 * en connectMeta. El nonce se consume UNA sola vez (transacción) y se elimina. Vive en
 * la colección GLOBAL `metaOAuthStates` (Admin SDK only; reglas la deniegan al cliente).
 */
import { randomBytes } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';

const COLL = 'metaOAuthStates';
const NONCE_TTL_MS = 10 * 60_000; // 10 minutos

export interface NonceDoc {
  tenantId: string;
  uid: string;
  createdAtMs: number;
  expiresAtMs: number;
}

/** Decisión PURA: ¿el nonce es válido para (tenantId, uid) y no expiró? */
export function isNonceValid(doc: NonceDoc | undefined, ctx: { tenantId: string; uid: string; nowMs: number }): boolean {
  if (!doc) return false;
  if (doc.tenantId !== ctx.tenantId) return false;
  if (doc.uid !== ctx.uid) return false;
  if (typeof doc.expiresAtMs !== 'number' || doc.expiresAtMs <= ctx.nowMs) return false;
  return true;
}

/** Crea un nonce atado a (tenantId, uid) y lo persiste con TTL. Devuelve el nonce. */
export async function createMetaConnectNonce(tenantId: string, uid: string): Promise<string> {
  const nonce = randomBytes(24).toString('hex');
  const now = Date.now();
  await db().doc(`${COLL}/${nonce}`).set({
    tenantId, uid, createdAtMs: now, expiresAtMs: now + NONCE_TTL_MS, createdAt: Timestamp.now(),
  });
  return nonce;
}

/** Consume el nonce UNA sola vez (transacción): válido → lo borra y devuelve true. */
export async function consumeMetaConnectNonce(nonce: string, ctx: { tenantId: string; uid: string }): Promise<boolean> {
  if (!nonce) return false;
  const ref = db().doc(`${COLL}/${nonce}`);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const valid = isNonceValid(snap.data() as NonceDoc | undefined, { ...ctx, nowMs: Date.now() });
    // One-time: si el doc existe se borra exista válido o no (también limpia expirados/ajenos).
    if (snap.exists) tx.delete(ref);
    return valid;
  });
}
