/**
 * functions/meta/catalogReconcileCallables.ts — Reconciliación Meta ↔ VendeyaPy
 * =============================================================================
 * (META-CATALOG-RECONCILIATION-1) Callables administrativos para reconciliar un catálogo
 * de Meta preexistente con el catálogo local. NINGUNO escribe en Meta:
 *
 *   · metaCatalogReconcilePlan  — READ-ONLY: candidatos de mapping + artículos sin vincular.
 *   · metaCatalogConfirmMapping — vincula UN producto local con UN retailer_id (idempotente,
 *                                 inmutable: no pisa un vínculo distinto).
 *   · metaCatalogImportItems    — importa artículos de Meta como productos INACTIVE con
 *                                 syncToMeta=false (no pueden modificar ni apagar Meta).
 *   · metaCatalogSetSyncEnabled — habilita/apaga el opt-in de sync de un producto, con gates.
 *
 * Auth: SOLO TENANT_OWNER o PLATFORM_ADMIN (resolveOwnerAuth). Manager/Seller denegados.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { Product } from '@vpw/shared';
import { resolveOwnerAuth } from '../../panel/auth.js';
import { assertWithinLimit } from '../../entitlements/entitlements.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { normalizeCatalogSyncConfig } from '../../meta/catalogSyncConfig.js';
import { getMetaCatalogClientForTenant, MetaCatalogApiError } from '../../meta/catalogClient.js';
import { outboundId } from '../../meta/catalogOutbound.js';
import {
  analyzeRemoteItems,
  buildImportedProduct,
  buildRemoteTokenIndex,
  normalizeText,
  rankMappingCandidates,
  retailerIdLockKey,
  syncEnableBlockers,
  type ImportBlockReason,
  type ProductMappingSuggestions,
  type RemoteCandidate,
} from '../../meta/catalogReconcile.js';

const MAX_IMPORT_PER_CALL = 100;
const MAX_PAGE_SIZE = 200;

function authorizeOwner(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolveOwnerAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

const actorOf = (req: CallableRequest<unknown>) => ({
  uid: req.auth?.uid ?? null,
  role: (req.auth?.token as { role?: string } | undefined)?.role ?? null,
});

/** Config de catálogo del tenant (fail-closed): sin catalogId válido no se opera. */
async function requireCatalogId(tenantId: string): Promise<string> {
  const doc = await db().doc(`tenants/${tenantId}/config/meta`).get();
  const cfg = normalizeCatalogSyncConfig((doc.data() as { catalogSync?: unknown } | undefined)?.catalogSync);
  if (!cfg.enabled || !cfg.catalogId) {
    throw new HttpsError('failed-precondition', 'La sincronización de catálogo no está configurada para esta empresa.');
  }
  return cfg.catalogId;
}

/** Lee el catálogo remoto COMPLETO (solo GET). Errores saneados, jamás el token. */
async function readRemote(tenantId: string, catalogId: string): Promise<RemoteCandidate[]> {
  try {
    const client = await getMetaCatalogClientForTenant(tenantId);
    await client.getCatalog(catalogId);
    return analyzeRemoteItems(await client.listItems(catalogId));
  } catch (e) {
    const detail = e instanceof MetaCatalogApiError ? e.message : 'No se pudo leer el catálogo de Meta.';
    logger.error('Reconciliación: fallo leyendo Meta', e, { tenantId });
    throw new HttpsError('unavailable', detail);
  }
}

const loadProducts = async (tenantId: string): Promise<Product[]> =>
  (await db().collection(paths.products(tenantId)).get()).docs.map((d) => ({ ...(d.data() as Product), id: d.id }));

// ---------------------------------------------------------------------------
// 1) Plan de reconciliación (READ-ONLY)
// ---------------------------------------------------------------------------

