/**
 * meta/catalog.ts — Sincronización REAL del catálogo a Meta (META-CATALOG-LIVE-1)
 * ================================================================================
 * Reemplaza la sync DEMO (D4). Contrato B:
 *  - Fuente de verdad: VendeyaPy → Meta. Meta→VendeyaPy solo para descubrimiento/drift.
 *  - Matching SOLO por retailer_id === SKU único. Coincidencia por nombre = SUGERENCIA
 *    (bloquea con confirmación pendiente); SKU vacío/duplicado bloquea el producto.
 *  - Payload SOLO con campos públicos (nombre, descripción pública, precio "N PYG",
 *    condition new, availability, imagen HTTPS, marca). JAMÁS costo/margen/aiNotes/
 *    aiFicha/datos de clientes/config bancaria/Coverage.
 *  - Disponibilidad por stock/ARCHIVED vía availability; NUNCA se borra un item de Meta.
 *    La palanca de availability funciona AUN con el producto bloqueado para create/update
 *    (disable mínimo), salvo ambigüedad de identidad (SKU duplicado/ausente).
 *  - Config fail-closed por tenant (catalogSyncConfig.ts): sin config ⇒ NO sincroniza.
 *  - dry_run: CERO escrituras en Meta y CERO cambios en products; solo run log + audit.
 *  - apply: SOLO con mode:'live'. Los requests siguen el contrato de escritura de Meta
 *    (ADR-0012): CREATE explícito con obligatorios, UPDATE parcial, disable mínimo.
 *    `allow_upsert:false` — un UPDATE jamás crea por accidente.
 *    items_batch es ASÍNCRONO en Meta: la verificación relee el catálogo y compara los
 *    campos públicos — solo lo confirmado queda 'synced'/'disabled'; lo demás 'pending'
 *    y CONVERGE en el próximo apply (los 'unchanged' con item remoto se re-confirman).
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Product, MetaCatalogSyncLog } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../audit/audit.js';
import { normalizeCatalogSyncConfig, type CatalogSyncMode } from './catalogSyncConfig.js';
import {
  assertBatchRequestShape,
  getMetaCatalogClientForTenant,
  MetaCatalogApiError,
  type MetaCatalogClient,
  type MetaRemoteCatalogItem,
} from './catalogClient.js';
import {
  buildCatalogCreatePayload,
  buildCatalogDisablePatch,
  buildCatalogUpdatePatch,
  canonicalHttpsUrl,
  createBlockers,
  MAX_ID_LENGTH,
  outboundAvailability,
  outboundBrand,
  outboundDescription,
  outboundId,
  outboundImageUrl,
  outboundLink,
  outboundPrice,
  outboundTitle,
  updateBlockers,
  type CatalogBatchRequest,
  type CreateBlocker,
  type UpdateBlocker,
} from './catalogOutbound.js';

const BATCH_CHUNK = 100;
const MAX_STORED_ENTRIES = 500; // techo del run doc (y de la respuesta al panel)
const STATE_COMMIT_CHUNK = 200; // docs por commit al persistir meta* (lejos de los techos de Firestore)

// ---------------------------------------------------------------------------
// Payload público (PURO, testeable): lo ÚNICO que puede viajar a Meta.
// ---------------------------------------------------------------------------

export type CatalogAvailability = 'in stock' | 'out of stock';

/**
 * Disponibilidad pública: vendible solo si está ACTIVE y con stock (si trackea).
 * Alias de la derivación canónica del contrato — una sola implementación para el diff y
 * para lo que se envía.
 */
export const productAvailability = outboundAvailability;

const firstHttpsImage = (p: Product): string | null => outboundImageUrl(p) || null;

/**
 * Identidad remota EFECTIVA de un producto: el `metaRetailerId` confirmado manda; el SKU
 * interno es fallback SOLO para productos habilitados que todavía no tienen vínculo (o sea,
 * productos nuevos que se van a crear en Meta). El SKU jamás se modifica para adaptarlo a Meta.
 */
export function effectiveRetailerId(p: Product): string {
  // Delega en `outboundId` para que la clave del plan sea EXACTAMENTE la que viaja a Meta
  // (incluido el tope de 100 caracteres). Si el plan usara una identidad más larga que la
  // enviada, la verificación post-apply y los errores por item nunca matchearían.
  return outboundId(p);
}

/**
 * Vista pública LOCAL en los términos del contrato de **LECTURA** de Meta (`name`,
 * `image_url`, …). Se usa EXCLUSIVAMENTE para comparar contra lo que devuelve un GET y
 * decidir qué cambió. **No es lo que se envía**: el contrato de escritura vive en
 * `catalogOutbound.ts` y usa `title`/`image`/`link`. Mantenerlos separados es lo que evita
 * mandar nombres de campo del lado equivocado.
 */
