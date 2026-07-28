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
import { ANTHROPIC_API_KEY } from '../../ai/aiSecret.js';
import { logger } from '../../lib/logger.js';

/** Valida auth + rol/tenant y devuelve la empresa objetivo (o lanza HttpsError). */
function authorizeTenant(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const result = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!result.ok) throw new HttpsError(result.code, result.message);
  return result.tenantId;
}

// timeoutSeconds: la sync de catálogo (META-CATALOG-LIVE-1) lee Meta paginado con
// retries + Retry-After y verifica releyendo: el default de 60s puede cortarla a mitad.
/**
 * META-CATALOG-PREVIEW-BINDING-1: un apply bloqueado por su evidencia de preview responde
 * `failed-precondition` (contrato del programa), con un mensaje accionable y sin exponer
 * detalle interno. `mode_not_live` NO entra acá: sigue siendo un resultado normal del panel.
 */
const PREVIEW_BLOCK_MESSAGES: Record<string, string> = {
  preview_required: 'Para enviar cambios primero previsualizá: el envío va atado a esa previsualización.',
  preview_not_found: 'La previsualización referida no existe para esta empresa. Previsualizá de nuevo.',
  preview_not_usable: 'La previsualización referida no es utilizable. Previsualizá de nuevo.',
  preview_mismatch: 'Los datos cambiaron desde la previsualización: el plan ya no es el aprobado. Previsualizá de nuevo.',
  preview_wrong_catalog: 'La configuración del catálogo cambió desde la previsualización. Previsualizá de nuevo.',
  preview_actor_mismatch: 'El envío debe hacerlo la misma persona que previsualizó. Previsualizá de nuevo.',
  preview_expired: 'La previsualización venció. Previsualizá de nuevo y confirmá dentro de los 10 minutos.',
  preview_consumed: 'Esa previsualización ya se usó. Previsualizá de nuevo para un nuevo envío.',
};

export const runTenantJob = onCall<{ action?: string; tenantId?: string; args?: { previewRunId?: string; planHash?: string } }>(
  { region: 'us-central1', timeoutSeconds: 300 },
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
      // El actor va a la auditoría del job (quién disparó la acción, con qué rol).
      const actorRole = (req.auth?.token as { role?: string } | undefined)?.role ?? null;
      const args = req.data?.args && typeof req.data.args === 'object' ? (req.data.args as Record<string, unknown>) : undefined;
      const result = await runPanelJob(action, tenantId, { uid: req.auth?.uid ?? null, role: actorRole }, args);
      const previewBlock =
        action === 'catalogSyncApply' &&
        result &&
        typeof result === 'object' &&
        (result as { status?: string }).status === 'apply_blocked' &&
        typeof (result as { reason?: string }).reason === 'string' &&
        (result as { reason: string }).reason.startsWith('preview')
          ? (result as { reason: string }).reason
          : null;
      if (previewBlock) {
        // El run doc ya registró el bloqueo (auditable); al cliente le llega el contrato.
        throw new HttpsError('failed-precondition', PREVIEW_BLOCK_MESSAGES[previewBlock] ?? PREVIEW_BLOCK_MESSAGES['preview_required']!, { reason: previewBlock });
      }
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

// simulateAgentMessage corre el MOTOR REAL (handleMessage → sales agent IA): bindea el secret.
export const simulateAgentMessage = onCall<{ from?: string; text?: string; tenantId?: string }>(
  { region: 'us-central1', secrets: [ANTHROPIC_API_KEY] },
  async (req) => {
    const { from, text } = req.data ?? {};
    if (!from || !text) throw new HttpsError('invalid-argument', 'Faltan from y text.');
    const tenantId = authorizeTenant(req, req.data?.tenantId);
    try {
      const result = await handleMessage({ tenantId, from: String(from), text: String(text), channel: 'whatsapp', simulation: true });
      return { ok: true, ...result };
    } catch (e) {
      logger.error('Error en simulateAgentMessage', e, { tenantId });
      throw new HttpsError('internal', 'No se pudo simular el mensaje.');
    }
  },
);
