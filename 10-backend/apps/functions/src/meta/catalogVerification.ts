/**
 * meta/catalogVerification.ts — Estado ACTUAL del producto contra Meta + reconciliación
 * =====================================================================================
 * (ADR-0015 §5 y §6) Dos ejes que hasta ahora estaban confundidos en uno solo:
 *
 *  · HISTÓRICO (intacto acá): `metaSyncStatus` + los jobs del outbox. `succeeded` es
 *    evidencia inmutable de lo que pasó. Este módulo NO lo toca jamás.
 *  · ACTUAL (lo que agrega este módulo): `metaSyncState` + `metaVerifiedAt` + `metaDrift`.
 *    Es una proyección que CADUCA y que solo se escribe tras una lectura remota REAL.
 *
 * El bug de origen fue tratar "lo escribimos y Meta lo aceptó" como "Meta lo muestra hoy":
 * el canary de Odyssey quedó `synced` para siempre mientras el feed diario del sitio del
 * tenant revertía el precio a las pocas horas y nadie lo volvía a mirar.
 *
 * Contenido:
 *  1. Núcleo PURO: comparación campo por campo usando la PROPIEDAD EFECTIVA
 *     (`EffectiveOwnership`) para decidir si la divergencia es nuestra (`drifted`) o de la
 *     fuente externa (`drifted_external`), más `remote_missing` y `unverifiable`.
 *  2. Derivación de `stale` EN LECTURA (nunca se persiste): un job de verificación que
 *     falla envejece el estado en vez de dejarlo mintiendo.
 *  3. Reconciliación PERIÓDICA paginada, idempotente, reanudable y tenant-scoped, detrás de
 *     un `VerificationStore` inyectable (misma costura que el import/mantenimiento).
 *
 * ⚠️ SOLO LEE de Meta (`listItemsPage`). No escribe en Meta, no borra productos ni locks, no
 * toca `metaSyncStatus`, `metaLastSyncAt`, precio, stock ni mapping. Ni siquiera existe acá
 * un camino de escritura remota: la corrección de un campo ajeno se hace EN EL ORIGEN.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { FieldPath } from 'firebase-admin/firestore';
import type {
  MetaCatalogVerificationCounters,
  MetaCatalogVerificationPhase,
  MetaDrift,
  MetaDriftObservation,
  MetaDriftOwner,
  MetaDriftSeverity,
  MetaSyncState,
  Product,
} from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { priceEquals, urlEquals } from './catalog.js';
import {
  getMetaCatalogClientForTenant,
  isInvalidCatalogCursor,
  MetaCatalogApiError,
  type MetaCatalogClient,
  type MetaCatalogItemsPage,
  type MetaRemoteCatalogItem,
} from './catalogClient.js';
import {
  outboundAvailability,
  outboundBrand,
  outboundDescription,
  outboundId,
  outboundImageUrl,
  outboundLink,
  outboundPrice,
  outboundTitle,
} from './catalogOutbound.js';
import { normalizeCatalogOwnership, WRITABLE_FIELDS, type EffectiveOwnership, type WritableField } from './catalogOwnership.js';
import { declaredCatalogId, declaredExternalGovernance, normalizeCatalogSyncConfig } from './catalogSyncConfig.js';
import { effectiveMetaSyncState, verificationTtlMs, VERIFICATION_MAX_TTL_MS } from './catalogVerificationState.js';

// ---------------------------------------------------------------------------
// 1) Propiedad por campo aplicada a la comparación
// ---------------------------------------------------------------------------

/**
 * Quién gobierna ESTE campo hoy. La propiedad **no se infiere** (ADR-0015 §3): un campo que
 * nadie declaró queda `unknown` y su divergencia jamás se atribuye a nosotros.
 *
 * La única "inferencia" es la del modelo `external_managed` sano, donde el propio modelo
 * declara que la fuente externa gobierna los campos públicos: sin esto, un feed que publica
 * un campo que no enumeró dejaría el producto en verde. Con la propiedad DEGRADADA
 * (fail-closed nivel 2) no se asume nada: `unknown`.
 */
export function fieldOwner(own: EffectiveOwnership, field: WritableField): MetaDriftOwner {
  if (own.writable.includes(field)) return 'vendeyapy';
  if (own.external.includes(field)) return 'external';
  if (own.degraded) return 'unknown';
  if (own.model === 'external_managed') return 'external';
  return 'unknown';
}

/**
 * Campos cuya divergencia impide afirmar precio/stock y cerrar una venta (ADR-0015 §8). El
 * resto es cosmético: genera advertencia administrativa, no corta la conversación.
 */
const COMMERCIAL_FIELDS: readonly WritableField[] = ['price', 'currency', 'availability', 'inventory'];

export const driftSeverityOf = (field: WritableField): MetaDriftSeverity =>
  COMMERCIAL_FIELDS.includes(field) ? 'commercial' : 'cosmetic';

// ---------------------------------------------------------------------------
// 2) Comparación campo por campo (PURA)
// ---------------------------------------------------------------------------

/**
 * Por qué un campo NO se pudo comparar. Es un tipo cerrado a propósito: esto termina explicándole
 * a una persona por qué su producto no está verificado, y "no sé" no es una respuesta.
 */
export type FieldUncomparableReason =
  /** El contrato de LECTURA de Meta no expone el campo (stock, categoría): jamás se finge. */
  | 'not_exposed'
  /** Meta devolvió el campo vacío. */
  | 'remote_empty'
  /** Meta devolvió algo que NO se puede leer como ese campo (un precio sin un solo dígito). */
  | 'remote_unreadable'
  /** El valor local está vacío: no lo administramos, así que no puede "diferir". */
  | 'local_absent';

/** Campo que no se pudo comparar, con su motivo. */
export interface UncomparableField {
  field: WritableField;
  reason: FieldUncomparableReason;
}

/** Resultado de comparar UN campo. `comparable:false` ⇒ no hay evidencia, no hay veredicto. */
interface FieldComparison {
  comparable: boolean;
  equal: boolean;
  local: string;
  remote: string;
  /** Presente SOLO cuando `comparable` es false. */
  reason?: FieldUncomparableReason;
}

const sinComparar = (reason: FieldUncomparableReason): FieldComparison => ({ comparable: false, equal: true, local: '', remote: '', reason });
const cmp = (equal: boolean, local: string, remote: string): FieldComparison => ({ comparable: true, equal, local, remote });

/**
 * Compara un campo público local contra lo que Meta DEVUELVE. Las derivaciones locales son
 * las MISMAS del serializador de escritura y las comparaciones (precio, URL) las mismas del
 * diff del plan: si acá se comparara distinto, el plan diría "sin cambios" y el estado diría
 * `drifted` sobre el mismo campo.
 */
function compareField(field: WritableField, p: Product, r: MetaRemoteCatalogItem): FieldComparison {
  switch (field) {
    case 'title':
      return cmp(outboundTitle(p) === r.name, outboundTitle(p), r.name);
    case 'description':
      return cmp(outboundDescription(p) === r.description, outboundDescription(p), r.description);
    case 'price': {
      // Sin precio remoto no hay nada que comparar: afirmar deriva desde una lectura vacía
      // sería inventarla (y para el bot, cortar ventas por un dato que Meta no devolvió).
      // Se distingue "vino vacío" de "vino ilegible" porque no es lo mismo para quien lo lee:
      // el cliente mapea `price: String(raw.price ?? '')`, así que si el contrato de lectura
      // cambiara de forma (un objeto) llegaría acá un "[object Object]" sin un solo dígito.
      const remota = String(r.price ?? '').trim();
      if (!remota) return sinComparar('remote_empty');
      if (!/\d/.test(remota)) return sinComparar('remote_unreadable');
      return cmp(priceEquals(outboundPrice(p), r.price), outboundPrice(p), r.price);
    }
    case 'currency': {
      const remota = (r.currency ?? '').trim().toUpperCase();
      if (!remota) return sinComparar('remote_empty'); // Meta no siempre expone la moneda del artículo
      return cmp(remota === String(p.currency ?? '').toUpperCase(), String(p.currency ?? ''), remota);
    }
    case 'availability': {
      const remota = (r.availability ?? '').trim();
      if (!remota) return sinComparar('remote_empty');
      return cmp(outboundAvailability(p) === remota, outboundAvailability(p), remota);
    }
    case 'brand': {
      // Espejo del diff: una marca local vacía no se administra, así que no puede "diferir".
      const local = outboundBrand(p);
      if (!local) return sinComparar('local_absent');
      return cmp(local === r.brand, local, r.brand);
    }
    case 'image':
      return cmp(outboundImageUrl(p) === r.imageUrl, outboundImageUrl(p), r.imageUrl ?? '');
    case 'url':
      return cmp(urlEquals(outboundLink(p), r.url ?? ''), outboundLink(p), r.url ?? '');
    case 'inventory':
      // El contrato de LECTURA de Meta no expone stock: `availability` es su único proxy y
      // ya se compara aparte. Fingir que verificamos el stock sería exactamente la mentira
      // que este módulo existe para eliminar.
      return sinComparar('not_exposed');
    case 'category':
      // `categoryId` es un id interno del tenant; `product_type` remoto es una taxonomía de
      // texto. Son vocabularios distintos: compararlos fabricaría deriva en cada corrida.
      return sinComparar('not_exposed');
  }
}

// ---------------------------------------------------------------------------
// 3) Saneamiento de los valores observados
// ---------------------------------------------------------------------------

const MAX_OBSERVED_CHARS = 120;
/** Tope de campos con valores adjuntos (los `fields` siguen completos). */
const MAX_OBSERVED_FIELDS = 8;

