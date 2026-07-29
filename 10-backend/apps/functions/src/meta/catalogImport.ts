/**
 * meta/catalogImport.ts — Núcleo de la importación PAGINADA y reanudable
 * ======================================================================
 * (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1) Procesa el catálogo de Meta por páginas con
 * cursor persistido. La orquestación (claim del run, lease, callable) vive en
 * `functions/meta/catalogImportCallables.ts`; acá está lo testeable:
 *
 *  - `classifyPageItems` (PURO): la clasificación por ítem, misma semántica que el import
 *    clásico pero generalizada: duplicado probable IMPORTA con observación; sin categoría
 *    IMPORTA como borrador sin clasificar (el callable viejo `metaCatalogImportItems`
 *    conserva su contrato: categoría obligatoria).
 *  - `runImportPages`: hasta N páginas por invocación. Escrituras POR ÍTEM idempotentes
 *    (docId determinístico `meta_<lockKey>` + lock del retailer_id EN LA MISMA transacción:
 *    el import clásico no tomaba el lock y permitía el doble vínculo vía confirmMapping).
 *    ALREADY_EXISTS se cuenta como `alreadyImported`, jamás aborta la página. El cursor y
 *    los contadores se persisten DESPUÉS de cada página: un crash reanuda desde ahí, y
 *    re-procesar una página ya escrita es un no-op declarado.
 *  - Cursor de Graph vencido/adulterado ⇒ reset a null con `cursorResets++` y el barrido
 *    continúa desde el principio (barato: los ya creados caen en `alreadyImported`).
 *  - (HARDEN-1) FENCING GENERACIONAL: cada claim del run lleva una `generation` inmutable
 *    (número creciente en el puntero `metaCatalogImportState/current`, copiado al run).
 *    TODA escritura posterior al claim demuestra ownership TRANSACCIONALMENTE (el run sigue
 *    `running` con ESA generación) antes de aplicar: crear producto+lock, marcar drift,
 *    renovar la lease (heartbeat verificado, jamás ciego), guardar cursor/contadores,
 *    cerrar el run y liberar el puntero. Un worker vencido no escribe NADA
 *    (`ImportRunClaimLostError` ⇒ la invocación termina con `stopReason: 'claim_lost'`).
 *    Cursor y contadores JAMÁS retroceden (guard monotónico en `saveProgress`).
 *
 * El acceso a Firestore está detrás de `ImportRunStore` (misma costura inyectable que el
 * `CatalogTransport` del cliente): los tests unitarios ejercitan cursores/idempotencia/
 * fencing sin emulador y el callable usa la implementación real de abajo.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { CatalogQualityProfile, MetaCatalogImportCounters, Product } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { effectiveCatalogPolicy, evaluateProductQuality, localNameSet } from '../products/quality.js';
import { isInvalidCatalogCursor, MetaCatalogApiError, type MetaCatalogClient, type MetaCatalogItemsPage } from './catalogClient.js';
import {
  analyzeRemoteItems,
  buildImportedProduct,
  buildRemoteTokenIndex,
  normalizeText,
  rankMappingCandidates,
  retailerIdLockKey,
  type RemoteCandidate,
} from './catalogReconcile.js';

export const emptyImportCounters = (): MetaCatalogImportCounters => ({
  imported: 0,
  alreadyLinked: 0,
  alreadyImported: 0,
  ambiguous: 0,
  conflicted: 0,
  skipped: 0,
  unclassified: 0,
  cursorResets: 0,
});

// ---------------------------------------------------------------------------
// Clasificación por ítem (PURA)
// ---------------------------------------------------------------------------

/** Vista mínima de un producto YA importado para detectar drift sin releer Firestore. */
export interface ImportedLocalLite {
  productId: string;
  name: string;
  price: number;
  description: string;
  imageUrl: string;
}

