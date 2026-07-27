/**
 * Capa de acceso al catálogo (panel) — productos y categorías.
 *
 * LECTURAS: directas a Firestore (las reglas permiten leer a Owner/Manager).
 * ESCRITURAS: pasan por callables seguros del backend (Fase 5C), NO por write directo:
 *   - productUpsert  (alta/edición de producto + costo privado en un solo batch; valida cuota maxProducts)
 *   - productDelete  (baja por soft-archive: status='ARCHIVED', preserva financials/pedidos)
 *   - categoryUpsert (alta/edición de categoría)  ← ver templates.ts para el alta por plantilla
 * El tenant sale del token; solo PLATFORM_ADMIN operando otra empresa pasa `tenantId`
 * (lo aceptan los callables vía resolvePanelAuth; para Owner/Manager se ignora).
 */

import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { Product, Category, ProductFinancials } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';

const productsCol = (tenantId: string) => collection(firebaseDb(), 'tenants', tenantId, 'products');
const categoriesCol = (tenantId: string) =>
  collection(firebaseDb(), 'tenants', tenantId, 'categories');
const productFinancialsCol = (tenantId: string) =>
  collection(firebaseDb(), 'tenants', tenantId, 'productFinancials');

export async function listProducts(tenantId: string): Promise<Product[]> {
  const snap = await getDocs(query(productsCol(tenantId), orderBy('position')));
  return snap.docs.map((d) => d.data() as Product);
}

export async function listCategories(tenantId: string): Promise<Category[]> {
  const snap = await getDocs(query(categoriesCol(tenantId), orderBy('position')));
  return snap.docs.map((d) => d.data() as Category);
}

/** Datos editables de un producto desde el panel (el resto se completa/preserva). */
export interface ProductInput {
  id?: string; // si viene, es edición
  name: string;
  description: string;
  price: number;
  costPrice: number | null;
  priorityScore: number | null;
  aiNotes: string;
  categoryId: string;
  images: string[];
  emoji: string;
  stock: number;
  sku: string;
  status: Product['status'];
  featured: boolean;
  perfume: Product['perfume'];
  /** Ficha para recomendaciones del agente (CAT-1). */
  aiFicha: Product['aiFicha'];
}

type ProductUpsertResp = { ok: boolean; id: string; created: boolean };

/**
 * Alta/edición de producto vía callable `productUpsert`. El backend valida (whitelist),
 * aplica la cuota `maxProducts` al crear y escribe el costo privado `productFinancials`
 * en el mismo batch. NO escribe directo a Firestore.
 */
export async function upsertProduct(tenantId: string, input: ProductInput): Promise<string> {
  // `data` = solo campos editables (el backend descarta id/tenantId/timestamps/sync).
  const data: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    price: input.price,
    compareAtPrice: null,
    aiNotes: input.aiNotes,
    currency: 'PYG',
    categoryId: input.categoryId,
    images: input.images,
    emoji: input.emoji,
    inventory: { trackStock: true, stock: input.stock, lowStockThreshold: 3, sku: input.sku },
    status: input.status,
    featured: input.featured,
    externalIds: { facebook: null, instagram: null, tiktok: null },
    perfume: input.perfume,
    aiFicha: input.aiFicha ?? null,
  };
  // En CREATE seteamos `position` para que el producto aparezca en listProducts
  // (que ordena por `position`; un doc sin ese campo quedaría fuera del orderBy).
  if (!input.id) data.position = 999;

  // El costo va a la subcolección privada productFinancials (ADR-0008), en el mismo callable.
  const financials = { costPrice: input.costPrice, priorityScore: input.priorityScore };

  const call = httpsCallable<{ tenantId: string; id?: string; data: unknown; financials: unknown }, ProductUpsertResp>(
    firebaseFunctions(),
    'productUpsert',
  );
  const res = await call({ tenantId, id: input.id, data, financials });
  return res.data.id;
}

