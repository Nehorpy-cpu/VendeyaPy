/**
 * COVERAGE-1D — Endpoint DEV para correr el mantenimiento de cobertura bajo demanda
 * (verify-coverage-resume.mjs). Mismo core que el scheduler diario. 404 en producción
 * (guardDevEndpoint), como el resto de los dev*.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { guardDevEndpoint } from '../../middleware/devGuard.js';
import { runCoverageMaintenance } from '../scheduled/coverageMaintenance.js';
import { logger } from '../../lib/logger.js';

export const devRunCoverageMaintenance = onRequest({ region: 'us-central1' }, async (req, res) => {
  if (!guardDevEndpoint(req, res)) return;
  try {
    await runCoverageMaintenance();
    res.status(200).json({ ok: true });
  } catch (e) {
    logger.error('devRunCoverageMaintenance falló', e);
    res.status(500).json({ ok: false });
  }
});
