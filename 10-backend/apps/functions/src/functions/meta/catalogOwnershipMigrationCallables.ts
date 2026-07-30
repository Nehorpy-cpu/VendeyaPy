/**
 * functions/meta/catalogOwnershipMigrationCallables.ts — Migración de propiedad (ADR-0015 §9)
 * ============================================================================================
 * UN callable owner-only, espejo EXACTO de `metaCatalogMaintenanceRun`:
 *
 *   · metaCatalogOwnershipMigrationRun — corre/reanuda la migración al contrato de PROPIEDAD
 *     POR CAMPOS. `mode: 'preview'` es el DEFAULT y NO ESCRIBE NADA: muestra tenant, modelo
 *     propuesto, campos propios/externos, feeds detectados (metadata saneada), productos
 *     afectados, estados que cambiarían y bloqueos. `mode: 'apply'` exige `confirm: true` y
 *     CERO bloqueos, y escribe solo `catalogSync.ownership` + el `metaSyncState` de los
 *     productos con identidad remota que aún no lo tienen.
 *
 * Contrato de invocación:
 *   { tenantId?, mode?: 'preview'|'apply' (default 'preview'), confirm?: boolean,
 *     runId?: string (reanudar una corrida 'running' propia), maxPages?: 1..20,
 *     model?: 'vendeyapy_managed'|'external_managed'|'hybrid', ownedFields?: string[] }
 *
 * `model`/`ownedFields` son la DECLARACIÓN EXPLÍCITA del owner. Sin ellos, la migración solo
 * deriva `external_managed` cuando el detector encontró una fuente que publica: proponer
 * "mandamos nosotros" por descarte sería regalarse permiso de escritura sin evidencia, que es
 * exactamente el bug que este programa cierra.
 *
 * ⚠️ NO ejecutar contra producción durante el desarrollo (paso del release auditado).
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaCatalogOwnershipMigrationRunSummary } from '@vpw/shared';
import { resolveOwnerAuth } from '../../panel/auth.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { normalizeCatalogSyncConfig } from '../../meta/catalogSyncConfig.js';
import { normalizeCatalogOwnership } from '../../meta/catalogOwnership.js';
import { enqueueCatalogVerificationRun } from '../../meta/catalogVerification.js';
import {
  detectExternalSources,
  emptyOwnershipMigrationCounters,
  firestoreOwnershipMigrationStore,
  OwnershipMigrationPreconditionError,
  planOwnershipMigration,
  runOwnershipMigrationPages,
  type MetaCatalogOwnershipMigrationRunDoc,
} from '../../meta/catalogOwnershipMigration.js';

const REGION = 'us-central1';
const DEFAULT_MAX_PAGES = 10;
const MAX_MAX_PAGES = 20;

function authorizeOwner(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolveOwnerAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

/** Vista SANEADA de la corrida (el doc está cerrado al cliente por rules). */
function runSummary(run: MetaCatalogOwnershipMigrationRunDoc): MetaCatalogOwnershipMigrationRunSummary {
  return {
    runId: run.runId,
    mode: run.mode,
    status: run.status,
    pagesDone: run.pagesDone ?? 0,
    counters: { ...emptyOwnershipMigrationCounters(), ...(run.counters ?? {}) },
    porEstado: run.porEstado ?? {},
    plan: run.plan,
    ownershipWritten: run.ownershipWritten === true,
    hasCursor: !!run.cursor,
    startedAtMs: run.startedAt?.toMillis?.() ?? null,
    updatedAtMs: run.updatedAt?.toMillis?.() ?? null,
    finishedAtMs: run.finishedAt?.toMillis?.() ?? null,
    lastError: run.lastError || null,
  };
}