/**
 * Baja de producto vía callable `productDelete`. Es un SOFT-ARCHIVE (status='ARCHIVED'):
 * no rompe pedidos/carritos abiertos y preserva el costo. NO borra directo en Firestore.
 */
export async function deleteProduct(tenantId: string, id: string): Promise<void> {
  const call = httpsCallable<{ tenantId: string; id: string }, { ok: boolean }>(firebaseFunctions(), 'productDelete');
  await call({ tenantId, id });
}

/** Mapa productId → finanzas privadas (costo + prioridad). Solo Owner/Manager (reglas). */
export async function listProductFinancials(tenantId: string): Promise<Record<string, ProductFinancials>> {
  const snap = await getDocs(productFinancialsCol(tenantId));
  const map: Record<string, ProductFinancials> = {};
  snap.docs.forEach((d) => { map[d.id] = d.data() as ProductFinancials; });
  return map;
}

/** Margen de ganancia (null si falta el costo). */
export function productMargin(price: number, costPrice: number | null): number | null {
  if (costPrice == null || price <= 0) return null;
  return ((price - costPrice) / price) * 100;
}

// --- Sincronización con el Meta Catalog (META-CATALOG-LIVE-1) ---------------
// Va por el callable autenticado `runTenantJob` (Owner/Manager/PLATFORM_ADMIN;
// Seller denegado por resolvePanelAuth). El endpoint dev quedó fuera del panel.

/** Espejo liviano del resultado de runCatalogSync (backend meta/catalog.ts). */
export interface CatalogSyncSummary {
  create: number;
  update: number;
  disable: number;
  unchanged: number;
  blocked: number;
  remoteOnly: number;
}
export interface CatalogSyncEntry {
  productId: string;
  /** Identidad remota efectiva (vínculo confirmado o SKU como fallback). */
  sku: string;
  internalSku?: string;
  mapped?: boolean;
  productName: string;
  action: 'create' | 'update' | 'disable' | 'unchanged' | 'blocked';
  blockedReasons?: string[];
  changedFields?: string[];
  suggestion?: { remoteRetailerId: string; remoteName: string };
  note?: string;
}
export interface CatalogSyncRun {
  runId: string;
  requestedMode: 'dry_run' | 'apply';
  status: 'disabled' | 'apply_blocked' | 'error' | 'planned' | 'applied' | 'partial_failure';
  configMode: 'off' | 'dry_run' | 'live';
  reason?: string;
  errorDetail?: string;
  summary?: CatalogSyncSummary;
  entries?: CatalogSyncEntry[];
  /** Productos sin opt-in de sincronización: quedan fuera del plan (fail-closed). */
  excludedNotManaged?: number;
  remoteOnly?: Array<{ retailerId: string; name: string }>;
  appliedCount?: number;
  failedCount?: number;
}

// --- Reconciliación con un catálogo de Meta preexistente ---------------------

export type RemoteQualityFlag =
  | 'generic_name'
  | 'probable_duplicate'
  | 'missing_brand'
  | 'out_of_stock'
  | 'name_description_mismatch'
  | 'invalid_price'
  | 'image_not_https';

export interface RemoteCandidateItem {
  retailerId: string;
  metaItemId: string;
  name: string;
  brand: string;
  priceGs: number;
  priceRaw: string;
  availability: string;
  imageUrl: string;
  description: string;
  productType: string;
  businessId: string | null;
  flags: RemoteQualityFlag[];
  duplicateOf?: string[];
  importable: boolean;
}

export interface MappingCandidate {
  retailerId: string;
  name: string;
  brand: string;
  priceGs: number;
  availability: string;
  score: number;
  confidence: 'alta' | 'media' | 'baja';
  reasons: string[];
}

