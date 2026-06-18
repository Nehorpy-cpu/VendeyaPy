/**
 * panelActions — Callables autenticados del panel (Hardening F2)
 * =============================================================
 * Reemplazan el uso futuro de los endpoints dev* desde el frontend, con
 * autorización por rol + tenant (panel/auth.ts). Los dev* quedan solo para
 * emulador / staging controlado (devGuard). El frontend se cablea más adelante.
 *
 *   runTenantJob({ action, tenantId? })      → corre una acción de mantenimiento.
 *   simulateAgentMessage({ from, text })     → simula un mensaje al bot (simulador).
 *
 * Autorización: PLATFORM_ADMIN (cualquier empresa, pasando tenantId) o
 * TENANT_OWNER/TENANT_MANAGER (solo su empresa). Vendedor/lector: denegado.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { resolvePanelAuth } from '../../panel/auth.js';
import { isPanelJobAction, runPanelJob, PANEL_JOB_ACTIONS, JOB_REQUIREMENTS } from '../../panel/jobs.js';
import { assertFeatureEnabled, assertWithinLimit, meterUsage } from '../../entitlements/entitlements.js';
import { handleMessage } from '../../conversation/engine.js';
import { logger } from '../../lib/logger.js';

/** Valida auth + rol/tenant y devuelve la empresa objetivo (o lanza HttpsError). */
function authorizeTenant(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const result = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!result.ok) throw new HttpsError(result.code, result.message);
  return result.tenantId;
}

export const runTenantJob = onCall<{ action?: string; tenantId?: string }>(
  { region: 'us-central1' },
  async (req) => {
    const action = req.data?.action;
    if (!action || !isPanelJobAction(action)) {
      throw new HttpsError('invalid-argument', `Acción inválida. Válidas: ${PANEL_JOB_ACTIONS.join(', ')}.`);
    }
    const tenantId = authorizeTenant(req, req.data?.tenantId);
    // Entitlements (Fase 5A): feature premium + cuota antes de correr; metering después.
    const jobReq = JOB_REQUIREMENTS[action];
    if (jobReq.feature) await assertFeatureEnabled(tenantId, jobReq.feature, { actorUid: req.auth?.uid });
    if (jobReq.quota === 'adSyncs') await assertWithinLimit(tenantId, 'adSyncs', { actorUid: req.auth?.uid });
    try {
      const result = await runPanelJob(action, tenantId);
      await meterUsage(tenantId, jobReq.meter).catch(() => { /* metering no crítico */ });
      logger.info('Panel job ejecutado', { tenantId, action });
      return { ok: true, action, tenantId, result };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error('Error en runTenantJob', e, { tenantId, action });
      throw new HttpsError('internal', 'No se pudo ejecutar la acción.');
    }
  },
);

export const simulateAgentMessage = onCall<{ from?: string; text?: string; tenantId?: string }>(
  { region: 'us-central1' },
  async (req) => {
    const { from, text } = req.data ?? {};
    if (!from || !text) throw new HttpsError('invalid-argument', 'Faltan from y text.');
    const tenantId = authorizeTenant(req, req.data?.tenantId);
    try {
      const result = await handleMessage({ tenantId, from: String(from), text: String(text), channel: 'whatsapp' });
      return { ok: true, ...result };
    } catch (e) {
      logger.error('Error en simulateAgentMessage', e, { tenantId });
      throw new HttpsError('internal', 'No se pudo simular el mensaje.');
    }
  },
);
