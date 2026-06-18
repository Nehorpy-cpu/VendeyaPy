/**
 * functions/scheduled/resetUsage.ts — Reinicio mensual proactivo del uso (Fase 5A)
 * ================================================================================
 * Complementa el lazy-reset: el día 1 de cada mes reinicia los contadores de uso de cada
 * tenant cuyo período cambió. El gate/metering ya hacen lazy-reset, así que esto es una red
 * de seguridad para tenants inactivos.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, paths } from '../../lib/firebase.js';
import { maybeResetUsage } from '../../entitlements/usageReset.js';
import { logger } from '../../lib/logger.js';

export const resetUsageMonthly = onSchedule(
  { schedule: '0 3 1 * *', timeZone: 'America/Asuncion', region: 'us-central1' },
  async () => {
    const tenants = await db().collection(paths.tenants()).get();
    let reset = 0;
    for (const d of tenants.docs) {
      if (await maybeResetUsage(d.id)) reset++;
    }
    logger.info('Reset mensual de uso ejecutado', { tenants: tenants.size, reset });
  },
);
