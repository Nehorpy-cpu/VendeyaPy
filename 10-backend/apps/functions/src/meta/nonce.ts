/**
 * meta/nonce.ts — Nonce de un solo uso + registro de códigos usados (Fase 4B · ADR-0017)
 * ======================================================================================
 * El Embedded Signup devuelve el `code` al frontend; antes de conectar, el frontend
 * pide un nonce (startMetaConnect) atado a (tenantId, uid, MODO) con TTL corto, y lo manda
 * en connectMeta. El nonce se consume UNA sola vez (transacción) y se elimina. Vive en
 * la colección GLOBAL `metaOAuthStates` (Admin SDK only; reglas la deniegan al cliente).
 *
 * NOTA OPERATIVA PENDIENTE: `metaOAuthStates` sigue SIN política TTL declarada. El código deja el
 * campo `expiresAt` (Timestamp) listo para habilitarla, pero declarar la política sobre una
 * colección que ya existe es un paso de operaciones aparte — nadie lo hace solo por desplegar.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';

const COLL = 'metaOAuthStates';
const NONCE_TTL_MS = 10 * 60_000; // 10 minutos

/**
 * EL MODO DEL ONBOARDING (ADR-0017 §5).
 *
 * El onboarding de un número real por Coexistence no es el mismo acto que un alta estándar: pide
 * otro consentimiento, otro `config_id`, otra ventana (24 h para el historial, y se pide UNA sola
 * vez) y tiene otras consecuencias sobre un número con clientes vivos adentro. Por eso el nonce
 * queda ligado —en el MISMO documento y en la misma escritura que el tenant, el uid y el
 * vencimiento— al modo con el que se emitió: un modo que viviera aparte se podría desincronizar
 * justo en el medio del flujo.
 *
 * Un nonce estándar NO puede consumirse como Coexistence ni al revés.
 */
export type MetaConnectMode = 'standard' | 'coexistence';

/** El modo por defecto: es el único flujo que existía cuando se emitieron los nonces sin campo. */
export const MODO_POR_DEFECTO: MetaConnectMode = 'standard';

const MODOS: readonly MetaConnectMode[] = Object.freeze(['standard', 'coexistence'] as const);

/**
 * Lee un modo CRUDO. Mismo criterio que `parseAutomationMode`: solo los strings EXACTOS valen.
 *
 * AUSENTE ⇒ `standard`, y es retrocompatibilidad, no laxitud: los nonces ya emitidos cuando esto
 * se despliega son todos del flujo estándar y romperlos cortaría una conexión en curso.
 * PRESENTE PERO IRRECONOCIBLE ⇒ `null`, que no coincide con ningún modo pedido y por lo tanto no
 * habilita nada. Un valor que este despliegue no entiende jamás se degrada al modo permisivo.
 */
export function parseMetaConnectMode(value: unknown): MetaConnectMode | null {
  if (value === undefined || value === null) return MODO_POR_DEFECTO;
  return MODOS.includes(value as MetaConnectMode) ? (value as MetaConnectMode) : null;
}

export interface NonceDoc {
  tenantId: string;
  uid: string;
  createdAtMs: number;
  expiresAtMs: number;
  /** Con qué flujo se emitió. Ausente = `standard` (nonce anterior a este campo). */
  mode?: MetaConnectMode;
}

/** Decisión PURA: ¿el nonce es válido para (tenantId, uid, modo) y no expiró? */
export function isNonceValid(
  doc: NonceDoc | undefined,
  ctx: { tenantId: string; uid: string; nowMs: number; mode?: MetaConnectMode },
): boolean {
  if (!doc) return false;
  if (doc.tenantId !== ctx.tenantId) return false;
  if (doc.uid !== ctx.uid) return false;
  if (typeof doc.expiresAtMs !== 'number' || doc.expiresAtMs <= ctx.nowMs) return false;
  // El modo pedido tiene que ser EXACTAMENTE el del nonce. Un `mode` irreconocible en el documento
  // devuelve `null` y no coincide con nada: fail-closed.
  if (parseMetaConnectMode(doc.mode) !== (ctx.mode ?? MODO_POR_DEFECTO)) return false;
  return true;
}

