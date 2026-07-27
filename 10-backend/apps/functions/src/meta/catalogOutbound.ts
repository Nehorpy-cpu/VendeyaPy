/**
 * meta/catalogOutbound.ts — Contrato de ESCRITURA hacia el Meta Catalog
 * =====================================================================
 * (META-CATALOG-OUTBOUND-CONTRACT-1) Serializador del contrato de escritura de Graph API
 * v23 para `POST /{catalog_id}/items_batch` con `item_type: PRODUCT_ITEM`.
 *
 * ⚠️ EL CONTRATO DE ESCRITURA NO ES EL DE LECTURA. Meta DEVUELVE `name`, `image_url` y
 * `url` al leer productos, pero ACEPTA `title`, `image` y `link` al escribirlos. Mezclarlos
 * produce requests que Meta rechaza o aplica a medias. Por eso este módulo está separado de
 * `catalogClient.ts` (que modela la lectura) y jamás comparte tipos con él.
 *
 * Contrato verificado (developers.facebook.com/docs/marketing-api/catalog-batch/reference):
 *   body      : { item_type: 'PRODUCT_ITEM', allow_upsert: false, requests: [...] }
 *   request   : { method: 'CREATE'|'UPDATE'|'DELETE', data: {...} }
 *   identidad : `data.id` — NUNCA un `retailer_id` hermano de `data`. Máx 100 caracteres.
 *   CREATE    : id, title, description, link, price, availability, condition, brand, image
 *   UPDATE    : id + SOLO los campos modificados (patch parcial de verdad)
 *   DELETE    : id
 *   image     : array de { url, tag? }   ·   availability: "in stock" | "out of stock"
 *
 * DECISIÓN sobre `allow_upsert` (default de Meta: true): lo enviamos **false** de forma
 * explícita. Con el default, un UPDATE crea el artículo si no existe — un "create" mal
 * clasificado se ejecutaría en silencio como upsert y nadie se enteraría. Apagándolo, crear
 * es SIEMPRE una decisión declarada del planner (`method: 'CREATE'`), y un UPDATE contra un
 * artículo inexistente falla de forma visible en vez de crear algo a medias.
 */

import type { Product } from '@vpw/shared';

/** `allow_upsert` explícito del body. false ⇒ un UPDATE jamás crea por accidente. */
export const ITEMS_BATCH_ALLOW_UPSERT = false;

/** Tipo de item del batch. Único soportado por el catálogo de productos. */
export const ITEMS_BATCH_ITEM_TYPE = 'PRODUCT_ITEM';

/** Límite del contrato para el identificador del artículo. */
const MAX_ID_LENGTH = 100;
const MAX_TITLE_LENGTH = 100; // el contrato acota `title` a 100 caracteres
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_BRAND_LENGTH = 100;

export type CatalogBatchMethod = 'CREATE' | 'UPDATE' | 'DELETE';

/**
 * Un elemento de `requests`. La identidad viaja SIEMPRE dentro de `data.id`: el tipo no
 * admite un `retailer_id` hermano, así que la ubicación equivocada no compila.
 */
export interface CatalogBatchRequest {
  method: CatalogBatchMethod;
  data: { id: string } & Record<string, unknown>;
}

/** Campos públicos del contrato de escritura. Nada fuera de esta lista sale jamás. */
export const WRITABLE_FIELDS = ['title', 'description', 'link', 'price', 'availability', 'condition', 'brand', 'image'] as const;
export type WritableField = (typeof WRITABLE_FIELDS)[number];

export type CreateBlocker =
  | 'identity_missing'
  | 'title_missing'
  | 'description_missing'
  | 'product_url_missing'
  | 'price_invalid'
  | 'currency_not_pyg'
  | 'brand_missing'
  | 'image_missing';

// ---------------------------------------------------------------------------
// Derivaciones puras de los campos públicos
// ---------------------------------------------------------------------------

/** Identidad remota efectiva, acotada al máximo del contrato. */
export function outboundId(p: Product): string {
  const raw = (p.metaRetailerId ?? '').trim() || (p.inventory?.sku ?? '').trim();
  return raw.slice(0, MAX_ID_LENGTH);
}

/**
 * ⚠️ ESTAS SON LAS ÚNICAS DERIVACIONES DE LOS CAMPOS PÚBLICOS. La vista de lectura
 * (`localPublicView` en catalog.ts) las reusa: si el diff calculara un valor y el
 * serializador otro —distinto truncado, distinto fallback— el campo figuraría como
 * "cambiado" en cada corrida y el producto quedaría `pending` para siempre.
 */
export const outboundTitle = (p: Product) => (p.name ?? '').trim().slice(0, MAX_TITLE_LENGTH);
/** Meta exige descripción: si el producto no la tiene, cae al título (mismo fallback en ambos lados). */
export const outboundDescription = (p: Product) =>
  ((p.description ?? '').trim() || outboundTitle(p)).slice(0, MAX_DESCRIPTION_LENGTH);
export const outboundBrand = (p: Product) => (p.perfume?.brand ?? '').trim().slice(0, MAX_BRAND_LENGTH);
export const outboundLink = (p: Product) => (p.productUrl ?? '').trim();
export const outboundImageUrl = (p: Product) => (p.images ?? []).find((u) => typeof u === 'string' && u.startsWith('https://')) ?? '';

const title = outboundTitle;
const description = outboundDescription;
const brand = outboundBrand;
const link = outboundLink;
const httpsImage = outboundImageUrl;

