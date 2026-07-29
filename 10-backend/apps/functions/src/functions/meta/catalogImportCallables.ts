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
 *     (HARDEN-1) Cada claim fija una GENERACIÓN inmutable (contador creciente en el puntero,
 *     copiado al run): toda escritura posterior la demuestra transaccionalmente. Un worker
 *     superado por un takeover responde `{ ok: false, status: 'claim_lost' }` sin haber
 *     escrito NADA tardío (ni productos/locks, ni cursor, ni puntero). La campana agregada
 *     queda FUERA del fencing: es BEST-EFFORT declarada (ADR-0014 §4b, last-writer-wins,
 *     se auto-corrige en el próximo refresh) — lo único garantizado es que un worker que YA
 *     SABE que perdió el claim no la refresca. El perfil de catálogo se FIJA al run en el
 *     claim de creación (igual que defaultCategoryId): un cambio de config a mitad de
 *     barrido no mezcla políticas dentro de un mismo runId.
 *   · metaCatalogImportStatus  (manager+) — read-only del run activo (o el último).
 *   · metaCatalogQualitySummary(manager+) — agregado del centro de calidad por severidad y
 *     código, con límite y `truncated` honesto, más la COBERTURA `sinEvaluar` (productos
 *     no archivados sin `quality`): un catálogo legacy sin evaluar jamás se muestra verde.
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
import { PRODUCT_STATUS, type MetaCatalogImportRunSummary, type ProductQuality, type QualitySeverity } from '@vpw/shared';
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
  settleImportRunIfOwner,
  IMPORT_RUN_LEASE_MS,
  type MetaCatalogImportRunDoc,
} from '../../meta/catalogImport.js';
import { refreshCatalogQualityNotification } from '../../products/qualityNotification.js';
import { loadCatalogProfile, requireCatalogId } from './catalogReconcileCallables.js';

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
  /** Generación de fencing: crece en CADA claim (creación de run o takeover). */
  generation?: number;
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
    // La config se lee UNA vez acá: se usa para FIJAR la política a un run NUEVO (y como
    // fallback para docs previos al campo `profile`). Un run existente usa LA DEL RUN.
    const profile = await loadCatalogProfile(tenantId);
    const stateRef = db().doc(paths.metaCatalogImportState(tenantId));

    // ---- Claim transaccional del run activo (lease 120s + GENERACIÓN de fencing) ----
    // La generación vive en el puntero y CRECE en cada claim (creación o takeover): toda
    // escritura posterior del worker la demuestra transaccionalmente (HARDEN-1).
    const now = Timestamp.now();
    const claim = await db().runTransaction(async (tx) => {
      const state = (await tx.get(stateRef)).data() as ImportState | undefined;
      const nextGeneration = (state?.generation ?? 0) + 1;
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
        // El TAKEOVER estrena generación: el worker anterior, si despierta, ya no escribe.
        tx.update(db().doc(paths.metaCatalogImportRun(tenantId, activo.runId)), {
          leaseUntil: Timestamp.fromMillis(now.toMillis() + IMPORT_RUN_LEASE_MS),
          attempts: (activo.attempts ?? 0) + 1,
          generation: nextGeneration,
          actorUid,
          updatedAt: now,
        });
        tx.set(stateRef, { generation: nextGeneration, updatedAt: now }, { merge: true });
        return { r: 'claimed' as const, run: { ...activo, attempts: (activo.attempts ?? 0) + 1, generation: nextGeneration } };
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
        // Política FIJADA al run (ADR-0014 §4b): las invocaciones siguientes usan ESTA.
        profile,
        leaseUntil: Timestamp.fromMillis(now.toMillis() + IMPORT_RUN_LEASE_MS),
        attempts: 1,
        generation: nextGeneration,
        actorUid,
        lastError: '',
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
      };
      // `create` (no set): si dos transacciones compitieran por el mismo id, la segunda falla.
      tx.create(runRef, run as unknown as Record<string, unknown>);
      tx.set(stateRef, { tenantId, activeRunId: runRef.id, lastRunId: runRef.id, generation: nextGeneration, updatedAt: now }, { merge: true });
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
    // (C1/HARDEN-1) TODAS las páginas de un run se procesan con la política DEL RUN (fijada
    // en el claim de creación): un cambio de `config/catalog.profile` a mitad de barrido no
    // mezcla criterios de bloqueo/vertical dentro de un mismo runId. El fallback a la config
    // cubre SOLO run docs previos al campo (repo no desplegado: no debería ocurrir).
    const runProfile = run.profile !== undefined ? run.profile : profile;

    // ---- Cliente + verificación del catálogo (solo GET; errores saneados) ----
    let client: Awaited<ReturnType<typeof getMetaCatalogClientForTenant>>;
    try {
      client = await getMetaCatalogClientForTenant(tenantId);
      await client.getCatalog(catalogId);
    } catch (e) {
      const detalle = e instanceof MetaCatalogApiError ? e.message : 'No se pudo leer el catálogo de Meta.';
      // Se libera la lease para que la próxima invocación reanude sin esperar los 120s —
      // SOLO si este worker sigue siendo el dueño (fencing: jamás una escritura ciega).
      await settleImportRunIfOwner(tenantId, run.runId, run.generation, { lastError: detalle.slice(0, 300), leaseUntil: null }).catch(() => {});
      logger.error('Import de catálogo: fallo leyendo Meta', e, { tenantId, runId: run.runId });
      throw new HttpsError('unavailable', detalle);
    }

    // ---- Hasta N páginas por invocación (cursor persistido tras cada una) ----
    const store = firestoreImportStore({ tenantId, runId: run.runId, profile: runProfile, generation: run.generation });
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
        // de barrido haría imposible explicar qué se importó a dónde. Ídem la política.
        defaultCategoryId: run.defaultCategoryId,
        profile: runProfile,
        assertQuota: (delta) => assertWithinLimit(tenantId, 'products', { actorUid: req.auth?.uid, delta }),
      });
    } catch (e) {
      // Fallo inesperado a mitad de invocación: el progreso por página YA está persistido.
      // Se libera la lease (si seguimos siendo dueños) para que el reintento reanude YA.
      await settleImportRunIfOwner(tenantId, run.runId, run.generation, { lastError: e instanceof Error ? e.message.slice(0, 300) : 'error interno', leaseUntil: null }).catch(() => {});
      logger.error('Import de catálogo: invocación interrumpida', e, { tenantId, runId: run.runId });
      throw new HttpsError('internal', 'La importación se interrumpió. El progreso quedó guardado: volvé a intentar para reanudar.');
    }

    if (res.stopReason === 'claim_lost') {
      // Otro worker reclamó el run con una generación nueva: este worker NO escribió nada
      // tardío (ni productos, ni cursor, ni puntero) y TAMPOCO toca la campana ni audita
      // contadores que ya no son suyos. El panel debe consultar el estado del claim vigente.
      logger.warn('Import de catálogo: invocación superada por un claim más nuevo', { tenantId, runId: run.runId, generation: run.generation });
      return {
        ok: false,
        status: 'claim_lost' as const,
        runId: run.runId,
        message: 'Otra invocación tomó el control de esta importación. Consultá el estado actual.',
      };
    }

    if (res.status !== 'completed') {
      // Entre invocaciones nadie trabaja el run: liberar la lease permite reanudar YA.
      // (El puntero de un run COMPLETADO ya lo liberó el propio saveProgress, en la misma
      // transacción con ownership.) Guardado con fencing: jamás pisa el claim de otro.
      await settleImportRunIfOwner(tenantId, run.runId, run.generation, { leaseUntil: null }).catch(() => {});
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
  //
  // COBERTURA `sinEvaluar` (ADR-0014 §4c): productos NO archivados que aún NO tienen
  // `quality` — un catálogo legacy sin evaluar nunca se muestra como "completo". Técnica:
  // count() agregado con la desigualdad `quality.blocking >= 0`, que matchea SOLO docs que
  // TIENEN el campo con valor numérico (en Firestore una desigualdad jamás matchea un campo
  // ausente; verificado en el emulador por el E2E CO-28). Los ARCHIVED quedan FUERA de la
  // cobertura a propósito: el mantenimiento saltea su backfill (contarlos sería deuda
  // inaccionable que rompería el estado verde para siempre). `status in [...]` + desigualdad
  // sobre otro campo exige el índice compuesto (status, quality.blocking) declarado en
  // firestore.indexes.json.
  const NO_ARCHIVADOS = PRODUCT_STATUS.filter((s) => s !== 'ARCHIVED');
  const [b, w, totalSnap, evaluadosSnap] = await Promise.all([
    col.where('quality.blocking', '>', 0).select('name', 'quality').limit(SUMMARY_LIMIT).get(),
    col.where('quality.warning', '>', 0).select('name', 'quality').limit(SUMMARY_LIMIT).get(),
    col.where('status', 'in', NO_ARCHIVADOS).count().get(),
    col.where('status', 'in', NO_ARCHIVADOS).where('quality.blocking', '>=', 0).count().get(),
  ]);
  const sinEvaluar = Math.max(0, totalSnap.data().count - evaluadosSnap.data().count);

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
    /** Productos NO archivados que todavía NO fueron evaluados (sin campo `quality`). */
    sinEvaluar,
    truncated,
    porCodigo,
    muestras,
  };
});