export const metaCatalogReconcilePlan = onCall<{ tenantId?: string; offset?: number; limit?: number }>(
  { region: 'us-central1', timeoutSeconds: 300 },
  async (req) => {
    const tenantId = authorizeOwner(req, req.data?.tenantId);
    const catalogId = await requireCatalogId(tenantId);
    const remote = await readRemote(tenantId, catalogId);
    const products = await loadProducts(tenantId);

    // Artículos ya reclamados por un vínculo confirmado ⇒ dejan de ser candidatos.
    const claimed = new Map<string, { productId: string; productName: string }>();
    for (const p of products) {
      const rid = (p.metaRetailerId ?? '').trim();
      if (rid) claimed.set(rid, { productId: p.id, productName: p.name ?? '' });
    }

    const unlinkedAll = remote.filter((r) => !claimed.has(r.retailerId));
    const rawOffset = Number(req.data?.offset ?? 0);
    const rawLimit = Number(req.data?.limit ?? MAX_PAGE_SIZE);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
    const limit = Number.isFinite(rawLimit) ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(rawLimit))) : MAX_PAGE_SIZE;
    const unlinked = unlinkedAll.slice(offset, offset + limit);

    // Sugerencias SOLO para productos vivos que todavía no tienen vínculo. Se devuelven solo
    // candidatos con confianza media o alta: un top-5 de coincidencias irrelevantes llena la
    // pantalla de ruido y empuja a vincular cualquier cosa.
    const tokenIndex = buildRemoteTokenIndex(unlinkedAll);
    const suggestions: ProductMappingSuggestions[] = products
      .filter((p) => p.status !== 'ARCHIVED' && !(p.metaRetailerId ?? '').trim())
      .map((p) => ({
        productId: p.id,
        productName: p.name ?? '',
        internalSku: p.inventory?.sku ?? '',
        candidates: rankMappingCandidates(p, unlinkedAll, { limit: 5, index: tokenIndex, minConfidence: 'media' }),
      }))
      .filter((s) => s.candidates.length > 0)
      .slice(0, MAX_PAGE_SIZE);

    const flagCount = (f: string) => unlinkedAll.filter((r) => r.flags.includes(f as never)).length;
    return {
      ok: true,
      catalogIdMasked: `…${catalogId.slice(-4)}`,
      totals: {
        remoteItems: remote.length,
        linked: claimed.size,
        unlinked: unlinkedAll.length,
        importable: unlinkedAll.filter((r) => r.importable).length,
        genericName: flagCount('generic_name'),
        probableDuplicate: flagCount('probable_duplicate'),
        missingBrand: flagCount('missing_brand'),
        outOfStock: flagCount('out_of_stock'),
        nameDescriptionMismatch: flagCount('name_description_mismatch'),
        blocked: unlinkedAll.filter((r) => !r.importable).length,
      },
      linked: [...claimed.entries()].map(([retailerId, v]) => ({ retailerId, ...v })),
      unlinked,
      page: { offset, limit, total: unlinkedAll.length, hasMore: offset + unlinked.length < unlinkedAll.length },
      suggestions,
    };
  },
);

// ---------------------------------------------------------------------------
// 2) Confirmar un mapping (idempotente e inmutable)
// ---------------------------------------------------------------------------

