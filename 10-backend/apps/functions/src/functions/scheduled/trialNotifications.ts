/**
 * functions/scheduled/trialNotifications.ts — Scheduler diario de notificaciones del trial (TN-3).
 * ================================================================================================
 * Corre el MISMO core que el callable admin (`runTrialNotificationsJob`) todos los días a las 09:00
 * (America/Asuncion). Crea SOLO notificaciones internas (no envía WhatsApp/email/push). Idempotente: re-correr
 * no duplica (ids determinísticos). Loguea el resumen (scanned/created/skipped/errors/byType).
 *
 * Deploy: requiere Cloud Scheduler habilitado en el proyecto de Firebase/Google Cloud. En el EMULADOR no se
 * dispara (necesita el pubsub/scheduler emulator); por eso el e2e prueba el core directo, no el cron.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { runTrialNotificationsJob } from '../../trial/runTrialNotificationsJob.js';

export const trialNotificationsDaily = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'America/Asuncion', region: 'us-central1' },
  async () => {
    const summary = await runTrialNotificationsJob(db(), { nowMs: Date.now() });
    logger.info('Notificaciones de trial (scheduled diario)', { ...summary });
  },
);
