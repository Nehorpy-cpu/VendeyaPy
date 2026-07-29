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
import type {
  Product,
  Category,
  ProductFinancials,
  QualityObservation,
  QualityObservationOrigin,
  QualitySeverity,
} from '@vpw/shared';
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

// --- Calidad del catálogo (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1) --------
// Los campos `brand` y `quality` de Product y los tipos de observación ya viven en
// @vpw/shared (product.types.ts). Acá solo se re-exportan con los nombres que consume
// el panel, para que los componentes no dependan de los detalles del paquete.

export type { QualitySeverity, QualityObservation, ProductQuality } from '@vpw/shared';

/** Alias del panel para el origen de una observación (shared: QualityObservationOrigin). */
export type QualityOrigin = QualityObservationOrigin;

/** Alias del panel: entrada del mapa `quality.fingerprints` (shared: QualityObservation). */
export type QualityFingerprintEntry = QualityObservation;

/**
 * Product ya incluye `brand` (marca neutral) y `quality` (evaluación server-side) en
 * @vpw/shared. Se conserva el alias porque los componentes del catálogo lo nombran así.
 */
export type ProductConCalidad = Product;

/** Datos editables de un producto desde el panel (el resto se completa/preserva). */
export interface ProductInput {
  id?: string; // si viene, es edición
  name: string;
  /** Marca neutral (campo top-level nuevo). Para perfumes se espeja también en perfume.brand. */
  brand: string;
  description: string;
  price: number;
  /** Precio anterior (tachado). Se precarga del producto para que guardar NO lo borre. */
  compareAtPrice: number | null;
  costPrice: number | null;
  priorityScore: number | null;
  aiNotes: string;
  categoryId: string;
  images: string[];
  emoji: string;
  stock: number;
  /** Si el negocio controla stock de este producto (los importados nacen sin control). */
  trackStock: boolean;
  lowStockThreshold: number;
  sku: string;
  status: Product['status'];
  featured: boolean;
  /** URL pública del producto. Meta la exige (`link`) para CREAR el artículo en el catálogo. */
  productUrl: string;
  perfume: Product['perfume'];
  /** Ficha para recomendaciones del agente (CAT-1). */
  aiFicha: Product['aiFicha'];
}

/** Observación que el guardado RESOLVIÓ (la condición dejó de cumplirse). */
export interface QualityResuelta {
  code: string;
  field: string;
  message: string;
}

/** Observación que sigue pendiente después del guardado. */
export interface QualityPendiente {
  code: string;
  severity: QualitySeverity;
  field: string;
  message: string;
  action: string;
}

/** Resultado de calidad que devuelve productUpsert (recomputada server-side al guardar). */
export interface UpsertQualityResult {
  resueltas: QualityResuelta[];
  pendientes: QualityPendiente[];
}

export interface ProductUpsertOutcome {
  id: string;
  /** Ausente mientras el backend del programa no esté desplegado (compat). */
  quality?: UpsertQualityResult;
}

type ProductUpsertResp = { ok: boolean; id: string; created: boolean; quality?: UpsertQualityResult };

/**
 * Alta/edición de producto vía callable `productUpsert`. El backend valida (whitelist),
 * aplica la cuota `maxProducts` al crear y escribe el costo privado `productFinancials`
 * en el mismo batch. NO escribe directo a Firestore.
 */
