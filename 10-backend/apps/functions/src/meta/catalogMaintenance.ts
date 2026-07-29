/**
 * meta/catalogMaintenance.ts — Mantenimiento del catálogo: locks + quality (HARDEN-1)
 * ===================================================================================
 * (ADR-0014 §4c) Los productos anteriores al programa GENERIC-ONBOARDING no tienen
 * `quality`, y los importados por el flujo curado clásico no tienen su `metaRetailerLock`.
 * Esta operación EXPLÍCITA — preview/dry-run por DEFECTO, apply solo con confirmación —
 * recorre los productos del tenant paginada por cursor local (orderBy id, reanudable,
 * idempotente, tenant-scoped) y por producto:
 *
 *  - con `metaRetailerId`: lock faltante ⇒ crear (apply) o contar (preview); lock propio ⇒
 *    ok; lock de OTRO producto o DOS productos reclamando el mismo retailer_id ⇒ CONFLICTO
 *    reportado con productIds y rid — JAMÁS se elige ganador ni se toca nada ambiguo;
 *  - sin `quality` ⇒ se calcula con el perfil efectivo del tenant y se escribe SOLO el
 *    campo `quality` (nunca nombre/precio/costo/stock/status/mapping/syncToMeta); con
 *    `quality` vigente ⇒ no se toca. Los ARCHIVED quedan FUERA del backfill de quality
 *    (ADR-0014 §4c): evaluarlos generaría bloqueos permanentes e inaccionables (not_active
 *    no se resuelve sin reactivar) y rompería el autocierre de la campana — se cuentan en
 *    `archivadosSalteados`. El chequeo de LOCKS sí los incluye: la identidad remota importa
 *    aunque el producto esté archivado.
 *
 * Contadores honestos {examinados, locksCreados, locksExistentes, conflictos,
 * qualityCalculada, qualityVigente, archivadosSalteados, erroresQuality}. Un catálogo
 * parcialmente evaluado JAMÁS se presenta como completo: el run queda `running` con cursor
 * hasta terminar; un backfill que falla por error de transacción se CUENTA (`erroresQuality`)
 * y sella `lastError` — un run con errores jamás termina limpio. La campana agregada se
 * recalcula al final del apply (la dispara el callable).
 *
 * `saveProgress` es TRANSACCIONAL con dos guards (ADR-0014 §4c): jamás escribe sobre un run
 * que ya no está `running` (el worker lento de un runId reanudado dos veces no pisa el
 * cierre del rápido) y cursor/contadores jamás retroceden (espejo del guard monotónico del
 * import run). No hay lease generacional completa: operación manual, owner-only, idempotente.
 *
 * El acceso a Firestore vive detrás de `MaintenanceStore` (misma costura inyectable que el
 * import run): los tests unitarios corren en memoria; el callable usa el store real.
 *
 * ⚠️ NO se ejecuta contra producción durante el desarrollo: es un paso del release auditado.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { FieldPath } from 'firebase-admin/firestore';
import type {
  CatalogQualityProfile,
  MetaCatalogMaintenanceConflict,
  MetaCatalogMaintenanceCounters,
  Product,
  ProductQuality,
} from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { evaluateProductQuality } from '../products/quality.js';
import { normalizeText, retailerIdLockKey } from './catalogReconcile.js';

export const emptyMaintenanceCounters = (): MetaCatalogMaintenanceCounters => ({
  examinados: 0,
  locksCreados: 0,
  locksExistentes: 0,
  conflictos: 0,
  qualityCalculada: 0,
  qualityVigente: 0,
  archivadosSalteados: 0,
  erroresQuality: 0,
});

/** Tope de conflictos ALMACENADOS en el run doc (el contador sigue siendo exacto). */
export const MAX_STORED_CONFLICTS = 200;

export interface MaintenanceProgressPatch {
  status: 'running' | 'completed';
  cursor: string | null;
  pagesDone: number;
  counters: MetaCatalogMaintenanceCounters;
  conflicts: MetaCatalogMaintenanceConflict[];
  conflictsTruncated: boolean;
  lastError?: string;
}

