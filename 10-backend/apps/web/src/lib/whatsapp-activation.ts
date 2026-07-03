/**
 * Capa de acceso al onboarding manual de WhatsApp (WM-2).
 * ------------------------------------------------------
 * Owner: solicitar / cancelar la activación ASISTIDA + leer su solicitud.
 * Admin (PLATFORM_ADMIN): listar solicitudes pendientes (collectionGroup) + cargar la conexión
 *   manual (WM-1, adminSetManualWhatsappConnection).
 *
 * SEGURIDAD: el accessToken NUNCA se guarda ni se loguea en el frontend — solo transita al callable
 * (que lo cifra server-side) y se descarta. Las solicitudes no contienen token (solo metadatos).
 */
import { collection, collectionGroup, getDocs, query, where, orderBy, limit } from 'firebase/firestore';
import { httpsCallable, type FunctionsError } from 'firebase/functions';
import type { WhatsappActivationRequest } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';

/** La vista incluye el Timestamp de Firestore (con `.toDate()`) para formatear la fecha. */
export type WhatsappActivationRequestView = WhatsappActivationRequest & { requestedAt?: { toDate?: () => Date } };

/**
 * Modelo de los 4 estados que ve el owner (WM-2), derivado del estado de la conexión Meta + su solicitud:
 *   - 'connected'    → conexión 'active' (WhatsApp conectado).
 *   - 'needs_review' → conexión conectada pero NO activa (pending_review/permission_missing/error/…): el
 *                      equipo está terminando o hay que corregir algo.
 *   - 'pending'      → sin conexión aún, pero hay una solicitud pendiente.
 *   - 'none'         → sin conexión y sin solicitud → mostrar el CTA de activación asistida.
 * Función PURA (testeable sin render). La conexión manda sobre la solicitud (una vez conectado, da igual).
 */
export type AssistedState = 'connected' | 'needs_review' | 'pending' | 'none';
export function deriveAssistedState(connStatus: string | null | undefined, requestStatus: string | null | undefined): AssistedState {
  if (connStatus === 'active') return 'connected';
  if (connStatus && connStatus !== 'not_connected') return 'needs_review';
  if (requestStatus === 'pending') return 'pending';
  return 'none';
}

// ===== Owner =====

/** Última solicitud del tenant (o null): permite mostrar pendiente/completada/cancelada. */
export async function getMyWhatsappRequest(tenantId: string): Promise<WhatsappActivationRequestView | null> {
  const snap = await getDocs(
    query(collection(firebaseDb(), 'tenants', tenantId, 'whatsappActivationRequests'), orderBy('requestedAt', 'desc'), limit(1)),
  );
  return snap.empty ? null : (snap.docs[0]!.data() as WhatsappActivationRequestView);
}

/** Crea la solicitud de activación asistida (owner: usa su claim; ignora tenantId externo). */
export async function requestWhatsappActivation(input: { note?: string; contactPhone?: string }): Promise<{ ok: boolean; requestId: string; status: string }> {
  const call = httpsCallable<{ note?: string; contactPhone?: string }, { ok: boolean; requestId: string; status: string }>(
    firebaseFunctions(), 'requestWhatsappActivation',
  );
  return (await call(input)).data;
}

/** Cancela una solicitud (owner: solo la suya pendiente; admin: cualquiera, pasando tenantId). */
export async function cancelWhatsappActivation(input: { tenantId?: string; requestId: string; reason?: string }): Promise<{ ok: boolean; status: string }> {
  const call = httpsCallable<{ tenantId?: string; requestId: string; reason?: string }, { ok: boolean; status: string }>(
    firebaseFunctions(), 'cancelWhatsappActivationRequest',
  );
  return (await call(input)).data;
}

// ===== Admin (PLATFORM_ADMIN) =====

