/**
 * meta/authz.ts — Autorización ESTRICTA de la conexión Meta (Fase 4B)
 * ==================================================================
 * Delega en el helper compartido resolveOwnerAdminAuth (Fase 5B-ii): solo PLATFORM_ADMIN
 * (con empresa objetivo) o TENANT_OWNER de su empresa. Manager/viewer/seller: DENEGADO.
 */
import { resolveOwnerAdminAuth, type OwnerAdminToken, type OwnerAdminAuthResult } from '../lib/ownerAdminAuth.js';

export type MetaAuthToken = OwnerAdminToken;
export type MetaAuthResult = OwnerAdminAuthResult;

export function resolveMetaConnectAuth(token: MetaAuthToken, requestedTenantId?: string): MetaAuthResult {
  return resolveOwnerAdminAuth(token, requestedTenantId, {
    deniedMessage: 'Solo el dueño de la empresa o un administrador pueden gestionar la conexión de Meta.',
  });
}
