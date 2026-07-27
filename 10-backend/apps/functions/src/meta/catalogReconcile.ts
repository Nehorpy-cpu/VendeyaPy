/**
 * meta/catalogReconcile.ts — Reconciliación inicial Meta ↔ VendeyaPy
 * ==================================================================
 * (META-CATALOG-RECONCILIATION-1) Lógica PURA para reconciliar un catálogo de Meta que
 * ya existe con el catálogo local:
 *  - flags de CALIDAD por artículo remoto (nombre genérico, probable duplicado, sin marca,
 *    no disponible, incoherencia nombre/descripción);
 *  - ranking DETERMINÍSTICO de candidatos de mapping (jamás last-wins, jamás automático);
 *  - construcción del producto IMPORTADO (INACTIVE, syncToMeta=false, sin costo ni stock
 *    inventados).
 * Nada de esto escribe en Meta ni en Firestore: eso lo hacen los callables.
 */

import { createHash } from 'node:crypto';
import type { Product } from '@vpw/shared';
import type { MetaRemoteCatalogItem } from './catalogClient.js';
import { canonicalHttpsUrl, createBlockers, MAX_ID_LENGTH, outboundId } from './catalogOutbound.js';

// ---------------------------------------------------------------------------
// Normalización compartida
// ---------------------------------------------------------------------------

export const normalizeText = (s: unknown): string =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Ruido comercial que no aporta identidad al comparar nombres de perfumes. */
const STOPWORDS = new Set([
  'edp', 'edt', 'eau', 'de', 'parfum', 'toilette', 'ml', '100ml', 'the', 'el', 'la', 'los',
  'las', 'y', 'edition', 'limited', 'collector', 'collectors', 'perfume', 'para',
]);

export const significantTokens = (s: unknown): string[] =>
  normalizeText(s).split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t));

const jaccard = (a: string[], b: string[]): number => {
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
};

/**
 * Dígitos del precio formateado de Meta ("₲250.000" → 250000). 0 si no es interpretable
 * como guaraníes. `currency` es el campo explícito del artículo: si Meta lo declara y no es
 * PYG, se descarta (no se asume conversión). Sin currency explícito se cae al ISO que venga
 * embebido en el string formateado.
 */
export function parseRemotePriceGs(raw: string, currency?: string): number {
  const declared = (currency ?? '').trim().toUpperCase();
  if (declared && declared !== 'PYG') return 0;
  if (!declared) {
    const iso = raw.match(/[A-Z]{3}/)?.[0];
    if (iso && iso !== 'PYG') return 0;
  }
  const digits = raw.replace(/[.,]00(?!\d)/, '').replace(/\D+/g, '');
  return digits ? Number(digits) : 0;
}

/**
 * Clave de doc segura para un retailer_id (los ids de Firestore no admiten '/').
 *
 * Sanear PIERDE información: `ARM/1` y `ARM#1` colapsaban en la misma clave, de modo que el
 * lock del primero declaraba al segundo "ya vinculado a otro producto" —para siempre y sin
 * forma de desvincularlo— y su importación fallaba con id de producto duplicado. Cuando el
 * id ya es seguro y entra en el largo (el caso de todo el catálogo actual) la clave es el id
 * TAL CUAL, idéntica a la histórica: cambiarla huerfanaría locks y productos ya importados.
 * Solo los ids que requieren saneo llevan un sufijo hash que restituye la inyectividad.
 */
export function retailerIdLockKey(retailerId: string): string {
  const raw = retailerId.trim();
  if (!raw) return '_vacio';
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe === raw && raw.length <= 400) return raw;
  return `${safe.slice(0, 380)}~${createHash('sha1').update(raw).digest('hex').slice(0, 12)}`;
}