export interface ClassifyPageContext {
  /** retailer_ids reclamados por un vínculo confirmado (metaRetailerId de productos locales). */
  mappedRids: ReadonlySet<string>;
  /** Importados previos (doc `meta_<lockKey>`) por retailer_id. */
  importedByRid: ReadonlyMap<string, ImportedLocalLite>;
  /**
   * SKUs de productos locales NO importados que coinciden con un retailer_id remoto. Es un
   * CONFLICTO (`sku_taken_by_local`), no una importación previa: el import clásico los
   * reportaba como `already_imported` y mentía.
   */
  localSkuRids: ReadonlySet<string>;
  /** Candidatos fuertes de mapping local (requieren humano: jamás se importan solos). */
  strongCandidateRids: ReadonlySet<string>;
  /** Categoría destino del run. '' ⇒ borrador «sin clasificar» (importa igual). */
  defaultCategoryId: string;
}

export type ClassifiedImportItem =
  | { kind: 'already_linked'; item: RemoteCandidate }
  | { kind: 'already_imported'; item: RemoteCandidate; productId: string; driftFields: string[] }
  | { kind: 'ambiguous'; item: RemoteCandidate; reason: 'strong_mapping_candidate' }
  | { kind: 'conflicted'; item: RemoteCandidate; reason: 'sku_taken_by_local' }
  | { kind: 'skipped'; item: RemoteCandidate; reason: 'invalid_price' | 'image_not_https' }
  | { kind: 'importable'; item: RemoteCandidate; categoryId: string; unclassified: boolean };

/** Diferencias importado↔remoto (el precio remoto no parseable no se compara). */
function driftFieldsOf(local: ImportedLocalLite, item: RemoteCandidate): string[] {
  const out: string[] = [];
  if (item.name.trim() !== local.name.trim()) out.push('name');
  if (item.priceGs > 0 && item.priceGs !== local.price) out.push('price');
  if (item.description.trim() !== local.description.trim()) out.push('description');
  if (item.imageUrl.trim() !== local.imageUrl.trim()) out.push('image');
  return out;
}

/**
 * Clasificación por ítem del run genérico. El ORDEN de los chequeos es contrato:
 * vinculado > importado > ambiguo > conflicto de SKU > flags bloqueantes > importable.
 */
export function classifyPageItems(items: readonly RemoteCandidate[], ctx: ClassifyPageContext): ClassifiedImportItem[] {
  return items.map((item) => {
    const rid = item.retailerId;
    if (ctx.mappedRids.has(rid)) return { kind: 'already_linked' as const, item };
    const importado = ctx.importedByRid.get(rid);
    if (importado) {
      return { kind: 'already_imported' as const, item, productId: importado.productId, driftFields: driftFieldsOf(importado, item) };
    }
    if (ctx.strongCandidateRids.has(rid)) return { kind: 'ambiguous' as const, item, reason: 'strong_mapping_candidate' as const };
    if (ctx.localSkuRids.has(rid)) return { kind: 'conflicted' as const, item, reason: 'sku_taken_by_local' as const };
    // Flags BLOQUEANTES del análisis remoto (los WARNING no frenan: quedan como observación).
    if (item.flags.includes('invalid_price')) return { kind: 'skipped' as const, item, reason: 'invalid_price' as const };
    if (item.flags.includes('image_not_https')) return { kind: 'skipped' as const, item, reason: 'image_not_https' as const };
    const categoryId = ctx.defaultCategoryId.trim();
    return { kind: 'importable' as const, item, categoryId, unclassified: !categoryId };
  });
}

/**
 * Candidatos FUERTES de mapping calculados POR PÁGINA. El ranking es ítem-a-ítem (jaccard),
 * así que evaluarlo por página es equivalente a hacerlo sobre el catálogo entero.
 * Las `stopwords` son la política del tenant: DEBEN ser las mismas del resto del análisis.
 */
