/**
 * functions/meta/catalogVerificationCallables.ts — Reconciliación periódica (ADR-0015 §6)
 * =======================================================================================
 * DOS callables sobre el estado ACTUAL del catálogo (nunca sobre el histórico del outbox):
 *
 *   · metaCatalogVerificationRun    (OWNER)    — corre/reanuda el barrido PAGINADO del
 *     catálogo remoto (SOLO GET) y actualiza `metaSyncState`/`metaVerifiedAt`/`metaDrift` de
 *     todos los productos mapeados — importados Y VINCULADOS MANUALMENTE. Sin `runId`
 *     reanuda la corrida activa del tenant; si no hay ninguna, arranca una nueva. El panel
 *     re-invoca hasta `status: 'completed'`.
 *   · metaCatalogVerificationStatus (manager+) — vista SANEADA de una corrida.
 *
 * NO escribe en Meta, no borra productos ni locks, no toca `metaSyncStatus` ni
 * `metaLastSyncAt` (el eje histórico es evidencia inmutable) y no emite alertas por producto:
 * la deriva ES el estado, y avisar por cada producto en cada corrida diaria duplicaría el
 * mismo aviso todos los días.
 *
 * Contrato de invocación:
 *   { tenantId?, runId?: string, maxPages?: 1..20 }
 * Respuesta: { ok, runId, status, phase, more, pagesDone, counters, missingDetectionSkipped,
 *   ttlMs, stopReason?, lastError? }, o bien { ok, alreadyRunning: true, more: true, run }
 * cuando otra invocación tiene la corrida tomada (claim con lease).
 *
 * La MISMA costura (`runCatalogVerificationForTenant`) la usa el scheduler diario de
 * reconciliación (`functions/scheduled/metaCatalogVerification.ts`, ADR-0015 §6).
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { MetaCatalogVerificationRunSummary } from '@vpw/shared';
import { resolveOwnerAuth, resolvePanelAuth } from '../../panel/auth.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import {
  CatalogVerificationAlreadyRunningError,
  CatalogVerificationUnavailableError,
  emptyVerificationCounters,
  runCatalogVerificationForTenant,
  type MetaCatalogVerificationRunDoc,
} from '../../meta/catalogVerification.js';

const REGION = 'us-central1';
const DEFAULT_MAX_PAGES = 10;
const MAX_MAX_PAGES = 20;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function authorizeOwner(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolveOwnerAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

/** Leer el estado es manager+ (espejo de metaCatalogMaintenanceStatus); CORRER es owner-only. */
function authorizeManager(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

/** Vista SANEADA de la corrida (el doc está cerrado al cliente por rules). */
function runSummary(run: MetaCatalogVerificationRunDoc): MetaCatalogVerificationRunSummary {
  return {
    runId: run.runId,
    status: run.status,
    phase: run.phase ?? 'remote',
    pagesDone: run.pagesDone ?? 0,
    counters: { ...emptyVerificationCounters(), ...(run.counters ?? {}) },
    hasCursor: !!(run.cursor || run.localCursor),
    missingDetectionSkipped: run.missingDetectionSkipped === true,
    startedAtMs: run.startedAt?.toMillis?.() ?? null,
    updatedAtMs: run.updatedAt?.toMillis?.() ?? null,
    finishedAtMs: run.finishedAt?.toMillis?.() ?? null,
    lastError: run.lastError || null,
  };
}

export const metaCatalogVerificationRun = onCall<{ tenantId?: string; runId?: string; maxPages?: number }>(
  { region: REGION, timeoutSeconds: 300 },
  async (req) => {
    const tenantId = authorizeOwner(req, req.data?.tenantId);
    const actorUid = req.auth?.uid ?? null;

    const rawMax = req.data?.maxPages;
    let maxPages = DEFAULT_MAX_PAGES;
    if (rawMax !== undefined) {
      if (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax < 1 || rawMax > MAX_MAX_PAGES) {
        throw new HttpsError('invalid-argument', `maxPages debe ser un entero entre 1 y ${MAX_MAX_PAGES}.`);
      }
      maxPages = rawMax;
    }
    const runId = String(req.data?.runId ?? '').trim();
    if (runId && !RUN_ID_RE.test(runId)) throw new HttpsError('invalid-argument', 'runId inválido.');

    // (ADR-0022 §4, hallazgo OW-20m/20o) Acá NO hay gate de relación A PROPÓSITO: el gate por
    // relación vive DENTRO de `catalogVerificationEligibility` (skip `relationship_none`), que
    // corta con el mismo failed-precondition PERO después de cerrar el aviso «no podemos
    // verificar tu catálogo». Un gate en el callable, delante de la corrida, dejaba ese aviso
    // HUÉRFANO para siempre al retirar la declaración externa o al borrar `catalogSync` entero
    // — la misma familia de bug que el sweep del outbox: la relación bloquea ACCIONES hacia
    // Meta, jamás la limpieza local. `mirror`/`managed` corren igual que siempre.

    let res;
    try {
      res = await runCatalogVerificationForTenant({
        tenantId,
        actorUid,
        trigger: 'callable',
        ...(runId ? { runId } : {}),
        maxPages,
      });
    } catch (e) {
      if (e instanceof CatalogVerificationAlreadyRunningError) {
        // Otra invocación (panel impaciente, scheduler) tiene la corrida tomada. No es un
        // error: se devuelve el estado real para que el panel siga mostrando el progreso en
        // vez de arrancar una segunda corrida en paralelo.
        return { ok: true, alreadyRunning: true, more: true, run: runSummary(e.run) };
      }
      if (e instanceof CatalogVerificationUnavailableError) throw new HttpsError('failed-precondition', e.message);
      // El progreso por página YA está persistido: reintentar reanuda la misma corrida.
      logger.error('Verificación de catálogo: invocación interrumpida', e, { tenantId });
      throw new HttpsError('internal', 'La verificación se interrumpió. El progreso quedó guardado: volvé a ejecutarla para continuar.');
    }

    await recordAudit({
      tenantId,
      action: 'meta.catalog_verification_run',
      actorUid,
      actorRole: (req.auth?.token as { role?: string } | undefined)?.role ?? null,
      targetType: 'catalog',
      targetId: res.runId,
      summary:
        res.status === 'completed'
          ? `Verificación de catálogo completada: ${res.counters.verified} verificados, ${res.counters.drifted} con deriva propia, ${res.counters.driftedExternal} con deriva externa, ${res.counters.remoteMissing} sin artículo remoto`
          : `Verificación de catálogo en curso (${res.phase}): ${res.pagesDone} páginas`,
      metadata: { runId: res.runId, status: res.status, phase: res.phase, counters: res.counters },
    }).catch(() => {});
    logger.info('Verificación de catálogo: invocación terminada', {
      tenantId,
      runId: res.runId,
      status: res.status,
      phase: res.phase,
      pagesDone: res.pagesDone,
      drifted: res.counters.drifted,
      driftedExternal: res.counters.driftedExternal,
    });

    return {
      ok: true,
      runId: res.runId,
      status: res.status,
      phase: res.phase,
      /** true ⇒ quedan páginas: re-invocar (con o sin runId) para continuar. */
      more: res.status !== 'completed',
      hasCursor: res.hasCursor,
      pagesDone: res.pagesDone,
      counters: res.counters,
      /** true ⇒ la detección de artículos borrados se salteó por evidencia incompleta. */
      missingDetectionSkipped: res.missingDetectionSkipped,
      /** TTL con el que el panel deriva `stale` (nunca se persiste ese estado). */
      ttlMs: res.ttlMs,
      ...(res.stopReason ? { stopReason: res.stopReason } : {}),
      ...(res.lastError ? { lastError: res.lastError } : {}),
    };
  },
);

/** Estado read-only de una corrida (manager+). */
export const metaCatalogVerificationStatus = onCall<{ tenantId?: string; runId?: string }>({ region: REGION }, async (req) => {
  const tenantId = authorizeManager(req, req.data?.tenantId);
  const runId = String(req.data?.runId ?? '').trim();
  if (runId) {
    if (!RUN_ID_RE.test(runId)) throw new HttpsError('invalid-argument', 'runId inválido.');
    const run = (await db().doc(paths.metaCatalogVerificationRun(tenantId, runId)).get()).data() as
      | MetaCatalogVerificationRunDoc
      | undefined;
    return { ok: true, run: run ? runSummary(run) : null };
  }
  // Sin runId: la corrida ACTIVA del tenant (hay como mucho una), para que el panel pueda
  // continuar un barrido interrumpido sin recordar ids.
  const activo = await db().collection(paths.metaCatalogVerificationRuns(tenantId)).where('status', '==', 'running').limit(1).get();
  const run = activo.docs[0]?.data() as MetaCatalogVerificationRunDoc | undefined;
  return { ok: true, run: run ? runSummary(run) : null };
});