export function localPublicView(p: Product): Record<string, unknown> {
  // Los valores salen de las MISMAS derivaciones que usa el serializador de escritura: si
  // difirieran (otro truncado, otro fallback), el diff marcaría el campo como cambiado en
  // cada corrida y el producto nunca convergería a `synced`.
  const brand = outboundBrand(p);
  return {
    retailer_id: outboundId(p),
    name: outboundTitle(p),
    description: outboundDescription(p),
    price: outboundPrice(p),
    condition: 'new',
    availability: outboundAvailability(p),
    image_url: outboundImageUrl(p),
    // `url` es el nombre del campo en el contrato de LECTURA (al escribir se llama `link`).
    url: outboundLink(p),
    ...(brand ? { brand } : {}),
  };
}

// ---------------------------------------------------------------------------
// Plan (PURO): diff local vs remoto con matching por retailer_id === SKU.
// ---------------------------------------------------------------------------

export type CatalogPlanAction = 'create' | 'update' | 'disable' | 'unchanged' | 'blocked';
export type CatalogBlockReason =
  | 'sku_missing'
  | 'sku_duplicated'
  | 'retailer_id_duplicated'
  | 'name_missing'
  | 'currency_not_pyg'
  | 'price_invalid'
  | 'image_not_https'
  | 'name_conflict_requires_confirmation'
  // Obligatorios del contrato de CREACIÓN de Meta (solo aplican a la acción `create`).
  | 'product_url_missing'
  | 'product_url_not_https'
  | 'identity_too_long'
  | 'brand_missing'
  | 'description_missing'
  | 'no_writable_change'
  /** El producto tiene datos que el contrato de Meta no admite: queda fuera, sin romper el plan. */
  | 'serialization_failed';

export interface CatalogPlanEntry {
  productId: string;
  /** Identidad remota efectiva (metaRetailerId confirmado, o el SKU como fallback). */
  sku: string;
  /** SKU interno real del producto (nunca se altera para Meta). Informativo. */
  internalSku?: string;
  /** true si la identidad viene de un mapping confirmado y no del SKU. */
  mapped?: boolean;
  productName: string;
  action: CatalogPlanAction;
  blockedReasons?: CatalogBlockReason[];
  /** Coincidencia por NOMBRE con otro retailer_id: sugerencia, jamás auto-vincula. */
  suggestion?: { remoteRetailerId: string; remoteName: string };
  changedFields?: string[];
  /** Vista LOCAL en términos de lectura (para el diff y para confirmar la convergencia). */
  payload?: Record<string, unknown>;
  /** Request de ESCRITURA ya serializado según el contrato. Solo en acciones accionables. */
  request?: CatalogBatchRequest;
  remoteItemId?: string | null;
  note?: string;
}

export interface CatalogSyncPlan {
  entries: CatalogPlanEntry[];
  /** Items que existen en Meta sin producto local con ese SKU. Solo se REPORTAN. */
  remoteOnly: Array<{ retailerId: string; name: string }>;
  /** ARCHIVED sin presencia remota (o con identidad reclamada por un producto vivo). */
  ignoredArchived: number;
  /** Productos SIN opt-in (`syncToMeta !== true`): quedan totalmente fuera del plan. */
  excludedNotManaged: number;
  summary: Record<CatalogPlanAction | 'remoteOnly', number>;
}

const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const priceDigits = (s: string) => s.replace(/\D+/g, '');

/**
 * Traduce un bloqueo del contrato de creación al vocabulario de motivos del plan. Mapeo
 * EXPLÍCITO (sin cast): si mañana el contrato agrega un bloqueo nuevo, TypeScript exige
 * decidir cómo se muestra en el panel en vez de dejar pasar un valor fuera de la unión.
 */
function createBlockerToPlanReason(b: CreateBlocker | UpdateBlocker): CatalogBlockReason {
  switch (b) {
    case 'identity_missing': return 'sku_missing';
    case 'identity_too_long': return 'identity_too_long';
    case 'title_missing': return 'name_missing';
    case 'description_missing': return 'description_missing';
    case 'product_url_missing': return 'product_url_missing';
    case 'product_url_not_https': return 'product_url_not_https';
    case 'price_invalid': return 'price_invalid';
    case 'currency_not_pyg': return 'currency_not_pyg';
    case 'brand_missing': return 'brand_missing';
    case 'image_missing': return 'image_not_https';
    case 'no_writable_change': return 'no_writable_change';
  }
}

function toWritableFields(changed: readonly string[]): string[] {
  const map: Record<string, string> = { name: 'title', image_url: 'image', url: 'link', description: 'description', price: 'price', availability: 'availability', brand: 'brand' };
  return [...new Set(changed.map((c) => map[c]).filter((c): c is string => !!c))];
}

/**
 * Compara el precio local ("250000 PYG") contra el formateado por Meta ("₲250.000",
 * "PYG 250,000.00", "USD 250"). Moneda ISO explícita distinta de PYG ⇒ distinto;
 * decimales finales ",00"/".00" se descartan (PYG no tiene decimales); después,
 * solo dígitos.
 */
export function priceEquals(local: string, remote: string): boolean {
  const iso = remote.match(/[A-Z]{3}/)?.[0];
  if (iso && iso !== 'PYG') return false;
  const remoteDigits = priceDigits(remote.replace(/[.,]00(?!\d)/, ''));
  const localDigits = priceDigits(local);
  return localDigits !== '' && remoteDigits === localDigits;
}

