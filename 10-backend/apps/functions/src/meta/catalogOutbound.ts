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
 *   request   : { method: 'CREATE'|'UPDATE', data: {...} }
 *   identidad : `data.id` — NUNCA un `retailer_id` hermano de `data`. Máx 100 caracteres,
 *               y JAMÁS truncada: pasado el tope el producto se bloquea (ver §9 del ADR).
 *   CREATE    : id, title, description, link, price, availability, condition, brand, image
 *   UPDATE    : id + SOLO los campos modificados (patch parcial de verdad)
 *   image     : array de { url, tag? }   ·   availability: "in stock" | "out of stock"
 *
 * Meta también define `DELETE`, pero VendeyaPy NO lo representa: no está en el tipo, no hay
 * builder que lo emita y el validador lo rechaza. Dar de baja es `out of stock`.
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

/**
 * Límite del contrato para el identificador del artículo. Lo comparten el planificador, el
 * gate de habilitación y el validador de transporte: tres constantes separadas se
 * desincronizan y dejan pasar identidades que después Meta rechaza.
 */
export const MAX_ID_LENGTH = 100;
const MAX_TITLE_LENGTH = 100; // el contrato acota `title` a 100 caracteres
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_BRAND_LENGTH = 100;

/**
 * Métodos que VendeyaPy representa. Meta también admite `DELETE`, pero **este sistema no lo
 * implementa**: dar de baja se hace con `availability: 'out of stock'`, y el borrado físico
 * será una operación aparte con confirmación humana. Al no estar en el tipo, un DELETE no es
 * construible; y la validación de runtime lo rechaza aunque se lo cuele por un cast.
 */
export type CatalogBatchMethod = 'CREATE' | 'UPDATE';

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
  | 'identity_too_long'
  | 'title_missing'
  | 'description_missing'
  | 'product_url_missing'
  | 'product_url_not_https'
  | 'price_invalid'
  | 'currency_not_pyg'
  | 'brand_missing'
  | 'image_missing';

/** Bloqueos que impiden emitir un patch de actualización o de apagado. */
export type UpdateBlocker = 'identity_missing' | 'identity_too_long' | 'description_missing' | 'title_missing' | 'image_missing' | 'brand_missing' | 'product_url_missing' | 'product_url_not_https' | 'price_invalid' | 'no_writable_change';

// ---------------------------------------------------------------------------
// Derivaciones puras de los campos públicos
// ---------------------------------------------------------------------------

/**
 * Identidad remota EXACTA. **Jamás se trunca**: recortar convertiría dos identidades
 * distintas con el mismo prefijo en una sola (dos productos escribiendo sobre el mismo
 * artículo de Meta) y además emitiría un id diferente del que el producto tiene guardado.
 * Si excede el máximo del contrato, el producto se BLOQUEA (`identity_too_long`).
 */
export function outboundId(p: Product): string {
  return (p.metaRetailerId ?? '').trim() || (p.inventory?.sku ?? '').trim();
}

/**
 * URL pública CANÓNICA para el contrato, o `null` si no es una https absoluta válida.
 *
 * Devuelve `href` (la forma normalizada del parser: esquema en minúsculas, host en
 * punycode, path escapado). Es la ÚNICA forma de una URL que este sistema emite o compara:
 * si un lado validara con `new URL()` y otro con `startsWith('https://')`, un valor como
 * `HTTPS://x.com` pasaría el primero y sería rechazado por el segundo — en el transporte,
 * cuando ya es tarde. Y si guardáramos la forma cruda pero Meta devolviera la canónica, el
 * diff marcaría la URL como cambiada en cada corrida.
 */
