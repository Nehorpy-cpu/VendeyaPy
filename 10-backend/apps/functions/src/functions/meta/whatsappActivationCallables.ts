/**
 * functions/meta/whatsappActivationCallables.ts — Onboarding manual de WhatsApp (WM-2).
 * =====================================================================================
 * requestWhatsappActivation (owner/admin): crea una solicitud 'pending' de activación ASISTIDA.
 *   NO toca metaConnections ni tokens. 1 pending por tenant. seller/manager/viewer → permission-denied
 *   (gate resolveOwnerAdminAuth: solo TENANT_OWNER de su empresa o PLATFORM_ADMIN indicando la empresa).
 *   El owner IGNORA cualquier tenantId externo: usa su claim (cross-tenant bloqueado).
 * cancelWhatsappActivationRequest: el admin cancela cualquiera; el owner solo su propia 'pending'.
 *
 * La escritura de las solicitudes es SOLO por estos callables (Admin SDK; rules write:false).
 * La CARGA de la conexión (con token) la hace adminSetManualWhatsappConnection (WM-1) — acá NO hay token.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { Tenant } from '@vpw/shared';
import { resolveOwnerAdminAuth } from '../../lib/ownerAdminAuth.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { COLL, DOC, sanitizeActivationRequestInput, buildActivationRequestDoc } from '../../meta/activationRequests.js';

/** Gate owner/admin (resolveOwnerAdminAuth): owner solo su tenant; admin pasa tenantId. Devuelve rol/uid. */
function authorizeOwnerAdmin(req: CallableRequest<unknown>, requestedTenantId?: string): { tenantId: string; role: string; uid: string } {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const token = req.auth.token as { role?: string; tenantId?: string };
  const r = resolveOwnerAdminAuth(token, requestedTenantId, {
    deniedMessage: 'Solo el dueño de la empresa o un administrador pueden solicitar la activación de WhatsApp.',
  });
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return { tenantId: r.tenantId, role: token.role ?? '', uid: req.auth.uid };
}

// ===== 1) requestWhatsappActivation (owner/admin) — crea la solicitud, NO conecta =====
export const requestWhatsappActivation = onCall<{ tenantId?: string; note?: string; contactPhone?: string }>(
  { region: 'us-central1' },
  async (req) => {
    const { tenantId, role, uid } = authorizeOwnerAdmin(req, req.data?.tenantId);

    // El tenant DEBE existir (no crear solicitudes fantasma).
    const tenantSnap = await db().doc(paths.tenant(tenantId)).get();
    if (!tenantSnap.exists) throw new HttpsError('failed-precondition', 'La empresa no existe.');

    // Una sola solicitud 'pending' por tenant (evita spam y ambigüedad al procesar).
    const pending = await db().collection(COLL(tenantId)).where('status', '==', 'pending').limit(1).get();
    if (!pending.empty) {
      throw new HttpsError('failed-precondition', 'Ya hay una solicitud de activación de WhatsApp pendiente para esta empresa.');
    }

    const input = sanitizeActivationRequestInput(req.data);
    const businessName = (tenantSnap.data() as Partial<Tenant> | undefined)?.name ?? tenantId;
    const now = Timestamp.now();
    const ref = db().collection(COLL(tenantId)).doc();
    await ref.set(buildActivationRequestDoc({ id: ref.id, tenantId, uid, role, businessName, input, now }));

    // Audit SIN datos sensibles: solo si trae nota/contacto (no su contenido).
    await recordAudit({
      tenantId, action: 'whatsapp.activation_requested', actorUid: uid, actorRole: role,
      targetType: 'meta', targetId: ref.id, summary: 'Solicitud de activación asistida de WhatsApp',
      metadata: { hasNote: input.note != null, hasContact: input.contactPhone != null },
    });
    logger.info('Solicitud de activación WhatsApp creada', { tenantId, requestId: ref.id });
    return { ok: true, requestId: ref.id, status: 'pending' };
  },
);

// ===== 2) cancelWhatsappActivationRequest (admin: cualquiera; owner: solo su propia 'pending') =====
export const cancelWhatsappActivationRequest = onCall<{ tenantId?: string; requestId?: string; reason?: string }>(
  { region: 'us-central1' },
  async (req) => {
    const { tenantId, role, uid } = authorizeOwnerAdmin(req, req.data?.tenantId);
    const requestId = req.data?.requestId;
    if (!requestId || typeof requestId !== 'string') throw new HttpsError('invalid-argument', 'Falta requestId.');
    const reason = typeof req.data?.reason === 'string' ? req.data.reason.slice(0, 500) : null;

    const ref = db().doc(DOC(tenantId, requestId));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Solicitud no encontrada.');
    const r = snap.data() as { status?: string; requestedByUid?: string };
    if (r.status !== 'pending') throw new HttpsError('failed-precondition', 'Solo se cancelan solicitudes pendientes.');
    // Owner: solo su propia solicitud. Admin: cualquiera.
    if (role !== 'PLATFORM_ADMIN' && r.requestedByUid !== uid) {
      throw new HttpsError('permission-denied', 'Solo podés cancelar tu propia solicitud.');
    }

    await ref.update({ status: 'cancelled', cancelReason: reason, reviewedByUid: uid, reviewedAt: Timestamp.now() });
    await recordAudit({
      tenantId, action: 'whatsapp.activation_cancelled', actorUid: uid, actorRole: role,
      targetType: 'meta', targetId: requestId, summary: 'Solicitud de activación de WhatsApp cancelada', metadata: { reason },
    });
    logger.info('Solicitud de activación WhatsApp cancelada', { tenantId, requestId });
    return { ok: true, requestId, status: 'cancelled' };
  },
);
