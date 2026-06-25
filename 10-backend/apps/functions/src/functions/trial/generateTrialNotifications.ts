/**
 * generateTrialNotifications — Callable (PLATFORM_ADMIN): genera notificaciones INTERNAS del free trial.
 * ====================================================================================================
 * TRIAL-NOTIFICATIONS-1. Recorre tenants (o uno si se pasa `tenantId`), decide con
 * `computeTrialNotificationState` y crea (idempotente) `tenants/{t}/notifications/trial_<tipo>`.
 * NO envía WhatsApp/email/push real — solo escribe la notificación interna + audita. Pensado para que
 * un scheduler lo dispare a futuro. NO pasa por gates de uso → funciona aunque el trial esté vencido.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { computeTrialNotificationState, buildTrialNotificationContent } from '../../trial/trialNotifications.js';

function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: number | string } | null)?.code;
  return code === 6 || code === 'already-exists' || /already.?exists/i.test(String(e));
}

/** Procesa UN tenant: crea la notificación que corresponda (si corresponde), idempotente + auditada. */
async function processTenant(tenantId: string, data: unknown, nowMs: number, actorUid: string | null): Promise<{ created: boolean; type?: string }> {
  const decision = computeTrialNotificationState(data as Parameters<typeof computeTrialNotificationState>[0], nowMs);
  if (!decision) return { created: false };
  const id = decision.type; // determinístico (= 'trial_ending_soon'|'trial_ending_today'|'trial_expired') → 1 por (tenant, tipo)
  const { title, body } = buildTrialNotificationContent(decision);
  const ref = db().doc(paths.notification(tenantId, id));
  try {
    await ref.create({
      id, tenantId, category: 'trial', type: decision.type, title, body,
      dedupeKey: id, read: false, readAt: null, createdAt: Timestamp.now(),
    });
  } catch (e) {
    if (isAlreadyExists(e)) return { created: false, type: decision.type }; // ya existía → idempotente
    throw e;
  }
  // Auditoría SIN PII: solo tipo + días. No guarda mensajes externos ni datos del cliente.
  await recordAudit({ tenantId, action: 'trial.notification_created', actorUid, targetType: 'notification', targetId: id, summary: `Notificación de trial: ${decision.type}`, metadata: { type: decision.type, daysLeft: decision.daysLeft } });
  return { created: true, type: decision.type };
}

export const generateTrialNotifications = onCall<{ tenantId?: string }>({ region: 'us-central1' }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión.');
  if ((req.auth.token as { role?: string }).role !== 'PLATFORM_ADMIN') {
    throw new HttpsError('permission-denied', 'Solo el administrador de la plataforma puede generar notificaciones de trial.');
  }
  const nowMs = Date.now();
  const actorUid = req.auth.uid;
  const summary = { scanned: 0, created: 0, skipped: 0, byType: { trial_ending_soon: 0, trial_ending_today: 0, trial_expired: 0 } as Record<string, number> };

  const targetId = req.data?.tenantId;
  const docs = targetId
    ? [await db().doc(paths.tenant(targetId)).get()].filter((s) => s.exists)
    : (await db().collection('tenants').get()).docs;

  for (const d of docs) {
    summary.scanned++;
    const r = await processTenant(d.id, d.data(), nowMs, actorUid);
    if (r.created && r.type) { summary.created++; summary.byType[r.type] = (summary.byType[r.type] ?? 0) + 1; }
    else summary.skipped++;
  }
  return summary;
});
