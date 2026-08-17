/**
 * Capa de acceso al Centro de Integración Meta (panel · D1 + Meta Connect UX).
 * Lectura de la conexión + activos (solo manager+, por reglas). Conectar/desconectar:
 *   - flujo REAL (callables owner/admin, Fase 4B): startMetaConnect/connectMeta/verifyMetaChannel/
 *     selectMetaPhoneNumber/metaDisconnect — el token nunca pasa por el frontend (solo el `code`).
 *   - fallback DEMO (endpoints dev): connectMetaDemo/disconnectMeta, cuando Meta no está configurado.
 *   - COEXISTENCE (ADR-0017): coexistenceStart/coexistenceConnect — superficie APARTE, no un `mode`
 *     del flujo estándar. Ver el bloque de más abajo: `connectMeta` reescribe `metaConnections/main`.
 * La page elige uno u otro según isMetaConfigured(). M-1 solo agrega los wrappers; no cambia la UI.
 */

import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { httpsCallable, type FunctionsError } from 'firebase/functions';
import type { MetaConnection, MetaAsset, MetaConversionEvent, MetaConnectionStatus, WhatsappAutomationMode } from '@vpw/shared';
import { declaredAutomationMode } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';
import { isEmbeddedSignupConfigured, type MetaSignupFlow } from './metaEmbeddedSignup';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:5001/demo-aiafg/us-central1';

/**
 * La conexión tal como la necesita el panel: el doc MÁS los campos ADITIVOS del contrato de
 * ADR-0020 (G8) que `MetaConnection` todavía no declara. Un intento de conexión fallido NO pisa el
 * estado de una conexión sana (contrato del backend), así que estos campos pueden convivir con
 * `status: 'active'` — y hasta con un doc que SOLO los tiene (primer intento fallido): por eso son
 * opcionales y la fecha se lee tolerante (`toMillis`).
 */
export type MetaConnectionView = MetaConnection & {
  /** Razón SANEADA (enum del backend) del último intento de conexión fallido. Jamás texto de Graph. */
  lastConnectError?: string | null;
  lastConnectErrorAt?: unknown;
};

export async function getMetaConnection(tenantId: string): Promise<MetaConnectionView | null> {
  const snap = await getDoc(doc(firebaseDb(), 'tenants', tenantId, 'metaConnections', 'main'));
  return snap.exists() ? (snap.data() as MetaConnectionView) : null;
}

/**
 * Un asset tal como lo necesita el panel: el documento MÁS el permiso de automatización del número
 * (ADR-0017 §1). `MetaAsset` todavía no declara `automationMode` porque es un campo ADITIVO que
 * convive con documentos que no lo tienen, así que se lee crudo y se estrecha acá.
 *
 * `null` = la fuente NO opina (documento anterior al campo). Es distinto de `inactive`, y la UI
 * los muestra igual de callados: lo que no se puede es mostrarlos como si automatizaran.
 */
export type MetaAssetView = MetaAsset & { automationMode: WhatsappAutomationMode | null };

export async function listMetaAssets(tenantId: string): Promise<MetaAssetView[]> {
  const snap = await getDocs(collection(firebaseDb(), 'tenants', tenantId, 'metaAssets'));
  return snap.docs.map((d) => {
    const data = d.data() as MetaAsset & { automationMode?: unknown };
    return { ...data, automationMode: declaredAutomationMode(data.automationMode) };
  });
}

export async function connectMetaDemo(tenantId: string, byUid: string): Promise<void> {
  await fetch(`${API}/devMetaConnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId, byUid }) });
}

export async function disconnectMeta(tenantId: string): Promise<void> {
  await fetch(`${API}/devMetaDisconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId }) });
}

// ===== Conexión REAL de Meta (Fase Meta Connect UX · M-1) =====
// Wrappers de los callables autenticados (owner/admin). El access token NUNCA pasa por el
// frontend: solo transita el `code` efímero del Embedded Signup, que se intercambia server-side.