export interface ReconcilePlan {
  ok: boolean;
  catalogIdMasked: string;
  totals: {
    remoteItems: number;
    linked: number;
    unlinked: number;
    importable: number;
    genericName: number;
    probableDuplicate: number;
    missingBrand: number;
    outOfStock: number;
    nameDescriptionMismatch: number;
    blocked: number;
  };
  linked: Array<{ retailerId: string; productId: string; productName: string }>;
  unlinked: RemoteCandidateItem[];
  page: { offset: number; limit: number; total: number; hasMore: boolean };
  suggestions: Array<{ productId: string; productName: string; internalSku: string; candidates: MappingCandidate[] }>;
}

/** Plan de reconciliación (read-only). Requiere rol dueño de la empresa. */
export async function fetchReconcilePlan(tenantId: string, opts?: { offset?: number; limit?: number }): Promise<ReconcilePlan> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogReconcilePlan');
  const res = await call({ tenantId, offset: opts?.offset ?? 0, limit: opts?.limit ?? 200 });
  return res.data as ReconcilePlan;
}

/** Vincula un producto local con un artículo de Meta. Irreversible por diseño. */
export async function confirmMetaMapping(tenantId: string, productId: string, retailerId: string): Promise<{ ok: boolean; alreadyMapped: boolean }> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogConfirmMapping');
  const res = await call({ tenantId, productId, retailerId });
  return res.data as { ok: boolean; alreadyMapped: boolean };
}

export interface ImportResult {
  ok: boolean;
  dryRun?: boolean;
  imported?: Array<{ productId: string; retailerId: string; name: string; flags: string[] }>;
  wouldImport?: Array<{ retailerId: string; name: string; flags: string[] }>;
  blocked: Array<{ retailerId: string; reason: string }>;
}

export type SyncEnableBlocker =
  | 'not_active'
  | 'name_missing'
  | 'price_invalid'
  | 'currency_not_pyg'
  | 'image_not_https'
  | 'category_missing'
  | 'stock_pending_review'
  | 'not_sellable_now'
  | 'unconfirmed_remote_match'
  | 'no_identity';

export interface SetSyncEnabledResult {
  ok: boolean;
  enabled: boolean;
  blockers: SyncEnableBlocker[];
  requiresConfirmation?: boolean;
  intent?: 'create' | 'update';
  retailerId?: string;
  message?: string;
}

/**
 * Habilita o apaga la sincronización con Meta de UN producto. Habilitar exige que el
 * producto cumpla todos los requisitos y una confirmación explícita del cambio que se
 * enviará a Meta (`confirmDiff`).
 */
export async function setProductSyncEnabled(
  tenantId: string,
  productId: string,
  enabled: boolean,
  opts?: { confirmDiff?: boolean },
): Promise<SetSyncEnabledResult> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogSetSyncEnabled');
  const res = await call({ tenantId, productId, enabled, confirmDiff: opts?.confirmDiff ?? false });
  return res.data as SetSyncEnabledResult;
}

/** Importa artículos de Meta como productos INACTIVE (sin costo ni stock inventados). */
export async function importMetaItems(
  tenantId: string,
  retailerIds: string[],
  categoryId: string,
  opts?: { dryRun?: boolean },
): Promise<ImportResult> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogImportItems');
  const res = await call({ tenantId, retailerIds, categoryId, dryRun: opts?.dryRun ?? false });
  return res.data as ImportResult;
}

/**
 * Corre la sync de catálogo. Por defecto DRY-RUN (plan, cero escrituras en Meta);
 * `apply` solo tiene efecto si la config del tenant está en mode 'live' (el backend
 * lo rechaza fail-closed si no).
 */
export async function syncCatalogToMeta(tenantId: string, opts?: { apply?: boolean }): Promise<CatalogSyncRun> {
  const call = httpsCallable(firebaseFunctions(), 'runTenantJob');
  const res = await call({ action: opts?.apply ? 'catalogSyncApply' : 'catalogSync', tenantId });
  return (res.data as { result: CatalogSyncRun }).result;
}
