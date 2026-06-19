/**
 * functions/billing/manualActivationCallables.ts — Billing manual por WhatsApp (MB-2)
 * ===================================================================================
 * requestManualPlanActivation (owner/admin): crea una solicitud 'pending' + devuelve el texto
 *   prellenado de WhatsApp. NO cambia el plan. 1 pending por tenant.
 * manualBillingActivate (SOLO PLATFORM_ADMIN, check literal): aprueba la solicitud (runTransaction
 *   pending→approved, idempotente) y activa el plan vía applySubscriptionUpdate(..., allowOverrideManual:true).
 *   Verifica que el tenant exista (no crea docs fantasma). Soporta requestId o planId directo.
 * manualBillingCancelRequest: PLATFORM_ADMIN cancela cualquiera; TENANT_OWNER solo su propia 'pending'.
 * La escritura de las solicitudes es SOLO por estos callables (Admin SDK; rules write:false).
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { Tenant } from '@vpw/shared';
import { MANUAL_PAYMENT_METHOD } from '@vpw/shared';
import { resolveOwnerAdminAuth } from '../../lib/ownerAdminAuth.js';
import { db, paths } from '../../lib/firebase.js';
import { getPlan } from '../../plans/plans.js';
import { applySubscriptionUpdate } from '../../billing/applySubscription.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';

const COLL = (t: string): string => `tenants/${t}/manualActivationRequests`;
const DOC = (t: string, id: string): string => `tenants/${t}/manualActivationRequests/${id}`;

/** Gate owner/admin (resolveOwnerAdminAuth): owner solo su tenant; admin pasa tenantId. Devuelve rol/uid. */
function authorizeOwnerAdmin(req: CallableRequest<unknown>, requestedTenantId?: string): { tenantId: string; role: string; uid: string } {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const token = req.auth.token as { role?: string; tenantId?: string };
  const r = resolveOwnerAdminAuth(token, requestedTenantId, { deniedMessage: 'Solo el dueño de la empresa o un administrador pueden gestionar el billing.' });
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return { tenantId: r.tenantId, role: token.role ?? '', uid: req.auth.uid };
}

// ===== 1) requestManualPlanActivation (owner/admin) — crea la solicitud, NO activa =====
export const requestManualPlanActivation = onCall<{ tenantId?: string; planId?: string; method?: string; note?: string }>(
  { region: 'us-central1' },
  async (req) => {
    const { tenantId, role, uid } = authorizeOwnerAdmin(req, req.data?.tenantId);
    const planId = req.data?.planId;
    if (!planId || typeof planId !== 'string') throw new HttpsError('invalid-argument', 'Falta planId.');
    if (planId === 'free') throw new HttpsError('invalid-argument', 'No se solicita activación del plan gratuito.');
    const plan = await getPlan(planId);
    if (!plan) throw new HttpsError('failed-precondition', 'Ese plan no existe.');
    const method = req.data?.method;
    if (!method || !(MANUAL_PAYMENT_METHOD as readonly string[]).includes(method)) {
      throw new HttpsError('invalid-argument', `Método de pago inválido. Válidos: ${MANUAL_PAYMENT_METHOD.join(', ')}.`);
    }

    // Una sola solicitud 'pending' por tenant (evita spam y ambigüedad al aprobar).
    const pending = await db().collection(COLL(tenantId)).where('status', '==', 'pending').limit(1).get();
    if (!pending.empty) throw new HttpsError('failed-precondition', 'Ya hay una solicitud de activación pendiente para esta empresa.');

    const tenant = (await db().doc(paths.tenant(tenantId)).get()).data() as Partial<Tenant> | undefined;
    const businessName = tenant?.name ?? tenantId;
    const now = Timestamp.now();
    const ref = db().collection(COLL(tenantId)).doc();
    await ref.set({
      id: ref.id, tenantId, planId, status: 'pending', method,
      requestedByUid: uid, requestedByRole: role, requestedAt: now,
      note: typeof req.data?.note === 'string' ? req.data.note.slice(0, 1000) : null,
      paymentReference: null, reviewedByUid: null, reviewedAt: null, cancelReason: null,
    });
    await recordAudit({ tenantId, action: 'billing.activation_requested', actorUid: uid, actorRole: role, targetType: 'subscription', targetId: ref.id, summary: `Solicitud de activación manual del plan ${planId}`, metadata: { planId, method } });
    logger.info('Solicitud de activación manual creada', { tenantId, requestId: ref.id, planId });

    // Texto prellenado de WhatsApp (el frontend arma el wa.me con NEXT_PUBLIC_SUPPORT_WHATSAPP → solo dígitos).
    const whatsappText = `Hola, quiero activar el plan ${plan.name} (USD ${plan.priceUsdPerMonth}/mes) para ${businessName} (empresa ${tenantId}). Método de pago: ${method}. Ref de solicitud: ${ref.id}.`;
    return {
      ok: true, requestId: ref.id, planId, status: 'pending',
      whatsappText,
      whatsappData: { tenantId, businessName, planId, planName: plan.name, priceUsdPerMonth: plan.priceUsdPerMonth, method, requestId: ref.id },
    };
  },
);

