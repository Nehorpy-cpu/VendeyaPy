/**
 * staffAuth.ts — Autorización de STAFF para callables de conversaciones (HUMAN-HANDOFF-1)
 * =======================================================================================
 * Regla compartida por tomar/devolver el chat y el mensaje manual del vendedor:
 * el usuario debe pertenecer al tenant (claims) o ser PLATFORM_ADMIN, con rol de staff.
 * Cross-tenant: imposible por construcción — el tenantId SIEMPRE se valida contra los claims,
 * nunca se confía en el que manda el frontend.
 */
import { HttpsError } from 'firebase-functions/v2/https';

export const STAFF_ROLES = ['PLATFORM_ADMIN', 'TENANT_OWNER', 'TENANT_MANAGER', 'SELLER'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export interface StaffActor {
  uid: string;
  role: StaffRole;
  /** Nombre legible para historial/audit (name > email > undefined). */
  name?: string;
  isPlatformAdmin: boolean;
}

export interface AuthLike {
  uid: string;
  token: { tenantId?: string; role?: string; name?: string; email?: string };
}

/** Valida tenant + rol de staff. PURA respecto a Firestore → unit-testeable. */
export function assertStaffAccess(auth: AuthLike | undefined | null, tenantId: string): StaffActor {
  if (!auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const token = auth.token ?? {};
  const role = (token.role ?? '') as StaffRole;
  if (!STAFF_ROLES.includes(role)) {
    throw new HttpsError('permission-denied', 'Tu rol no puede atender conversaciones.');
  }
  const isPlatformAdmin = role === 'PLATFORM_ADMIN';
  if (!isPlatformAdmin && token.tenantId !== tenantId) {
    throw new HttpsError('permission-denied', 'No tenés acceso a esta empresa.');
  }
  return { uid: auth.uid, role, name: token.name || token.email || undefined, isPlatformAdmin };
}
