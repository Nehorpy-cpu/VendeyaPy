/**
 * registerTenantOwner — Callable: auto-registro de empresa (Fase registro, R-1)
 * =============================================================================
 * Lo llama un usuario RECIÉN autenticado (email/password en el cliente) que aún NO tiene rol/tenant.
 * Crea su empresa y lo deja como TENANT_OWNER. Tras el OK, el cliente DEBE forzar getIdToken(true)
 * para que los claims { tenantId, role } aparezcan en el token.
 *
 * Invariantes de seguridad (R-1):
 *   - input NO acepta role/planId/tenantId/ownerUid/ownerEmail: todos server-set/derivados.
 *   - rol HARDCODEADO a TENANT_OWNER (nunca PLATFORM_ADMIN); owner = req.auth.uid; email = token.email.
 *   - exige email verificado (token.email_verified === true).
 *   - rechaza si el caller ya tiene tenantId/role (anti multi-tenant; cubre seller/manager/admin existentes).
 *   - plan inicial = free; slug reservado atómicamente (colisión → already-exists, sin auto-sufijo).
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { COUNTRY, CURRENCY } from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { provisionTenantCore, slugify, TenantSlugTakenError } from '../../tenants/provision.js';
import { logger } from '../../lib/logger.js';

export const registerTenantOwner = onCall<{ businessName?: string; slug?: string; ownerName?: string; industry?: string; country?: string; currency?: string; phone?: string }>(
  { region: 'us-central1' },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para crear tu empresa.');
    const token = req.auth.token as { role?: string; tenantId?: string; email?: string; email_verified?: boolean };

    // Email verificado obligatorio (anti-abuso del self-signup).
    if (token.email_verified !== true) {
      throw new HttpsError('failed-precondition', 'Verificá tu email antes de crear la empresa.');
    }
    // Anti multi-tenant / anti-escalada: un usuario que ya tiene empresa o rol NO puede crear otra.
    if (token.tenantId || token.role) {
      throw new HttpsError('failed-precondition', 'Ya tenés una empresa asociada.');
    }
    // Defensa en profundidad por si el token está rancio tras un alta previa en la sesión.
    if ((await db().doc(paths.user(req.auth.uid)).get()).exists) {
      throw new HttpsError('failed-precondition', 'Ya tenés una empresa asociada.');
    }
    const ownerEmail = token.email;
    if (!ownerEmail) throw new HttpsError('failed-precondition', 'Tu cuenta no tiene un email asociado.');

    const businessName = String(req.data?.businessName ?? '').trim();
    if (businessName.length < 2 || businessName.length > 60) {
      throw new HttpsError('invalid-argument', 'El nombre de la empresa debe tener entre 2 y 60 caracteres.');
    }
    const tenantId = slugify(req.data?.slug || businessName);
    if (!tenantId) throw new HttpsError('invalid-argument', 'El nombre de la empresa no es válido.');
    const country = (COUNTRY as readonly string[]).includes(req.data?.country ?? '') ? req.data!.country! : 'PY';
    const currency = (CURRENCY as readonly string[]).includes(req.data?.currency ?? '') ? req.data!.currency! : 'PYG';
    const ownerName = typeof req.data?.ownerName === 'string' ? req.data.ownerName.slice(0, 80) : undefined;
    const industry = typeof req.data?.industry === 'string' ? req.data.industry : undefined;
    const phone = typeof req.data?.phone === 'string' ? req.data.phone.slice(0, 40) : undefined;

    try {
      // ownerUid = req.auth.uid (NO del input). planId NO se acepta → el core fija 'free'.
      const result = await provisionTenantCore({
        tenantId, businessName, ownerUid: req.auth.uid, ownerEmail, ownerName, industry, country, currency, phone,
        audit: { action: 'tenant.self_provisioned', actorRole: 'TENANT_OWNER', self: true },
      });
      logger.info('Empresa auto-registrada', { tenantId: result.tenantId, ownerUid: result.ownerUid });
      return { ok: true, tenantId: result.tenantId, role: 'TENANT_OWNER' };
    } catch (e) {
      if (e instanceof TenantSlugTakenError) throw new HttpsError('already-exists', 'Ese nombre de empresa ya está en uso, elegí otro.');
      logger.error('Error en registerTenantOwner', e, { uid: req.auth.uid });
      throw new HttpsError('internal', 'No se pudo crear la empresa.');
    }
  },
);