/**
 * Hay configuración para el flujo real (App ID + config_id del Embedded Signup). Si no, se usa demo.
 *
 * DELEGA en `metaEmbeddedSignup`: la lectura de esas env vars estaba duplicada acá y allá, y dos
 * lecturas del mismo flag terminan divergiendo — la laxa es la que muestra un botón que no anda.
 */
export function isMetaConfigured(): boolean {
  return isEmbeddedSignupConfigured('standard');
}

/** Coexistence tiene su PROPIO config_id: puede estar habilitado el estándar y este no. */
export function isCoexistenceConfigured(): boolean {
  return isEmbeddedSignupConfigured('coexistence');
}

/**
 * El fallback demo de Integraciones (endpoints dev: connectMetaDemo/disconnectMeta/processConversions)
 * SOLO se permite en local/emulador, nunca en producción. En prod, la UI muestra estados honestos en
 * vez de acciones demo. (No afecta el flujo REAL por callables, que siempre está disponible.)
 */
export function isDemoIntegrationsAllowed(): boolean {
  return process.env['NEXT_PUBLIC_USE_EMULATORS'] === 'true' || process.env.NODE_ENV !== 'production';
}

/**
 * Las herramientas DEV del panel (endpoints `dev*`: generar sugerencias/insights/respuestas/
 * seguimientos/auditorías, recalcular atribución de tracking, chat de prueba) solo funcionan en
 * local/emulador — en prod `guardDevEndpoint` las 404ea. En staging/prod ocultamos los botones que
 * las llaman para no prometer algo que no responde. Mismo criterio que el demo de Integraciones.
 * Su cableado real (callable autenticado `runTenantJob`) llega en GROWTH-JOBS-WIRING.
 */
export function isDevToolingAllowed(): boolean {
  return isDemoIntegrationsAllowed();
}

export interface MetaConnectInput {
  nonce: string;
  code: string;
  /**
   * Con qué flujo se hizo el onboarding (ADR-0017 §5). El backend lo exige IGUAL al del nonce:
   * un nonce estándar no cierra un Coexistence ni al revés. Ausente = estándar.
   */
  mode?: MetaSignupFlow;
  // Best-effort: si el popup del Embedded Signup entrega sessionInfo. El backend descubre
  // WABA/número cuando faltan, así que basta con { nonce, code }.
  wabaId?: string;
  phoneNumberId?: string;
  businessId?: string;
  businessName?: string;
}

export interface MetaConnectResult {
  ok: boolean;
  status: MetaConnectionStatus;
  phoneNumberId: string | null;
  phoneNumber: string | null;
  assets: number;
}

export interface MetaVerifyResult {
  ok: boolean;
  ready: boolean;
  status: MetaConnectionStatus;
}

/** Paso 1 del Embedded Signup: emite un nonce de un solo uso (atado a tenant+uid+MODO). */
export async function startMetaConnect(tenantId: string, mode: MetaSignupFlow = 'standard'): Promise<{ nonce: string }> {
  const call = httpsCallable<{ tenantId: string; mode: MetaSignupFlow }, { ok: boolean; nonce: string }>(firebaseFunctions(), 'startMetaConnect');
  const res = await call({ tenantId, mode });
  return { nonce: res.data.nonce };
}

/** Paso 2: consume el nonce + el `code` del popup; el backend valida, descubre assets y conecta. */
export async function connectMeta(tenantId: string, input: MetaConnectInput): Promise<MetaConnectResult> {
  const call = httpsCallable<{ tenantId: string } & MetaConnectInput, MetaConnectResult>(firebaseFunctions(), 'connectMeta');
  const res = await call({ tenantId, ...input });
  return res.data;
}

// ===== Selección de WABA (ADR-0020 · G2) =====
// Con varios WABA autorizados y sin `wabaId`, el `code` YA se canjeó (single-flight): no se puede
// pedir «reintentá». `connectMeta` rechaza failed-precondition con la lista SANEADA + un id de
// selección de un solo uso; el owner elige y `completeMetaConnectWaba` cierra el MISMO camino.

export interface WabaOption {
  id: string;
  name: string;
}

export interface WabaSelectionRequired {
  selectionId: string;
  wabas: WabaOption[];
}