const URL_FIELDS: readonly WritableField[] = ['image', 'url'];

/**
 * Saca caracteres de control del texto observado (un feed puede traer cualquier cosa y esto
 * se muestra en el panel). Se filtra por código en vez de con una regex de rango: el rango
 * literal en el fuente es invisible y se rompe con cualquier reformateo.
 */
const sinControles = (s: string): string =>
  [...s].filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c !== 127; }).join('');

/**
 * Valor apto para persistir/mostrar. De las URLs se guarda host + path y NADA más: la query
 * string de un feed puede llevar firma o token, y este dato termina en Firestore y en el
 * panel. Del resto se quitan los caracteres de control y se acota el largo.
 */
export function sanitizeObservedValue(field: WritableField, raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (URL_FIELDS.includes(field)) {
    try {
      const u = new URL(s);
      // Sin query, sin fragmento, sin credenciales: solo la identidad legible del recurso.
      return `${u.host}${u.pathname}`.slice(0, MAX_OBSERVED_CHARS);
    } catch {
      return '(url no interpretable)';
    }
  }
  return sinControles(s).replace(/\s+/g, ' ').slice(0, MAX_OBSERVED_CHARS);
}

// ---------------------------------------------------------------------------
// 4) Verificación de UN producto (PURA)
// ---------------------------------------------------------------------------

/**
 * Por qué no se pudo verificar. Tipado: no hay motivos libres.
 * `nothing_comparable`: el artículo SÍ se leyó, pero ninguno de los campos GESTIONADOS pudo
 * compararse (el contrato de lectura no los expone o el remoto vino sin datos).
 * `no_commercial_evidence`: se comparó algo gestionado, pero NINGÚN campo comercial
 * (precio/moneda/disponibilidad/stock). Solo se comparó texto ⇒ no se afirma nada de plata.
 */
export type VerificationUnreadableReason =
  | 'no_identity'
  | 'remote_read_failed'
  | 'other_catalog'
  | 'nothing_comparable'
  | 'no_commercial_evidence';

/**
 * Lo que el llamador OBSERVÓ del lado remoto. Es un tipo cerrado a propósito: no se puede
 * pasar `null` y obtener `verified` por descuido — la ausencia de lectura tiene que declararse.
 */
export type RemoteObservation =
  | { kind: 'found'; item: MetaRemoteCatalogItem }
  /** El barrido COMPLETO del catálogo no lo trajo: el feed lo borró o nunca existió. */
  | { kind: 'missing' }
  /**
   * El producto YA NO tiene identidad remota (le sacaron el mapping): ningún artículo puede
   * contradecirlo, así que la proyección vieja se LIMPIA. Es la salida del callejón sin salida
   * de `remote_missing` — sin esto un producto desvinculado quedaba bloqueado para siempre.
   */
  | { kind: 'unmapped' }
  | { kind: 'unreadable'; reason: VerificationUnreadableReason };

export interface VerifyProductArgs {
  product: Product;
  ownership: EffectiveOwnership;
  remote: RemoteObservation;
  now: Timestamp;
  /** Id NO SECRETO de la fuente externa reconocida (jamás su URL ni su token). */
  externalSourceId?: string | null;
}

export interface ProductVerification {
  /**
   * Estado concluido. `null` ⇒ NO hay proyección que sostener (el producto perdió su vínculo
   * remoto): el patch la BORRA en vez de dejar un `remote_missing` eterno bloqueando la venta.
   */
  state: MetaSyncState | null;
  /**
   * Momento de la LECTURA remota. `null` ⇒ no hubo lectura: el patch NO toca `metaVerifiedAt`
   * y el estado guardado envejece hasta volverse `stale` por derivación.
   */
  verifiedAt: Timestamp | null;
  drift: MetaDrift | null;
  /** Campos gestionados efectivamente comparados contra el remoto. */
  comparedFields: WritableField[];
  /** Campos gestionados que el contrato de lectura NO expone: no se fingen verificados. */
  unobservedFields: WritableField[];
  /**
   * Los MISMOS campos de `unobservedFields`, con el POR QUÉ de cada uno. Misma pareja que ya
   * usa `MetaDrift` (`fields` plano + `observed` detallado): la lista plana es la firma estable
   * y el detalle es lo que se le muestra a una persona ("el precio no se comparó porque Meta lo
   * devolvió vacío"). Sin el motivo, `unverifiable` es un veredicto sin explicación.
   */
  uncomparable: UncomparableField[];
  reason?: VerificationUnreadableReason;
}

/**
 * ¿Se comparó de verdad al menos un campo GESTIONADO? Gestionados = los que tienen dueño
 * declarado (nuestros ∪ de la fuente externa). Con la propiedad DEGRADADA nadie declaró nada,
 * así que el criterio cae a "se comparó algo": sin declaración no hay partición que exigir, y
 * exigirla dejaría a todo tenant sin migrar permanentemente `unverifiable`.
 */
export function hayGestionadoComparado(own: EffectiveOwnership, comparados: readonly WritableField[]): boolean {
  const gestionados = new Set<WritableField>([...own.writable, ...own.external]);
  if (!gestionados.size) return comparados.length > 0;
  return comparados.some((f) => gestionados.has(f));
}

/**
 * ¿Se comparó de verdad al menos un campo COMERCIAL? Es el MISMO contrato que decide la
 * severidad de la deriva y que mira el guard del bot (`COMMERCIAL_FIELDS`), no uno nuevo.
 *
 * Por qué es una condición aparte de `hayGestionadoComparado`: esa pregunta "¿hay evidencia de
 * lo que alguien declaró?", y `title` la contesta que sí. Con el remoto devolviendo `price: ''`
 * (o "[object Object]" si el contrato de lectura cambia de forma) y `availability: ''` —y con
 * `inventory`/`category` no comparables POR DISEÑO— el producto salía `verified` con fecha
 * fresca habiendo comparado SOLO texto: el panel lo pintaba "coincide con lo publicado" y el
 * bot cotizaba un precio que nadie verificó. Fail-closed sobre lo que compromete plata.
 */
export function hayComercialComparado(comparados: readonly WritableField[]): boolean {
  return comparados.some((f) => COMMERCIAL_FIELDS.includes(f));
}

/**
 * ¿El producto tiene ALGUNA identidad contra Meta? Las dos cuentan: `metaRetailerId` (o su forma
 * saliente, el SKU) y el `metaProductItemId` del vínculo manual legacy. Mirar solo la primera
 * dejaba a un producto vinculado a mano sin retailer id como "sin identidad" ⇒ `unverifiable`
 * permanente, que es exactamente lo que apaga su venta automática para siempre.
 */
export const tieneIdentidadRemota = (p: Product): boolean => !!outboundId(p) || !!(p.metaProductItemId ?? '').trim();

/**
 * Estado ACTUAL de un producto contra el snapshot remoto.
 *
 * `verified` exige (a) una lectura remota real, (b) que se haya comparado de verdad al menos un
 * campo GESTIONADO, (c) que se haya comparado de verdad al menos un campo COMERCIAL —lo que
 * compromete plata no se afirma desde una coincidencia de texto— y (d) que TODOS los comparados
 * coincidan, no solo los nuestros: un campo gobernado por la fuente externa que difiere del
 * local es justamente el caso Odyssey (₲250.000 local contra ₲130.000 remoto), y se reporta como
 * `drifted_external` porque la corrección vive EN EL ORIGEN del feed, no escribiendo en Meta.
 *
 * Los campos que no se pudieron comparar quedan enumerados en `unobservedFields` y explicados en
 * `uncomparable`: se declaran no comparables, jamás se cuentan como verificados.
 */