export const metaCatalogConfirmMapping = onCall<{ tenantId?: string; productId?: string; retailerId?: string }>(
  { region: 'us-central1', timeoutSeconds: 300 },
  async (req) => {
    const tenantId = authorizeOwner(req, req.data?.tenantId);
    const productId = String(req.data?.productId ?? '').trim();
    const retailerId = String(req.data?.retailerId ?? '').trim();
    if (!productId || !retailerId) throw new HttpsError('invalid-argument', 'Faltan productId y retailerId.');

    const catalogId = await requireCatalogId(tenantId);

    // Releer el producto local (dentro del tenant SIEMPRE).
    const ref = db().doc(paths.product(tenantId, productId));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'El producto no existe en esta empresa.');
    const product = { ...(snap.data() as Product), id: snap.id };

    // Idempotencia: mismo vínculo ⇒ no-op. Vínculo distinto ⇒ RECHAZO (inmutable).
    const current = (product.metaRetailerId ?? '').trim();
    if (current === retailerId) {
      return { ok: true, alreadyMapped: true, productId, retailerId };
    }
    if (current) {
      throw new HttpsError('failed-precondition', `Este producto ya está vinculado a otro artículo de Meta (${current}). Un vínculo confirmado no se cambia.`);
    }

    // Releer el artículo en Meta: no se vincula contra algo que no existe.
    const remote = await readRemote(tenantId, catalogId);
    const item = remote.find((r) => r.retailerId === retailerId);
    if (!item) throw new HttpsError('not-found', 'Ese artículo no existe en el catálogo de Meta configurado.');

    // Escritura ACOTADA: identidad + estado de sync. NO toca sku, precio, costo, stock ni status.
    //
    // La UNICIDAD del retailer_id se garantiza con un LOCK determinístico leído DENTRO de la
    // transacción: una query no sirve como precondición transaccional (Firestore solo serializa
    // sobre los documentos leídos en la tx), y la ventana hasta acá incluye una lectura completa
    // del catálogo de Meta — segundos enteros durante los cuales dos confirmaciones del mismo
    // artículo a productos distintos podrían commitear las dos, de forma irreversible.
    const lockRef = db().doc(paths.metaRetailerLock(tenantId, retailerIdLockKey(retailerId)));
    await db().runTransaction(async (tx) => {
      const [fresh, lock] = await Promise.all([tx.get(ref), tx.get(lockRef)]);
      const freshData = fresh.data() as Product | undefined;
      const freshMapped = (freshData?.metaRetailerId ?? '').trim();
      if (freshMapped && freshMapped !== retailerId) {
        throw new HttpsError('aborted', 'El producto fue vinculado por otra operación. Volvé a intentar.');
      }
      const lockOwner = (lock.data() as { productId?: string } | undefined)?.productId;
      if (lock.exists && lockOwner && lockOwner !== productId) {
        throw new HttpsError('failed-precondition', `Ese artículo de Meta ya está vinculado a otro producto (${lockOwner}).`);
      }
      tx.set(lockRef, { retailerId, productId, tenantId, createdAt: Timestamp.now() });
      tx.set(
        ref,
        {
          metaRetailerId: retailerId,
          metaProductItemId: item.metaItemId,
          metaCatalogId: catalogId,
          // El vínculo NO habilita la sincronización: eso es una decisión aparte. Pero tampoco
          // la APAGA: un producto que ya venía sincronizando conserva su opt-in (apagarlo lo
          // sacaría del plan y sus cambios dejarían de propagarse a Meta en silencio).
          syncToMeta: freshData?.syncToMeta === true,
          ...(freshData?.syncToMeta === true ? {} : { metaSyncStatus: 'not_synced' }),
          updatedAt: Timestamp.now(),
        },
        { merge: true },
      );
    });

    const actor = actorOf(req);
    await recordAudit({
      tenantId,
      action: 'meta.catalog_mapping_confirmed',
      actorUid: actor.uid,
      actorRole: actor.role,
      targetType: 'product',
      targetId: productId,
      summary: `Producto vinculado al artículo ${retailerId} de Meta`,
      metadata: { retailerId, metaItemId: item.metaItemId, syncToMeta: false },
    });
    logger.info('Mapping de catálogo confirmado', { tenantId, productId, retailerId });
    return { ok: true, alreadyMapped: false, productId, retailerId, metaItemId: item.metaItemId, syncToMeta: false };
  },
);

// ---------------------------------------------------------------------------
// 3) Importar artículos de Meta (INACTIVE, syncToMeta=false)
// ---------------------------------------------------------------------------

