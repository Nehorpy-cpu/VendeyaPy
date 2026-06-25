/**
 * generateTrialNotifications — Callable (PLATFORM_ADMIN): genera notificaciones INTERNAS del free trial.
 * ====================================================================================================
 * TRIAL-NOTIFICATIONS-1/3. Wrapper fino del core `runTrialNotificationsJob` (compartido con la scheduled
 * function `trialNotificationsDaily`). Recorre tenants (o uno si se pasa `tenantId`) y crea (idempotente)
 * `tenants/{t}/notifications/<tipo>`. `dryRun` no escribe. NO envía WhatsApp/email/push real (solo escribe
 * la notificación interna + audita). NO pasa por gates de uso → funciona aunque el trial esté vencido.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../lib/firebase.js';
import { runTrialNotificationsJob } from '../../trial/runTrialNotificationsJob.js';

export const generateTrialNotifications = onCall<{ tenantId?: string; dryRun?: boolean }>({ region: 'us-central1' }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión.');
  if ((req.auth.token as { role?: string }).role !== 'PLATFORM_ADMIN') {
    throw new HttpsError('permission-denied', 'Solo el administrador de la plataforma puede generar notificaciones de trial.');
  }
  return runTrialNotificationsJob(db(), {
    nowMs: Date.now(),
    dryRun: req.data?.dryRun === true,
    actorUid: req.auth.uid,
    ...(req.data?.tenantId ? { tenantId: req.data.tenantId } : {}),
  });
});
