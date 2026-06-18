/**
 * lib/secretStore.ts — Almacén de secretos por REFERENCIA (Fase 3)
 * ================================================================
 * Los tokens (Meta, pasarelas) NUNCA se guardan en claro. Se guardan vía este
 * almacén, que devuelve una REFERENCIA opaca (`secret://...`) que es lo único que
 * va a Firestore visible (p.ej. MetaConnection.tokenSecretRef).
 *
 * Impl por defecto: FirestoreSecretStore — cifra con AES-256-GCM (lib/crypto) y lo
 * guarda en la colección global `secrets` (Admin SDK only; reglas la deniegan al
 * cliente). Punto de extensión a Google Secret Manager SIN tocar a los que llaman.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { db, paths } from './firebase.js';
import { encrypt, decrypt } from './crypto.js';

export interface SecretStore {
  /** Guarda `value` cifrado bajo `name` y devuelve la referencia opaca. */
  set(name: string, value: string): Promise<string>;
  /** Recupera el valor en claro a partir de la referencia (o null). */
  get(ref: string): Promise<string | null>;
  /** Borra el secreto referenciado. */
  remove(ref: string): Promise<void>;
}

const PREFIX = 'secret://firestore/';
// El name se mapea a secrets/{name} (doc de 2 segmentos): NO puede contener '/' u otros
// caracteres que rompan la ruta. (Bug histórico de Fase 4A: 'meta-token/${tenantId}'.)
const VALID_SECRET_NAME = /^[A-Za-z0-9._-]+$/;

export class FirestoreSecretStore implements SecretStore {
  async set(name: string, value: string): Promise<string> {
    if (!VALID_SECRET_NAME.test(name)) {
      throw new Error(`SecretStore: nombre de secreto inválido "${name}" (solo [A-Za-z0-9._-], sin '/').`);
    }
    await db()
      .doc(paths.secret(name))
      .set({ name, ciphertext: encrypt(value), updatedAt: Timestamp.now() });
    return `${PREFIX}${name}`;
  }

  async get(ref: string): Promise<string | null> {
    if (!ref.startsWith(PREFIX)) return null;
    const snap = await db().doc(paths.secret(ref.slice(PREFIX.length))).get();
    const ct = snap.data()?.ciphertext as string | undefined;
    return ct ? decrypt(ct) : null;
  }

  async remove(ref: string): Promise<void> {
    if (!ref.startsWith(PREFIX)) return;
    await db().doc(paths.secret(ref.slice(PREFIX.length))).delete();
  }
}

let _store: SecretStore | null = null;

/** Almacén de secretos activo. Extensión: Secret Manager bajo USE_SECRET_MANAGER. */
export function getSecretStore(): SecretStore {
  // if (process.env.USE_SECRET_MANAGER === 'true') return new SecretManagerStore();
  if (!_store) _store = new FirestoreSecretStore();
  return _store;
}
