/**
 * meta/nonce.ts — Nonce de un solo uso + registro de códigos usados (Fase 4B · ADR-0017)
 * ======================================================================================
 * El Embedded Signup devuelve el `code` al frontend; antes de conectar, el frontend
 * pide un nonce (startMetaConnect) atado a (tenantId, uid, MODO) con TTL corto, y lo manda
 * en connectMeta. El nonce se consume UNA sola vez (transacción) y se elimina. Vive en
 * la colección GLOBAL `metaOAuthStates` (Admin SDK only; reglas la deniegan al cliente).
 *
 * TTL (ADR-0020, G9): la política sobre `expiresAt` está DECLARADA en `firestore.indexes.json`
 * (fieldOverride de `metaOAuthStates`, mismo formato que las colecciones de webhooks). Se aplica
 * con `firebase deploy --only firestore:indexes` (NUNCA con --force) y hay que verificar en
 * consola que quedó ACTIVE: desplegar Functions no activa ninguna política.
 *
 * RATE LIMIT (ADR-0020, G10): la emisión de nonces era el único costado sin freno del
 * single-flight del `code`. Máximo NONCE_RATE_LIMIT nonces por tenant por ventana, contados
 * transaccionalmente en `metaOAuthStates/rate_{tenantId}`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firebase.js';

const COLL = 'metaOAuthStates';
const NONCE_TTL_MS = 10 * 60_000; // 10 minutos
/**
 * Correctivo (MEDIO 13): el onboarding de COEXISTENCE es un acto humano con el teléfono en la mano
 * — escanear el QR, esperar la verificación, revincular dispositivos. Diez minutos alcanzaban para
 * el flujo estándar (todo en el navegador) y se quedaban cortos acá: el nonce moría DESPUÉS de que
 * Meta ya había onboardeado el número real, dejando el peor estado posible (onboarding hecho,
 * conexión local no creada). Sigue siendo de un solo uso y atado a tenant+uid+modo: alargar la
 * ventana no relaja ninguna de esas tres cosas.
 */
const NONCE_TTL_COEXISTENCE_MS = 30 * 60_000; // 30 minutos

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

/**
 * FRENO DE EMISIÓN POR TENANT (ADR-0020, G10). El nonce es de un solo uso y el `code` tiene
 * single-flight, pero pedir nonces era gratis e ilimitado: el único costado del flujo que un
 * cliente (o un bug de reintento del panel) podía inflar sin freno. Diez por ventana de diez
 * minutos sobra para cualquier onboarding humano — el flujo entero consume uno o dos.
 */
export const NONCE_RATE_LIMIT = 10;
export const NONCE_RATE_WINDOW_MS = 10 * 60_000;

/**
 * Crea un nonce atado a (tenantId, uid, modo) y lo persiste con TTL. Devuelve el nonce.
 *
 * TRANSACCIONAL por el freno de emisión: leer el contador y escribir contador+nonce son el mismo
 * acto — dos emisiones concurrentes no pueden colarse por la misma ranura. El documento de rate
 * (`rate_{tenantId}`) no colisiona con los nonces (hex de 48) ni con los codes (`code_...`), y
 * lleva `expiresAt` para que la política TTL también lo limpie.
 */
