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
import {
  CAMPOS_PUBLICOS,
  describirHorario,
  esCampoCritico,
  esCampoPublico,
  esEstadoMeta,
  etiquetaCampo,
  sanitizarTextoPublico,
  valorMostrable,
  type CampoPublico,
  type EstadoMeta,
  type ModeloPropiedad,
} from './catalogOwnership';
import { normalizarAutoridad, type CatalogAuthorityView } from './catalogAuthority';

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
  /**
   * `claim_lost` = otra invocación tomó el control del run (fencing generacional del
   * backend): la respuesta viene SIN contadores — el panel debe consultar el estado del
   * claim vigente, jamás pintar estos ceros como si fueran el avance real.
   */
  status: 'running' | 'completed' | 'failed' | 'already_running' | 'claim_lost';
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
 * adentro/`hasCursor`). `cancelled` se muestra como corte con aviso (reanudable);
 * `claim_lost` (otra invocación tomó el run) se reconoce con su `message` — jamás cae al
 * default `failed` con contadores en cero. PURA (sin Firebase) — exportada para testearla.
 */
export function normalizarImportRun(raw: unknown): MetaCatalogImportRunState {
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
    statusRaw === 'running' || statusRaw === 'completed' || statusRaw === 'already_running' || statusRaw === 'claim_lost'
      ? statusRaw
      : 'failed';
  // `claim_lost` trae su explicación en `message` (no en lastError) y NINGÚN contador: el
  // texto se conserva, y el loop del panel sabe que este estado no debe pintar avance.
  const lastError =
    typeof d['lastError'] === 'string' && d['lastError']
      ? (d['lastError'] as string)
      : status === 'claim_lost' && typeof d['message'] === 'string' && d['message']
        ? (d['message'] as string)
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
  /**
   * COBERTURA (ADR-0014 §4c): productos NO archivados que todavía no fueron evaluados
   * (sin campo `quality`). Con esto >0 el panel jamás muestra el estado verde "completo".
   */
  sinEvaluar: number;
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

/**
 * Normaliza el agregado de calidad al shape del panel. El callable emite las DOS formas en
 * juego: `porCodigo` como número plano o como objeto `{severity, count}`, y `muestras[]` con
 * `productName/codigos` o `name/codes`. Se normaliza ACÁ (un solo borde): sin esto el filtro
 * mostraba "([object Object])" y el fallback crasheaba con codigos undefined.
 * PURA (sin Firebase) — exportada para testearla directo.
 */
export function normalizarQualitySummary(raw: unknown): CatalogQualitySummary {
  const data = (raw ?? {}) as Record<string, unknown>;
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
    // Backend viejo sin cobertura ⇒ 0 (no se inventa deuda que el server no reportó).
    sinEvaluar: typeof data['sinEvaluar'] === 'number' && data['sinEvaluar'] > 0 ? (data['sinEvaluar'] as number) : 0,
    porCodigo,
    muestras,
    truncated: data['truncated'] === true,
  };
}

export async function fetchCatalogQualitySummary(tenantId: string): Promise<CatalogQualitySummary> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogQualitySummary');
  const res = await call({ tenantId });
  return normalizarQualitySummary(res.data);
}

// --- Propiedad por campos del catálogo (ADR-0015) -----------------------------
// El backend de este programa se implementa EN PARALELO: el panel codea contra el shape
// del ADR y normaliza tolerante (igual que `normalizarImportRun`), aceptando la propiedad
// anidada en `ownership` o plana en el nivel superior y las dos ortografías de cada lista.
// Regla dura: de la fuente externa solo se muestra METADATA SANEADA — jamás la URL del feed,
// su query string ni un token, aunque el backend los mande por error.

export type { CampoPublico, EstadoMeta, ModeloPropiedad } from './catalogOwnership';