/**
 * Compara la URL local (ya canónica) contra la remota, canonizando también el lado de Meta.
 * Sin URL local ⇒ no se gestiona el campo. Sin URL remota ⇒ no se puede afirmar que difiere
 * (Meta puede no exponerla en el GET): no se marca cambio para no entrar en un bucle.
 */
function urlEquals(local: string, remoteUrl: string): boolean {
  if (!local) return true;
  if (!remoteUrl) return true;
  return local === (canonicalHttpsUrl(remoteUrl) ?? remoteUrl);
}

function diffPublicFields(payload: Record<string, unknown>, remote: MetaRemoteCatalogItem): string[] {
  const changed: string[] = [];
  if (String(payload.name) !== remote.name) changed.push('name');
  if (String(payload.description) !== remote.description) changed.push('description');
  if (String(payload.availability) !== remote.availability) changed.push('availability');
  if (!priceEquals(String(payload.price), remote.price)) changed.push('price');
  if (String(payload.image_url) !== remote.imageUrl) changed.push('image_url');
  // La URL entra al diff y por lo tanto a la VERIFICACIÓN post-escritura: un artículo cuyo
  // `link` remoto no coincide con el local no puede declararse `synced`.
  //
  // La comparación es entre formas CANÓNICAS de ambos lados: Meta normaliza lo que recibe
  // (agrega la barra final, pasa el host a punycode, escapa el path). Comparar los strings
  // crudos marcaría la URL como cambiada en cada corrida ⇒ un UPDATE perpetuo que nunca
  // converge a `synced`. Si Meta no devuelve `url`, no se asume que cambió.
  if (!urlEquals(String(payload.url ?? ''), remote.url ?? '')) changed.push('url');
  const brand = typeof payload.brand === 'string' ? payload.brand : '';
  if (brand && brand !== remote.brand) changed.push('brand');
  return changed;
}