// ===== 2) manualBillingActivate (SOLO PLATFORM_ADMIN, check literal) — activa el plan =====
export const manualBillingActivate = onCall<{ tenantId?: string; requestId?: string; planId?: string; paymentReference?: string; periodEndMs?: number }>(
  { region: 'us-central1' },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
    const role = (req.auth.token as { role?: string }).role;
    if (role !== 'PLATFORM_ADMIN') throw new HttpsError('permission-denied', 'Solo el administrador de la plataforma puede activar un plan.');
    const adminUid = req.auth.uid;
    const tenantId = req.data?.tenantId;
    if (!tenantId || typeof tenantId !== 'string') throw new HttpsError('invalid-argument', 'Falta tenantId.');

    // El tenant DEBE existir (no crear doc fantasma).
    if (!(await db().doc(paths.tenant(tenantId)).get()).exists) throw new HttpsError('failed-precondition', 'La empresa no existe.');

    const paymentReference = typeof req.data?.paymentReference === 'string' ? req.data.paymentReference.slice(0, 200) : null;
    const periodEndMs = typeof req.data?.periodEndMs === 'number' && req.data.periodEndMs > 0 ? req.data.periodEndMs : null;
    const requestId = req.data?.requestId;
    let planId: string | null = typeof req.data?.planId === 'string' ? req.data.planId : null;

    // Vía solicitud: transición ATÓMICA pending→approved (idempotencia: re-activar la misma falla, no re-aplica).
    if (requestId) {
      const reqRef = db().doc(DOC(tenantId, requestId));
      planId = await db().runTransaction(async (tx) => {
        const snap = await tx.get(reqRef);
        if (!snap.exists) throw new HttpsError('not-found', 'Solicitud no encontrada.');
        const r = snap.data() as { status?: string; planId?: string };
        if (r.status !== 'pending') throw new HttpsError('failed-precondition', 'La solicitud ya fue procesada.');
        tx.update(reqRef, { status: 'approved', reviewedByUid: adminUid, reviewedAt: Timestamp.now(), paymentReference });
        return r.planId ?? null;
      });
    }

    if (!planId) throw new HttpsError('invalid-argument', 'Falta planId (directo o vía requestId).');
    if (planId === 'free') throw new HttpsError('invalid-argument', 'No se activa el plan gratuito.');
    const plan = await getPlan(planId);
    if (!plan) throw new HttpsError('failed-precondition', 'Ese plan no existe.');

    const result = await applySubscriptionUpdate(tenantId, {
      tenantId, provider: 'manual_whatsapp', status: 'active', planId,
      currentPeriodEndMs: periodEndMs, externalCustomerId: null, externalSubscriptionId: null, externalPlanRef: null,
      providerMetadata: { source: 'manual_whatsapp', activatedBy: adminUid, paymentReference },
      pastDueSinceMs: null,
    }, { allowOverrideManual: true });

    await recordAudit({ tenantId, action: 'billing.activation_approved', actorUid: adminUid, actorRole: 'PLATFORM_ADMIN', targetType: 'subscription', targetId: requestId ?? tenantId, summary: `Plan ${planId} activado manualmente`, metadata: { planId, requestId: requestId ?? null, paymentReference } });
    logger.info('Plan activado manualmente', { tenantId, planId, requestId: requestId ?? null });
    return { ok: true, status: 'active', planId, applied: result.applied };
  },
);

// ===== 3) manualBillingCancelRequest (admin: cualquiera; owner: solo su propia 'pending') =====
export const manualBillingCancelRequest = onCall<{ tenantId?: string; requestId?: string; reason?: string }>(
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

    // Cancelar NO toca el plan vigente: solo marca la solicitud.
    await ref.update({ status: 'cancelled', cancelReason: reason, reviewedByUid: uid, reviewedAt: Timestamp.now() });
    await recordAudit({ tenantId, action: 'billing.activation_cancelled', actorUid: uid, actorRole: role, targetType: 'subscription', targetId: requestId, summary: 'Solicitud de activación manual cancelada', metadata: { reason } });
    logger.info('Solicitud de activación manual cancelada', { tenantId, requestId });
    return { ok: true, requestId, status: 'cancelled' };
  },
);