export function canonicalHttpsUrl(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    // Credenciales embebidas: la URL se publica en el catálogo y la ven clientes finales.
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * ⚠️ ESTAS SON LAS ÚNICAS DERIVACIONES DE LOS CAMPOS PÚBLICOS. La vista de lectura
 * (`localPublicView` en catalog.ts) las reusa: si el diff calculara un valor y el
 * serializador otro —distinto truncado, distinto fallback— el campo figuraría como
 * "cambiado" en cada corrida y el producto quedaría `pending` para siempre.
 */
export const outboundTitle = (p: Product) => (p.name ?? '').trim().slice(0, MAX_TITLE_LENGTH);
/**
 * Descripción tal cual la cargó el vendedor. **No se deriva del título**: inventar el
 * contenido que se publica en el catálogo del negocio no es una decisión del sistema. Vacía
 * ⇒ el producto queda bloqueado (`description_missing`) hasta que alguien la escriba.
 */
export const outboundDescription = (p: Product) => (p.description ?? '').trim().slice(0, MAX_DESCRIPTION_LENGTH);
/**
 * Marca pública: primero el campo NEUTRAL `brand` (cualquier rubro), con fallback al
 * sub-objeto del vertical (`perfume.brand`) para que los productos existentes de arfagi
 * sigan publicando su marca sin backfill. Una sola derivación: el gate, el diff y el
 * serializador ven exactamente el mismo valor.
 */
export const outboundBrand = (p: Product) => ((p.brand ?? p.perfume?.brand) ?? '').trim().slice(0, MAX_BRAND_LENGTH);
/** URL del producto en su forma CANÓNICA. Cadena vacía si no es una https válida. */
export const outboundLink = (p: Product) => canonicalHttpsUrl(p.productUrl) ?? '';
export const outboundImageUrl = (p: Product) => (p.images ?? []).find((u) => typeof u === 'string' && u.startsWith('https://')) ?? '';

const title = outboundTitle;
const description = outboundDescription;
const brand = outboundBrand;
const link = outboundLink;
const httpsImage = outboundImageUrl;

/** Precio máximo representable sin notación exponencial en el formato del contrato. */
const MAX_PRICE = 1_000_000_000_000; // un billón de guaraníes: muy por encima de cualquier venta real

/** Precio con el formato "monto ISO" del contrato. PYG no lleva decimales. */
export function outboundPrice(p: Product): string {
  return `${Math.round(p.price)} PYG`;
}

/** true si el precio se puede representar en el formato del contrato (`\d+ PYG`). */
const priceIsRepresentable = (p: Product): boolean =>
  Number.isFinite(p.price) && p.price > 0 && p.price < MAX_PRICE && /^\d+ [A-Z]{3}$/.test(outboundPrice(p));

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
    // Solo se emite una URL válida: una inválida bloquea, jamás viaja tal cual.
    case 'link': return link(p) || undefined; // ya viene canónica o vacía
    case 'price': return priceIsRepresentable(p) ? outboundPrice(p) : undefined;
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
  const id = outboundId(p);
  if (!id) out.push('identity_missing');
  else if (id.length > MAX_ID_LENGTH) out.push('identity_too_long');
  if (!title(p)) out.push('title_missing');
  if (!description(p)) out.push('description_missing');
  // `link(p)` ya devuelve la forma canónica, o vacía si la URL no es válida: se distingue
  // "no cargó ninguna" de "cargó una que no sirve" mirando el valor crudo.
  if (!link(p)) out.push((p.productUrl ?? '').trim() ? 'product_url_not_https' : 'product_url_missing');
  // Incluye el caso de un precio tan grande que `String()` lo emitiría en notación
  // exponencial ("1e+21 PYG"), que el contrato no admite.
  if (!priceIsRepresentable(p)) out.push('price_invalid');
  if (p.currency !== 'PYG') out.push('currency_not_pyg');
  if (!brand(p)) out.push('brand_missing');
  if (!httpsImage(p)) out.push('image_missing');
  return out;
}