export function planCatalogSync(products: Product[], remoteItems: MetaRemoteCatalogItem[]): CatalogSyncPlan {
  const remoteByRetailerId = new Map<string, MetaRemoteCatalogItem>();
  for (const r of remoteItems) if (r.retailerId) remoteByRetailerId.set(r.retailerId, r);
  const remoteByName = new Map<string, MetaRemoteCatalogItem>();
  for (const r of remoteItems) if (r.name) remoteByName.set(normName(r.name), r);

  // ═══ GATE FAIL-CLOSED (META-CATALOG-RECONCILIATION-1) ═══
  // SOLO los productos con opt-in explícito `syncToMeta === true` participan del plan.
  // Todo lo demás (importados, no revisados, legacy) queda COMPLETAMENTE fuera: sin
  // create, sin update y —lo crítico— SIN DISABLE. Sin este gate, importar el catálogo
  // como INACTIVE apagaría los artículos vivos que el negocio ya vende en Meta.
  // DEFENSA EN PROFUNDIDAD: además del opt-in, se excluye todo producto con el stock aún sin
  // validar (importado de Meta). Si alguien pusiera `syncToMeta:true` por fuera de los
  // callables — consola de Firebase, script con Admin SDK —, el importado seguiría fuera del
  // plan y su artículo vivo no correría riesgo de disable.
  const gestionados = products.filter((p) => p.syncToMeta === true && p.stockPendingReview !== true);
  const excluidos = products.length - gestionados.length;

  // Duplicados sobre la IDENTIDAD EFECTIVA (no sobre el SKU): con el fallback, el
  // metaRetailerId confirmado de un producto puede chocar con el SKU de otro.
  const idCounts = new Map<string, number>();
  for (const p of gestionados) {
    if (p.status === 'ARCHIVED') continue;
    const rid = effectiveRetailerId(p);
    if (rid) idCounts.set(rid, (idCounts.get(rid) ?? 0) + 1);
  }

  const entries: CatalogPlanEntry[] = [];
  let ignoredArchived = 0;

  for (const p of gestionados) {
    // AISLAMIENTO POR PRODUCTO: serializar puede lanzar (datos que el contrato de Meta no
    // admite). Un producto roto NO puede cancelar el plan de todo el tenant: se registra
    // como bloqueado con su motivo y la corrida sigue.
    try {
      planOne(p);
    } catch (e) {
      const detalle = e instanceof Error ? e.message.slice(0, 200) : 'error serializando';
      logger.warn('Producto excluido del plan por error de serialización', { productId: p.id, detalle });
      entries.push({
        productId: p.id,
        sku: effectiveRetailerId(p),
        internalSku: (p.inventory?.sku ?? '').trim(),
        mapped: !!(p.metaRetailerId ?? '').trim(),
        productName: (p.name ?? '').trim(),
        action: 'blocked',
        blockedReasons: ['serialization_failed'],
        note: detalle,
      });
    }
  }

  function planOne(p: Product): void {
    const sku = effectiveRetailerId(p);
    const internalSku = (p.inventory?.sku ?? '').trim();
    const mapped = !!(p.metaRetailerId ?? '').trim();
    const remote = sku ? remoteByRetailerId.get(sku) : undefined;
    const name = (p.name ?? '').trim();
    const base = { productId: p.id, sku, internalSku, mapped, productName: name };

    // ARCHIVED: sin rastro remoto no hay nada que hacer; si un producto VIVO reclama la
    // misma identidad, el item remoto le pertenece a ese reemplazo (el archivado se ignora).
    if (p.status === 'ARCHIVED' && (!remote || (idCounts.get(sku) ?? 0) > 0)) {
      ignoredArchived++;
      return;
    }

    const reasons: CatalogBlockReason[] = [];
    if (!sku) reasons.push('sku_missing');
    else if (sku.length > MAX_ID_LENGTH) reasons.push('identity_too_long'); // el contrato no admite truncar
    else if ((idCounts.get(sku) ?? 0) > 1) reasons.push(mapped ? 'retailer_id_duplicated' : 'sku_duplicated');
    if (!name) reasons.push('name_missing');
    if (p.currency !== 'PYG') reasons.push('currency_not_pyg');
    if (!Number.isFinite(p.price) || p.price <= 0) reasons.push('price_invalid');
    if (!firstHttpsImage(p)) reasons.push('image_not_https');
    if (reasons.length) {
      // La palanca de availability NO depende de los campos bloqueados: si el item vive
      // en Meta y acá dejó de ser vendible, se emite un disable MÍNIMO igual (salvo que
      // la identidad sea ambigua: SKU ausente o duplicado).
      const identityOk = !reasons.includes('sku_missing') && !reasons.includes('sku_duplicated') && !reasons.includes('retailer_id_duplicated') && !reasons.includes('identity_too_long');
      const wantsOut = productAvailability(p) === 'out of stock';
      if (remote && identityOk && wantsOut && remote.availability !== 'out of stock') {
        entries.push({
          ...base,
          action: 'disable',
          blockedReasons: reasons,
          changedFields: ['availability'],
          payload: { retailer_id: sku, availability: 'out of stock' },
          request: buildCatalogDisablePatch(p),
          remoteItemId: remote.id,
          note: 'disable_minimo_con_bloqueos',
        });
        return;
      }
      entries.push({ ...base, action: 'blocked', blockedReasons: reasons });
      return;
    }

    const payload = localPublicView(p);

    if (!remote) {
      // Un producto MAPEADO cuyo item remoto no aparece: identidad confirmada que Meta no
      // devuelve (item borrado del lado de Meta, o catálogo equivocado). Jamás se re-crea a
      // ciegas: requiere revisión humana.
      if (mapped) {
        entries.push({ ...base, action: 'blocked', blockedReasons: ['name_conflict_requires_confirmation'], note: 'mapeado_sin_item_remoto' });
        return;
      }
      // Matching por nombre = solo SUGERENCIA: crear igual duplicaría el item ⇒ bloquea.
      const nameMatch = remoteByName.get(normName(name));
      if (nameMatch && nameMatch.retailerId !== sku) {
        entries.push({
          ...base,
          action: 'blocked',
          blockedReasons: ['name_conflict_requires_confirmation'],
          suggestion: { remoteRetailerId: nameMatch.retailerId, remoteName: nameMatch.name },
        });
        return;
      }
      if (payload.availability === 'out of stock') {
        // No vendible y no existe en Meta: no se crea un item oculto.
        entries.push({ ...base, action: 'unchanged', note: 'no_vendible_sin_item_remoto', remoteItemId: null });
        return;
      }
      // CREAR exige TODOS los obligatorios del contrato de Meta (link, marca, descripción,
      // imagen…). Falta alguno ⇒ bloqueado con el motivo exacto; jamás se inventa un valor.
      const faltantes = createBlockers(p).map(createBlockerToPlanReason);
      if (faltantes.length) {
        entries.push({ ...base, action: 'blocked', blockedReasons: faltantes, note: 'create_incompleto' });
        return;
      }
      entries.push({ ...base, action: 'create', payload, request: buildCatalogCreatePayload(p), remoteItemId: null });
      return;
    }

    const changed = diffPublicFields(payload, remote);
    if (!changed.length) {
      // payload presente: el apply usa availability para confirmar synced/disabled.
      entries.push({ ...base, action: 'unchanged', payload, remoteItemId: remote.id });
      return;
    }
    const disabling = payload.availability === 'out of stock' && remote.availability !== 'out of stock';
    if (!disabling) {
      // Un campo cambiado cuyo valor local no es publicable (descripción vacía, URL
      // inválida) bloquea SOLO a este producto, con el motivo exacto.
      const impedimentos = updateBlockers(p, toWritableFields(changed));
      if (impedimentos.length) {
        entries.push({ ...base, action: 'blocked', blockedReasons: impedimentos.map(createBlockerToPlanReason), changedFields: changed, note: 'update_incompleto' });
        return;
      }
    }
    entries.push({
      ...base,
      action: disabling ? 'disable' : 'update',
      changedFields: changed,
      payload,
      // El request lleva SOLO lo que cambió (o solo availability si es un apagado).
      request: disabling ? buildCatalogDisablePatch(p) : buildCatalogUpdatePatch(p, toWritableFields(changed)),
      remoteItemId: remote.id,
    });
  }

  // remoteOnly = artículos de Meta que NINGÚN producto local reclama. Un vínculo confirmado
  // (metaRetailerId) reclama su artículo aunque el producto todavía no esté habilitado para
  // sincronizar: si no, un item ya mapeado seguiría ofreciéndose como "candidato a importar".
  const reclamados = new Set<string>();
  for (const p of products) {
    const mappedId = (p.metaRetailerId ?? '').trim();
    if (mappedId) reclamados.add(mappedId);
    const internal = (p.inventory?.sku ?? '').trim();
    if (internal && p.syncToMeta === true) reclamados.add(internal);
  }
  const remoteOnly = remoteItems
    .filter((r) => r.retailerId && !reclamados.has(r.retailerId))
    .map((r) => ({ retailerId: r.retailerId, name: r.name }));

  const summary: CatalogSyncPlan['summary'] = { create: 0, update: 0, disable: 0, unchanged: 0, blocked: 0, remoteOnly: remoteOnly.length };
  for (const e of entries) summary[e.action]++;

  return { entries, remoteOnly, ignoredArchived, excludedNotManaged: excluidos, summary };
}

