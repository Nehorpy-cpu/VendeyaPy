/**
 * Capa de acceso al Centro de Integración Meta (panel · D1 + Meta Connect UX).
 * Lectura de la conexión + activos (solo manager+, por reglas). Conectar/desconectar:
 *   - flujo REAL (callables owner/admin, Fase 4B): startMetaConnect/connectMeta/verifyMetaChannel/
 *     selectMetaPhoneNumber/metaDisconnect — el token nunca pasa por el frontend (solo el `code`).
 *   - fallback DEMO (endpoints dev): connectMetaDemo/disconnectMeta, cuando Meta no está configurado.
 * La page elige uno u otro según isMetaConfigured(). M-1 solo agrega los wrappers; no cambia la UI.
 */

import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { httpsCallable, type FunctionsError } from 'firebase/functions';
import type { MetaConnection, MetaAsset, MetaConversionEvent, MetaConnectionStatus } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:5001/demo-aiafg/us-central1';

export async function getMetaConnection(tenantId: string): Promise<MetaConnection | null> {
  const snap = await getDoc(doc(firebaseDb(), 'tenants', tenantId, 'metaConnections', 'main'));
  return snap.exists() ? (snap.data() as MetaConnection) : null;
}

export async function listMetaAssets(tenantId: string): Promise<MetaAsset[]> {
  const snap = await getDocs(collection(firebaseDb(), 'tenants', tenantId, 'metaAssets'));
  return snap.docs.map((d) => d.data() as MetaAsset);
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

/** Hay configuración para el flujo real (App ID + config_id del Embedded Signup). Si no, se usa demo. */
export function isMetaConfigured(): boolean {
  return !!process.env['NEXT_PUBLIC_META_APP_ID'] && !!process.env['NEXT_PUBLIC_META_CONFIG_ID'];
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

/** Paso 1 del Embedded Signup: emite un nonce de un solo uso (atado a tenant+uid). */
export async function startMetaConnect(tenantId: string): Promise<{ nonce: string }> {
  const call = httpsCallable<{ tenantId: string }, { ok: boolean; nonce: string }>(firebaseFunctions(), 'startMetaConnect');
  const res = await call({ tenantId });
  return { nonce: res.data.nonce };
}

/** Paso 2: consume el nonce + el `code` del popup; el backend valida, descubre assets y conecta. */
export async function connectMeta(tenantId: string, input: MetaConnectInput): Promise<MetaConnectResult> {
  const call = httpsCallable<{ tenantId: string } & MetaConnectInput, MetaConnectResult>(firebaseFunctions(), 'connectMeta');
  const res = await call({ tenantId, ...input });
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