/**
 * Lee el rechazo `waba_selection_required` de `connectMeta`. Devuelve null ante cualquier otra
 * cosa: código distinto, otra razón o details malformados (ahí manda `friendlyMetaError`).
 * Sanea las entradas: sin id no hay opción; sin nombre, un rótulo genérico (el id NUNCA se
 * muestra completo — la UI lo enmascara).
 */
export function readWabaSelectionRequired(e: unknown): WabaSelectionRequired | null {
  const err = e as { code?: unknown; details?: unknown } | null;
  if (!err || typeof err !== 'object' || err.code !== 'functions/failed-precondition') return null;
  const d = err.details as { reason?: unknown; selectionId?: unknown; wabas?: unknown } | null;
  if (!d || typeof d !== 'object' || d.reason !== 'waba_selection_required') return null;
  if (typeof d.selectionId !== 'string' || d.selectionId.trim() === '') return null;
  if (!Array.isArray(d.wabas)) return null;
  const wabas: WabaOption[] = [];
  for (const raw of d.wabas) {
    const w = raw as { id?: unknown; name?: unknown } | null;
    if (!w || typeof w !== 'object' || typeof w.id !== 'string' || w.id.trim() === '') continue;
    const name = typeof w.name === 'string' && w.name.trim() !== '' ? w.name.trim() : 'Cuenta de WhatsApp Business';
    wabas.push({ id: w.id.trim(), name });
  }
  return wabas.length > 0 ? { selectionId: d.selectionId, wabas } : null;
}

/**
 * ¿La selección ya no sirve? `completeMetaConnectWaba` marca con `details.reason ===
 * 'seleccion_invalida'` los TRES casos donde la selección murió de verdad (vencida, replay,
 * wabaId fuera de la lista): solo ahí el camino honesto es rehacer el login de Meta. Cualquier
 * otro failed-precondition (colisión de WABA, límite del plan, billing) conserva su mensaje
 * accionable y NO debe disfrazarse de "venció" (review MEDIO: el disfraz creaba un loop sin
 * salida — rehacer el login jamás arregla una suspensión de billing).
 */
export function wabaSelectionPerdida(e: unknown): boolean {
  const err = e as { code?: unknown; details?: unknown; customData?: unknown } | null;
  if (err?.code !== 'functions/failed-precondition') return false;
  const det = (err.details ?? err.customData) as { reason?: unknown } | null | undefined;
  return det?.reason === 'seleccion_invalida';
}

/** Cierra la conexión con el WABA elegido. Misma respuesta de éxito que `connectMeta`. */
export async function completeMetaConnectWaba(tenantId: string, selectionId: string, wabaId: string): Promise<MetaConnectResult> {
  const call = httpsCallable<{ tenantId: string; selectionId: string; wabaId: string }, MetaConnectResult>(
    firebaseFunctions(),
    'completeMetaConnectWaba',
  );
  const res = await call({ tenantId, selectionId, wabaId });
  return res.data;
}

// ===== Coexistence: el número que el negocio YA usa con sus clientes (ADR-0017) =====
// SUPERFICIE PROPIA, y no un `mode` del flujo estándar. `connectMeta` corre `runMetaConnect`, que
// guarda el token en el secreto del TENANT (pisando el de `main`) y reescribe `metaAssets` con
// `connectionId: 'main'` — cuya limpieza borra el asset y la entrada de índice del número que HOY
// vende. Por acá el número entra en su PROPIA conexión `wa_{pnid}`, con su token, y nace MUDO.

export interface CoexistenceConnectInput {
  nonce: string;
  code: string;
  /**
   * Lo que trae el `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`: en su página específica, SOLO
   * `waba_id`. El PNID lo resuelve el backend con `GET /<WABA_ID>/phone_numbers` — si viene, es un
   * desempate y no una fuente.
   */
  wabaId?: string;
  phoneNumberId?: string;
  businessId?: string;
  businessName?: string;
}