export function strongCandidateRidsForPage(
  unlinkedProducts: readonly Product[],
  candidates: readonly RemoteCandidate[],
  stopwords?: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  if (!unlinkedProducts.length || !candidates.length) return out;
  const index = buildRemoteTokenIndex([...candidates], stopwords);
  for (const p of unlinkedProducts) {
    for (const c of rankMappingCandidates(p, [...candidates], { index, limit: 3, minConfidence: 'alta', stopwords })) {
      out.add(c.retailerId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run paginado
// ---------------------------------------------------------------------------

export interface ImportLocalIndex {
  mappedRids: Set<string>;
  importedByRid: Map<string, ImportedLocalLite>;
  localSkuRids: Set<string>;
  /** Nombres normalizados no archivados (para probable_duplicate del evaluador). */
  localNames: Set<string>;
  /** Productos vivos sin vínculo (para el bloqueo por candidato fuerte). */
  unlinkedProducts: Product[];
  /** Cantidad total de productos (base determinística de `position`). */
  productsCount: number;
}

export interface ImportProgressPatch {
  status: 'running' | 'completed';
  cursor: string | null;
  counters: MetaCatalogImportCounters;
  blockedByReason: Record<string, number>;
  pagesDone: number;
  processed: number;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Fencing generacional (HARDEN-1)
// ---------------------------------------------------------------------------

/**
 * El claim de este worker ya no es el vigente: otro worker reclamó el run con una
 * generación nueva (o el run dejó de estar `running`). El worker vencido NO escribe nada
 * más — ni productos, ni locks, ni cursor, ni contadores, ni estado, ni puntero. La campana
 * agregada es BEST-EFFORT declarada (ADR-0014 §4b, no fenceada): la única garantía es que
 * un worker que YA SABE que perdió el claim tampoco la refresca.
 */
export class ImportRunClaimLostError extends Error {
  constructor(detail = 'El claim del run de importación ya no es el vigente.') {
    super(detail);
    this.name = 'ImportRunClaimLostError';
  }
}

/**
 * Predicado ÚNICO de ownership (puro): el run sigue en vuelo Y su generación es EXACTAMENTE
 * la que fijó el claim de este worker. Cualquier otra cosa ⇒ cero escrituras (mismo patrón
 * que `settleIfOwner` de lib/outboxFencing.ts, con generación dedicada en vez de attempts).
 */
export const ownsImportRun = (
  run: { status?: string; generation?: number } | null | undefined,
  generation: number,
): boolean => !!run && run.status === 'running' && (run.generation ?? 0) === generation;

/**
 * Guard monotónico del progreso (puro): cursor y contadores JAMÁS retroceden. Devuelve la
 * razón de la regresión o null si el patch es aplicable. `cursor` no se compara (un reset
 * legítimo lo vuelve null contando `cursorResets`): la monotonicidad vive en los contadores.
 */
export function importProgressRegression(
  current: { pagesDone?: number; processed?: number; counters?: Partial<MetaCatalogImportCounters> },
  patch: Pick<ImportProgressPatch, 'pagesDone' | 'processed' | 'counters'>,
): string | null {
  if (patch.pagesDone < (current.pagesDone ?? 0)) return `pagesDone ${patch.pagesDone} < ${current.pagesDone}`;
  if (patch.processed < (current.processed ?? 0)) return `processed ${patch.processed} < ${current.processed}`;
  for (const [k, v] of Object.entries(current.counters ?? {})) {
    const nuevo = patch.counters[k as keyof MetaCatalogImportCounters];
    if (typeof v === 'number' && typeof nuevo === 'number' && nuevo < v) return `counters.${k} ${nuevo} < ${v}`;
  }
  return null;
}

/**
 * Costura de persistencia del run. La implementación real (abajo) escribe en Firestore con
 * transacción por ítem que VERIFICA el ownership generacional; los tests inyectan una en
 * memoria. Cualquier método puede lanzar `ImportRunClaimLostError`: el run loop corta ahí.
 */
export interface ImportRunStore {
  loadLocalIndex(): Promise<ImportLocalIndex>;
  /**
   * Crea el producto importado + el lock del retailer_id EN LA MISMA transacción.
   * Idempotente por ítem: producto ya existente ⇒ 'already_imported' (y backfill del lock
   * si faltaba); lock en manos de OTRO producto ⇒ 'lock_conflict'. Jamás pisa nada.
   */
  createImported(args: { productId: string; lockKey: string; retailerId: string; doc: Record<string, unknown> }): Promise<'created' | 'already_imported' | 'lock_conflict'>;
  /** Recomputa la calidad del importado con el snapshot remoto (observación remote_drift). */
  markRemoteDrift(productId: string, item: RemoteCandidate, driftFields: string[]): Promise<void>;
  /** Persiste cursor + contadores DESPUÉS de cada página (y renueva la lease del run). */
  saveProgress(patch: ImportProgressPatch): Promise<void>;
}

export interface RunImportArgs {
  tenantId: string;
  catalogId: string;
  client: Pick<MetaCatalogClient, 'listItemsPage'>;
  store: ImportRunStore;
  /** Estado reanudado del run (cursor/contadores persistidos de la invocación anterior). */
  cursor: string | null;
  counters: MetaCatalogImportCounters;
  blockedByReason: Record<string, number>;
  pagesDone: number;
  processed: number;
  /** Presupuesto de páginas de ESTA invocación (un intento fallido también consume). */
  maxPages: number;
  defaultCategoryId: string;
  profile: CatalogQualityProfile | null;
  /** Cuota del plan: lanza si el delta no entra. Al agotarse el run PAUSA, no pierde nada. */
  assertQuota?: (delta: number) => Promise<void>;
  now?: () => Timestamp;
}

export interface RunImportResult {
  status: 'running' | 'completed';
  cursor: string | null;
  counters: MetaCatalogImportCounters;
  blockedByReason: Record<string, number>;
  pagesDone: number;
  processed: number;
  /**
   * Por qué se cortó una invocación que quedó `running`. `claim_lost` = otro worker reclamó
   * el run con una generación nueva: este worker NO escribió nada más (el estado de este
   * resultado es solo informativo — la verdad la tiene el run doc del claim vigente).
   */
  stopReason?: 'pages_budget' | 'quota' | 'remote_error' | 'claim_lost';
  lastError?: string;
}

const sumar = (mapa: Record<string, number>, razon: string): void => {
  mapa[razon] = (mapa[razon] ?? 0) + 1;
};

export async function runImportPages(args: RunImportArgs): Promise<RunImportResult> {
  const now = args.now ?? (() => Timestamp.now());
  const counters = { ...args.counters };
  const blockedByReason = { ...args.blockedByReason };
  let cursor = args.cursor;
  let pagesDone = args.pagesDone;
  let processed = args.processed;
  const index = await args.store.loadLocalIndex();
  // Política EFECTIVA del tenant (HARDEN-1): sin perfil ⇒ generic. Se resuelve UNA vez por
  // invocación y se propaga a TODO el análisis (flags remotos, matching, construcción).
  const policy = effectiveCatalogPolicy(args.profile);
  let creadosEnRun = 0;

  const resultado = (extra: Partial<RunImportResult> & { status: 'running' | 'completed' }): RunImportResult => ({
    cursor,
    counters,
    blockedByReason,
    pagesDone,
    processed,
    ...extra,
  });

  try {
    return await procesarPaginas();
  } catch (e) {
    if (e instanceof ImportRunClaimLostError) {
      // Otro worker es el dueño vigente: NADA más se escribe (ni saveProgress — fallaría
      // igual). El resultado es informativo; la verdad durable la tiene el claim nuevo.
      logger.warn('Import de catálogo: claim perdido, el worker se retira sin escribir', { tenantId: args.tenantId });
      return resultado({ status: 'running', stopReason: 'claim_lost', lastError: e.message });
    }
    throw e;
  }

  async function procesarPaginas(): Promise<RunImportResult> {
    for (let intento = 0; intento < args.maxPages; intento++) {
      let page: MetaCatalogItemsPage;
      try {
        page = await args.client.listItemsPage(args.catalogId, cursor);
      } catch (e) {
        if (isInvalidCatalogCursor(e)) {
          // Cursor vencido/adulterado: se REINICIA el barrido desde cero. Es seguro y barato:
          // la idempotencia por docId convierte lo ya creado en `alreadyImported`.
          counters.cursorResets++;
          cursor = null;
          await args.store.saveProgress({ status: 'running', cursor, counters, blockedByReason, pagesDone, processed });
          continue; // el reset consume presupuesto: un cursor SIEMPRE inválido no loopea
        }
        const detalle = e instanceof MetaCatalogApiError ? e.message.slice(0, 300) : 'No se pudo leer el catálogo de Meta.';
        await args.store.saveProgress({ status: 'running', cursor, counters, blockedByReason, pagesDone, processed, lastError: detalle });
        return resultado({ status: 'running', stopReason: 'remote_error', lastError: detalle });
      }

      // Análisis de calidad remota por página (byDesc intra-página; los duplicados contra el
      // catálogo LOCAL — incluidos los importados de páginas anteriores — los ve el evaluador
      // vía `localNames`, que se acumula durante el run). Stopwords: las de la política.
      const candidatos = analyzeRemoteItems(page.items, { stopwords: policy.stopwords });
      const fuertes = strongCandidateRidsForPage(index.unlinkedProducts, candidatos, policy.stopwords);
      const clasificados = classifyPageItems(candidatos, {
        mappedRids: index.mappedRids,
        importedByRid: index.importedByRid,
        localSkuRids: index.localSkuRids,
        strongCandidateRids: fuertes,
        defaultCategoryId: args.defaultCategoryId,
      });

      // Cuota ANTES de escribir la página: agotarla PAUSA el run con estado explícito y
      // reanudable tras el upgrade — jamás un throw que pierda el progreso.
      const importables = clasificados.filter((c) => c.kind === 'importable');
      if (importables.length && args.assertQuota) {
        try {
          await args.assertQuota(importables.length);
        } catch (e) {
          const detalle = `Cuota de productos del plan agotada: ${e instanceof Error ? e.message.slice(0, 200) : 'límite alcanzado'}`;
          await args.store.saveProgress({ status: 'running', cursor, counters, blockedByReason, pagesDone, processed, lastError: detalle });
          return resultado({ status: 'running', stopReason: 'quota', lastError: detalle });
        }
      }

      for (const c of clasificados) {
        processed++;
        switch (c.kind) {
          case 'already_linked':
            counters.alreadyLinked++;
            break;
          case 'already_imported': {
            counters.alreadyImported++;
            if (c.driftFields.length) {
              // El remoto cambió respecto de lo importado: observación en el producto local.
              // JAMÁS se pisa el doc local con datos remotos.
              await args.store.markRemoteDrift(c.productId, c.item, c.driftFields);
            }
            break;
          }
          case 'ambiguous':
            counters.ambiguous++;
            sumar(blockedByReason, c.reason);
            break;
          case 'conflicted':
            counters.conflicted++;
            sumar(blockedByReason, c.reason);
            break;
          case 'skipped':
            counters.skipped++;
            sumar(blockedByReason, c.reason);
            break;
          case 'importable': {
            const lockKey = retailerIdLockKey(c.item.retailerId);
            const productId = `meta_${lockKey}`;
            const base = buildImportedProduct(c.item, {
              productId,
              tenantId: args.tenantId,
              categoryId: c.categoryId,
              catalogId: args.catalogId,
              position: index.productsCount + creadosEnRun,
              vertical: policy.vertical,
            });
            // La calidad nace CON el producto (origin 'import'): el centro de calidad no
            // necesita otra pasada. Los nombres locales acumulan lo importado en este run,
            // así el segundo homónimo de un catálogo con duplicados queda marcado.
            const quality = evaluateProductQuality(base as unknown as Product, {
              profile: args.profile,
              localNames: index.localNames,
              origin: 'import',
              remoteHasIdentity: true,
              now: now(),
            });
            const doc = { ...base, quality, createdAt: now(), updatedAt: now() };
            const outcome = await args.store.createImported({ productId, lockKey, retailerId: c.item.retailerId, doc });
            if (outcome === 'created') {
              counters.imported++;
              if (c.unclassified) counters.unclassified++;
              creadosEnRun++;
              const n = normalizeText(c.item.name);
              if (n) index.localNames.add(n);
              index.importedByRid.set(c.item.retailerId, {
                productId,
                name: c.item.name,
                price: c.item.priceGs,
                description: c.item.description,
                imageUrl: c.item.imageUrl,
              });
            } else if (outcome === 'already_imported') {
              // Otra invocación/carrera lo creó: es EXACTAMENTE el no-op declarado que exige
              // la reanudación idempotente. Jamás aborta el resto de la página.
              counters.alreadyImported++;
            } else {
              counters.conflicted++;
              sumar(blockedByReason, 'retailer_id_lock_taken');
            }
            break;
          }
        }
      }

      cursor = page.nextCursor;
      pagesDone++;
      const status = cursor === null ? 'completed' : 'running';
      // El progreso se persiste DESPUÉS de commitear la página: un crash acá reanuda desde
      // este cursor y re-procesar la página anterior es un no-op (docIds determinísticos).
      await args.store.saveProgress({ status, cursor, counters, blockedByReason, pagesDone, processed });
      if (status === 'completed') return resultado({ status: 'completed' });
    }

    return resultado({ status: 'running', stopReason: 'pages_budget' });
  }
}

// ---------------------------------------------------------------------------
// Store real (Firestore) — lo usa el callable
// ---------------------------------------------------------------------------

/** Doc del run (`tenants/{t}/metaCatalogImportRuns/{runId}`). Cerrado al cliente por rules. */
export interface MetaCatalogImportRunDoc {
  runId: string;
  tenantId: string;
  catalogId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  cursor: string | null;
  pagesDone: number;
  processed: number;
  counters: MetaCatalogImportCounters;
  blockedByReason: Record<string, number>;
  defaultCategoryId: string;
  /**
   * (ADR-0014 §4b) Política NORMALIZADA fijada al run en su CREACIÓN (igual que
   * `defaultCategoryId`): todas las páginas de un run se procesan con la MISMA política
   * aunque `config/catalog.profile` cambie a mitad. Los claims siguientes usan LA DEL RUN.
   */
  profile: CatalogQualityProfile | null;
  leaseUntil: Timestamp | null;
  attempts: number;
  /**
   * Generación de FENCING (HARDEN-1): número creciente que vive en el puntero
   * `metaCatalogImportState/current` y se copia acá en CADA claim (creación o takeover de
   * lease vencida). Inmutable durante el claim: toda escritura del worker la verifica.
   */
  generation: number;
  actorUid: string | null;
  lastError: string;
  startedAt: Timestamp;
  updatedAt: Timestamp;
  finishedAt: Timestamp | null;
}

/** Lease del run: idéntica a la del outbox (un solo worker por run). */
export const IMPORT_RUN_LEASE_MS = 120_000;

/**
 * Asienta `patch` sobre el run SOLO si este worker sigue siendo el dueño vigente
 * (status `running` + generación del claim). Para las escrituras administrativas del
 * callable (liberar lease entre invocaciones, registrar lastError): jamás una escritura
 * ciega sobre un run que otro worker ya reclamó.
 */
export async function settleImportRunIfOwner(
  tenantId: string,
  runId: string,
  generation: number,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const ref = db().doc(paths.metaCatalogImportRun(tenantId, runId));
  return db().runTransaction(async (tx) => {
    const run = (await tx.get(ref)).data() as MetaCatalogImportRunDoc | undefined;
    if (!ownsImportRun(run, generation)) return false;
    tx.update(ref, { ...patch, updatedAt: Timestamp.now() });
    return true;
  });
}

export function firestoreImportStore(args: {
  tenantId: string;
  runId: string;
  profile: CatalogQualityProfile | null;
  /** Generación fijada por el claim de ESTE worker (fencing). */
  generation: number;
}): ImportRunStore {
  const { tenantId, runId, profile, generation } = args;
  const runRef = () => db().doc(paths.metaCatalogImportRun(tenantId, runId));
  const stateRef = () => db().doc(paths.metaCatalogImportState(tenantId));
  return {
    async loadLocalIndex(): Promise<ImportLocalIndex> {
      const snap = await db().collection(paths.products(tenantId)).get();
      const products = snap.docs.map((d) => ({ ...(d.data() as Product), id: d.id }));
      const mappedRids = new Set<string>();
      const importedByRid = new Map<string, ImportedLocalLite>();
      const localSkuRids = new Set<string>();
      for (const p of products) {
        const rid = (p.metaRetailerId ?? '').trim();
        const sku = (p.inventory?.sku ?? '').trim();
        if (rid && p.id === `meta_${retailerIdLockKey(rid)}`) {
          // Importado por este flujo: identidad remota propia (docId determinístico).
          importedByRid.set(rid, {
            productId: p.id,
            name: p.name ?? '',
            price: Number(p.price ?? 0),
            description: p.description ?? '',
            imageUrl: (p.images ?? [])[0] ?? '',
          });
        } else if (rid) {
          mappedRids.add(rid);
        }
        // SKU de un producto NO importado que podría chocar con un retailer_id remoto.
        if (sku && !rid) localSkuRids.add(sku);
      }
      return {
        mappedRids,
        importedByRid,
        localSkuRids,
        localNames: localNameSet(products),
        unlinkedProducts: products.filter((p) => p.status !== 'ARCHIVED' && !(p.metaRetailerId ?? '').trim()),
        productsCount: products.length,
      };
    },

    async createImported({ productId, lockKey, retailerId, doc }): Promise<'created' | 'already_imported' | 'lock_conflict'> {
      const prodRef = db().doc(paths.product(tenantId, productId));
      const lockRef = db().doc(paths.metaRetailerLock(tenantId, lockKey));
      try {
        return await db().runTransaction(async (tx) => {
          const [runSnap, prodSnap, lockSnap] = await Promise.all([tx.get(runRef()), tx.get(prodRef), tx.get(lockRef)]);
          // FENCING: el ownership se demuestra EN LA MISMA transacción que crea el
          // producto+lock. Un worker vencido no puede crear nada en el catálogo de B.
          if (!ownsImportRun(runSnap.data() as MetaCatalogImportRunDoc | undefined, generation)) {
            throw new ImportRunClaimLostError();
          }
          const lockOwner = (lockSnap.data() as { productId?: string } | undefined)?.productId;
          if (lockSnap.exists && lockOwner && lockOwner !== productId) return 'lock_conflict' as const;
          const lock = { retailerId, productId, tenantId, createdAt: Timestamp.now() };
          if (prodSnap.exists) {
            // Ya importado (por este run, otro concurrente o el callable clásico). BACKFILL
            // del lock que el import clásico nunca escribió: cierra el doble vínculo
            // importar→confirmMapping sin tocar el producto.
            if (!lockSnap.exists) tx.create(lockRef, lock);
            return 'already_imported' as const;
          }
          // Producto + lock EN LA MISMA transacción: si otro proceso reclama el retailer_id
          // en paralelo, una de las dos transacciones pierde — jamás quedan dos dueños.
          tx.create(prodRef, doc);
          if (!lockSnap.exists) tx.create(lockRef, lock);
          return 'created' as const;
        });
      } catch (e) {
        if (e instanceof ImportRunClaimLostError) throw e;
        const code = (e as { code?: number | string }).code;
        if (code === 6 || code === 'already-exists') return 'already_imported'; // carrera perdida = ya está
        throw e;
      }
    },

    async markRemoteDrift(productId, item, _driftFields): Promise<void> {
      try {
        const ref = db().doc(paths.product(tenantId, productId));
        await db().runTransaction(async (tx) => {
          const [runSnap, snap] = await Promise.all([tx.get(runRef()), tx.get(ref)]);
          // FENCING: un worker vencido tampoco toca la calidad de un producto ajeno al claim.
          if (!ownsImportRun(runSnap.data() as MetaCatalogImportRunDoc | undefined, generation)) {
            throw new ImportRunClaimLostError();
          }
          if (!snap.exists) return;
          const p = { ...(snap.data() as Product), id: snap.id };
          const quality = evaluateProductQuality(p, {
            profile,
            previous: p.quality ?? null,
            remoteSnapshot: { name: item.name, priceGs: item.priceGs, description: item.description, imageUrl: item.imageUrl },
            origin: 'import',
            now: Timestamp.now(),
          });
          // `update` de UN campo: reemplaza el mapa entero (un set con merge resucitaría
          // fingerprints podados) y no toca updatedAt — el barrido no es una edición humana.
          tx.update(ref, { quality });
        });
      } catch (e) {
        if (e instanceof ImportRunClaimLostError) throw e;
        // El aviso de drift jamás frena la importación.
        logger.warn('Import de catálogo: no se pudo registrar el drift remoto', { tenantId, runId, productId, error: e instanceof Error ? e.message.slice(0, 200) : 'desconocido' });
      }
    },

    async saveProgress(patch): Promise<void> {
      const now = Timestamp.now();
      await db().runTransaction(async (tx) => {
        const [runSnap, stateSnap] = await Promise.all([tx.get(runRef()), tx.get(stateRef())]);
        const run = runSnap.data() as MetaCatalogImportRunDoc | undefined;
        // FENCING: renovar la lease es un HEARTBEAT VERIFICADO (jamás una renovación ciega)
        // y el cursor/contadores solo los persiste el dueño vigente.
        if (!ownsImportRun(run, generation)) throw new ImportRunClaimLostError();
        // Guard monotónico: cursor y contadores JAMÁS retroceden. Una regresión indica un
        // bug del llamador — se descarta la escritura y se deja constancia, nunca se pisa
        // progreso ya durable.
        const regresion = importProgressRegression(run ?? {}, patch);
        if (regresion) {
          logger.error('Import de catálogo: escritura de progreso REGRESIVA descartada', { tenantId, runId, regresion });
          return;
        }
        tx.update(runRef(), {
          status: patch.status,
          cursor: patch.cursor,
          counters: patch.counters,
          blockedByReason: patch.blockedByReason,
          pagesDone: patch.pagesDone,
          processed: patch.processed,
          lastError: patch.lastError ?? '',
          updatedAt: now,
          // La lease se renueva con cada página; al completar se libera.
          leaseUntil: patch.status === 'completed' ? null : Timestamp.fromMillis(now.toMillis() + IMPORT_RUN_LEASE_MS),
          ...(patch.status === 'completed' ? { finishedAt: now } : {}),
        });
        if (patch.status === 'completed') {
          // Liberar el puntero es parte del MISMO settle (y solo si sigue apuntando acá):
          // un worker vencido jamás suelta el run activo de otro.
          const state = stateSnap.data() as { activeRunId?: string | null } | undefined;
          if (state?.activeRunId === runId) {
            tx.set(stateRef(), { activeRunId: null, lastRunId: runId, updatedAt: now }, { merge: true });
          }
        }
      });
    },
  };
}