/**
 * Guard monotónico del progreso del mantenimiento (PURO, espejo de
 * `importProgressRegression`): pagesDone y contadores JAMÁS retroceden. Devuelve la razón
 * de la regresión o null si el patch es aplicable. El cursor no se compara: la
 * monotonicidad vive en los contadores (una página corta legítima lo vuelve null).
 */
export function maintenanceProgressRegression(
  current: { pagesDone?: number; counters?: Partial<MetaCatalogMaintenanceCounters> },
  patch: Pick<MaintenanceProgressPatch, 'pagesDone' | 'counters'>,
): string | null {
  if (patch.pagesDone < (current.pagesDone ?? 0)) return `pagesDone ${patch.pagesDone} < ${current.pagesDone}`;
  for (const [k, v] of Object.entries(current.counters ?? {})) {
    const nuevo = patch.counters[k as keyof MetaCatalogMaintenanceCounters];
    if (typeof v === 'number' && typeof nuevo === 'number' && nuevo < v) return `counters.${k} ${nuevo} < ${v}`;
  }
  return null;
}

/**
 * Desenlace del backfill de quality de UN producto. `missing` = el producto DESAPARECIÓ
 * entre la página y la escritura (no se cuenta); `error` = la transacción FALLÓ
 * (UNAVAILABLE, contención agotada, evaluate() que lanza): se cuenta en `erroresQuality`
 * y sella `lastError` — jamás se disfraza de missing (ADR-0014 §4c).
 */
export interface MaintenanceBackfillResult {
  outcome: 'written' | 'already' | 'missing' | 'error';
  /** Detalle SANEADO del error (solo con outcome 'error'). */
  error?: string;
}

/**
 * Costura de persistencia. La implementación real (abajo) escribe en Firestore; los tests
 * inyectan una en memoria. NINGÚN método toca campos de producto fuera de `quality`.
 */
export interface MaintenanceStore {
  /** Página de productos ordenada por id (cursor = último id de la página anterior). */
  listProductsPage(cursor: string | null, pageSize: number): Promise<{ products: Product[]; nextCursor: string | null }>;
  /** Nombres normalizados (con repetición) de productos NO archivados, para el evaluador. */
  loadNameCounts(): Promise<Map<string, number>>;
  /** Ids de productos del TENANT que reclaman este retailer_id (query por metaRetailerId). */
  productsClaimingRid(retailerId: string): Promise<string[]>;
  /** Dueño actual del lock (productId) o null si no existe. */
  getLockOwner(lockKey: string): Promise<string | null>;
  /**
   * Crea el lock si no existe (transaccional, jamás pisa). 'exists_own'/'exists_other'
   * reflejan el dueño encontrado dentro de la transacción.
   */
  createLock(args: { lockKey: string; retailerId: string; productId: string }): Promise<'created' | 'exists_own' | 'exists_other'>;
  /**
   * Escribe SOLO `quality` si el producto AÚN no la tiene (transaccional: si otro camino
   * la escribió entre la página y acá, no se pisa). `evaluate` recibe el doc FRESCO.
   * Un fallo de transacción devuelve `error` (jamás se disfraza de `missing`).
   */
  backfillQuality(productId: string, evaluate: (fresh: Product) => ProductQuality): Promise<MaintenanceBackfillResult>;
  /**
   * Persiste cursor + contadores + conflictos DESPUÉS de cada página. Transaccional con
   * dos guards: nada se escribe sobre un run no-`running` y el progreso jamás retrocede.
   */
  saveProgress(patch: MaintenanceProgressPatch): Promise<void>;
}

export interface RunMaintenanceArgs {
  tenantId: string;
  mode: 'preview' | 'apply';
  store: MaintenanceStore;
  profile: CatalogQualityProfile | null;
  /** Estado reanudado (cursor/contadores/conflictos persistidos de la invocación previa). */
  cursor: string | null;
  counters: MetaCatalogMaintenanceCounters;
  conflicts: MetaCatalogMaintenanceConflict[];
  conflictsTruncated: boolean;
  pagesDone: number;
  /** lastError persistido del run: se CONSERVA si esta invocación no suma errores nuevos. */
  lastError?: string;
  /** Presupuesto de páginas de ESTA invocación. */
  maxPages: number;
  pageSize?: number;
  now?: () => Timestamp;
}