export interface CoexistenceConnectResult {
  ok: boolean;
  connectionId: string;
  phoneNumberId: string;
  phoneNumber: string | null;
  status: string;
  /** true ⇒ la conexión ya existía (callback repetido) y no se escribió nada nuevo. */
  replay: boolean;
  /** Siempre `inactive`: conectar no autoriza a automatizar (ADR-0017 §1). */
  automationMode: WhatsappAutomationMode;
}

/** Paso 1: nonce de un solo uso atado al MODO `coexistence` (un nonce estándar no lo cierra). */
export async function coexistenceStart(tenantId: string): Promise<{ nonce: string }> {
  const call = httpsCallable<{ tenantId: string }, { ok: boolean; nonce: string; mode: string }>(firebaseFunctions(), 'coexistenceStart');
  const res = await call({ tenantId });
  return { nonce: res.data.nonce };
}

/** Paso 2: cierra el onboarding del número real. Nunca toca `metaConnections/main`. */
export async function coexistenceConnect(tenantId: string, input: CoexistenceConnectInput): Promise<CoexistenceConnectResult> {
  const call = httpsCallable<{ tenantId: string } & CoexistenceConnectInput, CoexistenceConnectResult>(firebaseFunctions(), 'coexistenceConnect');
  const res = await call({ tenantId, ...input });
  return res.data;
}

/**
 * HISTORIAL DE COEXISTENCE (ADR-0017 §5) — los tres pasos humanos, en orden.
 * El `phoneNumberId` que viaja acá SIEMPRE sale de los assets del tenant que la página ya listó
 * (jamás de un input libre), y el backend lo re-verifica contra la conexión `wa_{pnid}` propia:
 * el frontend no puede apuntar la decisión ni el disparo —que es de UN solo uso— a otro número.
 */
export type HistorySharingDecision = 'share' | 'skip';

export interface CoexistenceSyncStatus {
  ok: boolean;
  exists: boolean;
  /** false ⇒ la conexión de ese número NO es de Coexistence (alta manual): no hay historial que pedir. */
  coexistence?: boolean;
  status?: 'pending_request' | 'requested' | 'receiving' | 'completed' | 'declined' | 'expired' | 'failed';
  sharingDecision?: HistorySharingDecision | null;
  syncGeneration?: number;
  deadlineAtMs?: number | null;
  requestedAtMs?: number | null;
  lastChunkAtMs?: number | null;
  syncTypesRequested?: string[];
  progress?: number | null;
  chunks?: number;
  chunksDuplicados?: number;
  chunksPendientes?: number;
  chunksSinTenant?: number;
  mediaObservados?: number;
  declineCode?: number | null;
  errorMessage?: string;
}

/** La decisión humana, explícita y previa: `share` o `skip`. `skip` es terminal en este ciclo. */
export async function coexistenceDecideHistorySharing(
  tenantId: string,
  phoneNumberId: string,
  decision: HistorySharingDecision,
): Promise<{ ok: boolean; status: string; deadlineAtMs: number | null }> {
  const call = httpsCallable<
    { tenantId: string; phoneNumberId: string; decision: HistorySharingDecision },
    { ok: boolean; status: string; deadlineAtMs: number | null }
  >(firebaseFunctions(), 'coexistenceDecideHistorySharing');
  const res = await call({ tenantId, phoneNumberId, decision });
  return res.data;
}

/** EL disparo (único): `smb_app_data`. El coordinador lo rechaza si no corresponde. */
export async function coexistenceRequestHistorySync(
  tenantId: string,
  phoneNumberId: string,
): Promise<{ ok: boolean; syncTypes: string[] }> {
  const call = httpsCallable<{ tenantId: string; phoneNumberId: string }, { ok: boolean; syncTypes: string[] }>(
    firebaseFunctions(),
    'coexistenceRequestHistorySync',
  );
  const res = await call({ tenantId, phoneNumberId });
  return res.data;
}

/** Estado SANEADO del ciclo (sin conversaciones, sin teléfonos): lo que el panel puede mostrar. */
export async function coexistenceSyncStatus(tenantId: string, phoneNumberId: string): Promise<CoexistenceSyncStatus> {
  const call = httpsCallable<{ tenantId: string; phoneNumberId: string }, CoexistenceSyncStatus>(
    firebaseFunctions(),
    'coexistenceSyncStatus',
  );
  const res = await call({ tenantId, phoneNumberId });
  return res.data;
}