// ---------------------------------------------------------------------------
// Servicio: runCatalogSync(tenantId, { mode }) — dry_run / apply.
// ---------------------------------------------------------------------------

export interface CatalogSyncActor {
  uid?: string | null;
  role?: string | null;
}

export interface CatalogSyncRunResult {
  runId: string;
  requestedMode: 'dry_run' | 'apply';
  status: 'disabled' | 'apply_blocked' | 'error' | 'planned' | 'applied' | 'partial_failure';
  configMode: CatalogSyncMode;
  reason?: 'mode_not_live' | 'missing_token' | 'catalog_unreachable' | 'batch_failed' | 'state_persist_failed';
  /** Detalle SANEADO (jamás token ni datos internos). */
  errorDetail?: string;
  catalogId?: string;
  summary?: CatalogSyncPlan['summary'];
  entries?: Array<Pick<CatalogPlanEntry, 'productId' | 'sku' | 'productName' | 'action' | 'blockedReasons' | 'changedFields' | 'suggestion' | 'note'>>;
  ignoredArchived?: number;
  /** Productos sin opt-in de sync: excluidos del plan (fail-closed). */
  excludedNotManaged?: number;
  /** Artículos de Meta sin producto local que los reclame (candidatos de importación). */
  remoteOnly?: Array<{ retailerId: string; name: string }>;
  appliedCount?: number;
  failedCount?: number;
}

