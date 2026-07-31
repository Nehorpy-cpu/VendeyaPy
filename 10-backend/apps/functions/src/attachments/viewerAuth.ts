/**
 * attachments/viewerAuth.ts — Quién puede pedir el archivo de un adjunto (ADR-0016 §6)
 * =====================================================================================
 * Lógica PURA, en el mismo espíritu que `panel/auth.ts`, para que la denegación del anónimo y la
 * del cross-tenant se puedan testear sin levantar un callable.
 *
 * Criterio: los adjuntos son material de la CONVERSACIÓN, así que los ve el mismo staff que ve el
 * chat y los comprobantes — `TENANT_OWNER`, `TENANT_MANAGER`, `SELLER` — más `PLATFORM_ADMIN`
 * para soporte. El `TENANT_VIEWER` queda AFUERA a propósito: es un rol de tablero (pedidos y
 * métricas) y estos son archivos personales de clientes; espeja `customers/{c}/messages` en
 * `firestore.rules`.
 *
 * Un usuario de tenant NO puede pedir otra empresa: el `tenantId` del request se IGNORA y manda
 * el del claim. Solo `PLATFORM_ADMIN` debe indicarlo, y explícitamente.
 */

/** Roles REALES del sistema (ADR-0005 / ARCHITECTURE.md §5.1). No hay enums nuevos acá. */
export const ATTACHMENT_VIEWER_ROLES = ['TENANT_OWNER', 'TENANT_MANAGER', 'SELLER'] as const;

export interface AttachmentViewerToken {
  role?: string;
  tenantId?: string;
}

export type AttachmentViewerAuthResult =
  | { ok: true; tenantId: string; role: string }
  | {
      ok: false;
      code: 'unauthenticated' | 'permission-denied' | 'invalid-argument';
      message: string;
    };

export function resolveAttachmentViewerAuth(
  token: AttachmentViewerToken | null | undefined,
  requestedTenantId?: string,
): AttachmentViewerAuthResult {
  if (!token || typeof token !== 'object') {
    return { ok: false, code: 'unauthenticated', message: 'Iniciá sesión para continuar.' };
  }
  const role = typeof token.role === 'string' ? token.role : '';
  if (role === 'PLATFORM_ADMIN') {
    const target = typeof requestedTenantId === 'string' ? requestedTenantId.trim() : '';
    if (!target) {
      return {
        ok: false,
        code: 'invalid-argument',
        message: 'Falta tenantId (PLATFORM_ADMIN debe indicar la empresa).',
      };
    }
    return { ok: true, tenantId: target, role };
  }
  if (!(ATTACHMENT_VIEWER_ROLES as readonly string[]).includes(role)) {
    return { ok: false, code: 'permission-denied', message: 'Tu rol no puede abrir archivos de la conversación.' };
  }
  if (!token.tenantId) {
    return { ok: false, code: 'permission-denied', message: 'Tu usuario no tiene una empresa asignada.' };
  }
  // El tenantId pedido se descarta: el staff solo abre archivos de su propia empresa.
  return { ok: true, tenantId: token.tenantId, role };
}