export const metaCatalogOwnershipMigrationRun = onCall<{
  tenantId?: string;
  mode?: string;
  confirm?: boolean;
  runId?: string;
  maxPages?: number;
  model?: string;
  ownedFields?: string[];
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
  if (req.data?.ownedFields !== undefined && !Array.isArray(req.data.ownedFields)) {
    throw new HttpsError('invalid-argument', 'ownedFields debe ser una lista de campos públicos.');
  }

  // ---- Crear o reanudar la corrida (tenant-scoped SIEMPRE) ----
  const now = Timestamp.now();
  let run: MetaCatalogOwnershipMigrationRunDoc;
  if (resumeRunId) {
    const snap = await db().doc(paths.metaCatalogOwnershipRun(tenantId, resumeRunId)).get();
    const data = snap.data() as MetaCatalogOwnershipMigrationRunDoc | undefined;
    if (!data) throw new HttpsError('not-found', 'Esa corrida de migración no existe en esta empresa.');
    if (data.status !== 'running') {
      throw new HttpsError('failed-precondition', `Esa corrida ya terminó (${data.status}): iniciá una nueva.`);
    }
    if (data.mode !== mode) {
      throw new HttpsError('failed-precondition', `Esa corrida es de modo '${data.mode}': reanudala con el mismo modo.`);
    }
    run = data;
  } else {
    // El PLAN se deriva UNA vez y se FIJA al run (igual que la política del mantenimiento): las
    // reanudaciones no vuelven a detectar ni a re-proponer. Mezclar dos propuestas dentro de un
    // mismo runId dejaría contadores calculados bajo dos permisos distintos.
    const cfgSnap = await db().doc(`tenants/${tenantId}/config/meta`).get();
    const config = normalizeCatalogSyncConfig((cfgSnap.data() as { catalogSync?: unknown } | undefined)?.catalogSync);
    const detection = await detectExternalSources(tenantId);
    const { plan, proposal } = planOwnershipMigration({
      tenantId,
      config,
      detection,
      requested: { model: req.data?.model, ownedFields: req.data?.ownedFields },
      actorUid,
      now,
    });

    if (mode === 'apply' && plan.blockers.length) {
      // El apply NO fuerza nada: los bloqueos los resuelve una persona (reconocer la fuente,
      // habilitar la sync, decidir el modelo). Se devuelven en el mensaje, ya saneados.
      throw new HttpsError(
        'failed-precondition',
        `La migración está bloqueada (${plan.blockers.join(', ')}): resolvelo y volvé a correr el preview.`,
      );
    }

    const ref = db().collection(paths.metaCatalogOwnershipRuns(tenantId)).doc();
    run = {
      runId: ref.id,
      tenantId,
      mode,
      status: 'running',
      cursor: null,
      pagesDone: 0,
      counters: emptyOwnershipMigrationCounters(),
      porEstado: {},
      plan,
      proposal: mode === 'apply' ? proposal : null,
      catalogId: config.catalogId,
      ownershipWritten: false,
      actorUid,
      lastError: '',
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    await ref.create(run as unknown as Record<string, unknown>);
  }

  const store = firestoreOwnershipMigrationStore({ tenantId, runId: run.runId });
  let res;
  try {
    res = await runOwnershipMigrationPages({
      tenantId,
      mode,
      store,
      proposal: run.proposal ?? null,
      catalogId: run.catalogId ?? '',
      cursor: run.cursor ?? null,
      counters: { ...emptyOwnershipMigrationCounters(), ...(run.counters ?? {}) },
      porEstado: run.porEstado ?? {},
      pagesDone: run.pagesDone ?? 0,
      ownershipWritten: run.ownershipWritten === true,
      lastError: run.lastError ?? '',
      maxPages,
    });
  } catch (e) {
    // El progreso por página YA está persistido: el reintento reanuda con runId. El lastError
    // se asienta con el MISMO guard del saveProgress (jamás sobre un run que otro ya cerró).
    const detalle = e instanceof Error ? e.message.slice(0, 300) : 'error interno';
    await db()
      .runTransaction(async (tx) => {
        const ref = db().doc(paths.metaCatalogOwnershipRun(tenantId, run.runId));
        const fresh = (await tx.get(ref)).data() as MetaCatalogOwnershipMigrationRunDoc | undefined;
        if (!fresh || fresh.status !== 'running') return;
        tx.update(ref, { lastError: detalle, updatedAt: Timestamp.now() });
      })
      .catch(() => {});
    if (e instanceof OwnershipMigrationPreconditionError) {
      logger.warn('Migración de propiedad: precondición fresca no se cumplió', { tenantId, runId: run.runId, outcome: e.outcome });
      throw new HttpsError('failed-precondition', e.message);
    }
    logger.error('Migración de propiedad: invocación interrumpida', e, { tenantId, runId: run.runId });
    throw new HttpsError('internal', 'La migración se interrumpió. El progreso quedó guardado: reanudá con el mismo runId.');
  }

  // ENCOLADO de la primera reconciliación (ADR-0015 §5 + §6). La migración no lee Meta: siembra
  // `unverifiable` sin `metaVerifiedAt`, o sea que todo el catálogo nace vencido y `stale`
  // bloquea la venta automática. Sin una verificación en camino eso no se levanta nunca. Solo se
  // CREA el doc del run —cero llamadas a Meta acá—; la lectura la hace la corrida programada.
  // Best-effort: si falla, la migración igual terminó bien y el scheduler crea la corrida solo.
  let verificationRunId: string | null = null;
  if (mode === 'apply' && res.status === 'completed' && res.ownershipWritten && run.proposal) {
    try {
      const q = await enqueueCatalogVerificationRun({
        tenantId,
        catalogId: run.catalogId ?? '',
        ownership: normalizeCatalogOwnership(run.proposal),
        actorUid,
        trigger: 'migration',
      });
      verificationRunId = q.runId;
    } catch (e) {
      logger.warn('Migración de propiedad: no se pudo encolar la verificación inicial', {
        tenantId,
        runId: run.runId,
        error: e instanceof Error ? e.message.slice(0, 200) : 'desconocido',
      });
    }
  }

  await recordAudit({
    tenantId,
    action: 'meta.catalog_ownership_migration_run',
    actorUid,
    actorRole: (req.auth?.token as { role?: string } | undefined)?.role ?? null,
    targetType: 'catalog',
    targetId: run.runId,
    summary:
      res.status === 'completed'
        ? `Migración de propiedad (${mode}) completada: modelo ${run.plan.proposedModel ?? 'sin propuesta'}, ${res.counters.estadoSembrado} estados sembrados, ${res.counters.syncedNoVerificados} "synced" sin verificar${res.counters.errores > 0 ? `, ${res.counters.errores} errores` : ''}`
        : `Migración de propiedad (${mode}) en curso: ${res.pagesDone} páginas`,
    metadata: {
      runId: run.runId,
      mode,
      status: res.status,
      // Metadata SANEADA: modelo, campos y CANTIDAD de fuentes. Jamás la URL del feed, su
      // query string ni su token — ni siquiera en la bitácora.
      modeloPropuesto: run.plan.proposedModel,
      camposPropios: run.plan.proposedOwnedFields,
      camposExternos: run.plan.proposedExternalFields,
      fuentesDetectadas: run.plan.detectedSources.length,
      bloqueos: run.plan.blockers,
      ownershipWritten: res.ownershipWritten,
      counters: res.counters,
    },
  }).catch(() => {});
  logger.info('Migración de propiedad: invocación terminada', {
    tenantId,
    runId: run.runId,
    mode,
    status: res.status,
    pagesDone: res.pagesDone,
    bloqueos: run.plan.blockers.length,
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
    porEstado: res.porEstado,
    plan: run.plan,
    ownershipWritten: res.ownershipWritten,
    /** Corrida de reconciliación encolada por el apply (null si no correspondía o falló). */
    verificationRunId,
    ...(res.stopReason ? { stopReason: res.stopReason } : {}),
    ...(res.lastError ? { lastError: res.lastError } : {}),
  };
});

/**
 * Estado read-only de una corrida. OWNER-ONLY (a diferencia del mantenimiento, que es
 * manager+): el plan dice QUIÉN gobierna el catálogo y con qué fuente reconocida — es una
 * decisión de gobierno de la empresa, no una tarea operativa del día a día.
 */
export const metaCatalogOwnershipMigrationStatus = onCall<{ tenantId?: string; runId?: string }>(
  { region: REGION },
  async (req) => {
    const tenantId = authorizeOwner(req, req.data?.tenantId);
    const runId = String(req.data?.runId ?? '').trim();
    if (!runId || !/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new HttpsError('invalid-argument', 'Falta runId.');
    const run = (await db().doc(paths.metaCatalogOwnershipRun(tenantId, runId)).get()).data() as
      | MetaCatalogOwnershipMigrationRunDoc
      | undefined;
    if (!run) return { ok: true, run: null };
    return { ok: true, run: runSummary(run) };
  },
);
