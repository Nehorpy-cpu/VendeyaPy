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
import type { Product } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../audit/audit.js';
import { normalizeCatalogSyncConfig, type CatalogSyncMode } from './catalogSyncConfig.js';
import {
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
  CREATE_PAYLOAD_FIELDS,
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
import { stableHash, verifyJobOutcome } from './catalogOutbox.js';
import {
  effectiveMode,
  type CatalogOwnershipModel,
  type EffectiveOwnership,
  type OwnershipDegradedReason,
  type WritableField as OwnedField,
} from './catalogOwnership.js';
import { outboundFieldsNotOwned, ownershipFingerprint } from './catalogOwnershipGates.js';
import { enqueueCatalogPlan } from './catalogOutboxWorker.js';

const MAX_STORED_ENTRIES = 500; // techo del run doc (y de la respuesta al panel)
const STATE_COMMIT_CHUNK = 200; // docs por commit al persistir meta* (lejos de los techos de Firestore)
/**
 * Vigencia de un preview (META-CATALOG-PREVIEW-BINDING-1): tiempo máximo entre la
 * previsualización aprobada y el apply que la referencia. Corto a propósito — el binding
 * garantiza que lo encolado sea EXACTAMENTE lo previsualizado, pero cuanto más vieja la
 * foto, más probable que el replan difiera y el dueño tenga que previsualizar de nuevo.
 */
export const PREVIEW_TTL_MS = 10 * 60_000;

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
  /**
   * (ADR-0015) La acción necesitaba escribir campos que VendeYaPy NO gobierna: los publica una
   * fuente externa reconocida, o la propiedad todavía no está declarada. No es un defecto del
   * producto — es que ese campo no es nuestro y proponerlo sería proponer un loop.
   */
  | 'externally_owned'
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
  /**
   * (ADR-0015) Campos —en el vocabulario del contrato de ESCRITURA— que esta entrada habría
   * necesitado y que VendeYaPy no gobierna. Se REPORTAN aunque la acción siga adelante con el
   * resto: el dueño tiene que ver qué quedó afuera y por qué, en vez de descubrir un día que
   * el precio nunca se propagó.
   */
  notOwnedFields?: string[];
  /** Vista LOCAL en términos de lectura (para el diff y para confirmar la convergencia). */
  payload?: Record<string, unknown>;
  /** Request de ESCRITURA ya serializado según el contrato. Solo en acciones accionables. */
  request?: CatalogBatchRequest;
  remoteItemId?: string | null;
  note?: string;
  /**
   * Snapshot del ITEM REMOTO tal como lo vio ESTA corrida — exactamente la superficie que
   * compara `diffPublicFields`. Participa de la huella del plan
   * (META-CATALOG-PREVIEW-BINDING-1): un cambio en Meta sobre un artículo afectado invalida
   * el preview AUNQUE no altere la acción, los `changedFields` ni el request (p. ej. alguien
   * tocó en Commerce Manager un campo que YA difería). `null` si la entrada no matcheó item.
   */
  remoteSnapshot?: CatalogRemoteSnapshot | null;
}

/**
 * Superficie remota para la huella del preview (cruda, tal como la devolvió el Graph API):
 * lo que compara el diff + `remoteItemId` + `currency` (estrictez extra, ver `snapshotRemoto`).
 */
export interface CatalogRemoteSnapshot {
  remoteItemId: string;
  name: string;
  description: string;
  availability: string;
  price: string;
  currency: string;
  imageUrl: string;
  url: string;
  brand: string;
}

/**
 * Propiedad con la que se planificó, SANEADA para el panel y para la huella del preview
 * (ADR-0015 §7). Jamás incluye la URL del feed, su query string ni token alguno.
 */