/** Fuente externa que publica el catálogo, tal como la muestra el panel (ya saneada). */
export interface FuenteExternaView {
  /** Identificador NO secreto del feed/data source (para distinguir dos fuentes). */
  id: string;
  kind: 'meta_feed' | 'commerce_manager' | 'other_api' | 'desconocida';
  /** Nombre SANEADO. Nunca una URL, una query string ni un token. */
  nombre: string;
  /** Horario legible ("todos los días a las 03:33 (America/Asuncion)") o '' si no se sabe. */
  horario: string;
  /** Datos públicos que publica esta fuente. */
  campos: CampoPublico[];
  /** true si una persona la reconoció explícitamente (hay quién y cuándo). */
  reconocida: boolean;
  /** true si la fuente BORRA en Meta lo que no está en su archivo. */
  borraFaltantes: boolean;
  /** Artículos que publica, si el backend lo informa. */
  articulos: number | null;
}

/** Estado de propiedad del catálogo del tenant, normalizado para el panel. */
export interface CatalogOwnershipStatus {
  /** false ⇒ el tenant no tiene sincronización de catálogo configurada: nada se lee ni se escribe. */
  configurado: boolean;
  model: ModeloPropiedad;
  /** Datos que VendeYaPy PUEDE publicar hoy. Vacío ⇒ no existe envío posible a Meta. */
  propios: CampoPublico[];
  /** Datos gobernados por la fuente externa reconocida. */
  externos: CampoPublico[];
  /**
   * REALIDAD (ADR-0015 §8): true si una persona reconoció una fuente externa que gobierna el
   * catálogo publicado. Se lee del eje `declared` del callable, que NO pasa por el interruptor
   * de sincronización: apagar lo NUESTRO no apaga el feed del tenant.
   */
  gobiernoExterno: boolean;
  /**
   * PERMISO: true si nuestra sincronización está apagada (nivel 1 fail-closed) — no publicamos
   * ni comparamos nada por nuestra cuenta. Es un motivo de bloqueo DISTINTO de "nadie declaró la
   * propiedad", y confundirlos hacía que la tarjeta negara un feed ya reconocido.
   */
  sincronizacionApagada: boolean;
  fuentes: FuenteExternaView[];
  /** Fuentes detectadas que nadie reconoció: bloquean cualquier escritura hasta revisarlas. */
  sinReconocer: number;
  modoConfigurado: CatalogSyncMode;
  /** Modo EFECTIVO: el techo de la propiedad nunca puede ser superado por la config. */
  modoEfectivo: CatalogSyncMode;
  degradado: boolean;
  /** Motivos crudos de la degradación (se traducen con `etiquetaMotivo`). */
  motivos: string[];
  /** Cuándo se leyó por última vez el catálogo publicado (null = nunca). */
  verificadoEn: Date | null;
  /**
   * Eje `authority` (ADR-0022): quién administra el catálogo y su relación con Meta.
   * null = el backend todavía no expone el contrato nuevo ⇒ el panel conserva el
   * comportamiento vigente (ningún gating nuevo se activa a ciegas).
   */
  autoridad: CatalogAuthorityView | null;
}

export type CatalogSyncMode = 'off' | 'dry_run' | 'live';

const MODELOS: readonly ModeloPropiedad[] = ['vendeyapy_managed', 'external_managed', 'hybrid'];
const KINDS: readonly FuenteExternaView['kind'][] = ['meta_feed', 'commerce_manager', 'other_api'];

function modoValido(v: unknown): CatalogSyncMode | null {
  return v === 'off' || v === 'dry_run' || v === 'live' ? v : null;
}

/** Lista canónica de campos públicos: solo válidos, sin repetidos, orden estable. */
function camposDe(raw: unknown): CampoPublico[] {
  if (!Array.isArray(raw)) return [];
  const s = new Set<CampoPublico>();
  for (const x of raw) if (esCampoPublico(x)) s.add(x);
  return CAMPOS_PUBLICOS.filter((f) => s.has(f));
}

/**
 * Fecha tolerante: Timestamp serializado por el callable (`_seconds`/`seconds`), ISO, milis
 * o Date. Cualquier otra cosa ⇒ null (el panel dice "todavía no verificamos", no inventa).
 */