export async function upsertProduct(tenantId: string, input: ProductInput): Promise<ProductUpsertOutcome> {
  // `data` = solo campos editables (el backend descarta id/tenantId/timestamps/sync).
  const data: Record<string, unknown> = {
    name: input.name,
    brand: input.brand.trim(),
    description: input.description,
    price: input.price,
    // Precargado del producto por el form: guardar sin tocarlo lo PRESERVA (antes se
    // mandaba null fijo y cada edición borraba el precio-antes en silencio).
    compareAtPrice: input.compareAtPrice,
    aiNotes: input.aiNotes,
    currency: 'PYG',
    categoryId: input.categoryId,
    images: input.images,
    emoji: input.emoji,
    // trackStock/lowStockThreshold también se precargan: un importado (trackStock:false)
    // no debe volverse "controlado" solo por guardarlo desde el panel.
    inventory: {
      trackStock: input.trackStock,
      stock: input.stock,
      lowStockThreshold: input.lowStockThreshold,
      sku: input.sku,
    },
    status: input.status,
    featured: input.featured,
    externalIds: { facebook: null, instagram: null, tiktok: null },
    perfume: input.perfume,
    aiFicha: input.aiFicha ?? null,
  };
  // Se manda siempre (el form lo precarga del producto): vaciar el campo tiene que BORRAR el
  // enlace, no ser un no-op silencioso. Sin este campo ningún producto puede crearse en Meta.
  data.productUrl = input.productUrl.trim();
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
  return { id: res.data.id, quality: res.data.quality };
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
  /** `queued`: confirmar el plan ENCOLA el trabajo. Lo aplicado lo confirma Meta después. */
  status: 'disabled' | 'apply_blocked' | 'error' | 'planned' | 'queued' | 'partial_failure';
  configMode: 'off' | 'dry_run' | 'live';
  reason?: string;
  errorDetail?: string;
  summary?: CatalogSyncSummary;
  entries?: CatalogSyncEntry[];
  /** Productos sin opt-in de sincronización: quedan fuera del plan (fail-closed). */
  excludedNotManaged?: number;
  remoteOnly?: Array<{ retailerId: string; name: string }>;
  /** Cambios encolados hacia Meta (todavía NO aplicados). */
  queuedCount?: number;
  /** Confirmaciones repetidas del mismo cambio: no generan trabajo nuevo. */
  deduplicatedCount?: number;
  /** De los repetidos, los que están trabados esperando una revisión del dueño. */
  awaitingReviewCount?: number;
  /** Productos cuyo cambio no cumple el contrato de Meta. */
  blockedCount?: number;
  failedCount?: number;
  /**
   * Huella del plan previsualizado (META-CATALOG-PREVIEW-BINDING-1). Es la evidencia que el
   * envío real debe presentar: sin ella el backend rechaza con failed-precondition.
   */
  planHash?: string;
  /** En un envío: qué previsualización lo autorizó. */
  previewRunId?: string;
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
  | 'no_identity'
  | 'identity_too_long'
  // Obligatorios que Meta exige para CREAR el artículo (no aplican si ya existe allá).
  | 'description_missing'
  | 'brand_missing'
  | 'product_url_missing'
  | 'product_url_not_https';

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

// --- Recuperación de envíos trabados (META-CATALOG-OUTBOX-HARDEN-1) ----------

/** Incidencia SANEADA del outbox: lo mínimo para entender y decidir. Sin payloads ni tokens. */
export interface OutboxIncident {
  jobId: string;
  productId: string;
  productName: string;
  retailerId: string;
  action: 'create' | 'update' | 'disable';
  status: string;
  reason: string | null;
  cycle: number;
  attempts: number;
  /** Nombres de los campos que el envío pretendía cambiar (nunca sus valores). */
  fields: string[];
  error: string;
}

export interface OutboxIncidentList {
  incidents: OutboxIncident[];
  /** true si hay MÁS incidencias abiertas que las devueltas: el panel no puede ocultarlo. */
  truncated: boolean;
}

export async function listOutboxIncidents(tenantId: string): Promise<OutboxIncidentList> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogOutboxIncidents');
  const res = await call({ tenantId });
  const data = res.data as { incidents?: OutboxIncident[]; truncated?: boolean };
  return { incidents: data.incidents ?? [], truncated: data.truncated === true };
}

export interface ReconcileOutcome {
  ok: boolean;
  outcome: 'confirmed_equal' | 'confirmed_different' | 'unverifiable' | 'nothing_to_do';
  status: string;
  newJobId?: string;
  message: string;
}

/**
 * Revisa UN envío trabado contra el catálogo real de Meta. Nunca reenvía a ciegas: si Meta ya
 * tiene el cambio lo cierra, si difiere encola un intento nuevo, y si no hay evidencia lo deja
 * pendiente de revisión.
 */
export async function reconcileOutboxJob(tenantId: string, jobId: string): Promise<ReconcileOutcome> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogOutboxReconcile');
  const res = await call({ tenantId, jobId });
  return res.data as ReconcileOutcome;
}

/** Descarta un envío trabado. El motivo queda auditado. */
export async function discardOutboxJob(tenantId: string, jobId: string, reason: string): Promise<{ ok: boolean; message: string }> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogOutboxDiscard');
  const res = await call({ tenantId, jobId, reason });
  return res.data as { ok: boolean; message: string };
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
 * lo rechaza fail-closed si no) y EXIGE la evidencia de la previsualización aprobada
 * ({runId, planHash} del dry-run): el backend replanifica y solo encola si el plan
 * coincide EXACTAMENTE; si algo cambió responde failed-precondition.
 */