export function verifyProduct(args: VerifyProductArgs): ProductVerification {
  const { product, ownership, remote, now } = args;

  // SALIDA del callejón sin salida: el producto perdió su vínculo con Meta. Nada publicado
  // puede contradecirlo, así que la proyección vieja (típicamente `remote_missing`, que caduca
  // a `stale` y bloquea la venta para siempre) se borra. No es afirmar algo del remoto: es
  // dejar de afirmarlo. Va ANTES del chequeo de identidad porque justamente no la tiene.
  if (remote.kind === 'unmapped') {
    return { state: null, verifiedAt: null, drift: null, comparedFields: [], unobservedFields: [], uncomparable: [] };
  }

  // Sin NINGUNA identidad remota no hay nada que comparar (y jamás se adivina cuál sería).
  if (!tieneIdentidadRemota(product)) {
    return { state: 'unverifiable', verifiedAt: null, drift: null, comparedFields: [], unobservedFields: [], uncomparable: [], reason: 'no_identity' };
  }
  if (remote.kind === 'unreadable') {
    // No se leyó: NO se toca `metaVerifiedAt` ni la deriva previa. La evidencia vieja se
    // conserva y caduca sola; sobrescribirla con optimismo sería el bug original.
    return { state: 'unverifiable', verifiedAt: null, drift: null, comparedFields: [], unobservedFields: [], uncomparable: [], reason: remote.reason };
  }
  if (remote.kind === 'missing') {
    // Ausencia OBSERVADA en un barrido completo: es una verificación válida (por eso sella
    // `verifiedAt`), no un error. Nunca borra el producto ni su lock: eso lo decide una persona.
    return { state: 'remote_missing', verifiedAt: now, drift: null, comparedFields: [], unobservedFields: [], uncomparable: [] };
  }

  const item = remote.item;
  const comparedFields: WritableField[] = [];
  const unobservedFields: WritableField[] = [];
  const uncomparable: UncomparableField[] = [];
  const observed: MetaDriftObservation[] = [];
  const fields: string[] = [];
  let hayPropio = false;
  let hayAjenoDesconocido = false;
  let hayExterno = false;
  let severity: MetaDriftSeverity = 'cosmetic';

  for (const field of WRITABLE_FIELDS) {
    const c = compareField(field, product, item);
    if (!c.comparable) {
      unobservedFields.push(field);
      uncomparable.push({ field, reason: c.reason ?? 'not_exposed' });
      continue;
    }
    comparedFields.push(field);
    if (c.equal) continue;
    const owner = fieldOwner(ownership, field);
    if (owner === 'vendeyapy') hayPropio = true;
    else if (owner === 'external') hayExterno = true;
    else hayAjenoDesconocido = true;
    const sev = driftSeverityOf(field);
    if (sev === 'commercial') severity = 'commercial';
    fields.push(field);
    if (observed.length < MAX_OBSERVED_FIELDS) {
      observed.push({
        field,
        local: sanitizeObservedValue(field, c.local),
        remote: sanitizeObservedValue(field, c.remote),
        owner,
        severity: sev,
      });
    }
  }

  /**
   * Sin evidencia no hay veredicto. La fecha SÍ se sella: el artículo se leyó de verdad (solo
   * que no había nada que comparar). Sin ese sello, la fase de faltantes vería el producto como
   * "no visto por este barrido" y lo acusaría de `remote_missing` estando publicado. No fabrica
   * ningún verde: `unverifiable` se respeta tal cual en lectura, caduque o no, y el guard del
   * bot lo trata como bloqueante.
   */
  const sinEvidencia = (reason: VerificationUnreadableReason): ProductVerification => ({
    state: 'unverifiable',
    verifiedAt: now,
    drift: null,
    comparedFields,
    unobservedFields,
    uncomparable,
    reason,
  });

  // (1) NINGÚN campo GESTIONADO se pudo comparar ⇒ `unverifiable`, JAMÁS `verified`.
  // `compareField` nunca compara `inventory` ni `category`, y tampoco price/currency/
  // availability/brand cuando el remoto no los trae. Sin este corte, un producto cuya partición
  // gestionada fuera justamente la no comparable (p. ej. hybrid con `price` e `inventory`
  // nuestros y el remoto sin precio) salía `verified` porque el título coincidía. Va ANTES del
  // veredicto de deriva porque es fail-closed — una divergencia cosmética no alcanza para
  // afirmar lo comercial.
  if (!hayGestionadoComparado(ownership, comparedFields)) return sinEvidencia('nothing_comparable');

  // (2) Se comparó algo gestionado, pero NADA comercial ⇒ tampoco alcanza. Es una condición
  // independiente de (1): con `external_managed` TODOS los públicos son gestionados, así que
  // `title` solo ya pasaba (1) y el producto quedaba verde sin que nadie hubiera mirado precio,
  // moneda ni disponibilidad. Lo que se afirma con eso es texto, y el bot cotiza plata.
  if (!hayComercialComparado(comparedFields)) return sinEvidencia('no_commercial_evidence');

  // `verified` cubre EXACTAMENTE los campos comparados; los demás quedan enumerados en
  // `unobservedFields` / `uncomparable` (no se fingen verificados, se declaran y se explican).
  if (!fields.length) {
    return { state: 'verified', verifiedAt: now, drift: null, comparedFields, unobservedFields, uncomparable };
  }

  // Dueño AGREGADO: si alguno de los campos divergentes es NUESTRO, la deriva es nuestra
  // (la arregla una escritura, cuando la propiedad lo permita). Si todos son de la fuente
  // externa, es de ella. Mezcla con campos sin dueño declarado ⇒ `unknown`: no se inventa.
  const owner: MetaDriftOwner = hayPropio ? 'vendeyapy' : hayExterno && !hayAjenoDesconocido ? 'external' : 'unknown';
  // `drifted` SOLO si el campo que difiere es nuestro. Todo lo demás —externo o sin dueño
  // declarado— es `drifted_external`: no se corrige escribiendo en Meta.
  const state: MetaSyncState = hayPropio ? 'drifted' : 'drifted_external';
  return {
    state,
    verifiedAt: now,
    drift: {
      fields: [...fields].sort(),
      owner,
      severity,
      detectedAt: now,
      lastSeenAt: now,
      observed,
      externalSourceId: args.externalSourceId ?? null,
    },
    comparedFields,
    unobservedFields,
    uncomparable,
  };
}

/** Firma de una deriva: mismos campos, mismo dueño, misma severidad ⇒ MISMO incidente. */
export const driftSignature = (d: MetaDrift | null | undefined): string =>
  d ? `${[...(d.fields ?? [])].sort().join('|')}::${d.owner}::${d.severity}` : '';

/**
 * Conserva `detectedAt` cuando la deriva vigente es la misma que la anterior. Es lo que
 * impide que una corrida diaria re-feche (y por lo tanto re-alerte) el mismo incidente:
 * cambian los valores observados y `lastSeenAt`, no el "desde cuándo".
 */
export function mergeDrift(previous: MetaDrift | null | undefined, next: MetaDrift | null): MetaDrift | null {
  if (!next) return null;
  if (!previous || driftSignature(previous) !== driftSignature(next)) return next;
  return { ...next, detectedAt: previous.detectedAt ?? next.detectedAt };
}

/**
 * Patch de producto de la verificación. Toca EXACTAMENTE tres campos y ninguno más: jamás
 * `metaSyncStatus` (histórico), jamás `metaLastSyncAt` (última escritura confirmada), jamás
 * precio/stock/status/mapping/`updatedAt` — esto no es una edición humana.
 */
export function buildVerificationPatch(v: ProductVerification, previousDrift?: MetaDrift | null): Record<string, unknown> {
  if (v.state === null) {
    // Producto sin vínculo remoto: se limpia la proyección ENTERA. Sin esto, un
    // `remote_missing` sobrevive al desvínculo, caduca a `stale` y apaga la venta automática
    // de ese producto para siempre. Sigue tocando SOLO los tres campos del eje actual.
    return { metaSyncState: null, metaVerifiedAt: null, metaDrift: null };
  }
  if (v.state === 'unverifiable') {
    // Sin lectura no se sella fecha ni se limpia la deriva conocida. Si el artículo SÍ se leyó
    // (nada gestionado era comparable), se sella la fecha —evidencia de que este barrido lo
    // vio, para que la fase de faltantes no lo acuse— pero la deriva previa se conserva: no
    // comparamos nada, así que no podemos ni confirmarla ni desmentirla.
    return v.verifiedAt ? { metaSyncState: 'unverifiable', metaVerifiedAt: v.verifiedAt } : { metaSyncState: 'unverifiable' };
  }
  return {
    metaSyncState: v.state,
    metaVerifiedAt: v.verifiedAt,
    metaDrift: mergeDrift(previousDrift, v.drift),
  };
}

/** true si el estado (y la deriva) del producto ya son los que la verificación concluyó. */
export function verificationIsUnchanged(current: Pick<Product, 'metaSyncState' | 'metaDrift'>, v: ProductVerification): boolean {
  if ((current.metaSyncState ?? null) !== v.state) return false;
  // `unverifiable` NO toca la deriva guardada: compararla contra la de la verificación (que
  // es null por definición) reportaría un cambio que la escritura ni siquiera hace.
  if (v.state === 'unverifiable') return true;
  return driftSignature(current.metaDrift) === driftSignature(v.drift);
}

// ---------------------------------------------------------------------------
// 5) Caducidad DERIVADA en lectura (`stale` jamás se persiste)
// ---------------------------------------------------------------------------

/**
 * La derivación de caducidad se MUDÓ a `catalogVerificationState.ts` y se re-exporta acá para
 * que ningún importador cambie. Motivo: son funciones puras que también necesita la proyección
 * de deriva, y esa se cablea en el arranque de TODAS las Cloud Functions — importarlas de este
 * módulo le arrastraba la reconciliación entera y el cliente HTTP del catálogo (axios) al cold
 * start de funciones que ni tocan el catálogo. La lógica es UNA sola, allá.
 */
export { VERIFICATION_MAX_TTL_MS, verificationTtlMs, effectiveMetaSyncState };

// ---------------------------------------------------------------------------
// 6) Reconciliación PERIÓDICA (paginada, idempotente, reanudable, tenant-scoped)
// ---------------------------------------------------------------------------

export const emptyVerificationCounters = (): MetaCatalogVerificationCounters => ({
  remoteItems: 0,
  matched: 0,
  remoteOnly: 0,
  verified: 0,
  drifted: 0,
  driftedExternal: 0,
  remoteMissing: 0,
  unverifiable: 0,
  unchanged: 0,
  cursorResets: 0,
  errors: 0,
});

/** Desenlace de escribir el estado de UN producto. `skipped` = el guard lo descartó. */
export type VerificationWriteOutcome = 'written' | 'unchanged' | 'skipped' | 'missing' | 'error';

export interface VerificationWriteResult {
  outcome: VerificationWriteOutcome;
  /**
   * Estado concluido sobre el doc FRESCO (lo que se contabiliza). Ausente con
   * 'missing'/'skipped'/'error': ahí no hay veredicto que contar. `null` ⇒ la proyección se
   * limpió (producto desvinculado): tampoco hay estado que contar.
   */
  state?: MetaSyncState | null;
  /** Detalle SANEADO (solo con outcome 'error'). */
  error?: string;
}

export interface VerificationProgressPatch {
  status: 'running' | 'completed';
  phase: MetaCatalogVerificationPhase;
  cursor: string | null;
  localCursor: string | null;
  pagesDone: number;
  counters: MetaCatalogVerificationCounters;
  /** Época del barrido vigente (se reinicia si el cursor remoto se resetea). */
  sweepStartedAtMs: number;
  missingDetectionSkipped: boolean;
  lastError?: string;
}

