/**
 * functions/scheduled/refreshGrowthJobs.ts — Scheduler diario de jobs de growth (GROWTH-JOBS-SCHEDULER-1).
 * ========================================================================================================
 * Corre el MISMO core que los botones del panel (`runTenantJob` → `runPanelJob`) pero automáticamente, una
 * vez al día (04:00 America/Asuncion, de madrugada), para los tenants ACTIVE. Solo jobs SEGUROS rule-based
 * (sin IA / sin Meta): computeTracking, generateWinningReplies, generateFollowups, generateAudits.
 *
 * Idempotente (los core jobs ya lo son: ids deterministas). Aislamiento por tenant/job. Loguea solo metadata.
 *
 * Deploy: requiere Cloud Scheduler habilitado en el proyecto. En el EMULADOR el cron no se dispara solo; por
 * eso el test prueba el CORE directo (refreshGrowthJobsForActiveTenants), no el cron.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { refreshGrowthJobsForActiveTenants } from '../../growth/scheduler.js';

export const refreshGrowthJobsDaily = onSchedule(
  { schedule: '0 4 * * *', timeZone: 'America/Asuncion', region: 'us-central1' },
  async () => {
    const summary = await refreshGrowthJobsForActiveTenants(db());
    logger.info('Growth jobs refresh (scheduled diario)', { ...summary });
  },
);