/** Precio con el formato "monto ISO" del contrato. PYG no lleva decimales. */
export function outboundPrice(p: Product): string {
  return `${Math.round(p.price)} PYG`;
}

/** Disponibilidad pública: literales exactos del contrato (dos palabras). */
export function outboundAvailability(p: Product): 'in stock' | 'out of stock' {
  const vendible = p.status === 'ACTIVE' && (!p.inventory?.trackStock || (p.inventory?.stock ?? 0) > 0);
  return vendible ? 'in stock' : 'out of stock';
}

/** `image` del contrato de escritura: array de objetos, NO el `image_url` de lectura. */
function outboundImage(p: Product): Array<{ url: string }> {
  const url = httpsImage(p);
  return url ? [{ url }] : [];
}

/** Valor público de un campo escribible. `undefined` ⇒ el campo no puede emitirse. */
function fieldValue(p: Product, field: WritableField): unknown {
  switch (field) {
    case 'title': return title(p) || undefined;
    case 'description': return description(p) || undefined;
    case 'link': return link(p) || undefined;
    case 'price': return outboundPrice(p);
    case 'availability': return outboundAvailability(p);
    case 'condition': return 'new';
    case 'brand': return brand(p) || undefined;
    case 'image': return outboundImage(p).length ? outboundImage(p) : undefined;
  }
}

// ---------------------------------------------------------------------------
// CREATE — fail-closed sobre los obligatorios del contrato
// ---------------------------------------------------------------------------

/**
 * Requisitos del contrato para CREAR un artículo. Lista vacía = se puede crear.
 * Nunca se inventa un link, una marca, una categoría ni una imagen: si falta, se bloquea.
 */
export function createBlockers(p: Product): CreateBlocker[] {
  const out: CreateBlocker[] = [];
  if (!outboundId(p)) out.push('identity_missing');
  if (!title(p)) out.push('title_missing');
  if (!description(p)) out.push('description_missing');
  if (!link(p)) out.push('product_url_missing');
  if (!Number.isFinite(p.price) || p.price <= 0) out.push('price_invalid');
  if (p.currency !== 'PYG') out.push('currency_not_pyg');
  if (!brand(p)) out.push('brand_missing');
  if (!httpsImage(p)) out.push('image_missing');
  return out;
}

export class CatalogOutboundError extends Error {
  constructor(message: string, readonly blockers: CreateBlocker[] = []) {
    super(message);
    this.name = 'CatalogOutboundError';
  }
}

/**
 * Request de CREACIÓN: `method: 'CREATE'` con los 9 campos obligatorios del contrato y
 * nada más. Lanza si falta alguno — un create incompleto jamás se despacha.
 */
export function buildCatalogCreatePayload(p: Product): CatalogBatchRequest {
  const blockers = createBlockers(p);
  if (blockers.length) {
    throw new CatalogOutboundError(`No se puede crear el artículo en Meta: faltan ${blockers.join(', ')}.`, blockers);
  }
  return {
    method: 'CREATE',
    data: {
      id: outboundId(p),
      title: title(p),
      description: description(p),
      link: link(p),
      price: outboundPrice(p),
      availability: outboundAvailability(p),
      condition: 'new',
      brand: brand(p),
      image: outboundImage(p),
    },
  };
}

// ---------------------------------------------------------------------------
// UPDATE — patch PARCIAL de verdad
// ---------------------------------------------------------------------------

/**
 * Request de ACTUALIZACIÓN: identidad + SOLO los campos realmente modificados.
 * Un cambio de precio manda exclusivamente `{ id, price }`: no reenvía el objeto entero,
 * así que no exige link, marca ni imagen para actualizar un artículo que ya existe.
 * Los campos ajenos al contrato público se descartan en silencio.
 */
export function buildCatalogUpdatePatch(p: Product, changedFields: readonly string[]): CatalogBatchRequest {
  const id = outboundId(p);
  if (!id) throw new CatalogOutboundError('No se puede actualizar en Meta: el producto no tiene identidad remota.', ['identity_missing']);

  const data: { id: string } & Record<string, unknown> = { id };
  for (const field of changedFields) {
    if (!(WRITABLE_FIELDS as readonly string[]).includes(field)) continue; // ajeno al contrato público
    const value = fieldValue(p, field as WritableField);
    if (value !== undefined) data[field] = value;
  }
  if (Object.keys(data).length === 1) {
    throw new CatalogOutboundError('No se puede actualizar en Meta: no hay ningún campo público modificado.');
  }
  return { method: 'UPDATE', data };
}

// ---------------------------------------------------------------------------
// DISABLE — la palanca mínima
// ---------------------------------------------------------------------------

/**
 * Request de APAGADO: identidad + `availability: 'out of stock'`, nada más. No toca
 * nombre, precio, imagen, descripción ni URL, y funciona aunque al producto le falten
 * campos obligatorios de creación (ocultar no puede depender de lo que no se envía).
 * Jamás DELETE: el borrado físico es una operación aparte con confirmación humana.
 */
export function buildCatalogDisablePatch(p: Product): CatalogBatchRequest {
  const id = outboundId(p);
  if (!id) throw new CatalogOutboundError('No se puede ocultar en Meta: el producto no tiene identidad remota.', ['identity_missing']);
  return { method: 'UPDATE', data: { id, availability: 'out of stock' } };
}
