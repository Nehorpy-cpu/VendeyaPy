/**
 * userManagement — Callables: invitar usuario, cambiar rol, activar/desactivar (Fase 4)
 * =====================================================================================
 * Autorización: PLATFORM_ADMIN o el TENANT_OWNER de esa empresa. El core vive en
 * users/manage.ts (Admin SDK: custom claims + doc users/{uid}).
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { UserRole } from '@vpw/shared';
import { inviteUser as inviteUserCore, setUserRole as setUserRoleCore, setUserActive as setUserActiveCore } from '../../users/manage.js';

function assertTenantAdmin(req: CallableRequest<unknown>, tenantId: string): void {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión.');
  const token = req.auth.token as { role?: string; tenantId?: string };
  const isAdmin = token.role === 'PLATFORM_ADMIN';
  const isOwner = token.role === 'TENANT_OWNER' && token.tenantId === tenantId;
  if (!isAdmin && !isOwner) {
    throw new HttpsError('permission-denied', 'Solo el dueño de la empresa o el admin pueden gestionar usuarios.');
  }
}

export const inviteUser = onCall<{ tenantId?: string; email?: string; role?: UserRole; name?: string }>(
  { region: 'us-central1' },
  async (req) => {
    const { tenantId, email, role, name } = req.data ?? {};
    if (!tenantId || !email || !role) throw new HttpsError('invalid-argument', 'Faltan tenantId, email y role.');
    assertTenantAdmin(req, tenantId);
    try {
      return await inviteUserCore(tenantId, email, role, name);
    } catch (e) {
      throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Error');
    }
  },
);

export const setUserRole = onCall<{ tenantId?: string; uid?: string; role?: UserRole }>(
  { region: 'us-central1' },
  async (req) => {
    const { tenantId, uid, role } = req.data ?? {};
    if (!tenantId || !uid || !role) throw new HttpsError('invalid-argument', 'Faltan tenantId, uid y role.');
    assertTenantAdmin(req, tenantId);
    try {
      await setUserRoleCore(tenantId, uid, role);
      return { ok: true };
    } catch (e) {
      throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Error');
    }
  },
);

export const setUserActive = onCall<{ tenantId?: string; uid?: string; active?: boolean }>(
  { region: 'us-central1' },
  async (req) => {
    const { tenantId, uid, active } = req.data ?? {};
    if (!tenantId || !uid || typeof active !== 'boolean') {
      throw new HttpsError('invalid-argument', 'Faltan tenantId, uid y active.');
    }
    assertTenantAdmin(req, tenantId);
    try {
      await setUserActiveCore(tenantId, uid, active);
      return { ok: true };
    } catch (e) {
      throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Error');
    }
  },
);