export const metaCatalogImportItems = onCall<{ tenantId?: string; retailerIds?: string[]; categoryId?: string; dryRun?: boolean }>(
  { region: 'us-central1', timeoutSeconds: 300 },
  async (req) => {
    const tenantId = authorizeOwner(req, req.data?.tenantId);
    if (req.data?.retailerIds !== undefined && !Array.isArray(req.data.retailerIds)) {
      throw new HttpsError('invalid-argument', 'retailerIds debe ser una lista.');
    }
    const retailerIds = [...new Set((req.data?.retailerIds ?? []).map((s) => String(s).trim()).filter(Boolean))];
    const categoryId = String(req.data?.categoryId ?? '').trim();
    const dryRun = req.data?.dryRun === true;
    if (!retailerIds.length) throw new HttpsError('invalid-argument', 'Elegí al menos un artículo para importar.');
    if (retailerIds.length > MAX_IMPORT_PER_CALL) {
      throw new HttpsError('invalid-argument', `Máximo ${MAX_IMPORT_PER_CALL} artículos por importación.`);
    }
    // Categoría EXPLÍCITA obligatoria: sin ella el candidato queda bloqueado (nunca se inventa).
    if (!categoryId) {
      return { ok: false, imported: [], blocked: retailerIds.map((retailerId) => ({ retailerId, reason: 'category_required' as const })) };
    }
    const catSnap = await db().doc(paths.category(tenantId, categoryId)).get();
    if (!catSnap.exists) throw new HttpsError('invalid-argument', 'La categoría indicada no existe en esta empresa.');

    const catalogId = await requireCatalogId(tenantId);
    const remote = await readRemote(tenantId, catalogId);
    const byRid = new Map(remote.map((r) => [r.retailerId, r]));
    const products = await loadProducts(tenantId);

    const mappedRids = new Set(products.map((p) => (p.metaRetailerId ?? '').trim()).filter(Boolean));
    const localSkus = new Set(products.map((p) => (p.inventory?.sku ?? '').trim()).filter(Boolean));
    const localNames = new Set(products.filter((p) => p.status !== 'ARCHIVED').map((p) => normalizeText(p.name)));

    // Candidatos de mapping FUERTES: si el artículo se parece mucho a un producto local que
    // todavía no está vinculado, importarlo crearía un duplicado del mismo perfume a otro
    // precio. Se bloquea y se pide resolver el vínculo primero.
    const sinVinculo = products.filter((p) => p.status !== 'ARCHIVED' && !(p.metaRetailerId ?? '').trim());
    const tokenIndex = buildRemoteTokenIndex(remote);
    const conCandidatoFuerte = new Set<string>();
    for (const p of sinVinculo) {
      for (const c of rankMappingCandidates(p, remote, { index: tokenIndex, limit: 3, minConfidence: 'alta' })) {
        conCandidatoFuerte.add(c.retailerId);
      }
    }

    const blocked: ImportBlockReason[] = [];
    const toImport: RemoteCandidate[] = [];
    // Los nombres ya elegidos en ESTA llamada cuentan como ocupados: dos artículos homónimos
    // (el catálogo real tiene 5 "ANTONIO BANDERAS") no pueden importarse juntos a ciegas.
    const nombresTomados = new Set(localNames);
    for (const rid of retailerIds) {
      const item = byRid.get(rid);
      if (!item) { blocked.push({ retailerId: rid, reason: 'not_found_in_meta' }); continue; }
      if (mappedRids.has(rid)) { blocked.push({ retailerId: rid, reason: 'already_mapped' }); continue; }
      if (localSkus.has(rid)) { blocked.push({ retailerId: rid, reason: 'already_imported' }); continue; }
      if (nombresTomados.has(normalizeText(item.name))) { blocked.push({ retailerId: rid, reason: 'duplicate_name_local' }); continue; }
      if (conCandidatoFuerte.has(rid)) { blocked.push({ retailerId: rid, reason: 'strong_mapping_candidate' }); continue; }
      if (!(item.priceGs > 0)) { blocked.push({ retailerId: rid, reason: 'invalid_price' }); continue; }
      if (!item.imageUrl.startsWith('https://')) { blocked.push({ retailerId: rid, reason: 'image_not_https' }); continue; }
      nombresTomados.add(normalizeText(item.name));
      toImport.push(item);
    }

    if (dryRun || !toImport.length) {
      return { ok: !dryRun ? toImport.length > 0 : true, dryRun: true, imported: [], wouldImport: toImport.map((i) => ({ retailerId: i.retailerId, name: i.name, flags: i.flags })), blocked };
    }

    // Cuota UNA sola vez, por el delta total (no N llamadas).
    await assertWithinLimit(tenantId, 'products', { actorUid: req.auth?.uid, delta: toImport.length });

    const now = Timestamp.now();
    const basePosition = products.length;
    const batch = db().batch();
    const imported: Array<{ productId: string; retailerId: string; name: string; flags: string[] }> = [];
    for (const [i, item] of toImport.entries()) {
      // ID DETERMINÍSTICO derivado del retailer_id + `create()`: dos importaciones concurrentes
      // del mismo artículo NO pueden crear dos productos (la segunda falla con ALREADY_EXISTS
      // y su reintento lo verá como `already_imported`).
      const ref = db().doc(paths.product(tenantId, `meta_${retailerIdLockKey(item.retailerId)}`));
      const doc = buildImportedProduct(item, { productId: ref.id, tenantId, categoryId, catalogId, position: basePosition + i });
      batch.create(ref, { ...doc, createdAt: now, updatedAt: now });
      // NUNCA se escribe productFinancials: el costo queda desconocido, no en 0.
      imported.push({ productId: ref.id, retailerId: item.retailerId, name: item.name, flags: item.flags });
    }
    try {
      await batch.commit();
    } catch {
      // ALREADY_EXISTS ⇒ otra importación concurrente ganó. Nada se creó (el batch es atómico).
      logger.warn('Importación abortada por conflicto de concurrencia', { tenantId, cantidad: toImport.length });
      throw new HttpsError('aborted', 'Otra importación creó estos productos al mismo tiempo. Volvé a abrir la reconciliación para ver el estado actualizado.');
    }

    const actor = actorOf(req);
    await recordAudit({
      tenantId,
      action: 'meta.catalog_items_imported',
      actorUid: actor.uid,
      actorRole: actor.role,
      targetType: 'catalog',
      targetId: categoryId,
      summary: `Importados ${imported.length} artículos de Meta como INACTIVE`,
      metadata: { count: imported.length, blocked: blocked.length, retailerIds: imported.map((i) => i.retailerId).slice(0, 50), categoryId },
    });
    logger.info('Artículos de Meta importados', { tenantId, count: imported.length, blocked: blocked.length });
    return { ok: true, dryRun: false, imported, blocked };
  },
);

