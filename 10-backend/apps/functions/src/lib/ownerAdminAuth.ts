/**
 * lib/ownerAdminAuth.ts — Autorización ESTRICTA owner/admin (Fase 5B-ii)
 * =====================================================================
 * Acciones sensibles (billing, conexión Meta, secretos) solo las pueden ejecutar:
 *   - PLATFORM_ADMIN (debe indicar la empresa objetivo), o
 *   - TENANT_OWNER (solo SU empresa; se ignora cualquier tenantId pedido).
 * TENANT_MANAGER / TENANT_VIEWER / SELLER y sin-rol: DENEGADO.
 * Helper PURO compartido (lo reusan meta/authz y los callables de billing).
 */

export interface OwnerAdminToken {
  role?: string;
  tenantId?: string;
}

export type OwnerAdminAuthResult =
  | { ok: true; tenantId: string }
  | { ok: false; code: 'permission-denied' | 'invalid-argument'; message: string };

export function resolveOwnerAdminAuth(
  token: OwnerAdminToken,
  requestedTenantId?: string,
  opts?: { deniedMessage?: string },
): OwnerAdminAuthResult {
  if (token.role === 'PLATFORM_ADMIN') {
    if (!requestedTenantId) {
      return { ok: false, code: 'invalid-argument', message: 'Falta tenantId (PLATFORM_ADMIN debe indicar la empresa).' };
    }
    return { ok: true, tenantId: requestedTenantId };
  }
  if (token.role === 'TENANT_OWNER') {
    if (!token.tenantId) {
      return { ok: false, code: 'permission-denied', message: 'Tu usuario no tiene una empresa asignada.' };
    }
    // Se IGNORA cualquier tenantId pedido: un owner solo opera su propia empresa (cross-tenant bloqueado).
    return { ok: true, tenantId: token.tenantId };
  }
  return { ok: false, code: 'permission-denied', message: opts?.deniedMessage ?? 'Solo el dueño de la empresa o un administrador pueden ejecutar esta acción.' };
}