const newRunId = () => `mcs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** Recorte del plan para persistir/devolver: sin payloads (auditables por producto). */
function slimEntries(entries: CatalogPlanEntry[]): NonNullable<CatalogSyncRunResult['entries']> {
  return entries.slice(0, MAX_STORED_ENTRIES).map((e) => ({
    productId: e.productId,
    sku: e.sku,
    productName: e.productName,
    action: e.action,
    ...(e.blockedReasons ? { blockedReasons: e.blockedReasons } : {}),
    ...(e.changedFields ? { changedFields: e.changedFields } : {}),
    ...(e.suggestion ? { suggestion: e.suggestion } : {}),
    ...(e.note ? { note: e.note } : {}),
  }));
}

async function writeRunDoc(tenantId: string, runId: string, data: Record<string, unknown>): Promise<void> {
  try {
    await db()
      .doc(paths.metaCatalogSyncRun(tenantId, runId))
      .set({ id: runId, tenantId, ...data }, { merge: true });
  } catch (e) {
    logger.error('No se pudo escribir el run de catalog sync', e, { tenantId, runId });
  }
}

async function auditRun(tenantId: string, runId: string, result: CatalogSyncRunResult, actor?: CatalogSyncActor): Promise<void> {
  await recordAudit({
    tenantId,
    action: 'meta.catalog_sync',
    actorUid: actor?.uid ?? null,
    actorRole: actor?.role ?? null,
    targetType: 'metaCatalogSyncRun',
    targetId: runId,
    summary: `Catalog sync ${result.requestedMode} → ${result.status}`,
    metadata: {
      runId,
      requestedMode: result.requestedMode,
      configMode: result.configMode,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.summary ? { counts: result.summary } : {}),
    },
  });
}

/** Persiste ops en commits chunkeados. Devuelve false si algún commit falló. */
async function commitStateOps(tenantId: string, runId: string, ops: Array<{ path: string; data: Record<string, unknown> }>): Promise<boolean> {
  for (let i = 0; i < ops.length; i += STATE_COMMIT_CHUNK) {
    const writer = db().batch();
    for (const op of ops.slice(i, i + STATE_COMMIT_CHUNK)) writer.set(db().doc(op.path), op.data, { merge: true });
    try {
      await writer.commit();
    } catch (e) {
      logger.error('No se pudo persistir el estado meta* de los productos', e, { tenantId, runId, desde: i });
      return false;
    }
  }
  return true;
}

export async function runCatalogSync(
  tenantId: string,
  opts: { mode: 'dry_run' | 'apply'; actor?: CatalogSyncActor },
): Promise<CatalogSyncRunResult> {
  const runId = newRunId();
  const startedAt = Timestamp.now();
  const actor = opts.actor;

  // 1) Config fail-closed: sin config válida NO se toca Meta (ni siquiera lectura).
  const cfgDoc = await db().doc(`tenants/${tenantId}/config/meta`).get();
  const cfg = normalizeCatalogSyncConfig((cfgDoc.data() as { catalogSync?: unknown } | undefined)?.catalogSync);
  if (!cfg.enabled) {
    logger.info('Catalog sync desactivada para el tenant', { tenantId, runId });
    return { runId, requestedMode: opts.mode, status: 'disabled', configMode: 'off' };
  }

  const base: CatalogSyncRunResult = { runId, requestedMode: opts.mode, status: 'planned', configMode: cfg.mode, catalogId: cfg.catalogId };

  // 2) apply exige mode 'live' explícito en la config (dry_run jamás escala solo).
  if (opts.mode === 'apply' && cfg.mode !== 'live') {
    const res: CatalogSyncRunResult = { ...base, status: 'apply_blocked', reason: 'mode_not_live' };
    await writeRunDoc(tenantId, runId, { status: res.status, requestedMode: opts.mode, configMode: cfg.mode, reason: res.reason, actorUid: actor?.uid ?? null, startedAt, finishedAt: Timestamp.now() });
    await auditRun(tenantId, runId, res, actor);
    return res;
  }

  // 3) Cliente + lecturas remotas (read-only hasta acá, siempre).
  let client: MetaCatalogClient;
  try {
    client = await getMetaCatalogClientForTenant(tenantId);
  } catch (e) {
    // SOLO la falta real de token se reporta como missing_token; el resto (Firestore,
    // SecretStore) va como catalog_unreachable con su detalle saneado.
    const missingToken = e instanceof MetaCatalogApiError && e.kind === 'missing_token';
    const res: CatalogSyncRunResult = {
      ...base,
      status: 'error',
      reason: missingToken ? 'missing_token' : 'catalog_unreachable',
      errorDetail: e instanceof Error ? e.message : 'no se pudo preparar el cliente de Meta',
    };
    await writeRunDoc(tenantId, runId, { status: res.status, requestedMode: opts.mode, configMode: cfg.mode, reason: res.reason, errorDetail: res.errorDetail, actorUid: actor?.uid ?? null, startedAt, finishedAt: Timestamp.now() });
    await auditRun(tenantId, runId, res, actor);
    return res;
  }

  let remoteItems: MetaRemoteCatalogItem[];
  try {
    await client.getCatalog(cfg.catalogId);
    remoteItems = await client.listItems(cfg.catalogId);
  } catch (e) {
    const detail = e instanceof MetaCatalogApiError ? e.message : 'error consultando Meta';
    const res: CatalogSyncRunResult = { ...base, status: 'error', reason: 'catalog_unreachable', errorDetail: detail };
    await writeRunDoc(tenantId, runId, { status: res.status, requestedMode: opts.mode, configMode: cfg.mode, reason: res.reason, errorDetail: detail, actorUid: actor?.uid ?? null, startedAt, finishedAt: Timestamp.now() });
    await auditRun(tenantId, runId, res, actor);
    return res;
  }

  // 4) Plan puro local vs remoto. El id SIEMPRE es el del doc (no confiar en data().id).
  const snap = await db().collection(paths.products(tenantId)).get();
  const products = snap.docs.map((d) => ({ ...(d.data() as Product), id: d.id }));
  const plan = planCatalogSync(products, remoteItems);

  const planned: CatalogSyncRunResult = {
    ...base,
    status: 'planned',
    summary: plan.summary,
    entries: slimEntries(plan.entries),
    ignoredArchived: plan.ignoredArchived,
    excludedNotManaged: plan.excludedNotManaged,
    // El panel necesita la LISTA para ofrecer la importación (las Rules no exponen los runs).
    remoteOnly: plan.remoteOnly.slice(0, MAX_STORED_ENTRIES),
  };
  await writeRunDoc(tenantId, runId, {
    status: 'planned',
    requestedMode: opts.mode,
    configMode: cfg.mode,
    catalogId: cfg.catalogId,
    summary: plan.summary,
    ignoredArchived: plan.ignoredArchived,
    excludedNotManaged: plan.excludedNotManaged,
    remoteOnly: plan.remoteOnly.slice(0, MAX_STORED_ENTRIES),
    entries: planned.entries,
    actorUid: actor?.uid ?? null,
    startedAt,
    finishedAt: Timestamp.now(),
  });

  // 5) dry_run: acá termina. CERO escrituras en Meta y CERO cambios en products.
  if (opts.mode === 'dry_run') {
    await auditRun(tenantId, runId, planned, actor);
    return planned;
  }

  // 6) apply (config live verificada): upserts idempotentes por chunks. JAMÁS delete.
  //    El run queda en 'applying' mientras corre (visible si la función muere a mitad).
  await writeRunDoc(tenantId, runId, { status: 'applying' });
  // Solo entradas accionables CON su request serializado. El filtro por `request` evita que
  // el chunk y el array de requests se descoordinen (si faltara uno, los errores por item se
  // atribuirían al producto equivocado).
  const actionable = plan.entries.filter((e) => (e.action === 'create' || e.action === 'update' || e.action === 'disable') && !!e.request);
  let batchError: string | undefined;
  const appliedEntries: CatalogPlanEntry[] = [];
  const failedEntries: CatalogPlanEntry[] = [];
  const unprocessedEntries: CatalogPlanEntry[] = [];
  /** Requests que no cumplen el contrato: se excluyen del lote, sin arrastrar a los demás. */
  const invalidEntries: Array<{ entry: CatalogPlanEntry; detalle: string }> = [];
  const handles: string[] = [];

  for (let i = 0; i < actionable.length; i += BATCH_CHUNK) {
    const bruto = actionable.slice(i, i + BATCH_CHUNK);
    // VALIDACIÓN POR ITEM ANTES DEL LOTE: si un request no cumple el contrato, se descarta
    // SOLO ese producto. Sin esto, el validador del transporte rechazaría el lote entero y
    // un único dato malo dejaría en `failed` a los 100 del chunk y a todos los siguientes,
    // de forma determinística — la sync del tenant quedaría muerta hasta encontrar al
    // culpable, que ni siquiera se nombra en el error.
    const chunk: CatalogPlanEntry[] = [];
    for (const e of bruto) {
      try {
        assertBatchRequestShape(e.request as CatalogBatchRequest, `producto ${e.productId}`);
        chunk.push(e);
      } catch (err) {
        const detalle = err instanceof Error ? err.message.slice(0, 300) : 'request inválido';
        logger.warn('Producto excluido del lote por no cumplir el contrato', { tenantId, runId, productId: e.productId });
        invalidEntries.push({ entry: e, detalle });
      }
    }
    if (!chunk.length) continue;
    const requests: CatalogBatchRequest[] = chunk.map((e) => e.request as CatalogBatchRequest);
    try {
      const res = await client.submitItemsBatch(cfg.catalogId, requests);
      handles.push(...res.handles);
      appliedEntries.push(...chunk);
    } catch (e) {
      batchError = e instanceof MetaCatalogApiError ? e.message : 'items_batch falló';
      failedEntries.push(...chunk);
      unprocessedEntries.push(...actionable.slice(i + BATCH_CHUNK));
      break; // no seguir martillando la API con el resto de los chunks
    }
  }

  // 7) Validación por item (best-effort): Meta procesa el batch asíncrono y reporta
  //    errores por handle. Si el estado aún no está disponible, la verificación por
  //    diff de abajo mantiene el producto en 'pending' (jamás un 'synced' falso).
  const itemErrors = new Map<string, string>();
  for (const h of handles) {
    try {
      for (const err of (await client.getBatchStatus(cfg.catalogId, h)).errors) {
        if (err.retailerId) itemErrors.set(err.retailerId, err.message);
      }
    } catch {
      // best-effort: sin estado del batch, el diff decide pending.
    }
  }

  // 8) Verificación honesta: releer Meta y comparar campos públicos. Solo lo que ya
  //    coincide queda 'synced'/'disabled'; lo demás 'pending' (converge en el próximo apply).
  //
  //    QUÉ SIGNIFICA `synced`: "ningún campo GESTIONADO difiere" — no "Meta es un espejo de
  //    VendeyaPy". Los campos que este sistema no administra (categoría de Meta, product_type,
  //    variantes, campos cargados a mano en Commerce Manager) pueden diferir y el producto
  //    igual figura `synced`. Es la lectura correcta: la sync es de un subconjunto declarado,
  //    no una réplica.
  let verified = new Map<string, MetaRemoteCatalogItem>();
  let verifyFailed = false;
  try {
    const after = await client.listItems(cfg.catalogId);
    verified = new Map(after.filter((r) => r.retailerId).map((r) => [r.retailerId, r]));
  } catch {
    verifyFailed = true;
    logger.warn('No se pudo releer el catálogo para verificar; los items quedan pending', { tenantId, runId });
  }

  // 9) Estado meta* por producto + log por producto (Admin SDK, mismo tenant SIEMPRE).
  const now = Timestamp.now();
  const ops: Array<{ path: string; data: Record<string, unknown> }> = [];
  const pushLog = (e: CatalogPlanEntry, status: 'success' | 'failed', itemId: string | null, errorMessage: string) => {
    const log: MetaCatalogSyncLog = { id: `${runId}_${e.productId}`, tenantId, productId: e.productId, metaCatalogId: cfg.catalogId, metaProductItemId: itemId, action: e.action, status, errorMessage, createdAt: now };
    ops.push({ path: paths.metaCatalogSyncLog(tenantId, log.id), data: log as unknown as Record<string, unknown> });
  };

  let appliedFailed = 0;
  for (const e of appliedEntries) {
    const after = verified.get(e.sku);
    const itemErr = itemErrors.get(e.sku);
    let metaSyncStatus: string;
    let errMsg = '';
    if (itemErr) {
      metaSyncStatus = 'failed';
      errMsg = itemErr.slice(0, 500);
      appliedFailed++;
    } else if (e.action === 'disable') {
      metaSyncStatus = after && after.availability === 'out of stock' ? 'disabled' : 'pending';
    } else {
      metaSyncStatus = after && e.payload && diffPublicFields(e.payload, after).length === 0 ? 'synced' : 'pending';
    }
    const itemId = after?.id ?? e.remoteItemId ?? null;
    ops.push({
      path: paths.product(tenantId, e.productId),
      // `syncToMeta` NO se escribe acá: el opt-in es una decisión administrativa explícita
      // (metaCatalogSetSyncEnabled). Si el apply lo encendiera solo, el fail-closed dejaría de
      // ser el estado por defecto de cualquier producto que alguna vez pasó por una sync.
      data: { metaSyncStatus, metaCatalogId: cfg.catalogId, metaProductItemId: itemId, metaLastSyncAt: now, metaSyncError: errMsg, updatedAt: now },
    });
    pushLog(e, itemErr ? 'failed' : 'success', itemId, errMsg);
  }
  // Convergencia: un 'unchanged' con item remoto está CONFIRMADO en sync ⇒ se refresca su
  // estado (esto saca de 'pending' a los creados/actualizados en applies anteriores).
  for (const e of plan.entries) {
    if (e.action !== 'unchanged' || !e.remoteItemId) continue;
    const metaSyncStatus = e.payload?.availability === 'out of stock' ? 'disabled' : 'synced';
    ops.push({
      path: paths.product(tenantId, e.productId),
      data: { metaSyncStatus, metaCatalogId: cfg.catalogId, metaProductItemId: e.remoteItemId, metaLastSyncAt: now, metaSyncError: '', updatedAt: now },
    });
  }
  for (const e of failedEntries) {
    const msg = (batchError ?? 'items_batch falló').slice(0, 500);
    ops.push({ path: paths.product(tenantId, e.productId), data: { metaSyncStatus: 'failed', metaSyncError: msg, updatedAt: now } });
    pushLog(e, 'failed', e.remoteItemId ?? null, msg);
  }
  for (const e of unprocessedEntries) {
    const msg = 'no procesado: falló un batch anterior de la misma corrida';
    ops.push({ path: paths.product(tenantId, e.productId), data: { metaSyncStatus: 'failed', metaSyncError: msg, updatedAt: now } });
    pushLog(e, 'failed', e.remoteItemId ?? null, msg);
  }
  for (const { entry, detalle } of invalidEntries) {
    ops.push({ path: paths.product(tenantId, entry.productId), data: { metaSyncStatus: 'failed', metaSyncError: detalle.slice(0, 500), updatedAt: now } });
    pushLog(entry, 'failed', entry.remoteItemId ?? null, detalle.slice(0, 500));
  }
  const statePersisted = await commitStateOps(tenantId, runId, ops);

  const failedTotal = failedEntries.length + unprocessedEntries.length + invalidEntries.length + appliedFailed;
  const appliedOk = appliedEntries.length - appliedFailed;
  const finalStatus: CatalogSyncRunResult['status'] = failedTotal > 0 || !statePersisted ? 'partial_failure' : 'applied';
  const reason: CatalogSyncRunResult['reason'] | undefined = !statePersisted
    ? 'state_persist_failed'
    : batchError || appliedFailed
      ? 'batch_failed'
      : undefined;
  const errorDetail = !statePersisted
    ? 'los cambios llegaron a Meta pero no se pudo guardar el estado meta* de los productos'
    : batchError;

  const result: CatalogSyncRunResult = {
    ...planned,
    status: finalStatus,
    appliedCount: appliedOk,
    failedCount: failedTotal,
    ...(reason ? { reason } : {}),
    ...(errorDetail ? { errorDetail } : {}),
  };
  await writeRunDoc(tenantId, runId, {
    status: finalStatus,
    appliedCount: appliedOk,
    failedCount: failedTotal,
    verifyFailed,
    batchHandles: handles.slice(0, 50),
    ...(errorDetail ? { errorDetail } : {}),
    finishedAt: Timestamp.now(),
  });
  // lastSuccessfulSyncAt SOLO si todo se aplicó y el estado quedó persistido.
  if (finalStatus === 'applied') {
    try {
      await db().doc(`tenants/${tenantId}/config/meta`).set({ catalogSync: { lastSuccessfulSyncAt: now } }, { merge: true });
    } catch {
      logger.warn('No se pudo actualizar lastSuccessfulSyncAt', { tenantId, runId });
    }
  }
  await auditRun(tenantId, runId, result, actor);
  logger.info('Catalog sync aplicada', { tenantId, runId, applied: appliedOk, failed: failedTotal });
  return result;
}