export interface CatalogPlanOwnership {
  model: CatalogOwnershipModel;
  /** Huella de la propiedad efectiva: participa de `planFingerprint`. */
  fingerprint: string;
  /** Campos públicos que VendeYaPy gobierna (vocabulario del catálogo). */
  ownedFields: OwnedField[];
  /** Campos públicos que gobierna la fuente externa reconocida. */
  externalFields: OwnedField[];
  degraded: boolean;
  reasons: OwnershipDegradedReason[];
  /**
   * Acciones que la propiedad IMPIDIÓ proponer. Es el número que explica un plan sin trabajo:
   * "no hay nada para hacer" y "no nos toca hacerlo" son cosas distintas.
   */
  blockedActions: number;
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
  /** Propiedad EFECTIVA con la que se planificó (ADR-0015 §7). */
  ownership: CatalogPlanOwnership;
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
 *
 * EXPORTADA (ADR-0015 §5): la verificación periódica compara los mismos campos que el diff.
 * Con dos implementaciones habría dos verdades sobre el mismo campo — el plan diría
 * "sin cambios" y el estado diría `drifted`, o al revés.
 */
export function urlEquals(local: string, remoteUrl: string): boolean {
  if (!local) return true;
  if (!remoteUrl) return true;
  return local === (canonicalHttpsUrl(remoteUrl) ?? remoteUrl);
}

/**
 * Traduce la vista de LECTURA a los nombres del contrato de ESCRITURA, para poder confirmarla
 * campo por campo con la verificación de tres estados. Un campo que el producto no tiene
 * (sin URL, sin imagen) NO se proyecta: no se administra, así que no hay nada que confirmar.
 */
function writableProjection(view: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (view.name !== undefined) out.title = view.name;
  if (view.description !== undefined) out.description = view.description;
  if (view.price !== undefined) out.price = view.price;
  if (view.availability !== undefined) out.availability = view.availability;
  if (view.condition !== undefined) out.condition = view.condition;
  if (view.brand !== undefined) out.brand = view.brand;
  if (view.url) out.link = view.url;
  if (view.image_url) out.image = [{ url: view.image_url }];
  return out;
}

/**
 * Snapshot crudo del item remoto para la huella del preview: la superficie que compara
 * `diffPublicFields` MÁS `remoteItemId` (la identidad sobre la que se aprueba el UPDATE) y
 * `currency` (el diff la parsea desde el string `price`; acá va aparte, a propósito). Los
 * extras solo agregan ESTRICTEZ — pueden producir un `preview_mismatch` de más (se vuelve a
 * previsualizar), jamás una aceptación indebida.
 */
function snapshotRemoto(r: MetaRemoteCatalogItem): CatalogRemoteSnapshot {
  return {
    remoteItemId: r.id,
    name: r.name,
    description: r.description,
    availability: r.availability,
    price: r.price,
    currency: r.currency ?? '',
    imageUrl: r.imageUrl,
    url: r.url ?? '',
    brand: r.brand,
  };
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

/**
 * Plan del ciclo. `ownership` es OBLIGATORIA y ya viene normalizada (fail-closed de nivel 2):
 * no tiene default a propósito — un planificador que asumiera propiedad total por omisión
 * sería exactamente el bug que ADR-0015 vino a cerrar.
 */
export function planCatalogSync(products: Product[], remoteItems: MetaRemoteCatalogItem[], ownership: EffectiveOwnership): CatalogSyncPlan {
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
  /** Acciones que existían pero no se proponen porque los campos no son nuestros. */
  let blockedByOwnership = 0;

  // ═══ GATE DE PROPIEDAD (ADR-0015 §7) ═══
  // Un campo que no gobernamos NO se propone, ni siquiera como sugerencia: proponer un update
  // sobre un campo que publica un feed diario ES el loop —el feed revierte de madrugada, el
  // plan lo vuelve a detectar, el apply lo vuelve a escribir— y nadie se entera nunca.
  const ajenos = (campos: readonly string[]) => outboundFieldsNotOwned(ownership, campos);
  // El motivo se le muestra al dueño: "todavía no declaraste quién manda" y "manda otro" son
  // problemas distintos y se arreglan en lugares distintos.
  const notaPropiedad = ownership.degraded ? 'propiedad_no_declarada' : 'campos_gobernados_por_fuente_externa';
  const bloqueadoPorPropiedad = (base: Omit<CatalogPlanEntry, 'action'>, sinPropiedad: string[], extra: Partial<CatalogPlanEntry> = {}): void => {
    blockedByOwnership++;
    entries.push({ ...base, action: 'blocked', blockedReasons: ['externally_owned'], notOwnedFields: sinPropiedad, note: notaPropiedad, ...extra });
  };

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
        remoteSnapshot: null,
      });
    }
  }

  function planOne(p: Product): void {
    const sku = effectiveRetailerId(p);
    const internalSku = (p.inventory?.sku ?? '').trim();
    const mapped = !!(p.metaRetailerId ?? '').trim();
    const remote = sku ? remoteByRetailerId.get(sku) : undefined;
    const name = (p.name ?? '').trim();
    // `remoteSnapshot` viaja en TODAS las entradas de este producto: la huella del preview
    // debe cambiar si el item remoto afectado cambia, sea cual sea la acción resultante.
    const base = { productId: p.id, sku, internalSku, mapped, productName: name, remoteSnapshot: remote ? snapshotRemoto(remote) : null };

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
        // Apagar TAMBIÉN es escribir: si `availability` la publica el feed, el apagado no es
        // nuestro. Se dice con todas las letras en vez de emitir un UPDATE que la fuente
        // externa revertiría mañana.
        const sinPropiedad = ajenos(['availability']);
        if (sinPropiedad.length) {
          bloqueadoPorPropiedad(base, sinPropiedad, { blockedReasons: [...reasons, 'externally_owned'], remoteItemId: remote.id });
          return;
        }
        entries.push({
          ...base,
          action: 'disable',
          blockedReasons: reasons,
          changedFields: ['availability'],
          // La vista pública COMPLETA, igual que cualquier otra entrada accionable: es el
          // snapshot con el que el outbox detecta si el producto cambió desde el preview.
          // Un payload reducido nunca coincidiría con el que recalcula el gate y este disable
          // quedaría `stale` para siempre — es decir, el artículo nunca se apagaría en Meta.
          payload: localPublicView(p),
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
      // CREAR publica el artículo ENTERO: exige gobernar TODOS los campos que el create emite.
      // Se pregunta ANTES de mirar los obligatorios porque el orden es el del diagnóstico
      // honesto: pedirle una descripción al dueño cuando el problema es que la descripción la
      // publica el feed lo manda a arreglar algo que no está roto.
      const createSinPropiedad = ajenos(CREATE_PAYLOAD_FIELDS);
      if (createSinPropiedad.length) {
        bloqueadoPorPropiedad(base, createSinPropiedad, { remoteItemId: null });
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
    // El patch se recorta a lo NUESTRO. Un híbrido donde gobernamos el precio pero el feed
    // gobierna el título manda `{ id, price }` y reporta el título como ajeno: se propaga lo
    // que nos toca y se dice qué quedó afuera. Sin un solo campo propio no hay patch posible.
    const escribibles = disabling ? ['availability'] : toWritableFields(changed);
    const sinPropiedad = ajenos(escribibles);
    const propios = escribibles.filter((f) => !sinPropiedad.includes(f));
    // Solo se culpa a la propiedad cuando la propiedad ES la causa. Si no quedó nada que
    // escribir por otro motivo, el mensaje correcto lo da `updateBlockers` (`no_writable_change`).
    if (!propios.length && sinPropiedad.length) {
      bloqueadoPorPropiedad(base, sinPropiedad, { changedFields: changed, payload, remoteItemId: remote.id });
      return;
    }
    if (!disabling) {
      // Un campo cambiado cuyo valor local no es publicable (descripción vacía, URL
      // inválida) bloquea SOLO a este producto, con el motivo exacto. Se evalúa sobre los
      // campos PROPIOS: un ajeno no puede bloquear un update que ni siquiera lo incluye.
      const impedimentos = updateBlockers(p, propios);
      if (impedimentos.length) {
        entries.push({ ...base, action: 'blocked', blockedReasons: impedimentos.map(createBlockerToPlanReason), changedFields: changed, note: 'update_incompleto' });
        return;
      }
    }
    entries.push({
      ...base,
      action: disabling ? 'disable' : 'update',
      changedFields: changed,
      ...(sinPropiedad.length ? { notOwnedFields: sinPropiedad } : {}),
      payload,
      // El request lleva SOLO lo que cambió Y es nuestro (o solo availability si es un apagado).
      request: disabling ? buildCatalogDisablePatch(p) : buildCatalogUpdatePatch(p, propios),
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

  return {
    entries,
    remoteOnly,
    ignoredArchived,
    excludedNotManaged: excluidos,
    summary,
    ownership: {
      model: ownership.model,
      fingerprint: ownershipFingerprint(ownership),
      ownedFields: ownership.writable,
      externalFields: ownership.external,
      degraded: ownership.degraded,
      reasons: ownership.reasons,
      blockedActions: blockedByOwnership,
    },
  };
}

// ---------------------------------------------------------------------------
// Servicio: runCatalogSync(tenantId, { mode }) — dry_run / apply.
// ---------------------------------------------------------------------------

export interface CatalogSyncActor {
  uid?: string | null;
  role?: string | null;
}

/**
 * META-CATALOG-PREVIEW-BINDING-1: motivos por los que un apply queda bloqueado por su
 * evidencia de preview. TODOS terminan en `failed-precondition` en el callable y con el
 * outbox intacto (cero jobs/intents nuevos).
 */
export type PreviewBlockReason =
  | 'preview_required' // apply sin evidencia {previewRunId, planHash}
  | 'preview_not_found' // el runId no existe EN ESTE TENANT (cubre evidencia de otro tenant)
  | 'preview_not_usable' // no es un dry_run 'planned' con planHash (p. ej. un run de error)
  | 'preview_mismatch' // el hash provisto ≠ almacenado, o el replan ya no coincide
  | 'preview_wrong_catalog' // la config apunta a otro catalogId que el previsualizado
  | 'preview_actor_mismatch' // quien aplica no es quien previsualizó
  | 'preview_expired' // pasó PREVIEW_TTL_MS desde que terminó el preview
  | 'preview_consumed'; // ya se usó (replay o carrera de applies concurrentes)

export interface CatalogSyncRunResult {
  runId: string;
  requestedMode: 'dry_run' | 'apply';
  /**
   * `queued` reemplazó a `applied`: confirmar el plan ENCOLA el trabajo, no lo aplica. El
   * resultado real lo declara la confirmación del outbox contra el catálogo de Meta.
   */
  status: 'disabled' | 'apply_blocked' | 'error' | 'planned' | 'queued' | 'partial_failure';
  configMode: CatalogSyncMode;
  /**
   * Modo REALMENTE ejecutable = config ∧ techo de la propiedad (ADR-0015). Un documento en
   * `live` con el catálogo gobernado por una fuente externa reporta `dry_run` acá: el panel
   * tiene que mostrar lo que va a pasar, no lo que alguien escribió en la config.
   */
  effectiveMode?: CatalogSyncMode;
  reason?: 'mode_not_live' | 'ownership_not_live' | 'missing_token' | 'catalog_unreachable' | 'batch_failed' | 'state_persist_failed' | PreviewBlockReason;
  /** Detalle SANEADO (jamás token ni datos internos). */
  errorDetail?: string;
  catalogId?: string;
  summary?: CatalogSyncPlan['summary'];
  /** Propiedad SANEADA con la que se planificó: qué gobierna cada lado y por qué. */
  ownership?: CatalogPlanOwnership;
  entries?: Array<Pick<CatalogPlanEntry, 'productId' | 'sku' | 'productName' | 'action' | 'blockedReasons' | 'changedFields' | 'notOwnedFields' | 'suggestion' | 'note'>>;
  ignoredArchived?: number;
  /** Productos sin opt-in de sync: excluidos del plan (fail-closed). */
  excludedNotManaged?: number;
  /** Artículos de Meta sin producto local que los reclame (candidatos de importación). */
  remoteOnly?: Array<{ retailerId: string; name: string }>;
  /** Jobs creados en el outbox. NO es "aplicado en Meta". */
  queuedCount?: number;
  /** Confirmaciones repetidas: ya hay trabajo pendiente para ese mismo cambio. */
  deduplicatedCount?: number;
  /** De los repetidos, los que están TRABADOS esperando una revisión del dueño. */
  awaitingReviewCount?: number;
  /** Productos cuyo request no cumple el contrato (quedan fuera, sin frenar a los demás). */
  blockedCount?: number;
  /**
   * Huella determinística del plan (dry_run). Es la evidencia que un apply posterior debe
   * presentar junto con el runId: sin ella no hay forma de encolar nada.
   */
  planHash?: string;
  /** En un apply: qué preview lo autorizó (trazabilidad del binding). */
  previewRunId?: string;
}

const newRunId = () => `mcs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// META-CATALOG-PREVIEW-BINDING-1 — huella del plan y validación de la evidencia.
// ---------------------------------------------------------------------------

/**
 * Huella determinística de un plan: tenant + catálogo + TODAS las entradas (también las
 * `unchanged`/`blocked` — un bloqueo nuevo o un unchanged que aparece también es un plan
 * DISTINTO) con su request congelado Y el snapshot remoto del item afectado. Dos corridas
 * con el mismo estado local y remoto producen la misma huella; cualquier cambio que altere
 * el plan — o el item remoto sobre el que se aprobó, aunque el request no cambie — la cambia.
 *
 * NO incluye `remoteOnly`: son candidatos informativos sin acción — un alta externa en el
 * catálogo no invalida un plan que no la toca.
 */
export function planFingerprint(tenantId: string, catalogId: string, plan: CatalogSyncPlan): string {
  const entries = plan.entries
    .map((e) => ({
      productId: e.productId,
      sku: e.sku,
      action: e.action,
      remoteItemId: e.remoteItemId ?? null,
      changedFields: e.changedFields ? [...e.changedFields].sort() : null,
      blockedReasons: e.blockedReasons ? [...e.blockedReasons].sort() : null,
      // Lo que quedó afuera por propiedad también define el plan aprobado: si mañana el dueño
      // reclama un campo que hoy publica el feed, lo previsualizado ya no es lo mismo.
      notOwnedFields: e.notOwnedFields ? [...e.notOwnedFields].sort() : null,
      request: e.request ?? null,
      // Snapshot remoto del item afectado: "Meta modificado" invalida el preview aunque el
      // request a enviar no cambie (el dueño aprueba contra un remoto concreto).
      remoteSnapshot: e.remoteSnapshot ?? null,
    }))
    // El orden del plan es determinístico, pero la huella no debe depender de él.
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
  // La PROPIEDAD participa de la huella (ADR-0015 §7): un preview se aprueba bajo permisos
  // concretos. Si entre la previsualización y el apply alguien cambia quién gobierna qué, el
  // plan aprobado dejó de existir aunque las acciones se vean idénticas — y encolarlo sería
  // ejecutar con permisos que ya nadie autorizó.
  return stableHash({ v: 2, tenantId, catalogId, ownership: plan.ownership.fingerprint, entries });
}

/** Evidencia que el apply debe presentar (viene del resultado del dry_run). */
export interface PreviewEvidence {
  runId: string;
  planHash: string;
}

/** Formatos estrictos: el runId viaja a una ruta de doc y el hash es hex de stableHash. */
const PREVIEW_RUN_ID_RE = /^mcs_[a-z0-9_]{1,60}$/;
const PLAN_HASH_RE = /^[a-f0-9]{16,128}$/;

export function normalizePreviewEvidence(raw: unknown): PreviewEvidence | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { runId?: unknown; planHash?: unknown };
  const runId = typeof r.runId === 'string' ? r.runId.trim() : '';
  const planHash = typeof r.planHash === 'string' ? r.planHash.trim().toLowerCase() : '';
  if (!PREVIEW_RUN_ID_RE.test(runId) || !PLAN_HASH_RE.test(planHash)) return null;
  return { runId, planHash };
}

/** Lo que el validador necesita del doc del preview (subset del run doc persistido). */
export interface PreviewDocData {
  requestedMode?: string;
  status?: string;
  planHash?: string;
  catalogId?: string;
  actorUid?: string | null;
  finishedAt?: Timestamp | null;
  startedAt?: Timestamp | null;
  consumedAt?: Timestamp | null;
}

/**
 * Validación PURA de la evidencia contra el doc del preview. Se corre dos veces: antes de
 * tocar Meta (fail-fast barato) y DE NUEVO dentro de la transacción de consumo (el estado
 * pudo cambiar mientras se releía el catálogo). `null` = utilizable.
 */
export function evaluatePreviewBinding(
  doc: PreviewDocData | null,
  ctx: { evidence: PreviewEvidence; catalogId: string; actorUid: string | null; now: Timestamp },
): PreviewBlockReason | null {
  if (!doc) return 'preview_not_found';
  if (doc.requestedMode !== 'dry_run' || doc.status !== 'planned' || typeof doc.planHash !== 'string' || !doc.planHash) {
    return 'preview_not_usable';
  }
  if (doc.planHash !== ctx.evidence.planHash) return 'preview_mismatch';
  if ((doc.catalogId ?? '') !== ctx.catalogId) return 'preview_wrong_catalog';
  // Ligado al actor: aplica quien previsualizó. Sin uid de ambos lados no hay binding posible.
  if (!ctx.actorUid || (doc.actorUid ?? null) !== ctx.actorUid) return 'preview_actor_mismatch';
  if (doc.consumedAt) return 'preview_consumed';
  const ancla = doc.finishedAt ?? doc.startedAt;
  if (!ancla) return 'preview_not_usable';
  if (ctx.now.toMillis() - ancla.toMillis() > PREVIEW_TTL_MS) return 'preview_expired';
  return null;
}

/** Recorte del plan para persistir/devolver: sin payloads (auditables por producto). */
function slimEntries(entries: CatalogPlanEntry[]): NonNullable<CatalogSyncRunResult['entries']> {
  return entries.slice(0, MAX_STORED_ENTRIES).map((e) => ({
    productId: e.productId,
    sku: e.sku,
    productName: e.productName,
    action: e.action,
    ...(e.blockedReasons ? { blockedReasons: e.blockedReasons } : {}),
    ...(e.changedFields ? { changedFields: e.changedFields } : {}),
    ...(e.notOwnedFields ? { notOwnedFields: e.notOwnedFields } : {}),
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

/** Error interno del consumo del preview: transporta el motivo a través de la transacción. */
class PreviewBindingError extends Error {
  constructor(readonly blockReason: PreviewBlockReason) {
    super(`preview binding: ${blockReason}`);
  }
}

export async function runCatalogSync(
  tenantId: string,
  opts: { mode: 'dry_run' | 'apply'; actor?: CatalogSyncActor; preview?: unknown },
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

  // 1b) MODO EFECTIVO (ADR-0015 §7): la config propone, la propiedad dispone. Con el catálogo
  //     gobernado por una fuente externa —o con la propiedad sin declarar— el techo es
  //     `dry_run` y ningún apply pasa de acá, diga lo que diga el documento.
  const modoEfectivo = effectiveMode(cfg.mode, cfg.ownership);
  const base: CatalogSyncRunResult = { runId, requestedMode: opts.mode, status: 'planned', configMode: cfg.mode, effectiveMode: modoEfectivo, catalogId: cfg.catalogId };

  // 2) apply exige mode 'live' EFECTIVO (dry_run jamás escala solo, y la propiedad tampoco).
  if (opts.mode === 'apply' && modoEfectivo !== 'live') {
    // Se distingue el motivo: "está en dry_run" se arregla en la config; "no gobernás estos
    // campos" se arregla declarando la propiedad (o no se arregla, y está bien que así sea).
    const reason = cfg.mode === 'live' ? ('ownership_not_live' as const) : ('mode_not_live' as const);
    const res: CatalogSyncRunResult = { ...base, status: 'apply_blocked', reason };
    await writeRunDoc(tenantId, runId, { status: res.status, requestedMode: opts.mode, configMode: cfg.mode, effectiveMode: modoEfectivo, reason: res.reason, actorUid: actor?.uid ?? null, startedAt, finishedAt: Timestamp.now() });
    await auditRun(tenantId, runId, res, actor);
    return res;
  }

  // 2b) META-CATALOG-PREVIEW-BINDING-1: un apply SOLO corre atado a un preview aprobado.
  //     La evidencia se valida ACÁ (antes de tocar Meta: fail-fast barato) y se re-valida
  //     dentro de la transacción de consumo, que es la única autoridad anti-replay.
  const applyBloqueadoPorPreview = async (reason: PreviewBlockReason, extra?: Record<string, unknown>): Promise<CatalogSyncRunResult> => {
    const res: CatalogSyncRunResult = { ...base, status: 'apply_blocked', reason };
    await writeRunDoc(tenantId, runId, {
      status: res.status,
      requestedMode: opts.mode,
      configMode: cfg.mode,
      reason,
      ...(extra ?? {}),
      actorUid: actor?.uid ?? null,
      startedAt,
      finishedAt: Timestamp.now(),
    });
    await auditRun(tenantId, runId, res, actor);
    return res;
  };
  let evidence: PreviewEvidence | null = null;
  if (opts.mode === 'apply') {
    evidence = normalizePreviewEvidence(opts.preview);
    if (!evidence) return applyBloqueadoPorPreview('preview_required');
    // La ruta es del MISMO tenant: evidencia de otro tenant simplemente no existe acá.
    const prevSnap = await db().doc(paths.metaCatalogSyncRun(tenantId, evidence.runId)).get();
    const bloqueo = evaluatePreviewBinding(prevSnap.exists ? (prevSnap.data() as PreviewDocData) : null, {
      evidence,
      catalogId: cfg.catalogId,
      actorUid: actor?.uid ?? null,
      now: Timestamp.now(),
    });
    if (bloqueo) return applyBloqueadoPorPreview(bloqueo, { previewRunId: evidence.runId });
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
  const plan = planCatalogSync(products, remoteItems, cfg.ownership);
  // Huella del plan COMPLETO (pre-truncado): la evidencia que un apply futuro debe presentar.
  const planHash = planFingerprint(tenantId, cfg.catalogId, plan);

  const planned: CatalogSyncRunResult = {
    ...base,
    status: 'planned',
    summary: plan.summary,
    ownership: plan.ownership,
    entries: slimEntries(plan.entries),
    ignoredArchived: plan.ignoredArchived,
    excludedNotManaged: plan.excludedNotManaged,
    // El panel necesita la LISTA para ofrecer la importación (las Rules no exponen los runs).
    remoteOnly: plan.remoteOnly.slice(0, MAX_STORED_ENTRIES),
    planHash,
  };
  await writeRunDoc(tenantId, runId, {
    status: 'planned',
    requestedMode: opts.mode,
    configMode: cfg.mode,
    effectiveMode: modoEfectivo,
    catalogId: cfg.catalogId,
    summary: plan.summary,
    // Propiedad SANEADA: modelo, campos de cada lado y huella. Ninguna URL, ningún token.
    ownership: plan.ownership,
    ignoredArchived: plan.ignoredArchived,
    excludedNotManaged: plan.excludedNotManaged,
    remoteOnly: plan.remoteOnly.slice(0, MAX_STORED_ENTRIES),
    entries: planned.entries,
    planHash,
    actorUid: actor?.uid ?? null,
    startedAt,
    finishedAt: Timestamp.now(),
  });

  // 5) dry_run: acá termina. CERO escrituras en Meta y CERO cambios en products.
  if (opts.mode === 'dry_run') {
    await auditRun(tenantId, runId, planned, actor);
    return planned;
  }

  // 5b) BINDING EXACTO: el replan recién hecho debe coincidir con lo previsualizado. Un
  //     producto editado, un cambio remoto que altere el diff, una acción de más o de menos
  //     — cualquiera cambia la huella y acá se corta SIN encolar nada.
  if (planHash !== evidence!.planHash) {
    return applyBloqueadoPorPreview('preview_mismatch', {
      previewRunId: evidence!.runId,
      expectedPlanHash: evidence!.planHash,
      freshPlanHash: planHash,
      freshSummary: plan.summary,
      freshEntries: slimEntries(plan.entries),
    });
  }

  // 5c) CONSUMO transaccional del preview: única autoridad anti-replay y anti-carrera. Se
  //     re-valida TODO adentro de la tx (pudo vencer, consumirse o cambiar mientras se releía
  //     el catálogo). Consumir ANTES de encolar: si el encolado muere a mitad, el preview ya
  //     no es reutilizable — lo correcto es previsualizar de nuevo, jamás repetir a ciegas.
  const previewRef = db().doc(paths.metaCatalogSyncRun(tenantId, evidence!.runId));
  try {
    await db().runTransaction(async (tx) => {
      const fresh = await tx.get(previewRef);
      const bloqueo = evaluatePreviewBinding(fresh.exists ? (fresh.data() as PreviewDocData) : null, {
        evidence: evidence!,
        catalogId: cfg.catalogId,
        actorUid: actor?.uid ?? null,
        now: Timestamp.now(),
      });
      if (bloqueo) throw new PreviewBindingError(bloqueo);
      tx.update(previewRef, { consumedAt: Timestamp.now(), consumedByRunId: runId, consumedByUid: actor?.uid ?? null });
    });
  } catch (e) {
    if (e instanceof PreviewBindingError) {
      return applyBloqueadoPorPreview(e.blockReason, { previewRunId: evidence!.runId });
    }
    throw e;
  }


  // 6) apply: NO se escribe en Meta acá. Cada acción del plan se convierte en un JOB
  //    PERSISTIDO (META-CATALOG-OUTBOX-1) que un worker reclama, envía y confirma después.
  //
  //    POR QUÉ: `items_batch` es asíncrono y la función que atiende al panel no puede
  //    sostener el ciclo completo (envío → estado del batch → relectura del catálogo). Antes
  //    intentaba hacerlo en una sola invocación: si moría a mitad, no quedaba registro de qué
  //    había salido, un error de red dejaba productos en un limbo irrecuperable y la respuesta
  //    decía "aplicado" cuando Meta todavía no había confirmado nada.
  //
  //    Solo se encolan las entradas accionables CON su request serializado. Se usan las
  //    entradas CRUDAS del plan (no `slimEntries`, que descarta `request` y `payload`: sin
  //    ellos no habría ni qué enviar ni contra qué verificar).
  const actionable = plan.entries.filter(
    (e): e is CatalogPlanEntry & { request: CatalogBatchRequest; payload: Record<string, unknown> } =>
      (e.action === 'create' || e.action === 'update' || e.action === 'disable') && !!e.request,
  );
  const encolado = await enqueueCatalogPlan(
    tenantId,
    runId,
    actionable.map((e) => ({
      productId: e.productId,
      sku: e.sku,
      action: e.action as 'create' | 'update' | 'disable',
      request: e.request,
      // Los `disable` con bloqueos no traen la vista pública completa: el snapshot es lo que
      // haya (lo importante es que cambie si el producto cambia).
      payload: e.payload ?? { retailer_id: e.sku, availability: 'out of stock' },
      remoteItemId: e.remoteItemId ?? null,
    })),
    // La propiedad viaja al encolado: cada job congela su huella y se revalida antes del POST.
    { catalogId: cfg.catalogId, ownership: cfg.ownership },
    actor,
  );

  // 7) Convergencia local (sin tocar Meta): un `unchanged` cuyo artículo remoto CONFIRMA los
  //    campos gestionados ya está sincronizado. Se usa la verificación de tres estados: sin
  //    evidencia (Meta no devolvió el campo) NO se marca `synced` — ese era el `synced` falso.
  const now = Timestamp.now();
  const convergencia: Array<{ path: string; data: Record<string, unknown> }> = [];
  const remotoPorId = new Map(remoteItems.filter((r) => r.retailerId).map((r) => [r.retailerId, r]));
  // Productos con un job vigente: su estado lo gobierna ESE job (fencing). La convergencia
  // solo habla de los que nadie está sincronizando en este momento.
  const conJobVigente = new Set(
    products.filter((p) => !!(p as Product & { metaSyncCurrentJobId?: string }).metaSyncCurrentJobId).map((p) => p.id),
  );
  for (const e of plan.entries) {
    if (e.action !== 'unchanged' || !e.remoteItemId || !e.payload) continue;
    if (conJobVigente.has(e.productId)) continue;
    const remoto = remotoPorId.get(e.sku) ?? null;
    if (verifyJobOutcome(writableProjection(e.payload), remoto).outcome !== 'confirmed_equal') continue;
    convergencia.push({
      path: paths.product(tenantId, e.productId),
      data: {
        metaSyncStatus: e.payload.availability === 'out of stock' ? 'disabled' : 'synced',
        metaCatalogId: cfg.catalogId,
        metaProductItemId: e.remoteItemId,
        metaLastSyncAt: now,
        metaSyncError: '',
        updatedAt: now,
      },
    });
  }
  const convergenciaOk = await commitStateOps(tenantId, runId, convergencia);

  const estadoOk = convergenciaOk && encolado.statePersisted;
  const result: CatalogSyncRunResult = {
    ...planned,
    status: 'queued',
    queuedCount: encolado.queued,
    deduplicatedCount: encolado.deduplicated,
    awaitingReviewCount: encolado.awaitingReview,
    blockedCount: encolado.blocked,
    previewRunId: evidence!.runId,
    ...(estadoOk ? {} : { reason: 'state_persist_failed' as const }),
  };
  await writeRunDoc(tenantId, runId, {
    status: 'queued',
    queuedCount: encolado.queued,
    deduplicatedCount: encolado.deduplicated,
    awaitingReviewCount: encolado.awaitingReview,
    blockedCount: encolado.blocked,
    previewRunId: evidence!.runId,
    // `appliedCount` y `lastSuccessfulSyncAt` NO se escriben acá: encolar no es aplicar. Los
    // fija la confirmación, cuando Meta devuelve evidencia.
    finishedAt: Timestamp.now(),
  });
  await auditRun(tenantId, runId, result, actor);
  logger.info('Catalog sync encolada', { tenantId, runId, ...encolado });
  return result;
}