/** Crea un nonce atado a (tenantId, uid, modo) y lo persiste con TTL. Devuelve el nonce. */
export async function createMetaConnectNonce(tenantId: string, uid: string, mode: MetaConnectMode = MODO_POR_DEFECTO): Promise<string> {
  const nonce = randomBytes(24).toString('hex');
  const now = Date.now();
  await db().doc(`${COLL}/${nonce}`).set({
    tenantId, uid, mode, createdAtMs: now, expiresAtMs: now + NONCE_TTL_MS, createdAt: Timestamp.now(),
    // Campo Timestamp para que la colección PUEDA tener política TTL. Hoy `metaOAuthStates` crece
    // sin límite: los nonces que nadie consume (el usuario abandona el flujo) quedan para siempre.
    // Declarar la política sobre una colección que ya existe es un PASO OPERATIVO aparte — este
    // código solo deja el campo listo; nadie lo hace solo por desplegar.
    expiresAt: Timestamp.fromMillis(now + NONCE_TTL_MS),
  });
  return nonce;
}

/**
 * Consume el nonce UNA sola vez (transacción): válido para ESE modo → lo borra y devuelve true.
 *
 * Un rechazo por modo cruzado también borra el documento. Es deliberado: el nonce ya se expuso en
 * una llamada que no correspondía, así que dejarlo vivo permitiría reintentar con el modo "bueno"
 * después de haber probado con el otro.
 */
export async function consumeMetaConnectNonce(nonce: string, ctx: { tenantId: string; uid: string; mode?: MetaConnectMode }): Promise<boolean> {
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

/** Id del registro de un code usado. Se guarda el HASH, jamás el code. */
function idDeCodigo(code: string): string {
  return `code_${createHash('sha256').update(code).digest('hex')}`;
}

/**
 * SINGLE-FLIGHT DEL `code` DE META.
 *
 * El nonce se consume una sola vez, pero nada impedía pedir OTRO nonce —`startMetaConnect` no tiene
 * límite— y volver a mandar el MISMO `code`. Sin registro de códigos usados, dos invocaciones
 * (concurrentes o en secuencia) corrían el flujo entero dos veces sobre la conexión que está
 * vendiendo: dos escrituras de secreto, dos discoveries, dos reclamos del índice.
 *
 * El reclamo es una transacción con el hash del code como id: el primero lo toma, cualquier otro se
 * rechaza. Un reclamo NO se libera si el flujo falla después, y es deliberado: el `code` de Meta es
 * de un solo uso igual, así que un reintento con el mismo code no iba a funcionar — reintentar
 * requiere volver a pasar por el Embedded Signup, que es lo que corresponde.
 *
 * Vive en `metaOAuthStates` (misma colección Admin-only del nonce) para no abrir una superficie
 * nueva: reglas y aislamiento ya son los correctos.
 */
export async function claimMetaConnectCode(code: string, ctx: { tenantId: string; uid: string; mode?: MetaConnectMode }): Promise<boolean> {
  if (!code) return false;
  const now = Date.now();
  const ref = db().doc(`${COLL}/${idDeCodigo(code)}`);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, {
      kind: 'code',
      tenantId: ctx.tenantId,
      uid: ctx.uid,
      // Con qué flujo se reclamó: el reclamo es de un solo uso pase lo que pase, pero saber si el
      // code venía del botón estándar o del de Coexistence es lo único que hace legible una
      // auditoría posterior sin tener que cruzar logs.
      mode: ctx.mode ?? MODO_POR_DEFECTO,
      createdAtMs: now,
      expiresAtMs: now + NONCE_TTL_MS,
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(now + NONCE_TTL_MS),
    });
    return true;
  });
}
