/**
 * onboardingCallables — Callable: marcar el onboarding como completado (Fase registro, R-1)
 * =========================================================================================
 * completeOnboarding(): el TENANT_OWNER (o PLATFORM_ADMIN) marca tenant.onboarding.completed=true.
 * Solo Admin SDK escribe ese flag (el cliente no puede tocarlo por write directo — ver R-2 rules).
 * NO toca campos sensibles del tenant (plan/limits/usage/subscription/status/isDemo).
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { resolveOwnerAdminAuth } from '../../lib/ownerAdminAuth.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';

function authorize(req: CallableRequest<unknown>, requestedTenantId?: string): { tenantId: string; uid: string; role: string } {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const token = req.auth.token as { role?: string; tenantId?: string };
  const r = resolveOwnerAdminAuth(token, requestedTenantId, { deniedMessage: 'Solo el dueño de la empresa o un administrador pueden completar el onboarding.' });
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return { tenantId: r.tenantId, uid: req.auth.uid, role: token.role ?? '' };
}

export const completeOnboarding = onCall<{ tenantId?: string }>({ region: 'us-central1' }, async (req) => {
  const { tenantId, uid, role } = authorize(req, req.data?.tenantId);
  const ref = db().doc(paths.tenant(tenantId));
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'La empresa no existe.');

  const now = Timestamp.now();
  // Solo el flag de onboarding (no toca plan/limits/subscription/status/isDemo).
  await ref.set({ onboarding: { completed: true, completedAt: now }, updatedAt: now }, { merge: true });
  await recordAudit({ tenantId, action: 'onboarding.completed', actorUid: uid, actorRole: role, targetType: 'tenant', targetId: tenantId, summary: 'Onboarding completado' });
  logger.info('Onboarding completado', { tenantId, uid });
  return { ok: true, tenantId };
});
