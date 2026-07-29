/**
 * functions/meta/catalogImportCallables.ts — Importación PAGINADA del catálogo de Meta
 * ====================================================================================
 * (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1) Tres callables:
 *
 *   · metaCatalogImportRun     (OWNER)    — corre/reanuda el run persistido: hasta N páginas
 *     por invocación, cursor+contadores guardados tras CADA página. El panel re-invoca hasta
 *     `status: 'completed'`. UN solo run activo por tenant (puntero transaccional
 *     `metaCatalogImportState/current` + lease 120s, patrón intent del outbox): una
 *     invocación CONCURRENTE recibe `{ status: 'already_running' }` con el estado actual.
 *   · metaCatalogImportStatus  (manager+) — read-only del run activo (o el último).
 *   · metaCatalogQualitySummary(manager+) — agregado del centro de calidad por severidad y
 *     código, con límite y `truncated` honesto.
 *
 * Semántica de `resume`: la reanudación de un run interrumpido (lease vencida) es el
 * comportamiento por DEFECTO — el run es idempotente y no puede haber dos. `resume: true`
 * además EXIGE que exista un run activo (failed-precondition si no hay nada que reanudar):
 * sirve para que un "continuar" del panel jamás arranque un barrido nuevo por accidente.
 *
 * A diferencia del callable clásico `metaCatalogImportItems` (que conserva su contrato:
 * categoría obligatoria, retailerIds explícitos), este run importa TODO lo importable y
 * relaja la categoría: sin `defaultCategoryId` los items entran como borrador «sin
 * clasificar» (categoryId '') con la observación de calidad correspondiente.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaCatalogImportRunSummary, ProductQuality, QualitySeverity } from '@vpw/shared';
import { resolveOwnerAuth, resolvePanelAuth } from '../../panel/auth.js';
import { assertWithinLimit } from '../../entitlements/entitlements.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { getMetaCatalogClientForTenant, MetaCatalogApiError } from '../../meta/catalogClient.js';
import {
  emptyImportCounters,
  firestoreImportStore,
  runImportPages,
  IMPORT_RUN_LEASE_MS,
  type MetaCatalogImportRunDoc,
} from '../../meta/catalogImport.js';
import { normalizeCatalogProfile } from '../../products/quality.js';
import { refreshCatalogQualityNotification } from '../../products/qualityNotification.js';
import { requireCatalogId } from './catalogReconcileCallables.js';

const REGION = 'us-central1';
const DEFAULT_MAX_PAGES = 5;
const MAX_MAX_PAGES = 10;
/** Tope de productos leídos por severidad en el resumen (con `truncated` honesto). */
const SUMMARY_LIMIT = 200;
const SUMMARY_SAMPLES = 20;

