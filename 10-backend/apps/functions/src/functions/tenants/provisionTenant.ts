/**
 * provisionTenant — Callable: alta de una empresa nueva (Fase 4)
 * =============================================================
 * Solo PLATFORM_ADMIN. Crea tenant + owner + claims + config inicial (core en
 * tenants/provision.ts).
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { provisionTenant as provisionTenantAdmin, TenantSlugTakenError, type ProvisionTenantInput } from '../../tenants/provision.js';

export const provisionTenant = onCall<ProvisionTenantInput>(
  { region: 'us-central1' },
  async (req: CallableRequest<ProvisionTenantInput>) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión.');
    const role = (req.auth.token as { role?: string }).role;
    if (role !== 'PLATFORM_ADMIN') {
      throw new HttpsError('permission-denied', 'Solo el administrador de la plataforma puede dar de alta empresas.');
    }
    try {
      // El core (provision.ts) audita 'tenant.provisioned' (sin duplicar acá).
      return await provisionTenantAdmin(req.data);
    } catch (e) {
      if (e instanceof TenantSlugTakenError) throw new HttpsError('already-exists', 'Ese nombre de empresa ya está en uso, elegí otro.');
      throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Error al aprovisionar');
    }
  },
);
