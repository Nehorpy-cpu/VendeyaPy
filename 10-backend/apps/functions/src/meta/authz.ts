/**
 * meta/authz.ts — Autorización ESTRICTA de la conexión Meta (Fase 4B)
 * ==================================================================
 * Más estricta que panel/auth.ts: conectar/desconectar/verificar/seleccionar canal Meta
 * (tocan secretos y credenciales) solo lo pueden hacer:
 *   - PLATFORM_ADMIN (debe indicar la empresa objetivo), o
 *   - TENANT_OWNER (solo SU empresa; se ignora cualquier tenantId pedido).
 * TENANT_MANAGER / TENANT_VIEWER / SELLER y sin-rol: DENEGADO.
 */

export interface MetaAuthToken {
  role?: string;
  tenantId?: string;
}

export type MetaAuthResult =
  | { ok: true; tenantId: string }
  | { ok: false; code: 'permission-denied' | 'invalid-argument'; message: string };

export function resolveMetaConnectAuth(token: MetaAuthToken, requestedTenantId?: string): MetaAuthResult {
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
  return { ok: false, code: 'permission-denied', message: 'Solo el dueño de la empresa o un administrador pueden gestionar la conexión de Meta.' };
}
