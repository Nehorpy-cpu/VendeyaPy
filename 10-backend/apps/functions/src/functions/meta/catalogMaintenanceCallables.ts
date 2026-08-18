/**
 * functions/meta/catalogMaintenanceCallables.ts — Mantenimiento del catálogo (HARDEN-1)
 * =====================================================================================
 * (ADR-0014 §4c) UN callable owner-only:
 *
 *   · metaCatalogMaintenanceRun — corre/reanuda la operación de mantenimiento (backfill de
 *     `metaRetailerLocks` faltantes + `quality` de productos que no la tienen), paginada por
 *     cursor local y reanudable. `mode: 'preview'` es el DEFAULT y NO ESCRIBE NADA;
 *     `mode: 'apply'` exige `confirm: true` explícito. Conflictos de identidad (dos
 *     productos reclamando el mismo retailer_id, o un lock de otro dueño) se REPORTAN con
 *     productIds y rid — jamás se elige ganador ni se toca nada ambiguo.
 *
 * Contrato de invocación:
 *   { tenantId?, mode?: 'preview'|'apply' (default 'preview'), confirm?: boolean,
 *     runId?: string (reanudar una corrida 'running' propia), maxPages?: 1..20 }
 * Respuesta: { ok, runId, status: 'running'|'completed', more, pagesDone, counters,
 *   conflicts (tope 200 + conflictsTruncated), stopReason?, lastError? } — un catálogo
 * parcialmente evaluado JAMÁS se presenta como completo (`status: 'running'` con cursor
 * hasta terminar) y un run con errores de backfill (`erroresQuality`) jamás termina limpio.
 * La política del tenant se FIJA al run al crearlo: las reanudaciones usan la del run.
 *
 * La campana agregada de calidad se recalcula al TERMINAR un apply.
 * ⚠️ NO ejecutar contra producción durante el desarrollo (paso del release auditado).
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaCatalogMaintenanceRunSummary } from '@vpw/shared';
import { resolveOwnerAuth, resolvePanelAuth } from '../../panel/auth.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import {
  emptyMaintenanceCounters,
  firestoreMaintenanceStore,
  runMaintenancePages,
  type MetaCatalogMaintenanceRunDoc,
} from '../../meta/catalogMaintenance.js';
import { requireCatalogRelationship } from '../../meta/catalogAuthority.js';
import { refreshCatalogQualityNotification } from '../../products/qualityNotification.js';
import { loadCatalogProfile } from './catalogReconcileCallables.js';

const REGION = 'us-central1';
const DEFAULT_MAX_PAGES = 10;
const MAX_MAX_PAGES = 20;

function authorizeOwner(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolveOwnerAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

/**
 * (Fix HARDEN-1) La lectura de estado es manager+ — espejo EXACTO de metaCatalogImportStatus:
 * el manager opera el centro de calidad a diario y necesita ver el progreso del mantenimiento.
 * CORRER el mantenimiento (metaCatalogMaintenanceRun) sigue siendo owner-only.
 */