export async function createMetaConnectNonce(tenantId: string, uid: string, mode: MetaConnectMode = MODO_POR_DEFECTO): Promise<string> {
  const nonce = randomBytes(24).toString('hex');
  const now = Date.now();
  const ttlMs = mode === 'coexistence' ? NONCE_TTL_COEXISTENCE_MS : NONCE_TTL_MS;
  const rateRef = db().doc(`${COLL}/rate_${tenantId}`);
  await db().runTransaction(async (tx) => {
    const rate = (await tx.get(rateRef)).data() as { windowStartMs?: unknown; count?: unknown } | undefined;
    // Basura o ventana vencida ⇒ ventana nueva: el freno protege, no puede bloquear para siempre.
    const enVentana = typeof rate?.windowStartMs === 'number' && now - rate.windowStartMs < NONCE_RATE_WINDOW_MS;
    const windowStartMs = enVentana ? (rate!.windowStartMs as number) : now;
    const count = enVentana && typeof rate?.count === 'number' ? rate.count : 0;
    if (count >= NONCE_RATE_LIMIT) {
      throw new HttpsError('resource-exhausted', 'Demasiados intentos de conexión seguidos. Esperá unos minutos y volvé a intentar.');
    }
    tx.set(rateRef, {
      kind: 'rate', tenantId, windowStartMs, count: count + 1, updatedAtMs: now,
      // La entrada de rate también vence: ventana + el TTL más largo de un nonce, para que la
      // limpieza pasiva nunca borre una ventana todavía vigente.
      expiresAt: Timestamp.fromMillis(windowStartMs + NONCE_RATE_WINDOW_MS + NONCE_TTL_COEXISTENCE_MS),
    });
    tx.set(db().doc(`${COLL}/${nonce}`), {
      tenantId, uid, mode, createdAtMs: now, expiresAtMs: now + ttlMs, createdAt: Timestamp.now(),
      // Campo Timestamp de la política TTL declarada en firestore.indexes.json (G9): los nonces
      // que nadie consume (el usuario abandona el flujo) se limpian solos.
      expiresAt: Timestamp.fromMillis(now + ttlMs),
    });
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

/**
 * SELECCIÓN PENDIENTE DE WABA (ADR-0020, G2).
 *
 * Cuando el token autoriza VARIOS WABAs y el owner no eligió, el `code` ya se canjeó y reclamó
 * (single-flight): no hay «reintentá» sin otro login. El estado intermedio vive acá: un nonce de
 * modo `waba_selection` que además de la atadura de siempre (tenant+uid+TTL 10 min+uso único)
 * guarda la referencia del secreto PENDIENTE y la lista SANEADA de WABAs ofrecidos.
 *
 * `waba_selection` NO entra en `MetaConnectMode` a propósito: `parseMetaConnectMode` lo devuelve
 * `null`, así que un nonce de selección jamás puede consumirse por `connectMeta`/`coexistenceConnect`
 * (y al revés: `consumeWabaSelectionNonce` exige el modo exacto). Fail-closed en las dos direcciones.
 *
 * La CREACIÓN no pasa por el freno de emisión (G10): la emite el server en el medio de un connect
 * que ya pagó nonce + code; frenarla acá cortaría a la mitad un flujo ya autorizado.
 */
export const WABA_SELECTION_MODE = 'waba_selection';

export interface WabaSelectionOption {
  id: string;
  name: string;
}

export interface WabaSelectionData {
  pendingSecretRef: string;
  wabas: WabaSelectionOption[];
  businessId?: string;
  businessName?: string;
}

/** Crea el nonce de selección de WABA. Devuelve el selectionId que ve el panel. */
export async function createWabaSelectionNonce(tenantId: string, uid: string, data: WabaSelectionData): Promise<string> {
  const nonce = randomBytes(24).toString('hex');
  const now = Date.now();
  await db().doc(`${COLL}/${nonce}`).set({
    tenantId,
    uid,
    mode: WABA_SELECTION_MODE,
    pendingSecretRef: data.pendingSecretRef,
    // Solo id + nombre: nada del token ni de Graph crudo queda en el documento.
    wabas: data.wabas.map((w) => ({ id: w.id, name: w.name })),
    ...(data.businessId ? { businessId: data.businessId } : {}),
    ...(data.businessName ? { businessName: data.businessName } : {}),
    createdAtMs: now,
    expiresAtMs: now + NONCE_TTL_MS,
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromMillis(now + NONCE_TTL_MS),
  });
  return nonce;
}

/**
 * Consume el nonce de selección UNA sola vez (transacción). Válido para (tenantId, uid) y modo
 * `waba_selection` ⇒ devuelve los datos guardados y borra el documento. Cualquier otra cosa
 * (vencido, ajeno, modo cruzado, forma corrupta) ⇒ `null` — y el documento se quema igual,
 * como el nonce de conexión: ya se expuso en una llamada que no correspondía.
 */
export async function consumeWabaSelectionNonce(nonce: string, ctx: { tenantId: string; uid: string }): Promise<WabaSelectionData | null> {
  if (!nonce) return null;
  const ref = db().doc(`${COLL}/${nonce}`);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.data() as
      | { tenantId?: unknown; uid?: unknown; mode?: unknown; expiresAtMs?: unknown; pendingSecretRef?: unknown; wabas?: unknown; businessId?: unknown; businessName?: unknown }
      | undefined;
    if (snap.exists) tx.delete(ref);
    if (!doc) return null;
    if (doc.mode !== WABA_SELECTION_MODE) return null;
    if (doc.tenantId !== ctx.tenantId || doc.uid !== ctx.uid) return null;
    if (typeof doc.expiresAtMs !== 'number' || doc.expiresAtMs <= Date.now()) return null;
    if (typeof doc.pendingSecretRef !== 'string' || !doc.pendingSecretRef) return null;
    const wabas: WabaSelectionOption[] = (Array.isArray(doc.wabas) ? doc.wabas : [])
      .filter((w): w is { id: unknown; name?: unknown } => typeof (w as { id?: unknown } | null)?.id === 'string')
      .map((w) => ({ id: String(w.id), name: typeof w.name === 'string' && w.name ? w.name : String(w.id) }));
    if (!wabas.length) return null;
    return {
      pendingSecretRef: doc.pendingSecretRef,
      wabas,
      ...(typeof doc.businessId === 'string' && doc.businessId ? { businessId: doc.businessId } : {}),
      ...(typeof doc.businessName === 'string' && doc.businessName ? { businessName: doc.businessName } : {}),
    };
  });
}

/** Id del registro de un code usado. Se guarda el HASH, jamás el code. */
function idDeCodigo(code: string): string {
  return `code_${createHash('sha256').update(code).digest('hex')}`;
}

/**
 * Identidad PÚBLICA del reclamo de un code: la misma que usa el registro transaccional. El
 * coordinador de historial la usa como identidad de la GENERACIÓN («solo un nuevo Embedded Signup
 * habilita una generación posterior»): como un code no se puede reclamar dos veces, este id existe
 * a lo sumo una vez por onboarding real. Es un hash — jamás el code.
 */
export function claimIdDeCodigo(code: string): string {
  return idDeCodigo(code);
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
      // El registro del code es evidencia, no una sesión: su retención no depende del modo.
      expiresAt: Timestamp.fromMillis(now + NONCE_TTL_MS),
    });
    return true;
  });
}