export function aFecha(raw: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Segundos (10 dígitos) contra milisegundos: sin esto, 1785...  caía en 1970.
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === 'string') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const seg = typeof r._seconds === 'number' ? r._seconds : typeof r.seconds === 'number' ? r.seconds : null;
    if (seg != null) return aFecha(seg * 1000);
  }
  return null;
}

/**
 * Una fuente externa lista para mostrar. `idsReconocidos` son los ids que una persona
 * reconoció en la declaración de propiedad: una fuente DETECTADA cuyo id está en esa lista ya
 * está reconocida aunque el backend no repita el flag en cada entrada. Sin esto, un catálogo
 * con dos feeds reconocidos mostraba "hay 1 fuente que nadie reconoció" para siempre.
 */
function fuenteDe(raw: unknown, idsReconocidos?: ReadonlySet<string>): FuenteExternaView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kindRaw = typeof r.kind === 'string' ? r.kind : '';
  const ids = Array.isArray(r.acknowledgedSourceIds)
    ? r.acknowledgedSourceIds.filter((x): x is string => typeof x === 'string' && !!x.trim())
    : [];
  const id = sanitizarTextoPublico(typeof r.id === 'string' ? r.id : (r.sourceId ?? ids[0]), 64);
  const nombre = sanitizarTextoPublico(r.name ?? r.nombre ?? r.label ?? r.nombreSaneado, 80);
  return {
    id,
    kind: (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as FuenteExternaView['kind']) : 'desconocida',
    nombre,
    // `schedule`+`timezone` separados es la forma de MetaCatalogDetectedSource (@vpw/shared).
    horario: describirHorario(r.scheduleLabel ?? r.schedule ?? r.horario, r.timezone),
    campos: camposDe(r.declaredFields ?? r.detectedFields ?? r.fields ?? r.campos),
    // Reconocida = hay rastro humano. `acknowledged:false` explícito gana sobre todo.
    reconocida:
      r.acknowledged === true ||
      (r.acknowledged !== false &&
        ((typeof r.acknowledgedByUid === 'string' ? !!r.acknowledgedByUid.trim() : false) ||
          (!!id && idsReconocidos?.has(id) === true))),
    borraFaltantes: r.deletionEnabled === true || r.deletesMissingItems === true || r.borraFaltantes === true,
    articulos: typeof r.itemCount === 'number' && Number.isFinite(r.itemCount) ? r.itemCount : null,
  };
}

/**
 * Normaliza el estado de propiedad al shape del panel. PURA (sin Firebase) — exportada para
 * testearla directo. FAIL-CLOSED en la presentación: si no se entiende qué llegó, el modelo
 * reportado es `external_managed` con CERO campos propios, que es el supuesto seguro (si no
 * sabemos quién manda, asumimos que no somos nosotros).
 */