export async function syncCatalogToMeta(
  tenantId: string,
  opts?: { apply?: boolean; preview?: { runId: string; planHash: string } },
): Promise<CatalogSyncRun> {
  const call = httpsCallable(firebaseFunctions(), 'runTenantJob');
  const res = await call({
    action: opts?.apply ? 'catalogSyncApply' : 'catalogSync',
    tenantId,
    ...(opts?.apply && opts.preview ? { args: { previewRunId: opts.preview.runId, planHash: opts.preview.planHash } } : {}),
  });
  return (res.data as { result: CatalogSyncRun }).result;
}

// --- Importación paginada reanudable + centro de calidad ----------------------
// (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1). Contratos fijados por el diseño;
// el backend se implementa en paralelo — el panel codea contra ESTOS shapes.

/** Contadores por desenlace de la corrida de importación (acumulados del run). */
export interface ImportRunContadores {
  imported: number;
  alreadyLinked: number;
  alreadyImported: number;
  ambiguous: number;
  conflicted: number;
  skipped: number;
  unclassified: number;
}

export interface MetaCatalogImportRunState {
  status: 'running' | 'completed' | 'failed' | 'already_running';
  runId: string;
  /** Cursor remoto persistido; null = arranque (o catálogo terminado). */
  cursor: string | null;
  /** true = quedan páginas: el panel debe re-invocar (con resume) hasta completed. */
  more: boolean;
  pagesDone: number;
  procesados: number;
  contadores: ImportRunContadores;
  /** Veces que el cursor venció y la lectura reinició (la idempotencia evita duplicados). */
  cursorResets: number;
  lastError?: string;
  /**
   * Por qué se cortó ESTA invocación: 'pages_budget' es avance normal (seguir invocando);
   * 'quota'/'remote_error' son cortes que el panel NO debe martillar en bucle — se muestran
   * y se ofrece reanudar manualmente.
   */
  stopReason?: 'pages_budget' | 'quota' | 'remote_error';
}

/**
 * Normaliza la respuesta del backend al shape que consume el panel. Tolera las dos
 * ortografías en juego mientras el backend se implementa en paralelo: el contrato del
 * programa (`procesados`/`contadores`/`cursorResets`/`more`) y la vista compartida
 * `MetaCatalogImportRunSummary` de @vpw/shared (`processed`/`counters` con cursorResets
 * adentro/`hasCursor`). `cancelled` se muestra como corte con aviso (reanudable).
 */
function normalizarImportRun(raw: unknown): MetaCatalogImportRunState {
  const top = (raw ?? {}) as Record<string, unknown>;
  // `already_running` trae el avance REAL adentro de `run` (el nivel superior solo dice que
  // está ocupado): sin esto, la fase "ocupado" mostraba todos los contadores en cero.
  const anidado =
    top['status'] === 'already_running' && top['run'] && typeof top['run'] === 'object'
      ? (top['run'] as Record<string, unknown>)
      : null;
  const d = anidado ? { ...anidado, status: 'already_running' } : top;
  const contadoresRaw = (d['contadores'] ?? d['counters'] ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const statusRaw = typeof d['status'] === 'string' ? (d['status'] as string) : 'failed';
  const cancelado = statusRaw === 'cancelled';
  const status: MetaCatalogImportRunState['status'] =
    statusRaw === 'running' || statusRaw === 'completed' || statusRaw === 'already_running'
      ? statusRaw
      : 'failed';
  const lastError =
    typeof d['lastError'] === 'string' && d['lastError']
      ? (d['lastError'] as string)
      : cancelado
        ? 'La importación fue cancelada. Se puede reanudar.'
        : undefined;
  return {
    status,
    runId: typeof d['runId'] === 'string' ? (d['runId'] as string) : '',
    cursor: typeof d['cursor'] === 'string' ? (d['cursor'] as string) : null,
    more:
      d['more'] === true ||
      (status === 'running' && (d['hasCursor'] === true || typeof d['cursor'] === 'string')),
    pagesDone: num(d['pagesDone']),
    procesados: num(d['procesados'] ?? d['processed']),
    contadores: {
      imported: num(contadoresRaw['imported']),
      alreadyLinked: num(contadoresRaw['alreadyLinked']),
      alreadyImported: num(contadoresRaw['alreadyImported']),
      ambiguous: num(contadoresRaw['ambiguous']),
      conflicted: num(contadoresRaw['conflicted']),
      skipped: num(contadoresRaw['skipped']),
      unclassified: num(contadoresRaw['unclassified']),
    },
    cursorResets: num(d['cursorResets'] ?? contadoresRaw['cursorResets']),
    ...(lastError ? { lastError } : {}),
    ...(d['stopReason'] === 'pages_budget' || d['stopReason'] === 'quota' || d['stopReason'] === 'remote_error'
      ? { stopReason: d['stopReason'] as 'pages_budget' | 'quota' | 'remote_error' }
      : {}),
  };
}

/**
 * Corre (o reanuda) la importación paginada del catálogo de Meta. SOLO dueño.
 * Cada invocación procesa un puñado de páginas y devuelve el estado del run; si
 * `more` es true hay que volver a invocar con `resume: true` hasta `completed`.
 * NO escribe nada en Meta: solo crea productos locales inactivos.
 */
export async function runMetaCatalogImport(
  tenantId: string,
  opts?: { resume?: boolean; defaultCategoryId?: string; maxPages?: number },
): Promise<MetaCatalogImportRunState> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogImportRun');
  const res = await call({
    tenantId,
    ...(opts?.resume != null ? { resume: opts.resume } : {}),
    ...(opts?.defaultCategoryId ? { defaultCategoryId: opts.defaultCategoryId } : {}),
    ...(opts?.maxPages != null ? { maxPages: opts.maxPages } : {}),
  });
  return normalizarImportRun(res.data);
}