function authorizeOwner(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolveOwnerAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

function authorizeManager(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

/** Perfil de calidad del tenant (`config/catalog.profile`). Ausente ⇒ defaults (arfagi). */
async function loadProfile(tenantId: string) {
  const doc = await db().doc(`tenants/${tenantId}/config/catalog`).get();
  return normalizeCatalogProfile((doc.data() as { profile?: unknown } | undefined)?.profile);
}

/** Vista SANEADA del run para el panel (el doc está cerrado al cliente por rules). */
function runSummary(run: MetaCatalogImportRunDoc): MetaCatalogImportRunSummary {
  return {
    runId: run.runId,
    status: run.status,
    pagesDone: run.pagesDone ?? 0,
    processed: run.processed ?? 0,
    counters: { ...emptyImportCounters(), ...(run.counters ?? {}) },
    blockedByReason: run.blockedByReason ?? {},
    hasCursor: !!run.cursor,
    startedAtMs: run.startedAt?.toMillis?.() ?? null,
    updatedAtMs: run.updatedAt?.toMillis?.() ?? null,
    finishedAtMs: run.finishedAt?.toMillis?.() ?? null,
    lastError: run.lastError || null,
  };
}

interface ImportState {
  activeRunId?: string | null;
  lastRunId?: string | null;
}

// ---------------------------------------------------------------------------
// 1) Correr / reanudar el run (OWNER)
// ---------------------------------------------------------------------------

export const metaCatalogImportRun = onCall<{ tenantId?: string; resume?: boolean; defaultCategoryId?: string; maxPages?: number }>(
  { region: REGION, timeoutSeconds: 300 },
  async (req) => {
    const tenantId = authorizeOwner(req, req.data?.tenantId);
    const actorUid = req.auth?.uid ?? null;

    // ---- Validación de input (fail-closed) ----
    if (req.data?.resume !== undefined && typeof req.data.resume !== 'boolean') {
      throw new HttpsError('invalid-argument', 'resume debe ser booleano.');
    }
    const resume = req.data?.resume === true;
    const rawMax = req.data?.maxPages;
    let maxPages = DEFAULT_MAX_PAGES;
    if (rawMax !== undefined) {
      if (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax < 1 || rawMax > MAX_MAX_PAGES) {
        throw new HttpsError('invalid-argument', `maxPages debe ser un entero entre 1 y ${MAX_MAX_PAGES}.`);
      }
      maxPages = rawMax;
    }
    const defaultCategoryId = String(req.data?.defaultCategoryId ?? '').trim();
    if (defaultCategoryId) {
      const catSnap = await db().doc(paths.category(tenantId, defaultCategoryId)).get();
      if (!catSnap.exists) throw new HttpsError('invalid-argument', 'La categoría indicada no existe en esta empresa.');
    }

    const catalogId = await requireCatalogId(tenantId);
    const profile = await loadProfile(tenantId);
    const stateRef = db().doc(paths.metaCatalogImportState(tenantId));

    // ---- Claim transaccional del run activo (lease 120s, patrón del outbox) ----
    const now = Timestamp.now();
    const claim = await db().runTransaction(async (tx) => {
      const state = (await tx.get(stateRef)).data() as ImportState | undefined;
      const activo = state?.activeRunId
        ? ((await tx.get(db().doc(paths.metaCatalogImportRun(tenantId, state.activeRunId)))).data() as MetaCatalogImportRunDoc | undefined)
        : undefined;

      if (activo && activo.status === 'running') {
        // El catálogo configurado cambió a mitad de run: ese barrido ya no describe nada.
        // Se cierra como fallido y el dueño arranca uno nuevo contra el catálogo actual.
        if (activo.catalogId !== catalogId) {
          tx.update(db().doc(paths.metaCatalogImportRun(tenantId, activo.runId)), {
            status: 'failed',
            lastError: 'El catálogo configurado cambió durante la importación.',
            leaseUntil: null,
            finishedAt: now,
            updatedAt: now,
          });
          tx.set(stateRef, { activeRunId: null, lastRunId: activo.runId, updatedAt: now }, { merge: true });
          return { r: 'catalog_changed' as const };
        }
        const leaseVigente = (activo.leaseUntil?.toMillis?.() ?? 0) > now.toMillis();
        if (leaseVigente) return { r: 'already_running' as const, run: activo };
        // Lease vencida (invocación anterior cortada o entre iteraciones del panel):
        // retomar es el DEFAULT — es el mismo run, y re-procesar páginas es idempotente.
        tx.update(db().doc(paths.metaCatalogImportRun(tenantId, activo.runId)), {
          leaseUntil: Timestamp.fromMillis(now.toMillis() + IMPORT_RUN_LEASE_MS),
          attempts: (activo.attempts ?? 0) + 1,
          actorUid,
          updatedAt: now,
        });
        return { r: 'claimed' as const, run: { ...activo, attempts: (activo.attempts ?? 0) + 1 } };
      }

      if (resume) return { r: 'nothing_to_resume' as const };

      const runRef = db().collection(paths.metaCatalogImportRuns(tenantId)).doc();
      const run: MetaCatalogImportRunDoc = {
        runId: runRef.id,
        tenantId,
        catalogId,
        status: 'running',
        cursor: null,
        pagesDone: 0,
        processed: 0,
        counters: emptyImportCounters(),
        blockedByReason: {},
        defaultCategoryId,
        leaseUntil: Timestamp.fromMillis(now.toMillis() + IMPORT_RUN_LEASE_MS),
        attempts: 1,
        actorUid,
        lastError: '',
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
      };
      // `create` (no set): si dos transacciones compitieran por el mismo id, la segunda falla.
      tx.create(runRef, run as unknown as Record<string, unknown>);
      tx.set(stateRef, { tenantId, activeRunId: runRef.id, lastRunId: runRef.id, updatedAt: now }, { merge: true });
      return { r: 'claimed' as const, run };
    });

    if (claim.r === 'already_running') {
      return { ok: false, status: 'already_running' as const, run: runSummary(claim.run) };
    }
    if (claim.r === 'nothing_to_resume') {
      throw new HttpsError('failed-precondition', 'No hay ninguna importación activa para reanudar.');
    }
    if (claim.r === 'catalog_changed') {
      throw new HttpsError('failed-precondition', 'El catálogo configurado cambió durante la importación. Iniciá una importación nueva.');
    }

    const run = claim.run;
    const runRef = db().doc(paths.metaCatalogImportRun(tenantId, run.runId));

    // ---- Cliente + verificación del catálogo (solo GET; errores saneados) ----
    let client: Awaited<ReturnType<typeof getMetaCatalogClientForTenant>>;
    try {
      client = await getMetaCatalogClientForTenant(tenantId);
      await client.getCatalog(catalogId);
    } catch (e) {
      const detalle = e instanceof MetaCatalogApiError ? e.message : 'No se pudo leer el catálogo de Meta.';
      // Se libera la lease para que la próxima invocación reanude sin esperar los 120s.
      await runRef.set({ lastError: detalle.slice(0, 300), leaseUntil: null, updatedAt: Timestamp.now() }, { merge: true }).catch(() => {});
      logger.error('Import de catálogo: fallo leyendo Meta', e, { tenantId, runId: run.runId });
      throw new HttpsError('unavailable', detalle);
    }

    // ---- Hasta N páginas por invocación (cursor persistido tras cada una) ----
    const store = firestoreImportStore({ tenantId, runId: run.runId, profile });
    let res;
    try {
      res = await runImportPages({
        tenantId,
        catalogId,
        client,
        store,
        cursor: run.cursor ?? null,
        counters: { ...emptyImportCounters(), ...(run.counters ?? {}) },
        blockedByReason: run.blockedByReason ?? {},
        pagesDone: run.pagesDone ?? 0,
        processed: run.processed ?? 0,
        maxPages,
        // SIEMPRE manda la categoría del RUN (fijada al crearlo): mezclar categorías a mitad
        // de barrido haría imposible explicar qué se importó a dónde.
        defaultCategoryId: run.defaultCategoryId,
        profile,
        assertQuota: (delta) => assertWithinLimit(tenantId, 'products', { actorUid: req.auth?.uid, delta }),
      });
    } catch (e) {
      // Fallo inesperado a mitad de invocación: el progreso por página YA está persistido.
      // Se libera la lease para que el reintento reanude sin esperar los 120s.
      await runRef.set({ lastError: e instanceof Error ? e.message.slice(0, 300) : 'error interno', leaseUntil: null, updatedAt: Timestamp.now() }, { merge: true }).catch(() => {});
      logger.error('Import de catálogo: invocación interrumpida', e, { tenantId, runId: run.runId });
      throw new HttpsError('internal', 'La importación se interrumpió. El progreso quedó guardado: volvé a intentar para reanudar.');
    }

    if (res.status === 'completed') {
      await stateRef.set({ activeRunId: null, lastRunId: run.runId, updatedAt: Timestamp.now() }, { merge: true });
    } else {
      // Entre invocaciones nadie trabaja el run: liberar la lease permite reanudar YA.
      await runRef.set({ leaseUntil: null, updatedAt: Timestamp.now() }, { merge: true });
    }

    // Campana agregada + auditoría (best-effort: jamás rompen el run). Se refresca al
    // TERMINAR el run y también cuando una invocación intermedia creó importados nuevos
    // (cada borrador nace con bloqueos: el agregado cambió).
    if (res.status === 'completed' || res.counters.imported > (run.counters?.imported ?? 0)) {
      await refreshCatalogQualityNotification(tenantId);
    }
    await recordAudit({
      tenantId,
      action: 'meta.catalog_import_run',
      actorUid,
      actorRole: (req.auth?.token as { role?: string } | undefined)?.role ?? null,
      targetType: 'catalog',
      targetId: catalogId ? `…${catalogId.slice(-4)}` : 'catalog',
      summary: res.status === 'completed'
        ? `Importación paginada completada: ${res.counters.imported} importados (${res.counters.unclassified} sin clasificar)`
        : `Importación paginada en curso: ${res.pagesDone} páginas, ${res.counters.imported} importados`,
      metadata: { runId: run.runId, status: res.status, counters: res.counters, blockedByReason: res.blockedByReason, stopReason: res.stopReason ?? null },
    }).catch(() => {});
    logger.info('Import de catálogo: invocación terminada', { tenantId, runId: run.runId, status: res.status, pagesDone: res.pagesDone, imported: res.counters.imported });

    return {
      ok: true,
      runId: run.runId,
      status: res.status,
      /** true ⇒ el panel debe re-invocar para seguir (quedan páginas / cuota / error remoto). */
      more: res.status !== 'completed',
      hasCursor: !!res.cursor,
      pagesDone: res.pagesDone,
      processed: res.processed,
      counters: res.counters,
      blockedByReason: res.blockedByReason,
      ...(res.stopReason ? { stopReason: res.stopReason } : {}),
      ...(res.lastError ? { lastError: res.lastError } : {}),
    };
  },
);

// ---------------------------------------------------------------------------
// 2) Estado del run (manager+, read-only)
// ---------------------------------------------------------------------------

export const metaCatalogImportStatus = onCall<{ tenantId?: string }>({ region: REGION }, async (req) => {
  const tenantId = authorizeManager(req, req.data?.tenantId);
  const state = (await db().doc(paths.metaCatalogImportState(tenantId)).get()).data() as ImportState | undefined;
  const runId = state?.activeRunId ?? state?.lastRunId ?? null;
  if (!runId) return { ok: true, active: false, run: null };
  const run = (await db().doc(paths.metaCatalogImportRun(tenantId, runId)).get()).data() as MetaCatalogImportRunDoc | undefined;
  if (!run) return { ok: true, active: false, run: null };
  return { ok: true, active: run.status === 'running', run: runSummary(run) };
});

// ---------------------------------------------------------------------------
// 3) Resumen del centro de calidad (manager+, read-only)
// ---------------------------------------------------------------------------

export const metaCatalogQualitySummary = onCall<{ tenantId?: string }>({ region: REGION }, async (req) => {
  const tenantId = authorizeManager(req, req.data?.tenantId);
  const col = db().collection(paths.products(tenantId));
  // Índice automático de campo único de Firestore (sin entrada en firestore.indexes.json):
  // cada query filtra por UN solo campo anidado, sin orderBy adicional.
  const [b, w] = await Promise.all([
    col.where('quality.blocking', '>', 0).select('name', 'quality').limit(SUMMARY_LIMIT).get(),
    col.where('quality.warning', '>', 0).select('name', 'quality').limit(SUMMARY_LIMIT).get(),
  ]);

  // Un producto puede aparecer en ambas queries: se deduplica por id.
  const porProducto = new Map<string, { name: string; quality: ProductQuality }>();
  for (const d of [...b.docs, ...w.docs]) {
    const data = d.data() as { name?: string; quality?: ProductQuality };
    if (data.quality) porProducto.set(d.id, { name: data.name ?? '', quality: data.quality });
  }

  const porCodigo: Record<string, { severity: QualitySeverity; count: number }> = {};
  const muestras: Array<{ productId: string; name: string; blocking: number; warning: number; codes: string[] }> = [];
  for (const [productId, { name, quality }] of porProducto) {
    const activos = Object.values(quality.fingerprints ?? {}).filter((o) => o.resolvedAt === null);
    for (const o of activos) {
      const slot = (porCodigo[o.code] ??= { severity: o.severity, count: 0 });
      slot.count++;
    }
    if (muestras.length < SUMMARY_SAMPLES) {
      muestras.push({ productId, name, blocking: quality.blocking ?? 0, warning: quality.warning ?? 0, codes: activos.map((o) => o.code).sort() });
    }
  }

  // `truncated` HONESTO: si alguna query llegó al tope, los conteos son un piso, no el total.
  const truncated = b.size >= SUMMARY_LIMIT || w.size >= SUMMARY_LIMIT;
  return {
    ok: true,
    conBloqueos: b.size,
    conAdvertencias: w.size,
    truncated,
    porCodigo,
    muestras,
  };
});