export function normalizarOwnershipStatus(raw: unknown): CatalogOwnershipStatus {
  const top = (raw ?? {}) as Record<string, unknown>;
  const own = (top.ownership && typeof top.ownership === 'object' && !Array.isArray(top.ownership)
    ? (top.ownership as Record<string, unknown>)
    : top) as Record<string, unknown>;

  const modelRaw = typeof own.model === 'string' ? own.model : '';
  const model: ModeloPropiedad = (MODELOS as readonly string[]).includes(modelRaw)
    ? (modelRaw as ModeloPropiedad)
    : 'external_managed';

  const motivos = Array.isArray(own.reasons)
    ? own.reasons.filter((x): x is string => typeof x === 'string' && !!x.trim())
    : [];
  const degradado = own.degraded === true || (own.degraded !== false && motivos.length > 0);

  // Fuentes: la reconocida del contrato (`externalSource`) + las detectadas por la lectura.
  const detectadas = Array.isArray(top.detectedSources)
    ? top.detectedSources
    : Array.isArray(own.detectedSources)
      ? own.detectedSources
      : Array.isArray(top.sources)
        ? top.sources
        : [];
  // EJE REALIDAD del callable (`declared`): quién gobierna el catálogo AFUERA, leído SIN el gate
  // de ejecución. Con la sync apagada `ownership` viaja degradada (es el eje PERMISO, y ahí está
  // bien que no haya nada), pero el feed que una persona reconoció sigue publicando: sin esto la
  // tarjeta decía "todavía nadie declaró quién administra el catálogo" y le mentía al owner.
  const declarado = (top.declared && typeof top.declared === 'object' && !Array.isArray(top.declared)
    ? (top.declared as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  // La declaración humana puede llegar como `externalSource` (EffectiveOwnership del backend), en
  // el eje `declared`, o como `external` objeto (la config cruda del ADR §1). Ojo: `external`
  // TAMBIÉN puede ser la lista de campos externos — solo se toma como declaración si es un objeto.
  const declaracion =
    own.externalSource ??
    top.externalSource ??
    declarado.externalSource ??
    (own.external && typeof own.external === 'object' && !Array.isArray(own.external) ? own.external : null);
  const idsReconocidos = new Set<string>(
    (Array.isArray((declaracion as Record<string, unknown> | null)?.acknowledgedSourceIds)
      ? ((declaracion as Record<string, unknown>).acknowledgedSourceIds as unknown[])
      : []
    )
      .map((x) => sanitizarTextoPublico(x, 64))
      .filter((x) => !!x),
  );
  const fuentes: FuenteExternaView[] = [];
  const reconocida = fuenteDe(declaracion, idsReconocidos);
  if (reconocida) fuentes.push({ ...reconocida, reconocida: true });
  for (const d of detectadas) {
    const f = fuenteDe(d, idsReconocidos);
    if (!f) continue;
    // Misma fuente ya listada por el reconocimiento: no se duplica en pantalla.
    if (f.id && fuentes.some((x) => x.id === f.id)) continue;
    fuentes.push(f);
  }

  // Degradado ⇒ cero campos propios SIEMPRE, aunque el backend mande una lista.
  const propios = degradado ? [] : camposDe(own.writable ?? own.ownedFields ?? own.propios);
  // Campos externos según el eje PERMISO (la propiedad efectiva, que pasa por el gate de sync)…
  const externosDeGate = camposDe(own.external ?? own.externalFields ?? own.externos);
  // …y según el eje REALIDAD (la declaración humana, sin gate). Con la sync encendida las dos
  // listas coinciden; con la sync apagada la primera viaja vacía y esta es la única que dice
  // quién gobierna el catálogo publicado.
  const externosReales = camposDe(declarado.externalFields ?? declarado.external ?? declarado.externos);
  const externos = externosDeGate.length
    ? externosDeGate
    : externosReales.length
      ? externosReales
      : camposDe(fuentes.flatMap((f) => f.campos as string[]));
  const gobiernoExterno = externosReales.length > 0 || fuentes.some((f) => f.reconocida);

  // El callable puede devolver la config anidada (`config: { mode, enabled }`) o plana.
  const cfg = (top.config && typeof top.config === 'object' && !Array.isArray(top.config)
    ? (top.config as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const modoConfigurado = modoValido(top.configMode ?? top.mode ?? cfg.mode ?? own.mode) ?? 'off';
  const techo = modoValido(own.modeCeiling) ?? (degradado ? 'dry_run' : 'live');
  const modoEfectivo =
    modoValido(top.effectiveMode ?? cfg.effectiveMode) ??
    (modoConfigurado === 'off' ? 'off' : modoConfigurado === 'live' && techo === 'live' ? 'live' : 'dry_run');

  const señales =
    modoConfigurado !== 'off' ||
    fuentes.length > 0 ||
    propios.length > 0 ||
    externos.length > 0 ||
    motivos.length > 0 ||
    (MODELOS as readonly string[]).includes(modelRaw);
  // Un gobierno externo RECONOCIDO alcanza para considerar el catálogo conectado aunque nuestra
  // sync esté apagada: responder "esta empresa no tiene un catálogo de Meta conectado" mientras
  // el sitio del tenant lo publica todas las madrugadas es la misma mentira con otra cara.
  const configurado =
    gobiernoExterno || (top.enabled !== false && cfg.enabled !== false && top.configured !== false && señales);
  const sincronizacionApagada = top.enabled === false || cfg.enabled === false || modoEfectivo === 'off';

  return {
    configurado,
    model,
    propios,
    externos,
    gobiernoExterno,
    sincronizacionApagada,
    fuentes,
    sinReconocer: fuentes.filter((f) => !f.reconocida).length,
    modoConfigurado,
    modoEfectivo,
    degradado,
    motivos,
    verificadoEn: aFecha(
      top.lastSourceCheckAtMs ?? top.lastSourceCheckAt ?? own.lastSourceCheckAt ?? top.lastVerifiedAt ?? top.verifiedAt,
    ),
    autoridad: normalizarAutoridad(top.authority),
  };
}

/**
 * Estado de propiedad del catálogo del tenant. SOLO LECTURA: no cambia el modelo, no reconoce
 * fuentes y no escribe en Meta.
 *
 * Contrato del callable `metaCatalogOwnershipStatus` (el backend lo expone en paralelo):
 *   { ok, enabled, configMode, effectiveMode, lastSourceCheckAt,
 *     ownership: EffectiveOwnership,               // PERMISO: {model, writable[], external[], externalSource, modeCeiling, degraded, reasons[]}
 *     declared: { externalFields[], externalSource }, // REALIDAD: gobierno externo declarado, SIN el gate de sync
 *     detectedSources: MetaCatalogDetectedSource[],  // vista SANEADA de @vpw/shared
 *     authority: { authority, relationship, declared, reasons[], staleness } } // ADR-0022 (opcional)
 * `normalizarOwnershipStatus` tolera además la config anidada (`config:{mode,enabled}`), la
 * propiedad plana y la declaración externa en `ownership.external` como objeto.
 *
 * Si el callable NO existe o falla, la promesa rechaza a propósito: la UI queda FAIL-CLOSED
 * (bloquea el opt-in y el envío diciendo que no pudo verificar), nunca fail-open.
 */
export async function fetchCatalogOwnershipStatus(tenantId: string): Promise<CatalogOwnershipStatus> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogOwnershipStatus');
  const res = await call({ tenantId });
  return normalizarOwnershipStatus(res.data);
}

// --- Estado ACTUAL de un producto contra lo publicado (ADR-0015 §5) -----------

/** Un dato que quedó distinto entre lo local y lo publicado, listo para mostrar. */
export interface CampoDivergente {
  campo: string;
  /** Etiqueta legible ("Precio"). */
  etiqueta: string;
  /** Quién gobierna ese dato (define a quién hay que ir a corregir). */
  duenio: 'externa' | 'vendeyapy' | 'desconocido';
  /** true si la divergencia frena la venta automática (plata y disponibilidad). */
  critico: boolean;
  /** Valor de acá, ya formateado y saneado. */
  local: string;
  /** Valor publicado en Meta, ya formateado y saneado. */
  publicado: string;
}

export interface ProductoDerivaView {
  estado: EstadoMeta;
  campos: CampoDivergente[];
  /** Cuándo LEÍMOS Meta para comparar (distinto de la última escritura confirmada). */
  verificadoEn: Date | null;
  /** true si alguna divergencia frena la venta automática. */
  critico: boolean;
}

/**
 * Caducidad de la verificación (ADR-0015 §5): el TTL documentado es el menor entre 24 horas y
 * el período de la fuente externa. El panel usa ese techo de 24 h — con un feed diario coincide.
 */
export const TTL_VERIFICACION_MS = 24 * 60 * 60 * 1000;

/**
 * Lee `metaSyncState` / `metaDrift` / `metaVerifiedAt` de un producto. Devuelve null si el
 * producto todavía no tiene ninguna proyección de estado actual (backend sin desplegar o
 * artículo nunca verificado): el panel muestra el estado operativo de siempre, jamás inventa
 * un "coincide". PURA — exportada para testearla (`ahora` inyectable para fijar la caducidad).
 */
export function normalizarDerivaProducto(raw: unknown, ahora: number = Date.now()): ProductoDerivaView | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const estadoRaw = p.metaSyncState ?? p.metaState;
  const driftRaw = (p.metaDrift ?? p.drift) as Record<string, unknown> | undefined;
  // Forma CANÓNICA del backend (ADR-0015 §5): `fields` es la lista de NOMBRES de campo y los
  // valores viajan saneados en `observed`. Se prioriza `observed` porque es la única que trae
  // los valores; las otras formas se conservan por tolerancia (docs viejos / vistas previas).
  const listaRaw = Array.isArray(driftRaw?.observed)
    ? driftRaw!.observed
    : Array.isArray(driftRaw?.fields)
      ? driftRaw!.fields
      : Array.isArray(driftRaw?.campos)
        ? driftRaw!.campos
        : Array.isArray(p.metaDrift)
          ? (p.metaDrift as unknown[])
          : [];
  if (!esEstadoMeta(estadoRaw) && listaRaw.length === 0) return null;

  const campos: CampoDivergente[] = [];
  for (const it of listaRaw) {
    // `fields: string[]` (forma canónica sin valores): el dueño y la severidad viven en la
    // RAÍZ de la deriva. Sin este caso, un producto derivado se mostraría sin ningún campo.
    const f = (typeof it === 'string' ? { field: it } : it) as Record<string, unknown> | null;
    if (!f || typeof f !== 'object') continue;
    const campo = typeof f.field === 'string' ? f.field : typeof f.campo === 'string' ? f.campo : '';
    if (!campo) continue;
    const duenioRaw =
      typeof f.owner === 'string'
        ? f.owner
        : typeof f.duenio === 'string'
          ? f.duenio
          : typeof driftRaw?.owner === 'string'
            ? (driftRaw.owner as string)
            : '';
    const duenio: CampoDivergente['duenio'] =
      duenioRaw === 'external' || duenioRaw === 'externa'
        ? 'externa'
        : duenioRaw === 'vendeyapy' || duenioRaw === 'vendeyapy_managed'
          ? 'vendeyapy'
          : 'desconocido';
    // La severidad se toma SOLO de la entrada del campo: la de la raíz es el agregado (la más
    // grave de todas) y aplicarla a cada campo pintaría de crítico un cambio de nombre.
    const sev = typeof f.severity === 'string' ? f.severity : '';
    campos.push({
      campo,
      etiqueta: etiquetaCampo(campo),
      duenio,
      // La severidad del backend manda; sin ella, la lista de campos críticos del ADR.
      // `commercial` es el vocabulario del backend (precio/moneda/disponibilidad/stock):
      // omitirlo dejaría pasar una divergencia de plata como si fuera cosmética.
      critico: sev ? sev === 'commercial' || sev === 'critical' || sev === 'blocking' : esCampoCritico(campo),
      local: valorMostrable(campo, f.local ?? f.localValue ?? f.expected),
      publicado: valorMostrable(campo, f.remote ?? f.remoteValue ?? f.published ?? f.observed),
    });
  }

  const base: EstadoMeta = esEstadoMeta(estadoRaw)
    ? estadoRaw
    : campos.some((c) => c.duenio === 'externa')
      ? 'drifted_external'
      : 'drifted';
  const verificadoEn = aFecha(p.metaVerifiedAt ?? driftRaw?.lastSeenAt ?? driftRaw?.detectedAt ?? driftRaw?.observedAt);
  // CADUCIDAD DERIVADA EN LECTURA (ADR-0015 §5): `stale` jamás se persiste, así que si el
  // panel no lo derivara mostraría "coincide" para siempre con una comprobación de la semana
  // pasada. Solo degrada `verified`: envejecer una deriva YA detectada la escondería, que es
  // exactamente la falla opuesta a la que este programa viene a arreglar.
  const vencida = verificadoEn == null || ahora - verificadoEn.getTime() > TTL_VERIFICACION_MS;
  return {
    estado: base === 'verified' && vencida ? 'stale' : base,
    campos,
    verificadoEn,
    critico: campos.some((c) => c.critico),
  };
}