export interface RunMaintenanceResult {
  status: 'running' | 'completed';
  cursor: string | null;
  pagesDone: number;
  counters: MetaCatalogMaintenanceCounters;
  conflicts: MetaCatalogMaintenanceConflict[];
  conflictsTruncated: boolean;
  stopReason?: 'pages_budget';
  /** Error saneado del último backfill fallido (un run con errores jamás termina limpio). */
  lastError?: string;
}

const DEFAULT_PAGE_SIZE = 200;

export async function runMaintenancePages(args: RunMaintenanceArgs): Promise<RunMaintenanceResult> {
  const now = args.now ?? (() => Timestamp.now());
  const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
  const counters = { ...args.counters };
  const conflicts = [...args.conflicts];
  let conflictsTruncated = args.conflictsTruncated;
  let cursor = args.cursor;
  let pagesDone = args.pagesDone;
  // El lastError del run se HEREDA: una reanudación sin errores nuevos no lo borra (el run
  // con errores jamás se presenta limpio, aunque la última invocación haya salido bien).
  let lastError = (args.lastError ?? '').trim();

  // Nombres locales UNA vez por invocación (para probable_duplicate del evaluador). El mapa
  // con conteos permite excluir el propio nombre sin O(n) copias por producto.
  const nameCounts = await args.store.loadNameCounts();
  const allNames = new Set(nameCounts.keys());
  const namesExcept = (p: Product): ReadonlySet<string> => {
    const n = normalizeText(p.name);
    if (!n || (nameCounts.get(n) ?? 0) > 1) return allNames; // homónimo real: se queda
    const sin = new Set(allNames);
    sin.delete(n);
    return sin;
  };

  // Dedupe por rid: cada retailer_id en conflicto se cuenta UNA vez aunque lo reporten
  // varios productos o lo re-examine una reanudación (contadores honestos). Más allá del
  // tope almacenado, el rid se sigue CONTANDO (la lista es un piso, `conflictsTruncated`).
  const ridsContados = new Set(conflicts.map((c) => c.retailerId));
  const registrarConflicto = (retailerId: string, productIds: string[]): void => {
    if (ridsContados.has(retailerId)) return;
    ridsContados.add(retailerId);
    counters.conflictos++;
    if (conflicts.length >= MAX_STORED_CONFLICTS) {
      conflictsTruncated = true;
      return;
    }
    conflicts.push({ retailerId, productIds: [...productIds].sort() });
  };

  const resultado = (extra: Partial<RunMaintenanceResult> & { status: 'running' | 'completed' }): RunMaintenanceResult => ({
    cursor,
    pagesDone,
    counters,
    conflicts,
    conflictsTruncated,
    ...(lastError ? { lastError } : {}),
    ...extra,
  });

  for (let intento = 0; intento < args.maxPages; intento++) {
    const page = await args.store.listProductsPage(cursor, pageSize);

    for (const p of page.products) {
      counters.examinados++;
      const rid = (p.metaRetailerId ?? '').trim();
      let conflictivo = false;

      // ── Locks de identidad remota ──
      if (rid) {
        const lockKey = retailerIdLockKey(rid);
        const claimants = await args.store.productsClaimingRid(rid);
        const otros = claimants.filter((id) => id !== p.id);
        if (otros.length) {
          // DOS (o más) productos reclaman el mismo retailer_id: resolución humana.
          registrarConflicto(rid, [p.id, ...otros]);
          conflictivo = true;
        } else {
          const owner = await args.store.getLockOwner(lockKey);
          if (owner === p.id) {
            counters.locksExistentes++;
          } else if (owner) {
            // El lock pertenece a OTRO producto (que quizá ni reclama el rid ya): ambiguo.
            registrarConflicto(rid, [p.id, owner]);
            conflictivo = true;
          } else if (args.mode === 'preview') {
            counters.locksCreados++; // lo que SE HARÍA — preview no escribe nada
          } else {
            const r = await args.store.createLock({ lockKey, retailerId: rid, productId: p.id });
            if (r === 'created') counters.locksCreados++;
            else if (r === 'exists_own') counters.locksExistentes++;
            else {
              registrarConflicto(rid, [p.id]);
              conflictivo = true;
            }
          }
        }
      }

      // ── Backfill de quality (SOLO productos sin quality; jamás se recalcula la vigente) ──
      if (p.quality) {
        counters.qualityVigente++;
      } else if (p.status === 'ARCHIVED') {
        // (ADR-0014 §4c) El backfill SALTEA los ARCHIVED: evaluarlos les fijaría bloqueos
        // permanentes e inaccionables (not_active jamás se resuelve sin reactivar) y
        // rompería el autocierre de la campana. El chequeo de locks de arriba SÍ los
        // incluyó — la identidad remota importa aunque el producto esté archivado.
        counters.archivadosSalteados++;
      } else if (conflictivo) {
        // Identidad ambigua ⇒ no se toca NADA de ese producto (tampoco su quality):
        // primero lo resuelve una persona. El contador de conflicto ya lo cuenta.
      } else if (args.mode === 'preview') {
        counters.qualityCalculada++;
      } else {
        const r = await args.store.backfillQuality(p.id, (fresh) =>
          evaluateProductQuality(fresh, {
            profile: args.profile,
            localNames: namesExcept(fresh),
            origin: 'system',
            now: now(),
          }),
        );
        if (r.outcome === 'written') counters.qualityCalculada++;
        else if (r.outcome === 'already') counters.qualityVigente++;
        else if (r.outcome === 'error') {
          // Un error de transacción NO es un producto inexistente: se cuenta y sella
          // lastError — el run NUNCA termina con lastError vacío si hubo errores.
          counters.erroresQuality++;
          lastError = `No se pudo escribir la quality de ${p.id}: ${r.error ?? 'error de transacción'}`.slice(0, 300);
        }
        // 'missing': el producto desapareció entre la página y la escritura — no se cuenta.
      }
    }

    cursor = page.nextCursor;
    pagesDone++;
    const status = cursor === null ? 'completed' : 'running';
    await args.store.saveProgress({ status, cursor, pagesDone, counters, conflicts, conflictsTruncated, lastError });
    if (status === 'completed') return resultado({ status: 'completed' });
  }

  return resultado({ status: 'running', stopReason: 'pages_budget' });
}