/**
 * Índice de productos MAPEADOS por sus DOS identidades remotas. Los dos mapas son DISJUNTOS por
 * construcción (`byItemId` solo lleva los que NO tienen retailer id), así que un artículo remoto
 * resuelve a lo sumo un producto y un producto con las dos identidades no se procesa dos veces.
 */
export interface MappedProductIndex {
  /** Identidad primaria: la que publica el feed y la que usa el contrato de escritura. */
  byRetailerId: Map<string, Product>;
  /**
   * Vínculo manual LEGACY: `confirmMapping` podía dejar solo `metaProductItemId`. Sin este mapa
   * esos productos no entraban en NINGUNA fase de la reconciliación y se quedaban con la semilla
   * `unverifiable` de la migración corrida tras corrida — venta automática apagada para siempre.
   */
  byItemId: Map<string, Product>;
}

/**
 * Costura de persistencia. La implementación real escribe en Firestore; los tests inyectan
 * una en memoria. NINGÚN método escribe en Meta, borra productos o locks, ni toca campos
 * fuera de `metaSyncState`/`metaVerifiedAt`/`metaDrift`.
 */
export interface VerificationStore {
  /**
   * Productos MAPEADOS — importados **y vinculados manualmente**, por retailer id o por item id.
   * Este es el agujero que dejó ciego a Odyssey: el import clasificaba los vinculados como
   * `already_linked` y ni los comparaba.
   */
  loadMappedIndex(): Promise<MappedProductIndex>;
  /**
   * Aplica el estado verificado. Transaccional: `verify` recibe el doc FRESCO (mismo patrón
   * que el backfill del mantenimiento), así un producto editado entre la lectura remota y la
   * escritura se compara con su valor NUEVO y no se le cuelga una deriva ya resuelta. Además
   * conserva el `detectedAt` de la deriva vigente y respeta `guardVerifiedBeforeMs`: si el
   * producto se verificó DESPUÉS del inicio del barrido, otro camino ya lo vio y no se lo
   * marca como faltante.
   */
  applyState(
    productId: string,
    verify: (fresh: Product) => ProductVerification,
    guardVerifiedBeforeMs?: number,
  ): Promise<VerificationWriteResult>;
  /** Página de productos local ordenada por id (para detectar los que el barrido no tocó). */
  listProductsPage(cursor: string | null, pageSize: number): Promise<{ products: Product[]; nextCursor: string | null }>;
  /** Persiste fase + cursores + contadores DESPUÉS de cada página. */
  saveProgress(patch: VerificationProgressPatch): Promise<void>;
}

export interface RunVerificationArgs {
  tenantId: string;
  catalogId: string;
  ownership: EffectiveOwnership;
  client: Pick<MetaCatalogClient, 'listItemsPage'>;
  store: VerificationStore;
  /** Estado reanudado de la corrida. */
  phase: MetaCatalogVerificationPhase;
  cursor: string | null;
  localCursor: string | null;
  counters: MetaCatalogVerificationCounters;
  pagesDone: number;
  sweepStartedAtMs: number;
  missingDetectionSkipped: boolean;
  lastError?: string;
  /** Presupuesto de páginas de ESTA invocación (un error de página también consume). */
  maxPages: number;
  pageSize?: number;
  externalSourceId?: string | null;
  now?: () => Timestamp;
}

export interface RunVerificationResult {
  status: 'running' | 'completed';
  phase: MetaCatalogVerificationPhase;
  cursor: string | null;
  localCursor: string | null;
  pagesDone: number;
  counters: MetaCatalogVerificationCounters;
  sweepStartedAtMs: number;
  missingDetectionSkipped: boolean;
  stopReason?: 'pages_budget' | 'remote_error';
  lastError?: string;
}

const DEFAULT_PAGE_SIZE = 200;

/**
 * Corre (o reanuda) la reconciliación. Dos fases:
 *
 *  · `remote`  — pagina el catálogo remoto COMPLETO (solo GET) y verifica cada artículo que
 *                corresponde a un producto mapeado. Los remotos sin producto local se CUENTAN.
 *  · `missing` — barre los productos mapeados que la fase remota no tocó (comparando contra
 *                la época del barrido) y los marca `remote_missing` — o `unverifiable` si su
 *                `metaCatalogId` apunta a OTRO catálogo, porque ahí no leímos nada.
 *
 * La fase `missing` se SALTEA si la remota tuvo errores de escritura: sin evidencia completa
 * no se declara que un artículo desapareció. Idempotente: re-verificar un producto ya
 * verificado reescribe el mismo estado (contado como `unchanged`) y conserva el `detectedAt`
 * de la deriva. No emite alertas por producto: la deriva ES el estado, y una corrida diaria
 * que avisara por cada producto duplicaría el mismo aviso todos los días.
 */
export async function runVerificationPages(args: RunVerificationArgs): Promise<RunVerificationResult> {
  const now = args.now ?? (() => Timestamp.now());
  const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
  const counters = { ...args.counters };
  let phase = args.phase;
  let cursor = args.cursor;
  let localCursor = args.localCursor;
  let pagesDone = args.pagesDone;
  let sweepStartedAtMs = args.sweepStartedAtMs;
  let missingDetectionSkipped = args.missingDetectionSkipped;
  // El lastError se HEREDA: una reanudación sin errores nuevos no lo borra.
  let lastError = (args.lastError ?? '').trim();

  // El índice se carga SOLO si esta invocación va a mirar el catálogo remoto: una reanudación
  // que arranca ya en la fase de faltantes no necesita releer todo el catálogo local.
  let index: MappedProductIndex | null = null;
  const mapeados = async (): Promise<MappedProductIndex> => {
    if (!index) index = await args.store.loadMappedIndex();
    return index;
  };

  const resultado = (extra: Partial<RunVerificationResult> & { status: 'running' | 'completed' }): RunVerificationResult => ({
    phase,
    cursor,
    localCursor,
    pagesDone,
    counters,
    sweepStartedAtMs,
    missingDetectionSkipped,
    ...(lastError ? { lastError } : {}),
    ...extra,
  });

  const contarEstado = (state: MetaSyncState): void => {
    if (state === 'verified') counters.verified++;
    else if (state === 'drifted') counters.drifted++;
    else if (state === 'drifted_external') counters.driftedExternal++;
    else if (state === 'remote_missing') counters.remoteMissing++;
    else counters.unverifiable++;
  };

  /**
   * Verifica y persiste UN producto. La comparación se rehace sobre el doc FRESCO dentro de
   * la transacción: entre la lectura remota y la escritura alguien pudo corregir el precio
   * local, y colgarle una deriva ya resuelta sería tan falso como el `synced` de antes.
   */
  const aplicar = async (product: Product, remote: RemoteObservation, guardMs?: number): Promise<void> => {
    const r = await args.store.applyState(
      product.id,
      (fresh) =>
        verifyProduct({
          product: fresh,
          ownership: args.ownership,
          remote,
          now: now(),
          externalSourceId: args.externalSourceId ?? null,
        }),
      guardMs,
    );
    if (r.outcome === 'error') {
      counters.errors++;
      lastError = `No se pudo actualizar el estado de ${product.id}: ${r.error ?? 'error de transacción'}`.slice(0, 300);
      return;
    }
    // 'missing' (el producto desapareció entre el índice y la escritura) y 'skipped' (otro
    // camino lo verificó después del inicio del barrido) no se cuentan como estado nuevo.
    if (r.outcome === 'missing' || r.outcome === 'skipped' || !r.state) return;
    if (r.outcome === 'unchanged') counters.unchanged++;
    contarEstado(r.state);
  };

  const guardar = async (status: 'running' | 'completed'): Promise<void> => {
    await args.store.saveProgress({
      status,
      phase,
      cursor,
      localCursor,
      pagesDone,
      counters,
      sweepStartedAtMs,
      missingDetectionSkipped,
      lastError,
    });
  };

  for (let intento = 0; intento < args.maxPages; intento++) {
    if (phase === 'done') break;

    if (phase === 'remote') {
      let page: MetaCatalogItemsPage;
      try {
        page = await args.client.listItemsPage(args.catalogId, cursor);
      } catch (e) {
        if (isInvalidCatalogCursor(e)) {
          // Cursor vencido/adulterado: se reinicia el barrido. La época TAMBIÉN se reinicia:
          // si no, los productos vistos antes del reset contarían como "vistos" y un artículo
          // borrado por el feed se escaparía de la detección de faltantes.
          counters.cursorResets++;
          cursor = null;
          sweepStartedAtMs = now().toMillis();
          await guardar('running');
          continue; // el reset consume presupuesto: un cursor siempre inválido no loopea
        }
        const detalle = e instanceof MetaCatalogApiError ? e.message.slice(0, 300) : 'No se pudo leer el catálogo de Meta.';
        lastError = detalle;
        await guardar('running');
        // Sin lectura no se toca NINGÚN estado: los productos no verificados envejecen y la
        // derivación los muestra `stale`. Eso es la caducidad haciendo su trabajo.
        return resultado({ status: 'running', stopReason: 'remote_error' });
      }

      const idx = await mapeados();
      for (const item of page.items) {
        counters.remoteItems++;
        const rid = (item.retailerId ?? '').trim();
        const itemId = (item.id ?? '').trim();
        // Se resuelve por retailer id y, si no, por el ITEM ID de Meta. La segunda identidad es
        // la de los vinculados a mano por el camino legacy: sin ella el artículo se contaba como
        // `remoteOnly` y su producto local no se comparaba nunca. Los mapas son disjuntos, así
        // que un producto con las dos identidades entra por la primera y una sola vez.
        const producto = (rid ? idx.byRetailerId.get(rid) : undefined) ?? (itemId ? idx.byItemId.get(itemId) : undefined);
        if (!producto) {
          counters.remoteOnly++; // artículo remoto sin producto local mapeado: solo se cuenta
          continue;
        }
        counters.matched++;
        await aplicar(producto, { kind: 'found', item });
      }

      cursor = page.nextCursor;
      pagesDone++;
      if (cursor === null) {
        // Barrido remoto completo. La detección de faltantes exige evidencia COMPLETA: con
        // errores de escritura, un producto podría figurar "no visto" solo porque su
        // escritura falló — y marcarlo `remote_missing` sería una acusación falsa.
        if (counters.errors > 0) {
          missingDetectionSkipped = true;
          phase = 'done';
        } else {
          phase = 'missing';
          localCursor = null;
        }
      }
      await guardar(phase === 'done' ? 'completed' : 'running');
      if (phase === 'done') return resultado({ status: 'completed' });
      continue;
    }

    // ── Fase `missing`: productos mapeados que el barrido remoto NO tocó ──
    const page = await args.store.listProductsPage(localCursor, pageSize);
    for (const p of page.products) {
      const rid = (p.metaRetailerId ?? '').trim();
      const itemId = (p.metaProductItemId ?? '').trim();
      if (!rid && !itemId) {
        // SIN NINGUNA identidad: nunca estuvo en Meta… salvo que la haya PERDIDO. Un producto al
        // que le sacaron el mapping arrastra su `metaSyncState` viejo (típicamente
        // `remote_missing`), que caduca a `stale` y bloquea su venta automática para siempre.
        // Ese es el camino de SALIDA: se limpia la proyección, porque ya no hay artículo
        // publicado que pueda contradecirnos. Si no arrastra nada, no hay nada que hacer.
        const arrastra = !!p.metaSyncState || !!p.metaVerifiedAt || !!p.metaDrift;
        if (!arrastra) continue;
        await aplicar(p, { kind: 'unmapped' }, sweepStartedAtMs);
        continue;
      }
      // Con CUALQUIERA de las dos identidades el producto entra a la detección de faltantes. Antes
      // los vinculados solo por item id se salteaban acá (y tampoco entraban por la fase remota):
      // quedaban trabados en `unverifiable` para siempre. Si el barrido COMPLETO no lo trajo por
      // ninguna de sus identidades, el dato observado es `remote_missing` — no un "no sé" eterno.
      const visto = p.metaVerifiedAt?.toMillis?.() ?? 0;
      if (visto >= sweepStartedAtMs) continue; // ya lo verificó ESTE barrido
      // Producto vinculado a OTRO catálogo: no leímos ese catálogo, así que no podemos decir
      // que el artículo no existe. `unverifiable` es la única respuesta honesta.
      const otroCatalogo = !!p.metaCatalogId && p.metaCatalogId !== args.catalogId;
      await aplicar(p, otroCatalogo ? { kind: 'unreadable', reason: 'other_catalog' } : { kind: 'missing' }, sweepStartedAtMs);
    }
    localCursor = page.nextCursor;
    pagesDone++;
    if (localCursor === null) phase = 'done';
    await guardar(phase === 'done' ? 'completed' : 'running');
    if (phase === 'done') return resultado({ status: 'completed' });
  }

  if (phase === 'done') {
    await guardar('completed');
    return resultado({ status: 'completed' });
  }
  return resultado({ status: 'running', stopReason: 'pages_budget' });
}