function authorizeManager(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

/** Vista SANEADA de la corrida (el doc está cerrado al cliente por rules). */
function runSummary(run: MetaCatalogMaintenanceRunDoc): MetaCatalogMaintenanceRunSummary {
  return {
    runId: run.runId,
    mode: run.mode,
    status: run.status,
    pagesDone: run.pagesDone ?? 0,
    counters: { ...emptyMaintenanceCounters(), ...(run.counters ?? {}) },
    conflicts: run.conflicts ?? [],
    conflictsTruncated: run.conflictsTruncated === true,
    hasCursor: !!run.cursor,
    startedAtMs: run.startedAt?.toMillis?.() ?? null,
    updatedAtMs: run.updatedAt?.toMillis?.() ?? null,
    finishedAtMs: run.finishedAt?.toMillis?.() ?? null,
    lastError: run.lastError || null,
  };
}

export const metaCatalogMaintenanceRun = onCall<{
  tenantId?: string;
  mode?: string;
  confirm?: boolean;
  runId?: string;
  maxPages?: number;
}>({ region: REGION, timeoutSeconds: 300 }, async (req) => {
  const tenantId = authorizeOwner(req, req.data?.tenantId);
  const actorUid = req.auth?.uid ?? null;

  // ---- Validación de input (fail-closed) ----
  const rawMode = req.data?.mode ?? 'preview';
  if (rawMode !== 'preview' && rawMode !== 'apply') {
    throw new HttpsError('invalid-argument', "mode debe ser 'preview' o 'apply'.");
  }
  const mode = rawMode;
  if (mode === 'apply' && req.data?.confirm !== true) {
    // El apply escribe locks y quality: exige la confirmación EXPLÍCITA, jamás implícita.
    throw new HttpsError('failed-precondition', 'El modo apply requiere confirm: true explícito. Corré primero un preview.');
  }
  const rawMax = req.data?.maxPages;
  let maxPages = DEFAULT_MAX_PAGES;
  if (rawMax !== undefined) {
    if (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax < 1 || rawMax > MAX_MAX_PAGES) {
      throw new HttpsError('invalid-argument', `maxPages debe ser un entero entre 1 y ${MAX_MAX_PAGES}.`);
    }
    maxPages = rawMax;
  }
  const resumeRunId = String(req.data?.runId ?? '').trim();
  if (resumeRunId && !/^[A-Za-z0-9_-]{1,64}$/.test(resumeRunId)) {
    throw new HttpsError('invalid-argument', 'runId inválido.');
  }

  // ADR-0022 §4: el mantenimiento es una acción del ciclo Meta (backfill de locks/quality del
  // espejo) — mirror/managed; `none` bloquea. La lectura de estado (Status) NO se gatea.
  await requireCatalogRelationship(tenantId, 'mirror', 'managed');

  // ---- Crear o reanudar la corrida (tenant-scoped SIEMPRE) ----
  const now = Timestamp.now();
  let run: MetaCatalogMaintenanceRunDoc;
  if (resumeRunId) {
    const snap = await db().doc(paths.metaCatalogMaintenanceRun(tenantId, resumeRunId)).get();
    const data = snap.data() as MetaCatalogMaintenanceRunDoc | undefined;
    if (!data) throw new HttpsError('not-found', 'Esa corrida de mantenimiento no existe en esta empresa.');
    if (data.status !== 'running') {
      throw new HttpsError('failed-precondition', `Esa corrida ya terminó (${data.status}): iniciá una nueva.`);
    }
    if (data.mode !== mode) {
      throw new HttpsError('failed-precondition', `Esa corrida es de modo '${data.mode}': reanudala con el mismo modo.`);
    }
    run = data;
  } else {
    const ref = db().collection(paths.metaCatalogMaintenanceRuns(tenantId)).doc();
    run = {
      runId: ref.id,
      tenantId,
      mode,
      status: 'running',
      cursor: null,
      pagesDone: 0,
      counters: emptyMaintenanceCounters(),
      conflicts: [],
      conflictsTruncated: false,
      actorUid,
      lastError: '',
      // (ADR-0014 §4b/4c) La política NORMALIZADA se fija al run en su CREACIÓN: todas las
      // páginas se evalúan con la misma política aunque la config cambie a mitad.
      profile: await loadCatalogProfile(tenantId),
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    await ref.create(run as unknown as Record<string, unknown>);
  }

  // Las reanudaciones usan la política DEL RUN (no releen la config): mezclar políticas
  // dentro de un mismo runId dejaría contadores calculados bajo dos criterios. El fallback
  // a config cubre SOLO docs previos al campo (repo no desplegado: no debería ocurrir).
  const profile = run.profile !== undefined ? run.profile : await loadCatalogProfile(tenantId);
  const store = firestoreMaintenanceStore({ tenantId, runId: run.runId });
  let res;
  try {
    res = await runMaintenancePages({
      tenantId,
      mode,
      store,
      profile,
      cursor: run.cursor ?? null,
      counters: { ...emptyMaintenanceCounters(), ...(run.counters ?? {}) },
      conflicts: run.conflicts ?? [],
      conflictsTruncated: run.conflictsTruncated === true,
      pagesDone: run.pagesDone ?? 0,
      lastError: run.lastError ?? '',
      maxPages,
    });
  } catch (e) {
    // El progreso por página YA está persistido: el reintento reanuda con runId. El
    // lastError se asienta con el MISMO guard del saveProgress (jamás sobre un run que
    // otro worker ya cerró — espejo de los guards transaccionales de ADR-0014 §4c).
    await db()
      .runTransaction(async (tx) => {
        const ref = db().doc(paths.metaCatalogMaintenanceRun(tenantId, run.runId));
        const fresh = (await tx.get(ref)).data() as MetaCatalogMaintenanceRunDoc | undefined;
        if (!fresh || fresh.status !== 'running') return;
        tx.update(ref, { lastError: e instanceof Error ? e.message.slice(0, 300) : 'error interno', updatedAt: Timestamp.now() });
      })
      .catch(() => {});
    logger.error('Mantenimiento de catálogo: invocación interrumpida', e, { tenantId, runId: run.runId });
    throw new HttpsError('internal', 'El mantenimiento se interrumpió. El progreso quedó guardado: reanudá con el mismo runId.');
  }

  // La campana agregada refleja el backfill recién al TERMINAR el apply (nunca en preview,
  // que no escribió nada; nunca a mitad de catálogo, que mentiría por incompleto).
  if (mode === 'apply' && res.status === 'completed') {
    await refreshCatalogQualityNotification(tenantId);
  }

  await recordAudit({
    tenantId,
    action: 'meta.catalog_maintenance_run',
    actorUid,
    actorRole: (req.auth?.token as { role?: string } | undefined)?.role ?? null,
    targetType: 'catalog',
    targetId: run.runId,
    summary:
      res.status === 'completed'
        ? `Mantenimiento de catálogo (${mode}) completado: ${res.counters.locksCreados} locks, ${res.counters.qualityCalculada} quality, ${res.counters.conflictos} conflictos${res.counters.erroresQuality > 0 ? `, ${res.counters.erroresQuality} errores` : ''}`
        : `Mantenimiento de catálogo (${mode}) en curso: ${res.pagesDone} páginas`,
    metadata: { runId: run.runId, mode, status: res.status, counters: res.counters, conflictos: res.counters.conflictos },
  }).catch(() => {});
  logger.info('Mantenimiento de catálogo: invocación terminada', {
    tenantId,
    runId: run.runId,
    mode,
    status: res.status,
    pagesDone: res.pagesDone,
    conflictos: res.counters.conflictos,
  });

  return {
    ok: true,
    runId: run.runId,
    mode,
    status: res.status,
    /** true ⇒ quedan páginas: re-invocar con { runId } para continuar. */
    more: res.status !== 'completed',
    hasCursor: !!res.cursor,
    pagesDone: res.pagesDone,
    counters: res.counters,
    conflicts: res.conflicts,
    conflictsTruncated: res.conflictsTruncated,
    ...(res.stopReason ? { stopReason: res.stopReason } : {}),
    /** Error saneado del backfill (con `erroresQuality`>0): el run no se presenta limpio. */
    ...(res.lastError ? { lastError: res.lastError } : {}),
  };
});

/** Estado read-only de una corrida (manager+). Para el panel del paso de release auditado. */
export const metaCatalogMaintenanceStatus = onCall<{ tenantId?: string; runId?: string }>(
  { region: REGION },
  async (req) => {
    const tenantId = authorizeManager(req, req.data?.tenantId);
    const runId = String(req.data?.runId ?? '').trim();
    if (!runId || !/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new HttpsError('invalid-argument', 'Falta runId.');
    const run = (await db().doc(paths.metaCatalogMaintenanceRun(tenantId, runId)).get()).data() as
      | MetaCatalogMaintenanceRunDoc
      | undefined;
    if (!run) return { ok: true, run: null };
    return { ok: true, run: runSummary(run) };
  },
);