// ---------------------------------------------------------------------------
// Doc del run + store real (Firestore) — lo usa el callable
// ---------------------------------------------------------------------------

/** Doc de la corrida (`tenants/{t}/metaCatalogMaintenanceRuns/{runId}`). Cerrado por rules. */
export interface MetaCatalogMaintenanceRunDoc {
  runId: string;
  tenantId: string;
  mode: 'preview' | 'apply';
  status: 'running' | 'completed' | 'failed';
  cursor: string | null;
  pagesDone: number;
  counters: MetaCatalogMaintenanceCounters;
  conflicts: MetaCatalogMaintenanceConflict[];
  conflictsTruncated: boolean;
  actorUid: string | null;
  lastError: string;
  /**
   * (ADR-0014 §4b/4c) Política NORMALIZADA fijada al run en su CREACIÓN — igual que el
   * import run: todas las páginas de una corrida se evalúan con la MISMA política aunque
   * `config/catalog.profile` cambie a mitad. Las reanudaciones usan LA DEL RUN.
   */
  profile: CatalogQualityProfile | null;
  startedAt: Timestamp;
  updatedAt: Timestamp;
  finishedAt: Timestamp | null;
}

export function firestoreMaintenanceStore(args: { tenantId: string; runId: string }): MaintenanceStore {
  const { tenantId, runId } = args;
  return {
    async listProductsPage(cursor, pageSize) {
      let q = db().collection(paths.products(tenantId)).orderBy(FieldPath.documentId()).limit(pageSize);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      const products = snap.docs.map((d) => ({ ...(d.data() as Product), id: d.id }));
      // Cursor = último id SOLO si la página vino llena (una página corta es la última).
      const nextCursor = snap.size === pageSize ? snap.docs[snap.size - 1]!.id : null;
      return { products, nextCursor };
    },

    async loadNameCounts() {
      const snap = await db().collection(paths.products(tenantId)).select('name', 'status').get();
      const out = new Map<string, number>();
      for (const d of snap.docs) {
        const data = d.data() as { name?: string; status?: string };
        if (data.status === 'ARCHIVED') continue;
        const n = normalizeText(data.name);
        if (n) out.set(n, (out.get(n) ?? 0) + 1);
      }
      return out;
    },

    async productsClaimingRid(retailerId) {
      const snap = await db()
        .collection(paths.products(tenantId))
        .where('metaRetailerId', '==', retailerId)
        .select()
        .limit(5)
        .get();
      return snap.docs.map((d) => d.id);
    },

    async getLockOwner(lockKey) {
      const snap = await db().doc(paths.metaRetailerLock(tenantId, lockKey)).get();
      return (snap.data() as { productId?: string } | undefined)?.productId ?? null;
    },

    async createLock({ lockKey, retailerId, productId }) {
      const ref = db().doc(paths.metaRetailerLock(tenantId, lockKey));
      return db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const owner = (snap.data() as { productId?: string } | undefined)?.productId;
        if (snap.exists) return owner === productId ? ('exists_own' as const) : ('exists_other' as const);
        tx.create(ref, { retailerId, productId, tenantId, createdAt: Timestamp.now() });
        return 'created' as const;
      });
    },

    async backfillQuality(productId, evaluate) {
      const ref = db().doc(paths.product(tenantId, productId));
      try {
        return await db().runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) return { outcome: 'missing' as const };
          const fresh = { ...(snap.data() as Product), id: snap.id };
          // Si OTRO camino (productUpsert / import) escribió quality entre la página y acá,
          // NO se pisa: la del editor es más fresca que la nuestra.
          if (fresh.quality) return { outcome: 'already' as const };
          // `update` de UN solo campo: jamás toca nombre/precio/stock/status/mapping/sync,
          // y no toca updatedAt — el mantenimiento no es una edición humana.
          tx.update(ref, { quality: evaluate(fresh) });
          return { outcome: 'written' as const };
        });
      } catch (e) {
        const detalle = e instanceof Error ? e.message.slice(0, 200) : 'desconocido';
        logger.warn('Mantenimiento de catálogo: no se pudo backfillear quality', {
          tenantId,
          runId,
          productId,
          error: detalle,
        });
        // (ADR-0014 §4c) Error de transacción ≠ producto inexistente: el core lo cuenta en
        // `erroresQuality` y sella lastError — jamás se disfraza de 'missing'.
        return { outcome: 'error', error: detalle };
      }
    },

    async saveProgress(patch) {
      const now = Timestamp.now();
      const ref = db().doc(paths.metaCatalogMaintenanceRun(tenantId, runId));
      await db().runTransaction(async (tx) => {
        const run = (await tx.get(ref)).data() as MetaCatalogMaintenanceRunDoc | undefined;
        // Guard 1 (ADR-0014 §4c): jamás escribir sobre un run que ya no está 'running'. El
        // worker LENTO de un runId reanudado dos veces no pisa el cierre del rápido (un
        // patch 'running' sobre 'completed' dejaría finishedAt fantasma + cursor resucitado).
        if (!run || run.status !== 'running') {
          logger.warn('Mantenimiento de catálogo: escritura sobre un run no-running DESCARTADA', {
            tenantId,
            runId,
            status: run?.status ?? 'inexistente',
          });
          return;
        }
        // Guard 2: cursor/contadores jamás retroceden (espejo de importProgressRegression).
        // Una regresión indica un llamador con estado viejo — se descarta con constancia.
        const regresion = maintenanceProgressRegression(run, patch);
        if (regresion) {
          logger.error('Mantenimiento de catálogo: escritura de progreso REGRESIVA descartada', { tenantId, runId, regresion });
          return;
        }
        tx.update(ref, {
          status: patch.status,
          cursor: patch.cursor,
          pagesDone: patch.pagesDone,
          counters: patch.counters,
          conflicts: patch.conflicts,
          conflictsTruncated: patch.conflictsTruncated,
          lastError: patch.lastError ?? '',
          updatedAt: now,
          ...(patch.status === 'completed' ? { finishedAt: now } : {}),
        });
      });
    },
  };
}
