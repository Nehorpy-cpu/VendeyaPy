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

export async function getMetaConnection(tenantId: string): Promise<MetaConnection | null> {
  const snap = await getDoc(doc(firebaseDb(), 'tenants', tenantId, 'metaConnections', 'main'));
  return snap.exists() ? (snap.data() as MetaConnection) : null;
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

/** Preflight bajo demanda: revalida token/número y actualiza el estado de la conexión. */
export async function verifyMetaChannel(tenantId: string): Promise<MetaVerifyResult> {
  const call = httpsCallable<{ tenantId: string }, MetaVerifyResult>(firebaseFunctions(), 'verifyMetaChannel');
  const res = await call({ tenantId });
  return res.data;
}

/** Elige el número de WhatsApp activo cuando el WABA tiene más de uno. */
export async function selectMetaPhoneNumber(tenantId: string, phoneNumberId: string): Promise<{ phoneNumberId: string }> {
  const call = httpsCallable<{ tenantId: string; phoneNumberId: string }, { ok: boolean; phoneNumberId: string }>(firebaseFunctions(), 'selectMetaPhoneNumber');
  const res = await call({ tenantId, phoneNumberId });
  return { phoneNumberId: res.data.phoneNumberId };
}

/** Desconexión REAL (callable): borra conexión/assets/índice/secreto. Distinta del demo disconnectMeta. */
export async function metaDisconnect(tenantId: string): Promise<void> {
  const call = httpsCallable<{ tenantId: string }, { ok: boolean }>(firebaseFunctions(), 'metaDisconnect');
  await call({ tenantId });
}

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