// ---------------------------------------------------------------------------
// 7) Doc del run + store real (Firestore)
// ---------------------------------------------------------------------------

/** Doc de la corrida (`tenants/{t}/metaCatalogVerificationRuns/{runId}`). Cerrado por rules. */
export interface MetaCatalogVerificationRunDoc {
  runId: string;
  tenantId: string;
  catalogId: string;
  status: 'running' | 'completed' | 'failed';
  phase: MetaCatalogVerificationPhase;
  cursor: string | null;
  localCursor: string | null;
  pagesDone: number;
  counters: MetaCatalogVerificationCounters;
  /** Época del barrido vigente: base de la detección de faltantes. */
  sweepStartedAtMs: number;
  missingDetectionSkipped: boolean;
  /**
   * Propiedad EFECTIVA fijada al run en su CREACIÓN (espejo del `profile` del import): todas
   * las páginas se evalúan con la MISMA propiedad aunque la config cambie a mitad, y así los
   * contadores de una corrida no mezclan dos criterios de dueño.
   */
  ownership: EffectiveOwnership;
  actorUid: string | null;
  /** 'callable' | 'scheduler': quién disparó la corrida (costura del scheduler). */
  trigger: string;
  lastError: string;
  /**
   * CLAIM del run: hasta cuándo esta corrida está tomada por una invocación en vuelo. Sin
   * esto, dos invocaciones simultáneas hacían read-then-create sin exclusión mutua y creaban
   * DOS corridas para el mismo tenant (o reanudaban la misma en paralelo, pisándose cursores).
   * 0 ⇒ libre. Se libera al terminar cada invocación y vence solo si el proceso murió.
   */
  leaseUntilMs?: number;
  startedAt: Timestamp;
  updatedAt: Timestamp;
  finishedAt: Timestamp | null;
}

/** Ventana del claim: cubre el timeout del callable (300 s) con margen. */
export const VERIFICATION_LEASE_MS = 6 * 60 * 1000;

/** Qué hacer con la corrida activa que se encontró (o su ausencia). PURO y testeable. */
export type VerificationClaimAction = 'create' | 'resume' | 'already_running';

/**
 * Decisión del claim (PURA). Se separa de la transacción para poder testearla sola: una
 * corrida activa con lease VIGENTE está siendo trabajada por otra invocación y no se toca;
 * con lease vencido (proceso muerto a mitad) se reanuda; sin corrida activa se crea una.
 */
export function verificationClaimDecision(
  run: Pick<MetaCatalogVerificationRunDoc, 'status' | 'leaseUntilMs'> | null | undefined,
  nowMs: number,
): VerificationClaimAction {
  if (!run || run.status !== 'running') return 'create';
  return (run.leaseUntilMs ?? 0) > nowMs ? 'already_running' : 'resume';
}

/** La corrida pedida ya está siendo trabajada por otra invocación (no es un error del usuario). */
export class CatalogVerificationAlreadyRunningError extends Error {
  constructor(readonly run: MetaCatalogVerificationRunDoc) {
    super('Ya hay una verificación de catálogo en curso para esta empresa.');
    this.name = 'CatalogVerificationAlreadyRunningError';
  }
}

export function firestoreVerificationStore(args: { tenantId: string; runId: string }): VerificationStore {
  const { tenantId, runId } = args;
  return {
    async loadMappedIndex() {
      // TODOS los productos con identidad remota: importados (docId `meta_…`) y vinculados
      // manualmente por el callable de mapping. La distinción que hacía el import acá NO
      // existe — un vínculo manual es exactamente igual de verificable.
      //
      // OJO con la semántica de `!=` de Firestore: EXCLUYE los documentos que NO TIENEN el
      // campo. Por eso hacen falta DOS consultas y no una: un producto vinculado a mano solo por
      // `metaProductItemId` no tiene `metaRetailerId`, la primera consulta jamás lo devolvía y
      // la fase de faltantes también lo salteaba ⇒ quedaba trabado en `unverifiable` para
      // siempre, con su venta automática apagada y sin nada que la levantara. Las dos consultas
      // salen de `paths.products(tenantId)`: el aislamiento por tenant es la colección misma.
      const col = db().collection(paths.products(tenantId));
      const [porRid, porItem] = await Promise.all([
        col.where('metaRetailerId', '!=', '').get(),
        col.where('metaProductItemId', '!=', '').get(),
      ]);
      const byRetailerId = new Map<string, Product>();
      for (const d of porRid.docs) {
        const p = { ...(d.data() as Product), id: d.id };
        const rid = (p.metaRetailerId ?? '').trim();
        if (rid) byRetailerId.set(rid, p);
      }
      const byItemId = new Map<string, Product>();
      for (const d of porItem.docs) {
        const p = { ...(d.data() as Product), id: d.id };
        // Disjunto a propósito: si tiene retailer id ya está en el otro mapa, y meterlo en los
        // dos permitiría que dos artículos remotos distintos resolvieran al MISMO producto.
        if ((p.metaRetailerId ?? '').trim()) continue;
        const item = (p.metaProductItemId ?? '').trim();
        if (item) byItemId.set(item, p);
      }
      return { byRetailerId, byItemId };
    },

    async listProductsPage(cursor, pageSize) {
      let q = db().collection(paths.products(tenantId)).orderBy(FieldPath.documentId()).limit(pageSize);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      const products = snap.docs.map((d) => ({ ...(d.data() as Product), id: d.id }));
      // Cursor = último id SOLO si la página vino llena (una página corta es la última).
      const nextCursor = snap.size === pageSize ? snap.docs[snap.size - 1]!.id : null;
      return { products, nextCursor };
    },

    async applyState(productId, verify, guardVerifiedBeforeMs) {
      const ref = db().doc(paths.product(tenantId, productId));
      try {
        return await db().runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) return { outcome: 'missing' as const };
          const fresh = { ...(snap.data() as Product), id: snap.id };
          if (typeof guardVerifiedBeforeMs === 'number') {
            // Otro camino lo verificó DESPUÉS del inicio del barrido: la evidencia fresca
            // gana y este marcado (que se basa en "no lo vi") se descarta.
            const visto = fresh.metaVerifiedAt?.toMillis?.() ?? 0;
            if (visto >= guardVerifiedBeforeMs) return { outcome: 'skipped' as const };
          }
          // La comparación se rehace contra el doc FRESCO: si alguien corrigió el precio
          // local mientras leíamos Meta, el veredicto es sobre el valor que hay AHORA.
          const v = verify(fresh);
          const sinCambio = verificationIsUnchanged(fresh, v);
          // `update` de campos SUELTOS: no toca `metaSyncStatus`, `metaLastSyncAt`, precio,
          // stock, status, mapping ni `updatedAt`. La reconciliación no es una edición humana.
          tx.update(ref, buildVerificationPatch(v, fresh.metaDrift ?? null));
          return { outcome: sinCambio ? ('unchanged' as const) : ('written' as const), state: v.state };
        });
      } catch (e) {
        const detalle = e instanceof Error ? e.message.slice(0, 200) : 'desconocido';
        // Se loguea el ID del producto y el motivo — nunca valores del catálogo ni URLs.
        logger.warn('Verificación de catálogo: no se pudo actualizar el estado', { tenantId, runId, productId, error: detalle });
        return { outcome: 'error', error: detalle };
      }
    },

    async saveProgress(patch) {
      const now = Timestamp.now();
      const ref = db().doc(paths.metaCatalogVerificationRun(tenantId, runId));
      await db().runTransaction(async (tx) => {
        const run = (await tx.get(ref)).data() as MetaCatalogVerificationRunDoc | undefined;
        // Guard: jamás se escribe sobre un run que ya no está `running` (una reanudación
        // lenta no resucita el cursor de una corrida ya cerrada).
        if (!run || run.status !== 'running') {
          logger.warn('Verificación de catálogo: escritura sobre un run no-running DESCARTADA', {
            tenantId,
            runId,
            status: run?.status ?? 'inexistente',
          });
          return;
        }
        // Guard monotónico: páginas y contadores jamás retroceden.
        const regresion = verificationProgressRegression(run, patch);
        if (regresion) {
          logger.error('Verificación de catálogo: escritura de progreso REGRESIVA descartada', { tenantId, runId, regresion });
          return;
        }
        tx.update(ref, {
          status: patch.status,
          phase: patch.phase,
          cursor: patch.cursor,
          localCursor: patch.localCursor,
          pagesDone: patch.pagesDone,
          counters: patch.counters,
          sweepStartedAtMs: patch.sweepStartedAtMs,
          missingDetectionSkipped: patch.missingDetectionSkipped,
          lastError: patch.lastError ?? '',
          updatedAt: now,
          ...(patch.status === 'completed' ? { finishedAt: now } : {}),
        });
      });
    },
  };
}