/**
 * Preflight bajo demanda: revalida token/número y actualiza el estado de la conexión.
 * `connectionId` opcional (ADR-0020 · G4): `'main'` por default, o una conexión `wa_{pnid}` de
 * Coexistence — SIEMPRE tomada de los assets que la página ya listó, jamás de un input libre.
 */
export async function verifyMetaChannel(tenantId: string, connectionId?: string): Promise<MetaVerifyResult> {
  const call = httpsCallable<{ tenantId: string; connectionId?: string }, MetaVerifyResult>(firebaseFunctions(), 'verifyMetaChannel');
  const res = await call(connectionId ? { tenantId, connectionId } : { tenantId });
  return res.data;
}

/** Elige el número de WhatsApp activo cuando el WABA tiene más de uno. */
export async function selectMetaPhoneNumber(tenantId: string, phoneNumberId: string): Promise<{ phoneNumberId: string }> {
  const call = httpsCallable<{ tenantId: string; phoneNumberId: string }, { ok: boolean; phoneNumberId: string }>(firebaseFunctions(), 'selectMetaPhoneNumber');
  const res = await call({ tenantId, phoneNumberId });
  return { phoneNumberId: res.data.phoneNumberId };
}

/**
 * Desconexión REAL (callable): corta el ruteo/automatización en VendeYaPy. Distinta del demo
 * disconnectMeta. `connectionId` opcional (ADR-0020 · G3): `'main'` por default, o `wa_{pnid}`
 * para dar de baja un número Coexistence propio. NO elimina nada dentro de Meta (ni WABA, ni
 * número, ni catálogo): se puede reconectar.
 */
export async function metaDisconnect(tenantId: string, connectionId?: string): Promise<void> {
  const call = httpsCallable<{ tenantId: string; connectionId?: string }, { ok: boolean }>(firebaseFunctions(), 'metaDisconnect');
  await call(connectionId ? { tenantId, connectionId } : { tenantId });
}

// ===== Verdad persistida legible (ADR-0020 · G8 + antigüedad de verificación) =====

/**
 * Razón saneada del backend → texto es-PY para el owner. Cubre el enum `ConnectFailReason` de
 * `connectFlow.ts` (incluidos los nuevos de ADR-0020: `waba_collision`, `seleccion_invalida`,
 * `waba_selection_required`). Una razón DESCONOCIDA cae al genérico honesto: el valor crudo
 * JAMÁS se muestra (podría ser jerga interna o, peor, texto de Graph).
 */
const CONNECT_ERROR_TEXT: Record<string, string> = {
  exchange_failed: 'No se pudo completar la autorización con Meta. Volvé a conectar desde el botón.',
  token_invalid: 'Meta rechazó la credencial obtenida. Volvé a conectar tu cuenta.',
  scopes_insuficientes: 'Faltaron permisos al autorizar. Reconectá aceptando todos los permisos de WhatsApp.',
  no_waba: 'Tu cuenta de Meta no tiene una cuenta de WhatsApp Business disponible para conectar.',
  waba_no_autorizado: 'La cuenta de WhatsApp Business elegida no está autorizada por el login que hiciste. Volvé a conectar y elegí una autorizada.',
  no_phone_number: 'La cuenta de WhatsApp Business no tiene ningún número para conectar.',
  phone_number_mismatch: 'El número elegido no pertenece a la cuenta de WhatsApp Business autorizada.',
  phone_number_collision: 'Ese número de WhatsApp ya está conectado en otra empresa.',
  waba_collision: 'Esa cuenta de WhatsApp Business ya está conectada en otra empresa.',
  persistencia_incompleta: 'No pudimos guardar la conexión. Probá conectar de nuevo.',
  over_number_limit: 'Tu plan no permite conectar tantos números de WhatsApp.',
  waba_selection_required: 'Quedó pendiente elegir la cuenta de WhatsApp Business. Volvé a conectar y elegila.',
  seleccion_invalida: 'La elección de cuenta venció o ya se usó. Rehacé el login de Meta.',
};