/** Bloqueos de identidad comunes a UPDATE y DISABLE (se evalúan antes de cualquier envío). */
function identityBlockers(p: Product): UpdateBlocker[] {
  const id = outboundId(p);
  if (!id) return ['identity_missing'];
  if (id.length > MAX_ID_LENGTH) return ['identity_too_long'];
  return [];
}

/**
 * Bloqueos de un patch de actualización: identidad inválida, o un campo pedido cuyo valor
 * local no se puede emitir (p.ej. sincronizar `description` cuando está vacía). Vacío = el
 * patch se puede construir.
 */
export function updateBlockers(p: Product, changedFields: readonly string[]): UpdateBlocker[] {
  const out: UpdateBlocker[] = [...identityBlockers(p)];
  let emitibles = 0;
  for (const field of changedFields) {
    if (!(WRITABLE_FIELDS as readonly string[]).includes(field)) continue;
    const w = field as WritableField;
    if (fieldValue(p, w) !== undefined) { emitibles++; continue; }
    // El campo se pidió sincronizar pero su valor local no es publicable.
    switch (w) {
      case 'description': out.push('description_missing'); break;
      case 'title': out.push('title_missing'); break;
      case 'image': out.push('image_missing'); break;
      case 'brand': out.push('brand_missing'); break;
      case 'link': out.push((p.productUrl ?? '').trim() ? 'product_url_not_https' : 'product_url_missing'); break;
      // Precio no representable en el formato del contrato: el motivo tiene que decir eso,
      // no "no hay cambios publicables".
      case 'price': out.push('price_invalid'); break;
      default: break;
    }
  }
  if (!emitibles && !out.length) out.push('no_writable_change');
  return out;
}

export class CatalogOutboundError extends Error {
  constructor(message: string, readonly blockers: Array<CreateBlocker | UpdateBlocker> = []) {
    super(message);
    this.name = 'CatalogOutboundError';
  }
}

/**
 * Campos públicos que un CREATE completo emite (todos menos la identidad). Existe para que
 * los gates de PROPIEDAD (ADR-0015) pregunten "¿gobernamos TODO lo que este create publica?"
 * ANTES de construirlo — decirle al dueño "falta la descripción" cuando el problema real es
 * que el campo lo gobierna el feed sería mandarlo a arreglar lo que no está roto.
 * `catalogOutbound.contract.test.ts` verifica que coincida EXACTAMENTE con lo que emite
 * `buildCatalogCreatePayload`: una lista paralela que se desincroniza es un agujero.
 */
export const CREATE_PAYLOAD_FIELDS = ['title', 'description', 'link', 'price', 'availability', 'condition', 'brand', 'image'] as const satisfies readonly WritableField[];

/**
 * Request de CREACIÓN: `method: 'CREATE'` con los 9 campos obligatorios del contrato y
 * nada más. Lanza si falta alguno — un create incompleto jamás se despacha.
 */
export function buildCatalogCreatePayload(p: Product): CatalogBatchRequest {
  const blockers = createBlockers(p);
  if (blockers.length) {
    throw new CatalogOutboundError(`No se puede crear el artículo en Meta: ${blockers.join(', ')}.`, blockers);
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
  const blockers = updateBlockers(p, changedFields);
  if (blockers.length) {
    throw new CatalogOutboundError(`No se puede actualizar el artículo en Meta: ${blockers.join(', ')}.`, blockers);
  }
  const data: { id: string } & Record<string, unknown> = { id: outboundId(p) };
  for (const field of changedFields) {
    if (!(WRITABLE_FIELDS as readonly string[]).includes(field)) continue; // ajeno al contrato público
    const value = fieldValue(p, field as WritableField);
    if (value !== undefined) data[field] = value;
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
  const blockers = identityBlockers(p);
  if (blockers.length) {
    throw new CatalogOutboundError(`No se puede ocultar el artículo en Meta: ${blockers.join(', ')}.`, blockers);
  }
  return { method: 'UPDATE', data: { id: outboundId(p), availability: 'out of stock' } };
}
