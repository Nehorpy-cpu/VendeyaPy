/**
 * panel/auth.ts — Autorización de acciones del panel (Hardening F2)
 * ================================================================
 * Lógica PURA (testeable) que resuelve la empresa objetivo y autoriza una acción
 * del panel según el rol y el tenant del usuario (custom claims):
 *   - PLATFORM_ADMIN: puede operar CUALQUIER empresa (debe pasar tenantId).
 *   - TENANT_OWNER / TENANT_MANAGER: solo SU empresa (se ignora cualquier tenantId pedido).
 *   - resto (vendedor / lector / sin rol): denegado.
 */

export interface PanelToken {
  role?: string;
  tenantId?: string;
}

export type PanelAuthResult =
  | { ok: true; tenantId: string }
  | { ok: false; code: 'permission-denied' | 'invalid-argument'; message: string };

const MANAGER_ROLES = ['TENANT_OWNER', 'TENANT_MANAGER'];

export function resolvePanelAuth(token: PanelToken, requestedTenantId?: string): PanelAuthResult {
  if (token.role === 'PLATFORM_ADMIN') {
    if (!requestedTenantId) {
      return { ok: false, code: 'invalid-argument', message: 'Falta tenantId (PLATFORM_ADMIN debe indicar la empresa).' };
    }
    return { ok: true, tenantId: requestedTenantId };
  }
  if (token.role && MANAGER_ROLES.includes(token.role)) {
    if (!token.tenantId) {
      return { ok: false, code: 'permission-denied', message: 'Tu usuario no tiene una empresa asignada.' };
    }
    // Se IGNORA cualquier tenantId pedido: un manager solo opera su propia empresa.
    return { ok: true, tenantId: token.tenantId };
  }
  return { ok: false, code: 'permission-denied', message: 'Tu rol no puede ejecutar acciones del panel.' };
}