/**
 * Guard monotónico del progreso (PURO, espejo de `maintenanceProgressRegression`): páginas y
 * contadores JAMÁS retroceden. Los cursores no se comparan (un reset legítimo los vuelve null).
 */
export function verificationProgressRegression(
  current: { pagesDone?: number; counters?: Partial<MetaCatalogVerificationCounters> },
  patch: Pick<VerificationProgressPatch, 'pagesDone' | 'counters'>,
): string | null {
  if (patch.pagesDone < (current.pagesDone ?? 0)) return `pagesDone ${patch.pagesDone} < ${current.pagesDone}`;
  for (const [k, v] of Object.entries(current.counters ?? {})) {
    const nuevo = patch.counters[k as keyof MetaCatalogVerificationCounters];
    if (typeof v === 'number' && typeof nuevo === 'number' && nuevo < v) return `counters.${k} ${nuevo} < ${v}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 8) Orquestación REUSABLE (costura del scheduler)
// ---------------------------------------------------------------------------

/**
 * La reconciliación no se puede correr para este tenant. Es un error de PRECONDICIÓN, no un
 * fallo: un tenant sin config de catálogo (credipower) jamás toca Meta — el nivel 1 del
 * fail-closed sigue exactamente igual que antes de ADR-0015.
 */
export class CatalogVerificationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogVerificationUnavailableError';
  }
}

/** Por qué la verificación es ESTRUCTURALMENTE imposible pese a haber gobierno externo declarado. */
export type CatalogVerificationBlockReason = 'external_without_catalog';

/**
 * La reconciliación NO se puede correr y eso SÍ es un problema: alguien declaró gobierno externo
 * —o sea que el guard del bot está activo y va a bloquear la venta de los mapeados en cuanto la
 * evidencia venza— pero no hay catálogo remoto que leer, así que nada la puede refrescar.
 *
 * Es una subclase de `CatalogVerificationUnavailableError` a propósito: quien ya traducía "no se
 * puede correr" a una precondición para el usuario (el callable del panel) sigue mostrando el
 * mensaje correcto sin cambios. Lo que NO puede pasar es que se cuente como una salteada
 * silenciosa — por eso es un tipo aparte y por eso el scheduler la distingue DENTRO de esa rama.
 */
export class CatalogVerificationBlockedError extends CatalogVerificationUnavailableError {
  constructor(readonly reason: CatalogVerificationBlockReason, message: string) {
    super(message);
    this.name = 'CatalogVerificationBlockedError';
  }
}

/** Por qué no hay nada que verificar (y por lo tanto tampoco nada que avisar). */
export type CatalogVerificationSkipReason =
  /** Ni siquiera existe `catalogSync` (credipower): no se gasta una llamada ni se escribe un doc. */
  | 'no_catalog_sync'
  /**
   * Hay config, pero nadie declaró gobierno externo sobre un campo COMERCIAL ⇒ el guard está
   * inerte: nada bloquea la venta y no hay evidencia que refrescar. Incluye la declaración
   * puramente cosmética (el feed publica título/imagen), que tampoco activa el guard.
   */
  | 'no_external_governance';

/**
 * ¿Se puede (y se debe) reconciliar este tenant hoy? PURA: entra el `catalogSync` CRUDO, sale la
 * decisión. Se testea sola y no toca ni la red ni Firestore.
 */
export type CatalogVerificationEligibility =
  | {
      can: 'run';
      /** 'sync_enabled' = camino de siempre; 'external_governance' = nosotros no escribimos, pero alguien de afuera sí. */
      via: 'sync_enabled' | 'external_governance';
      catalogId: string;
      ownership: EffectiveOwnership;
    }
  | { can: 'skip'; reason: CatalogVerificationSkipReason }
  | { can: 'blocked'; reason: CatalogVerificationBlockReason; externalFields: WritableField[] };

const esObjeto = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Separa los DOS EJES que el ADR-0015 ya separó en la proyección de deriva (§8) y en el callable
 * de propiedad, y que acá seguían pegados:
 *
 *  · PERMISO DE ESCRITURA — lo sigue decidiendo el interruptor (`enabled`/`mode`), intacto.
 *  · CAPACIDAD DE VERIFICAR — la decide que exista gobierno externo DECLARADO y un catálogo
 *    remoto que leer. La reconciliación solo hace GET: no necesita permiso de escritura.
 *
 * El bug que esto elimina: con `catalogSync.enabled:false` (o `mode:'off'`) y gobierno externo
 * declarado, el guard del bot seguía ACTIVO —lee la propiedad sin pasar por el interruptor— pero
 * la reconciliación se negaba a correr. Como es el ÚNICO camino que escribe `metaVerifiedAt`, a
 * las 24 h todos los mapeados caducaban a `stale` (bloqueante) y la venta automática del catálogo
 * entero se apagaba en silencio y para siempre. La regla que queda escrita en código: **si el
 * guard está activo para un tenant, lo que refresca la evidencia también tiene que poder correr.**
 *
 * Caso `blocked` (config CONTRADICTORIA): gobierno externo declarado y ningún `catalogId` válido.
 * No hay catálogo remoto que leer, así que verificar es imposible por construcción. Se decidió
 * NO degradar la propiedad automáticamente para que el guard afloje: el ADR-0015 §4 es explícito
 * en que jamás se cambia el modelo de propiedad de forma automática —eso es decisión humana—, y
 * "apagar el guard porque no podemos verificar" es exactamente fabricar un verde sin evidencia
 * sobre un catálogo que una persona declaró que gobierna otro. Lo honesto es lo contrario:
 * mantener el bloqueo, GRITARLO (alerta administrativa idempotente + contador propio en el
 * scheduler) y darle a la persona las dos salidas reales —configurar el catálogo o retirar la
 * declaración de fuente externa—. La diferencia con el callejón sin salida que el ADR §6 prohíbe
 * es justamente esa: acá hay salida y el sistema la está pidiendo a los gritos, en vez de contar
 * el tenant como "salteado" y no decir nada.
 */
export function catalogVerificationEligibility(rawCatalogSync: unknown): CatalogVerificationEligibility {
  const cfg = normalizeCatalogSyncConfig(rawCatalogSync);
  // Camino de siempre: nuestra sync está encendida ⇒ hay catálogo y hay propiedad efectiva
  // (aunque esté degradada por nivel 2: leer y diagnosticar se puede, escribir no).
  if (cfg.enabled && cfg.catalogId) return { can: 'run', via: 'sync_enabled', catalogId: cfg.catalogId, ownership: cfg.ownership };

  // Nuestro interruptor está apagado. Eso decide si ESCRIBIMOS, no si podemos MIRAR.
  const gobierno = declaredExternalGovernance(rawCatalogSync);
  // Y la pregunta no es "¿declararon algo?" sino "¿el guard del bot está ACTIVO?", que es lo que
  // justifica gastar contra Meta. El guard se activa SOLO si la fuente externa gobierna un campo
  // COMERCIAL (`catalogDriftProjection.activa` usa este mismo contrato de campos: `COMMERCIAL_FIELDS`,
  // atado a `CAMPOS_CRITICOS` por `contratosDeDeriva.test.ts`). Con una declaración puramente
  // cosmética —el feed publica el título y la imagen— el guard queda INERTE: no bloquea ninguna
  // venta, no hay evidencia que refrescar y paginar el catálogo remoto dos veces por día sería
  // gasto sin destinatario. La regla del hallazgo B1 se lee en las DOS direcciones: si el guard
  // está activo, lo que refresca la evidencia tiene que poder correr; si NO lo está, no hay nada
  // que refrescar.
  const gobiernaLoComercial = gobierno.fields.some((f) => COMMERCIAL_FIELDS.includes(f));
  if (!esObjeto(rawCatalogSync) || !gobiernaLoComercial) {
    // Nadie declaró gobierno externo sobre lo comercial ⇒ el guard del bot está inerte ⇒ nada
    // bloquea la venta y no hay evidencia que refrescar. Se distingue "no hay config" de "hay
    // config sin gobierno externo" para saber, en el contador del scheduler, cuál es cuál.
    return { can: 'skip', reason: esObjeto(rawCatalogSync) ? 'no_external_governance' : 'no_catalog_sync' };
  }

  const catalogId = declaredCatalogId(rawCatalogSync);
  if (!catalogId) return { can: 'blocked', reason: 'external_without_catalog', externalFields: [...gobierno.fields] };

  // La propiedad se normaliza del MISMO campo `ownership` que ya miró `declaredExternalGovernance`
  // (una sola derivación). Se usa solo para clasificar de quién es cada divergencia: esta corrida
  // no escribe en Meta ni consulta `writable` como permiso.
  return { can: 'run', via: 'external_governance', catalogId, ownership: normalizeCatalogOwnership(rawCatalogSync.ownership) };
}

// ── Alerta administrativa de la config contradictoria (agregada e idempotente) ──

/** Id determinístico de la campana: UNA sola viva por tenant (mismo patrón que la de calidad). */
export const catalogVerificationNotificationId = (tenantId: string): string => `catalog-verification-${tenantId}`;

/** Lo que ya había en la campana (solo lo que la decisión necesita mirar). */
export interface VerificationAlertPrevious {
  createdAt?: Timestamp;
  resolvedAt?: Timestamp | null;
  read?: boolean;
}

/**
 * Patch de la campana (PURO). `null` ⇒ no hay nada que escribir: ni se crea un aviso vacío ni se
 * re-cierra uno ya cerrado. Espejo de `alertarFuenteDelCatalogo` y de la campana de calidad:
 * mismo hallazgo repetido ⇒ mismo documento, sin volver a saltar sobre un aviso ya leído.
 */
export function decideVerificationBlockedPatch(
  tenantId: string,
  blocked: CatalogVerificationBlockReason | null,
  prev: VerificationAlertPrevious | undefined,
  now: Timestamp,
): Record<string, unknown> | null {
  const id = catalogVerificationNotificationId(tenantId);
  if (!blocked) {
    // Se resolvió (o ya no aplica): solo se CIERRA un aviso abierto.
    if (!prev || prev.resolvedAt) return null;
    return {
      read: true,
      readAt: now,
      resolvedAt: now,
      title: '✅ Ya se puede verificar tu catálogo de Meta',
      body: 'Se resolvió la configuración que impedía comparar tus productos con lo publicado en Meta.',
    };
  }
  // Reabre solo si el aviso estaba cerrado (o no existía): el mismo hallazgo, corrida tras
  // corrida, actualiza el documento sin volver a marcarlo como no leído.
  const reabre = !prev || !!prev.resolvedAt;
  return {
    id,
    tenantId,
    category: 'catalog_verification',
    type: 'catalog_verification_blocked',
    title: '⚠️ No podemos verificar tu catálogo de Meta',
    body:
      'Declaraste que un sistema externo (por ejemplo el feed de tu sitio) publica los datos de tu catálogo, pero no hay un catálogo de Meta configurado para leer. Sin eso no podemos confirmar precio ni disponibilidad contra lo publicado y los productos vinculados no cierran venta automática. Configurá el catálogo de Meta o quitá la declaración de fuente externa.',
    dedupeKey: id,
    reason: blocked,
    resolvedAt: null,
    createdAt: prev?.createdAt ?? now,
    ...(reabre ? { read: false, readAt: null } : {}),
  };
}

/**
 * Escribe (o cierra) la campana de "no se puede verificar". Best-effort: si falla, el bloqueo ya
 * se reportó igual por el error tipado y por el contador del scheduler — la visibilidad no
 * depende de un solo canal.
 */
export async function alertarVerificacionImposible(tenantId: string, blocked: CatalogVerificationBlockReason | null): Promise<void> {
  try {
    const ref = db().doc(paths.notification(tenantId, catalogVerificationNotificationId(tenantId)));
    const prev = (await ref.get()).data() as VerificationAlertPrevious | undefined;
    const patch = decideVerificationBlockedPatch(tenantId, blocked, prev, Timestamp.now());
    if (!patch) return;
    await ref.set(patch, { merge: true });
  } catch (e) {
    logger.warn('No se pudo actualizar el aviso de verificación de catálogo', {
      tenantId,
      error: e instanceof Error ? e.message.slice(0, 200) : 'desconocido',
    });
  }
}

/**
 * ENCOLA la primera corrida de reconciliación SIN leer Meta ni gastar una sola llamada: crea
 * el doc del run (con el claim libre) para que la próxima corrida programada —o el panel— lo
 * reanude.
 *
 * Por qué el apply de la migración lo necesita (ADR-0015 §5 + §9): la migración no lee Meta, así
 * que siembra `unverifiable` y NO sella `metaVerifiedAt`. Sin una verificación en camino todo el
 * catálogo nace vencido y `stale`/`unverifiable` bloquean la venta automática hasta que alguien
 * se acuerde de correr el barrido a mano. Encolar la corrida hace que la primera lectura real
 * ocurra sola, sin darle a la migración un permiso que no tiene (afirmar el presente).
 *
 * Idempotente: si ya hay una corrida activa devuelve esa y no crea otra.
 */
export async function enqueueCatalogVerificationRun(args: {
  tenantId: string;
  catalogId: string;
  ownership: EffectiveOwnership;
  actorUid?: string | null;
  trigger?: string;
  now?: () => Timestamp;
}): Promise<{ runId: string; created: boolean }> {
  const { tenantId } = args;
  const now = args.now ?? (() => Timestamp.now());
  const runsCol = db().collection(paths.metaCatalogVerificationRuns(tenantId));
  return db().runTransaction(async (tx) => {
    // La query va DENTRO de la transacción, igual que el claim: dos applies simultáneos no
    // pueden dejar dos corridas activas del mismo tenant.
    const activo = await tx.get(runsCol.where('status', '==', 'running').limit(1));
    const previo = activo.docs[0]?.data() as MetaCatalogVerificationRunDoc | undefined;
    if (previo) return { runId: previo.runId, created: false };
    const ref = runsCol.doc();
    const t = now();
    const run: MetaCatalogVerificationRunDoc = {
      runId: ref.id,
      tenantId,
      catalogId: args.catalogId,
      status: 'running',
      phase: 'remote',
      cursor: null,
      localCursor: null,
      pagesDone: 0,
      counters: emptyVerificationCounters(),
      sweepStartedAtMs: t.toMillis(),
      missingDetectionSkipped: false,
      ownership: args.ownership,
      actorUid: args.actorUid ?? null,
      trigger: args.trigger ?? 'migration',
      lastError: '',
      // Claim LIBRE: nadie la está trabajando todavía; el primer llamador la reclama.
      leaseUntilMs: 0,
      startedAt: t,
      updatedAt: t,
      finishedAt: null,
    };
    tx.create(ref, run as unknown as Record<string, unknown>);
    return { runId: ref.id, created: true };
  });
}

/**
 * Libera el claim de la corrida. Best-effort y silencioso: si falla, el lease vence solo y la
 * próxima invocación reanuda igual. Jamás resucita un run que ya no está `running`.
 */
async function releaseVerificationLease(tenantId: string, runId: string): Promise<void> {
  try {
    const ref = db().doc(paths.metaCatalogVerificationRun(tenantId, runId));
    await db().runTransaction(async (tx) => {
      const run = (await tx.get(ref)).data() as MetaCatalogVerificationRunDoc | undefined;
      if (!run || run.status !== 'running') return;
      tx.update(ref, { leaseUntilMs: 0 });
    });
  } catch (e) {
    logger.warn('Verificación de catálogo: no se pudo liberar el claim de la corrida', {
      tenantId,
      runId,
      error: e instanceof Error ? e.message.slice(0, 200) : 'desconocido',
    });
  }
}

export interface CatalogVerificationRunOptions {
  tenantId: string;
  actorUid?: string | null;
  /** Quién dispara: 'callable' (owner) o 'scheduler'. Solo para trazabilidad del run. */
  trigger?: 'callable' | 'scheduler';
  /** Reanudar ESTA corrida. Sin valor, se reanuda la corrida activa del tenant (si la hay). */
  runId?: string;
  maxPages: number;
  /** Período de la fuente externa, si se conoce: acota el TTL de caducidad informado. */
  externalPeriodMs?: number | null;
  client?: Pick<MetaCatalogClient, 'listItemsPage'>;
  now?: () => Timestamp;
}

export interface CatalogVerificationRunOutcome {
  runId: string;
  status: 'running' | 'completed';
  phase: MetaCatalogVerificationPhase;
  pagesDone: number;
  counters: MetaCatalogVerificationCounters;
  hasCursor: boolean;
  missingDetectionSkipped: boolean;
  ttlMs: number;
  stopReason?: 'pages_budget' | 'remote_error';
  lastError?: string;
}

/**
 * Corre o reanuda la reconciliación de UN tenant. Sin `runId` reanuda la corrida activa (hay
 * como mucho una) y, si no hay ninguna, crea una nueva. Es la costura que comparten el
 * callable owner-only y el scheduler diario (`functions/scheduled/metaCatalogVerification.ts`).
 *
 * La creación/reanudación es un CLAIM TRANSACCIONAL con lease: si otra invocación ya está
 * trabajando la corrida, esta lanza `CatalogVerificationAlreadyRunningError` en vez de correr
 * en paralelo. SOLO LEE de Meta, así que el peor caso de una carrera era gasto y cursores
 * pisados — no una escritura duplicada.
 *
 * La PROPIEDAD se fija al run en su creación (espejo del `profile` del import): un cambio de
 * config a mitad de barrido no mezcla dos criterios de dueño dentro de la misma corrida.
 *
 * QUIÉN puede correr lo decide `catalogVerificationEligibility`, NO el interruptor de sync: esta
 * corrida solo hace GET, así que que nosotros dejemos de escribir no puede dejarnos ciegos. Los
 * tres desenlaces: se corre; se saltea sin gastar nada (nadie declaró gobierno externo ⇒ el guard
 * está inerte); o se corta con `CatalogVerificationBlockedError` + alerta idempotente cuando la
 * config es contradictoria (gobierno externo declarado y ningún catálogo remoto que leer).
 */
export async function runCatalogVerificationForTenant(opts: CatalogVerificationRunOptions): Promise<CatalogVerificationRunOutcome> {
  const { tenantId } = opts;
  const now = opts.now ?? (() => Timestamp.now());
  const cfgDoc = await db().doc(`tenants/${tenantId}/config/meta`).get();
  // Se lee la config COMPLETA (no solo el catalogId) porque la comparación necesita la
  // propiedad efectiva: sin ella no se puede decir de quién es una divergencia.
  const rawCatalogSync = (cfgDoc.data() as { catalogSync?: unknown } | undefined)?.catalogSync;
  // La elegibilidad separa "podemos escribir" de "podemos mirar": con la sync apagada y gobierno
  // externo declarado, el guard del bot sigue activo y esta corrida —que solo hace GET— es lo
  // ÚNICO que refresca la evidencia. Negarse a correr acá apagaba la venta del catálogo entero.
  const elegible = catalogVerificationEligibility(rawCatalogSync);
  if (elegible.can === 'blocked') {
    // Config CONTRADICTORIA: el guard va a bloquear y nada puede desbloquearlo. Se avisa de forma
    // idempotente ANTES de cortar, para que el bloqueo tenga cara visible y salida humana.
    await alertarVerificacionImposible(tenantId, elegible.reason);
    throw new CatalogVerificationBlockedError(
      elegible.reason,
      'Declaraste que un sistema externo publica los datos de tu catálogo, pero no hay un catálogo de Meta configurado para leer: no se puede verificar hasta corregir esa configuración.',
    );
  }
  if (elegible.can === 'skip') {
    // Sin gobierno externo declarado el guard está inerte: no hay nada que refrescar. Antes de
    // cortar se cierra un aviso que ya no aplica, POR LAS DOS SALIDAS: retirar la declaración
    // externa (`no_external_governance`) y borrar `catalogSync` entero para desconectarse
    // (`no_catalog_sync`). La segunda faltaba y dejaba huérfano el aviso "No podemos verificar tu
    // catálogo": quedaba abierto para siempre en un tenant que ya ni siquiera está conectado,
    // porque nada vuelve a pasar por acá con la razón que sí lo cerraba.
    //
    // El costo consciente: un tenant sin `catalogSync` (credipower) paga UNA lectura del doc del
    // aviso por corrida (dos por día) y CERO escrituras —`decideVerificationBlockedPatch` devuelve
    // `null` cuando no hay nada que cerrar—. Sigue sin gastar una sola llamada contra Meta, que es
    // lo que el fail-closed de nivel 1 promete.
    await alertarVerificacionImposible(tenantId, null);
    throw new CatalogVerificationUnavailableError('La sincronización de catálogo no está configurada para esta empresa.');
  }
  // Se puede verificar ⇒ si quedó un aviso de "no podemos verificar" abierto, se cierra.
  await alertarVerificacionImposible(tenantId, null);

  const runsCol = db().collection(paths.metaCatalogVerificationRuns(tenantId));

  /**
   * CLAIM TRANSACCIONAL (espejo del claim con lease del outbox). La búsqueda de la corrida
   * activa, la reanudación y la creación viven DENTRO de una sola transacción: el
   * read-then-create anterior no tenía exclusión mutua, así que dos invocaciones simultáneas
   * (panel impaciente + scheduler, o dos pestañas) creaban DOS corridas del mismo tenant o
   * reanudaban la misma en paralelo pisándose cursores y contadores.
   */
  const run: MetaCatalogVerificationRunDoc = await db().runTransaction(async (tx) => {
    const nowMs = now().toMillis();
    let actual: MetaCatalogVerificationRunDoc | undefined;
    let ref = opts.runId ? db().doc(paths.metaCatalogVerificationRun(tenantId, opts.runId)) : null;

    if (ref) {
      const snap = await tx.get(ref);
      actual = snap.data() as MetaCatalogVerificationRunDoc | undefined;
      if (!actual) throw new CatalogVerificationUnavailableError('Esa corrida de verificación no existe en esta empresa.');
      if (actual.status !== 'running') {
        throw new CatalogVerificationUnavailableError(`Esa corrida ya terminó (${actual.status}): iniciá una nueva.`);
      }
    } else {
      // La query va DENTRO de la transacción: es lo que serializa a los dos llamadores.
      const activo = await tx.get(runsCol.where('status', '==', 'running').limit(1));
      const previo = activo.docs[0];
      if (previo) {
        actual = previo.data() as MetaCatalogVerificationRunDoc;
        ref = previo.ref;
      }
    }

    const accion = verificationClaimDecision(actual ?? null, nowMs);
    if (accion === 'already_running') throw new CatalogVerificationAlreadyRunningError(actual!);

    const leaseUntilMs = nowMs + VERIFICATION_LEASE_MS;
    if (accion === 'resume' && actual && ref) {
      tx.update(ref, { leaseUntilMs, updatedAt: now() });
      return { ...actual, leaseUntilMs };
    }

    const nuevoRef = runsCol.doc();
    const t = now();
    const nuevo: MetaCatalogVerificationRunDoc = {
      runId: nuevoRef.id,
      tenantId,
      catalogId: elegible.catalogId,
      status: 'running',
      phase: 'remote',
      cursor: null,
      localCursor: null,
      pagesDone: 0,
      counters: emptyVerificationCounters(),
      sweepStartedAtMs: t.toMillis(),
      missingDetectionSkipped: false,
      ownership: elegible.ownership,
      actorUid: opts.actorUid ?? null,
      trigger: opts.trigger ?? 'callable',
      lastError: '',
      leaseUntilMs,
      startedAt: t,
      updatedAt: t,
      finishedAt: null,
    };
    tx.create(nuevoRef, nuevo as unknown as Record<string, unknown>);
    return nuevo;
  });

  let res: RunVerificationResult;
  try {
    // El cliente se arma DENTRO del try: si obtener credenciales falla, el claim se libera
    // igual y la próxima invocación puede reintentar sin esperar a que venza el lease.
    const client = opts.client ?? (await getMetaCatalogClientForTenant(tenantId));
    res = await runVerificationPages({
      tenantId,
      // El catálogo es EL DEL RUN: si alguien cambia la config a mitad de barrido, la corrida
      // termina contra el catálogo que empezó a leer (mezclar dos catálogos marcaría faltantes
      // que solo faltan en el otro).
      catalogId: run.catalogId,
      // El fallback cubre un doc de run sin propiedad (no debería existir: colección nueva).
      // Ante la duda se usa la propiedad DECLARADA vigente, que ya viene fail-closed de nivel 2.
      ownership: run.ownership ?? elegible.ownership,
      client,
      store: firestoreVerificationStore({ tenantId, runId: run.runId }),
      phase: run.phase ?? 'remote',
      cursor: run.cursor ?? null,
      localCursor: run.localCursor ?? null,
      counters: { ...emptyVerificationCounters(), ...(run.counters ?? {}) },
      pagesDone: run.pagesDone ?? 0,
      sweepStartedAtMs: run.sweepStartedAtMs ?? run.startedAt?.toMillis?.() ?? now().toMillis(),
      missingDetectionSkipped: run.missingDetectionSkipped === true,
      lastError: run.lastError ?? '',
      maxPages: opts.maxPages,
      externalSourceId: run.ownership?.externalSource?.acknowledgedSourceIds?.[0] ?? null,
      now,
    });
  } finally {
    // Se libera el claim SIEMPRE (también si la invocación explota): el progreso por página ya
    // está persistido y la próxima invocación tiene que poder reanudar sin esperar el lease.
    await releaseVerificationLease(tenantId, run.runId);
  }

  return {
    runId: run.runId,
    status: res.status,
    phase: res.phase,
    pagesDone: res.pagesDone,
    counters: res.counters,
    hasCursor: !!(res.cursor || res.localCursor),
    missingDetectionSkipped: res.missingDetectionSkipped,
    ttlMs: verificationTtlMs(opts.externalPeriodMs),
    ...(res.stopReason ? { stopReason: res.stopReason } : {}),
    ...(res.lastError ? { lastError: res.lastError } : {}),
  };
}
