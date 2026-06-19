/**
 * Capa de registro self-service + onboarding (panel · Fase registro R-3).
 *
 * Cablea los callables del backend (R-1) desde el cliente:
 *   - registerTenantOwner: el visitante (email verificado) crea su empresa y queda TENANT_OWNER.
 *     NUNCA enviamos role/tenantId/planId/ownerUid/ownerEmail — todos los fija/deriva el backend.
 *   - completeOnboarding: el owner marca onboarding.completed (la rule R-2 lo cierra a callable-only).
 * Más utilidades: lectura del flag de onboarding (para el guard), espera de claims tras el alta,
 * y mapeo de errores del callable a mensajes claros en español.
 */

import { httpsCallable, type FunctionsError } from 'firebase/functions';
import { doc, getDoc } from 'firebase/firestore';
import { firebaseAuth, firebaseDb, firebaseFunctions } from './firebase';

/** Datos de empresa que SÍ acepta el callable. role/tenantId/planId/ownerUid/ownerEmail los pone el backend. */
export interface RegisterTenantInput {
  businessName: string;
  ownerName?: string;
  phone?: string;
  country?: string;
  currency?: string;
}

export interface RegisterTenantResult {
  ok: boolean;
  tenantId: string;
  role: 'TENANT_OWNER';
}

/** Alta self-service de empresa. Requiere usuario autenticado con email verificado (el backend lo exige). */
export async function registerTenantOwner(input: RegisterTenantInput): Promise<RegisterTenantResult> {
  const call = httpsCallable<RegisterTenantInput, RegisterTenantResult>(firebaseFunctions(), 'registerTenantOwner');
  const res = await call(input);
  return res.data;
}

/** Marca el onboarding como completado. Owner: sin tenantId (usa el del token). Admin: debe pasar tenantId. */
export async function completeOnboarding(tenantId?: string): Promise<{ ok: boolean; tenantId: string }> {
  const call = httpsCallable<{ tenantId?: string }, { ok: boolean; tenantId: string }>(firebaseFunctions(), 'completeOnboarding');
  const res = await call(tenantId ? { tenantId } : {});
  return res.data;
}

/**
 * Lee tenants/{tenantId}.onboarding.completed (lo usa el guard). El owner puede leer su tenant
 * (rules). Devuelve null si no se pudo leer (fail-open: el guard no bloquea el panel por un read fallido).
 */
export async function getTenantOnboardingCompleted(tenantId: string): Promise<boolean | null> {
  try {
    const snap = await getDoc(doc(firebaseDb(), 'tenants', tenantId));
    if (!snap.exists()) return null;
    const onboarding = snap.data()['onboarding'] as { completed?: boolean } | undefined;
    return onboarding?.completed ?? false;
  } catch {
    return null;
  }
}

/**
 * Tras registerTenantOwner el backend setea custom claims { tenantId, role }. Forzamos refresh del
 * token y esperamos a que aparezca el claim tenantId (propagación). Devuelve los claims o nulls si expira.
 */
export async function waitForTenantClaim(
  maxTries = 6,
  delayMs = 1500,
): Promise<{ tenantId: string | null; role: string | null }> {
  for (let i = 0; i < maxTries; i++) {
    const u = firebaseAuth().currentUser;
    if (!u) return { tenantId: null, role: null };
    const res = await u.getIdTokenResult(true); // force refresh
    const tenantId = (res.claims['tenantId'] as string | undefined) ?? null;
    const role = (res.claims['role'] as string | undefined) ?? null;
    if (tenantId && role) return { tenantId, role };
    if (i < maxTries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { tenantId: null, role: null };
}

/** Mapea errores del callable a mensajes claros. El backend ya manda mensajes amables; los reusamos. */
export function friendlyRegisterError(e: unknown): string {
  const err = e as Partial<FunctionsError> & { code?: string; message?: string };
  const code = err?.code ?? '';
  const msg = err?.message ?? '';
  if (code === 'functions/already-exists') return msg || 'Ese nombre de empresa ya está en uso, elegí otro.';
  if (code === 'functions/failed-precondition') {
    if (/verific/i.test(msg)) return 'Tu email todavía no figura como verificado. Tocá el enlace del correo y reintentá.';
    if (/ya tenés|ya tenes|asociada/i.test(msg)) return 'Tu cuenta ya tiene una empresa asociada.';
    return msg || 'No pudimos continuar con el registro.';
  }
  if (code === 'functions/invalid-argument') return msg || 'Revisá los datos del formulario.';
  if (code === 'functions/unauthenticated') return 'Iniciá sesión para continuar.';
  return msg || 'No se pudo crear la empresa. Probá de nuevo.';
}
