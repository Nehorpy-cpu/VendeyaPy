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
 *
 * El acceso a Firestore está detrás de `ImportRunStore` (misma costura inyectable que el
 * `CatalogTransport` del cliente): los tests unitarios ejercitan cursores/idempotencia sin
 * emulador y el callable usa la implementación real de abajo.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { CatalogQualityProfile, MetaCatalogImportCounters, Product } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { evaluateProductQuality, localNameSet } from '../products/quality.js';
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
 */
export function strongCandidateRidsForPage(unlinkedProducts: readonly Product[], candidates: readonly RemoteCandidate[]): Set<string> {
  const out = new Set<string>();
  if (!unlinkedProducts.length || !candidates.length) return out;
  const index = buildRemoteTokenIndex([...candidates]);
  for (const p of unlinkedProducts) {
    for (const c of rankMappingCandidates(p, [...candidates], { index, limit: 3, minConfidence: 'alta' })) {
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

/**
 * Costura de persistencia del run. La implementación real (abajo) escribe en Firestore con
 * transacción por ítem; los tests inyectan una en memoria.
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
  /** Por qué se cortó una invocación que quedó `running`. */
  stopReason?: 'pages_budget' | 'quota' | 'remote_error';
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
  const vertical = args.profile?.vertical ?? 'perfumeria';
  let creadosEnRun = 0;

  const resultado = (extra: Partial<RunImportResult> & { status: 'running' | 'completed' }): RunImportResult => ({
    cursor,
    counters,
    blockedByReason,
    pagesDone,
    processed,
    ...extra,
  });

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
    // vía `localNames`, que se acumula durante el run).
    const candidatos = analyzeRemoteItems(page.items);
    const fuertes = strongCandidateRidsForPage(index.unlinkedProducts, candidatos);
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
            vertical,
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
  leaseUntil: Timestamp | null;
  attempts: number;
  actorUid: string | null;
  lastError: string;
  startedAt: Timestamp;
  updatedAt: Timestamp;
  finishedAt: Timestamp | null;
}

/** Lease del run: idéntica a la del outbox (un solo worker por run). */
export const IMPORT_RUN_LEASE_MS = 120_000;

export function firestoreImportStore(args: {
  tenantId: string;
  runId: string;
  profile: CatalogQualityProfile | null;
}): ImportRunStore {
  const { tenantId, runId, profile } = args;
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
          const [prodSnap, lockSnap] = await Promise.all([tx.get(prodRef), tx.get(lockRef)]);
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
        const code = (e as { code?: number | string }).code;
        if (code === 6 || code === 'already-exists') return 'already_imported'; // carrera perdida = ya está
        throw e;
      }
    },

    async markRemoteDrift(productId, item, _driftFields): Promise<void> {
      try {
        const ref = db().doc(paths.product(tenantId, productId));
        const snap = await ref.get();
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
        await ref.update({ quality });
      } catch (e) {
        // El aviso de drift jamás frena la importación.
        logger.warn('Import de catálogo: no se pudo registrar el drift remoto', { tenantId, runId, productId, error: e instanceof Error ? e.message.slice(0, 200) : 'desconocido' });
      }
    },

    async saveProgress(patch): Promise<void> {
      const now = Timestamp.now();
      await db()
        .doc(paths.metaCatalogImportRun(tenantId, runId))
        .set(
          {
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
          },
          { merge: true },
        );
    },
  };
}