/** Estado del run de importación activo/último (null si nunca se corrió). */
export async function fetchMetaCatalogImportStatus(
  tenantId: string,
): Promise<{ run: MetaCatalogImportRunState | null }> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogImportStatus');
  const res = await call({ tenantId });
  const data = res.data as { run?: unknown };
  return { run: data.run != null ? normalizarImportRun(data.run) : null };
}

/** Agregado del centro de calidad, calculado server-side (nunca recorriendo el cliente). */
export interface CatalogQualitySummary {
  /** Productos con al menos una observación BLOCKING abierta. */
  conBloqueos: number;
  /** Productos con advertencias (WARNING) abiertas. */
  conAdvertencias: number;
  /** Conteo por código de problema (para los filtros del centro de calidad). */
  porCodigo: Record<string, number>;
  muestras: Array<{
    productId: string;
    productName: string;
    blocking: number;
    warning: number;
    codigos: string[];
  }>;
  /** true si hay más productos con problemas que las muestras devueltas. */
  truncated: boolean;
}

export async function fetchCatalogQualitySummary(tenantId: string): Promise<CatalogQualitySummary> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogQualitySummary');
  const res = await call({ tenantId });
  const data = (res.data ?? {}) as Record<string, unknown>;
  // El callable emite `porCodigo: {code: {severity, count}}` y `muestras[].name/codes`; el
  // panel consume números planos y `productName/codigos`. Se normaliza ACÁ (un solo borde):
  // sin esto el filtro mostraba "([object Object])" y el fallback crasheaba con codigos
  // undefined.
  const porCodigo: Record<string, number> = {};
  for (const [code, v] of Object.entries((data['porCodigo'] as Record<string, unknown>) ?? {})) {
    porCodigo[code] =
      typeof v === 'number'
        ? v
        : typeof (v as { count?: unknown })?.count === 'number'
          ? ((v as { count: number }).count)
          : 0;
  }
  const muestras = Array.isArray(data['muestras'])
    ? (data['muestras'] as Array<Record<string, unknown>>).map((m) => ({
        productId: typeof m['productId'] === 'string' ? (m['productId'] as string) : '',
        productName:
          typeof m['productName'] === 'string'
            ? (m['productName'] as string)
            : typeof m['name'] === 'string'
              ? (m['name'] as string)
              : '',
        blocking: typeof m['blocking'] === 'number' ? (m['blocking'] as number) : 0,
        warning: typeof m['warning'] === 'number' ? (m['warning'] as number) : 0,
        codigos: Array.isArray(m['codigos'])
          ? (m['codigos'] as string[])
          : Array.isArray(m['codes'])
            ? (m['codes'] as string[])
            : [],
      }))
    : [];
  return {
    conBloqueos: typeof data['conBloqueos'] === 'number' ? (data['conBloqueos'] as number) : 0,
    conAdvertencias: typeof data['conAdvertencias'] === 'number' ? (data['conAdvertencias'] as number) : 0,
    porCodigo,
    muestras,
    truncated: data['truncated'] === true,
  };
}