/**
 * Lo que `registrarFalloDeConexion` PERSISTE HOY son frases (saneadas, es-PY) y no códigos: este
 * alias las lleva al mismo mapa. Si el backend migra a códigos, ya están cubiertos arriba y este
 * bloque queda inerte. La frase de scopes es dinámica («faltan permisos: …») y se resuelve por
 * prefijo en `textoDeConnectError`.
 */
const CONNECT_ERROR_ALIAS: Record<string, string> = {
  'no se pudo intercambiar el code': 'exchange_failed',
  'token inválido': 'token_invalid',
  'varias cuentas de WhatsApp Business autorizadas: falta la elección explícita': 'waba_selection_required',
  'sin WhatsApp Business Account': 'no_waba',
  'la cuenta de WhatsApp Business pedida no está autorizada por el token': 'waba_no_autorizado',
  'el número pedido no pertenece a esa cuenta': 'phone_number_mismatch',
  'sin phone_number_id': 'no_phone_number',
  'el número de WhatsApp ya está conectado en otra empresa': 'phone_number_collision',
  'no se pudo guardar la conexión': 'persistencia_incompleta',
};

const CONNECT_ERROR_GENERICO = 'El último intento de conexión no se pudo completar. Probá conectar de nuevo.';

/** Texto es-PY para una razón persistida en `lastConnectError`. Nunca devuelve la cruda. */
export function textoDeConnectError(reason: unknown): string {
  if (typeof reason !== 'string' || reason.trim() === '') return CONNECT_ERROR_GENERICO;
  const limpio = reason.trim();
  const clave = CONNECT_ERROR_ALIAS[limpio] ?? (limpio.startsWith('faltan permisos') ? 'scopes_insuficientes' : limpio);
  return CONNECT_ERROR_TEXT[clave] ?? CONNECT_ERROR_GENERICO;
}

/**
 * Antigüedad legible («hace 3 horas») para `lastVerifiedAt` y compañía. Pura y con `nowMs`
 * inyectable para testear sin relojes falsos. Granularidad gruesa a propósito: al owner le
 * importa «hoy / hace días», no los segundos.
 */
export function formatHace(thenMs: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, nowMs - thenMs);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return min === 1 ? 'hace 1 minuto' : `hace ${min} minutos`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return horas === 1 ? 'hace 1 hora' : `hace ${horas} horas`;
  const dias = Math.floor(horas / 24);
  return dias === 1 ? 'hace 1 día' : `hace ${dias} días`;
}

/** A partir de cuántos ms sin verificar la UI sugiere «Revisar conexión» (7 días · deuda G5). */
export const VERIFICACION_VIEJA_MS = 7 * 86_400_000;

/** Mapea errores de los callables de Meta a mensajes claros (el backend ya manda mensajes amables). */
export function friendlyMetaError(e: unknown): string {
  const err = e as Partial<FunctionsError> & { code?: string; message?: string };
  const code = err?.code ?? '';
  const msg = err?.message ?? '';
  if (code === 'functions/permission-denied') return msg || 'Solo el dueño o un administrador pueden gestionar la conexión de Meta.';
  if (code === 'functions/unauthenticated') return 'Iniciá sesión para continuar.';
  // failed-precondition / invalid-argument / not-found ya traen mensajes claros del backend
  // (faltan permisos, sin WABA, sin número, token inválido, nonce expirado, número ajeno…).
  if (msg) return msg;
  return 'No se pudo completar la operación con Meta. Probá de nuevo.';
}

/** Eventos enviados a la Conversions API de Meta (D6). */
export async function listConversionEvents(tenantId: string): Promise<MetaConversionEvent[]> {
  const snap = await getDocs(collection(firebaseDb(), 'tenants', tenantId, 'metaConversionEvents'));
  return snap.docs.map((d) => d.data() as MetaConversionEvent);
}

export async function processConversions(tenantId: string): Promise<void> {
  await fetch(`${API}/devProcessConversions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId }) });
}