/** Identidad de negocio del artículo (producto_id del sitio del tenant), si viene en la url. */
export function remoteBusinessId(item: MetaRemoteCatalogItem): string | null {
  return item.url?.match(/producto_id=(\d+)/)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Calidad de los artículos remotos
// ---------------------------------------------------------------------------

export type RemoteQualityFlag =
  | 'generic_name'
  | 'probable_duplicate'
  | 'missing_brand'
  | 'out_of_stock'
  | 'name_description_mismatch'
  | 'invalid_price'
  | 'image_not_https';

export interface RemoteCandidate {
  retailerId: string;
  metaItemId: string;
  name: string;
  brand: string;
  /** Precio en guaraníes ya parseado (0 = no interpretable). */
  priceGs: number;
  priceRaw: string;
  availability: string;
  imageUrl: string;
  description: string;
  productType: string;
  /** URL pública del artículo en el sitio del tenant (`link` del contrato de escritura). */
  url: string;
  businessId: string | null;
  flags: RemoteQualityFlag[];
  /** retailer_ids con los que probablemente esté duplicado. */
  duplicateOf?: string[];
  /** true si no tiene ningún flag bloqueante para importar. */
  importable: boolean;
}

const BLOCKING_FLAGS: RemoteQualityFlag[] = ['invalid_price', 'image_not_https'];

/**
 * Analiza los artículos remotos y les asigna flags de calidad. PURO y determinístico:
 * el orden de salida sigue el de entrada, y los grupos de duplicados se ordenan por
 * retailer_id para que el resultado no dependa del orden de lectura de Meta.
 */
export function analyzeRemoteItems(items: MetaRemoteCatalogItem[]): RemoteCandidate[] {
  // Duplicado probable: misma descripción normalizada (los nombres genéricos no alcanzan
  // para distinguir; la descripción sí identifica el perfume real).
  const byDesc = new Map<string, string[]>();
  for (const it of items) {
    const key = normalizeText(it.description).slice(0, 60);
    if (!key) continue;
    if (!byDesc.has(key)) byDesc.set(key, []);
    byDesc.get(key)!.push(it.retailerId);
  }
  for (const [, rids] of byDesc) rids.sort();

  return items.map((it) => {
    const flags: RemoteQualityFlag[] = [];
    const name = String(it.name ?? '').trim();
    const brand = String(it.brand ?? '').trim();
    const priceGs = parseRemotePriceGs(String(it.price ?? ''), it.currency);

    // Nombre genérico: el nombre es (casi) solo la marca ⇒ el bot no podría distinguirlo.
    const nName = normalizeText(name), nBrand = normalizeText(brand);
    if (nBrand && (nName === nBrand || nName.replace(nBrand, '').trim().length <= 3)) flags.push('generic_name');
    if (!brand) flags.push('missing_brand');
    if (it.availability !== 'in stock') flags.push('out_of_stock');
    if (!(priceGs > 0)) flags.push('invalid_price');
    if (!String(it.imageUrl ?? '').startsWith('https://')) flags.push('image_not_https');

    // Incoherencia nombre ↔ descripción: ningún token del nombre (ni la marca) aparece al
    // inicio de la descripción. Solo se marca cuando el nombre NO es genérico (si lo es, la
    // discrepancia es esperable y ya está cubierta por `generic_name`).
    const descIni = normalizeText(it.description).slice(0, 80);
    if (!flags.includes('generic_name')) {
      const nameTokens = significantTokens(name);
      const hit = nameTokens.some((t) => descIni.includes(t)) || (nBrand && descIni.includes(nBrand.split(' ')[0]!));
      if (nameTokens.length && descIni && !hit) flags.push('name_description_mismatch');
    }

    const dupGroup = byDesc.get(normalizeText(it.description).slice(0, 60)) ?? [];
    const duplicateOf = dupGroup.filter((r) => r !== it.retailerId);
    if (duplicateOf.length) flags.push('probable_duplicate');

    return {
      retailerId: it.retailerId,
      metaItemId: it.id,
      name,
      brand,
      priceGs,
      priceRaw: String(it.price ?? ''),
      availability: String(it.availability ?? ''),
      imageUrl: String(it.imageUrl ?? ''),
      description: String(it.description ?? ''),
      productType: String(it.productType ?? ''),
      url: String(it.url ?? ''),
      businessId: remoteBusinessId(it),
      flags,
      ...(duplicateOf.length ? { duplicateOf } : {}),
      importable: !flags.some((f) => BLOCKING_FLAGS.includes(f)),
    };
  });
}

// ---------------------------------------------------------------------------
// Ranking de candidatos de mapping (SUGERENCIA — jamás automático)
// ---------------------------------------------------------------------------

export type MappingConfidence = 'alta' | 'media' | 'baja';

export interface MappingCandidate {
  retailerId: string;
  name: string;
  brand: string;
  priceGs: number;
  availability: string;
  score: number;
  confidence: MappingConfidence;
  /** Motivos legibles del puntaje (para que el humano decida con criterio). */
  reasons: string[];
}

export interface ProductMappingSuggestions {
  productId: string;
  productName: string;
  internalSku: string;
  candidates: MappingCandidate[];
}

const confidenceOf = (score: number): MappingConfidence => (score >= 0.6 ? 'alta' : score >= 0.33 ? 'media' : 'baja');

/**
 * Rankea candidatos remotos para UN producto local. Determinístico: ante puntajes iguales
 * desempata por retailer_id, así el orden nunca depende del orden de lectura de Meta.
 * SOLO sugiere: el vínculo lo confirma una persona.
 */
/**
 * Tokens precomputados del lado remoto. Sin esto, el ranking recalcula la normalización de
 * cada artículo una vez POR PRODUCTO (O(productos × artículos) normalizaciones de string).
 */
export type RemoteTokenIndex = Map<string, { name: string[]; desc: string[] }>;

export function buildRemoteTokenIndex(remote: RemoteCandidate[]): RemoteTokenIndex {
  const idx: RemoteTokenIndex = new Map();
  for (const r of remote) {
    idx.set(r.retailerId, { name: significantTokens(`${r.name} ${r.brand}`), desc: significantTokens(r.description.slice(0, 140)) });
  }
  return idx;
}

export function rankMappingCandidates(
  product: Product,
  remote: RemoteCandidate[],
  opts: { limit?: number; index?: RemoteTokenIndex; minConfidence?: MappingConfidence } = {},
): MappingCandidate[] {
  const pTokens = significantTokens(`${product.name ?? ''} ${product.perfume?.brand ?? ''}`);
  const pBrand = normalizeText(product.perfume?.brand ?? '').split(' ')[0] ?? '';
  const pPrice = Number(product.price ?? 0);
  const index = opts.index;

  const scored = remote.map((r) => {
    const reasons: string[] = [];
    const cached = index?.get(r.retailerId);
    const simName = jaccard(pTokens, cached?.name ?? significantTokens(`${r.name} ${r.brand}`));
    // La descripción rescata los artículos con nombre genérico (el perfume real vive ahí).
    const simDesc = jaccard(pTokens, cached?.desc ?? significantTokens(r.description.slice(0, 140)));
    // El término `+ simDesc * 0.2` es el DESEMPATE: cuando varios artículos comparten el
    // mismo nombre genérico (5× "ANTONIO BANDERAS"), su simName es idéntico y solo la
    // descripción dice cuál es cuál. Sin este término ganaría el primero por orden alfabético.
    let score = Math.max(simName, simDesc * 0.9) + simDesc * 0.2;
    if (simName >= 0.9) reasons.push('nombre casi idéntico');
    else if (simName >= 0.4) reasons.push('nombre parecido');
    if (simDesc > simName && simDesc >= 0.3) reasons.push('coincide con la descripción del artículo');

    const brandHit = !!pBrand && (normalizeText(r.brand).includes(pBrand) || normalizeText(r.name).includes(pBrand));
    if (brandHit) { score += 0.15; reasons.push('misma marca'); }
    if (pPrice > 0 && r.priceGs === pPrice) { score += 0.1; reasons.push('mismo precio'); }
    else if (pPrice > 0 && r.priceGs > 0) reasons.push(`precio distinto (local ₲${pPrice} · Meta ₲${r.priceGs})`);
    if (r.flags.includes('out_of_stock')) reasons.push('el artículo está sin stock en Meta');

    return { r, score: Math.round(score * 1000) / 1000, reasons };
  });

  scored.sort((a, b) => b.score - a.score || a.r.retailerId.localeCompare(b.r.retailerId));

  const min = opts.minConfidence;
  const rank = { baja: 0, media: 1, alta: 2 } as const;
  return scored
    .map((s) => ({
      retailerId: s.r.retailerId,
      name: s.r.name,
      brand: s.r.brand,
      priceGs: s.r.priceGs,
      availability: s.r.availability,
      score: s.score,
      confidence: confidenceOf(s.score),
      reasons: s.reasons,
    }))
    .filter((c) => !min || rank[c.confidence] >= rank[min])
    .slice(0, opts.limit ?? 5);
}

// ---------------------------------------------------------------------------
// Construcción del producto IMPORTADO
// ---------------------------------------------------------------------------

export interface ImportBlockReason {
  retailerId: string;
  reason:
    | 'already_mapped'
    | 'already_imported'
    | 'duplicate_name_local'
    | 'strong_mapping_candidate'
    | 'not_found_in_meta'
    | 'invalid_price'
    | 'image_not_https'
    | 'category_required';
}

/** Género sugerido por la taxonomía de Meta ("… > Femenino"). null si no se puede inferir. */
export function genderFromProductType(productType: string): 'Femenino' | 'Masculino' | 'Unisex' | null {
  const last = normalizeText(productType).split('>').pop()?.trim() ?? normalizeText(productType).split(' ').pop() ?? '';
  if (last.includes('femenino')) return 'Femenino';
  if (last.includes('masculino')) return 'Masculino';
  if (last.includes('unisex')) return 'Unisex';
  return null;
}

/**
 * Arma el documento de un producto IMPORTADO desde un artículo de Meta. PURO.
 * Invariantes del contrato:
 *  - `status: 'INACTIVE'` ⇒ el bot no lo ofrece nunca (ver catalog/search.ts).
 *  - `syncToMeta: false` ⇒ queda FUERA del plan de sync: no puede modificar ni apagar Meta.
 *  - `metaRetailerId` conservado ⇒ identidad remota estable, sin tocar el SKU interno.
 *  - stock 0 SIN trackStock ⇒ no se inventa cantidad; `stockPendingReview` lo marca.
 *  - `productUrl` = el `url` que ya publica Meta (canónico), o vacío si no lo expone.
 *  - JAMÁS se arma productFinancials: el costo queda desconocido, no en 0.
 */
export function buildImportedProduct(
  item: RemoteCandidate,
  ctx: { productId: string; tenantId: string; categoryId: string; catalogId: string; position: number },
): Omit<Product, 'createdAt' | 'updatedAt'> & { stockPendingReview: true } {
  const gender = genderFromProductType(item.productType);
  return {
    id: ctx.productId,
    tenantId: ctx.tenantId,
    name: item.name,
    description: item.description,
    price: item.priceGs,
    compareAtPrice: null,
    aiNotes: '',
    currency: 'PYG',
    categoryId: ctx.categoryId,
    images: item.imageUrl ? [item.imageUrl] : [],
    // Sin emoji: es una decoración de catálogo que elige el vendedor, no un dato de Meta
    // (y hardcodear uno de perfumería violaría el aislamiento por rubro del backend).
    emoji: '',
    // Sin trackStock: no inventamos cantidad. El SKU interno se deriva del retailer_id de
    // Meta SOLO en la creación (es un producto nuevo, no hay SKU previo que respetar).
    inventory: { trackStock: false, stock: 0, lowStockThreshold: 0, sku: item.retailerId },
    status: 'INACTIVE',
    featured: false,
    position: ctx.position,
    externalIds: { facebook: null, instagram: null, tiktok: null },
    perfume: item.brand
      ? { brand: item.brand, gender: gender ?? 'Unisex', olfactiveFamily: '', styleTags: [], notes: { top: [], heart: [], base: [] }, priceRange: 'MID', sizeMl: null, isNew: false }
      : null,
    aiFicha: null,
    // El enlace lo trae el propio artículo de Meta: no se inventa, y si no viene queda vacío
    // (el gate lo pedirá antes de habilitar la sincronización).
    productUrl: canonicalHttpsUrl(item.url) ?? '',
    // Vínculo confirmado por la importación + opt-in de sync APAGADO.
    syncToMeta: false,
    metaSyncStatus: 'not_synced',
    metaCatalogId: ctx.catalogId,
    metaRetailerId: item.retailerId,
    metaProductItemId: item.metaItemId,
    metaLastSyncAt: null,
    metaSyncError: '',
    stockPendingReview: true,
  } as Omit<Product, 'createdAt' | 'updatedAt'> & { stockPendingReview: true };
}

// ---------------------------------------------------------------------------
// Gates de habilitación (metaCatalogSetSyncEnabled)
// ---------------------------------------------------------------------------

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
  // Obligatorios del contrato de ESCRITURA, exigidos solo cuando el artículo todavía no
  // existe en Meta (la primera sincronización sería un CREATE).
  | 'description_missing'
  | 'brand_missing'
  | 'product_url_missing'
  | 'product_url_not_https';

/**
 * Requisitos para habilitar `syncToMeta` en un producto. PURO. Devuelve la lista de
 * bloqueos: vacía = se puede habilitar. Un importado recién traído SIEMPRE tiene al menos
 * `not_active` y `stock_pending_review` ⇒ nunca se habilita solo.
 *
 * `remoteHasIdentity` indica que el retailer_id EFECTIVO ya existe en el catálogo de Meta.
 * Si eso pasa SIN un vínculo confirmado, la identidad se estaría reclamando por coincidencia
 * de SKU: se bloquea (`unconfirmed_remote_match`) porque habilitarlo podría modificar —o
 * apagar— un artículo vivo que nadie confirmó que sea de este producto.
 */
export function syncEnableBlockers(
  p: Product & { stockPendingReview?: boolean },
  ctx: { remoteHasIdentity?: boolean } = {},
): SyncEnableBlocker[] {
  const out: SyncEnableBlocker[] = [];
  if (p.status !== 'ACTIVE') out.push('not_active');
  if (!(p.name ?? '').trim()) out.push('name_missing');
  if (!Number.isFinite(p.price) || p.price <= 0) out.push('price_invalid');
  if (p.currency !== 'PYG') out.push('currency_not_pyg');
  if (!(p.images ?? []).some((u) => typeof u === 'string' && u.startsWith('https://'))) out.push('image_not_https');
  if (!(p.categoryId ?? '').trim()) out.push('category_missing');
  if (p.stockPendingReview === true) out.push('stock_pending_review');
  // Habilitar un producto que hoy NO es vendible haría que la primera sync lo publique como
  // "sin stock" (o apague su artículo): el stock se resuelve antes de sincronizar, no después.
  if (p.status === 'ACTIVE' && p.inventory?.trackStock && (p.inventory?.stock ?? 0) <= 0) out.push('not_sellable_now');
  if (ctx.remoteHasIdentity && !(p.metaRetailerId ?? '').trim()) out.push('unconfirmed_remote_match');
  const identity = outboundId(p);
  if (!identity) out.push('no_identity');
  else if (identity.length > MAX_ID_LENGTH) out.push('identity_too_long');

  // Si el artículo NO existe todavía en Meta, la primera sincronización será un CREATE y
  // Meta exige los nueve obligatorios. Sin este gate el panel prometía "se va a crear" y el
  // planificador dejaba el producto `blocked` para siempre, sin que nadie se enterara.
  // Se reusan LOS MISMOS bloqueos del contrato: una segunda lista se desincroniza.
  if (!ctx.remoteHasIdentity) {
    for (const b of createBlockers(p)) {
      if (b === 'description_missing' || b === 'brand_missing' || b === 'product_url_missing' || b === 'product_url_not_https') {
        out.push(b);
      }
    }
  }
  return out;
}