// ---------------------------------------------------------------------------
// 4) Habilitar / apagar el opt-in de sincronización de un producto
// ---------------------------------------------------------------------------

export const metaCatalogSetSyncEnabled = onCall<{ tenantId?: string; productId?: string; enabled?: boolean; confirmDiff?: boolean }>(
  { region: 'us-central1', timeoutSeconds: 300 },
  async (req) => {
    const tenantId = authorizeOwner(req, req.data?.tenantId);
    const productId = String(req.data?.productId ?? '').trim();
    if (!productId) throw new HttpsError('invalid-argument', 'Falta productId.');
    if (typeof req.data?.enabled !== 'boolean') {
      throw new HttpsError('invalid-argument', 'Indicá explícitamente si la sincronización queda activada o desactivada.');
    }
    const enabled = req.data.enabled;

    const ref = db().doc(paths.product(tenantId, productId));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'El producto no existe en esta empresa.');
    const product = { ...(snap.data() as Product), id: snap.id };

    // Apagar siempre se puede (es el lado seguro).
    if (!enabled) {
      await ref.set({ syncToMeta: false, updatedAt: Timestamp.now() }, { merge: true });
      const a = actorOf(req);
      await recordAudit({ tenantId, action: 'meta.catalog_sync_disabled', actorUid: a.uid, actorRole: a.role, targetType: 'product', targetId: productId, summary: 'Sincronización con Meta desactivada para el producto', metadata: {} });
      return { ok: true, enabled: false, blockers: [] };
    }

    // Habilitar exige catálogo configurado + TODOS los gates + confirmación del diff REAL.
    const catalogId = await requireCatalogId(tenantId);
    const remote = await readRemote(tenantId, catalogId);
    // MISMA derivación que usa el planificador: una copia inline se desincroniza y el gate
    // terminaría evaluando una identidad distinta de la que va a viajar a Meta.
    const identity = outboundId(product);
    const remoteItem = remote.find((r) => r.retailerId === identity);
    const blockers = syncEnableBlockers(product, { remoteHasIdentity: !!remoteItem });
    if (blockers.length) {
      return { ok: false, enabled: false, blockers, message: 'El producto no cumple los requisitos para sincronizarse con Meta.' };
    }
    const hasMapping = !!(product.metaRetailerId ?? '').trim();
    if (req.data?.confirmDiff !== true) {
      // El intent se calcula contra el catálogo REAL, no contra la presencia del mapping:
      // decirle "se va a crear" a alguien cuyo SKU ya existe en Meta sería mentirle.
      const intent = remoteItem ? 'update' : 'create';
      return {
        ok: false,
        enabled: false,
        blockers: [],
        requiresConfirmation: true,
        intent,
        retailerId: identity,
        message: intent === 'update'
          ? `Al habilitarlo, la próxima sincronización ACTUALIZARÁ el artículo ${identity} que ya existe en Meta.`
          : 'Este producto no existe en Meta: la próxima sincronización CREARÁ un artículo nuevo.',
      };
    }

    // TOCTOU: re-leer y re-evaluar DENTRO de la transacción. Entre la lectura y el write
    // alguien pudo desactivar o archivar el producto — habilitar un INACTIVE mapeado haría
    // que la próxima sync apague su artículo vivo en Meta.
    await db().runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      const freshProduct = { ...(fresh.data() as Product), id: ref.id };
      const freshBlockers = syncEnableBlockers(freshProduct, { remoteHasIdentity: !!remoteItem });
      if (freshBlockers.length) {
        throw new HttpsError('aborted', `El producto cambió mientras confirmabas (${freshBlockers.join(', ')}). Volvé a intentar.`);
      }
      tx.set(ref, { syncToMeta: true, updatedAt: Timestamp.now() }, { merge: true });
    });
    const a = actorOf(req);
    await recordAudit({
      tenantId,
      action: 'meta.catalog_sync_enabled',
      actorUid: a.uid,
      actorRole: a.role,
      targetType: 'product',
      targetId: productId,
      summary: 'Sincronización con Meta habilitada para el producto',
      metadata: { intent: remoteItem ? 'update' : 'create', retailerId: identity, mapped: hasMapping },
    });
    logger.info('Sync habilitada para un producto', { tenantId, productId });
    return { ok: true, enabled: true, blockers: [] };
  },
);