/** Solicitudes pendientes de TODAS las empresas (collectionGroup; índice WM-2). */
export async function listPendingWhatsappRequests(): Promise<WhatsappActivationRequestView[]> {
  const snap = await getDocs(
    query(collectionGroup(firebaseDb(), 'whatsappActivationRequests'), where('status', '==', 'pending'), orderBy('requestedAt', 'desc')),
  );
  return snap.docs.map((d) => d.data() as WhatsappActivationRequestView);
}

export interface ManualWhatsappConnInput {
  tenantId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  businessId?: string;
  businessName?: string;
  accessToken: string;
  tokenExpiresAt?: number;
  /** Si la carga responde a una solicitud del owner, se marca 'completed'. */
  requestId?: string;
}

export interface ManualWhatsappConnResult {
  ok: boolean;
  status: string;
  ready: boolean;
  phoneNumberId: string;
  phoneNumber: string | null;
}

/** (PLATFORM_ADMIN) Carga manual de la conexión WhatsApp (WM-1). El token va al callable, no se guarda acá. */
export async function setManualWhatsappConnection(input: ManualWhatsappConnInput): Promise<ManualWhatsappConnResult> {
  const call = httpsCallable<ManualWhatsappConnInput, ManualWhatsappConnResult>(firebaseFunctions(), 'adminSetManualWhatsappConnection');
  return (await call(input)).data;
}

// ---------------- MULTI-NUMBER-1: números adicionales por empresa ----------------

export interface TenantWhatsappNumber {
  phoneNumberId: string;
  displayPhoneNumber: string;
  connectionId: string;
  status: string;
  isDefault: boolean;
}

/** Números de WhatsApp de la empresa (assets phone). Lectura directa (rules: manager+/admin). */
export async function listTenantWhatsappNumbers(tenantId: string): Promise<TenantWhatsappNumber[]> {
  const { collection, getDocs, query, where } = await import('firebase/firestore');
  const { firebaseDb } = await import('./firebase');
  const snap = await getDocs(query(
    collection(firebaseDb(), 'tenants', tenantId, 'metaAssets'),
    where('assetType', '==', 'whatsapp_phone_number'),
  ));
  return snap.docs.map((d) => {
    const a = d.data() as { externalId?: string; name?: string; connectionId?: string; status?: string; selected?: boolean };
    return {
      phoneNumberId: a.externalId ?? d.id,
      displayPhoneNumber: a.name ?? d.id,
      connectionId: a.connectionId ?? 'main',
      status: a.status ?? 'active',
      isDefault: !!a.selected,
    };
  }).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/** (PLATFORM_ADMIN) Agrega un número ADICIONAL (no reemplaza el principal). */
export async function adminAddWhatsappNumber(input: ManualWhatsappConnInput): Promise<{ ok: boolean; status: string; phoneNumberId: string; phoneNumber: string | null }> {
  const call = httpsCallable<ManualWhatsappConnInput, { ok: boolean; status: string; phoneNumberId: string; phoneNumber: string | null }>(firebaseFunctions(), 'adminAddWhatsappNumber');
  return (await call(input)).data;
}

/** (PLATFORM_ADMIN) Desactiva un número adicional: deja de rutear, historial intacto. */
export async function adminDeactivateWhatsappNumber(tenantId: string, phoneNumberId: string): Promise<{ ok: boolean }> {
  const call = httpsCallable<{ tenantId: string; phoneNumberId: string }, { ok: boolean }>(firebaseFunctions(), 'adminDeactivateWhatsappNumber');
  return (await call({ tenantId, phoneNumberId })).data;
}

/** Mapea errores de los callables de WhatsApp a mensajes claros (el backend ya manda mensajes amables). */
export function friendlyWhatsappError(e: unknown): string {
  const err = e as Partial<FunctionsError> & { code?: string; message?: string };
  const code = err?.code ?? '';
  if (code === 'functions/unauthenticated') return 'Iniciá sesión para continuar.';
  if (code === 'functions/permission-denied') return err.message || 'No tenés permiso para esta acción.';
  // failed-precondition / invalid-argument / not-found ya traen mensajes claros del backend.
  return err?.message || 'No se pudo completar la operación. Probá de nuevo.';
}
