/**
 * products/quality.ts — Evaluador de calidad del catálogo (PURO)
 * ==============================================================
 * (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1) Evalúa UN producto y devuelve sus
 * observaciones de calidad con historia (firstSeenAt / lastSeenAt / resolvedAt).
 *
 * REGLA CENTRAL: los códigos BLOCKING salen de `syncEnableBlockers` (que a su vez reusa
 * `createBlockers` del contrato de escritura) — este módulo NO re-implementa ningún
 * predicado de bloqueo: una segunda lista se desincroniza (ya pasó, ver ADR-0012 §15).
 * Los WARNING son señales nuevas de calidad de ficha (genericidad, duplicados locales,
 * incoherencia nombre↔descripción, borrador sin clasificar, drift remoto).
 *
 * AUTORIDAD SERVER-SIDE: `product.quality` lo escribe SOLO el servidor. El cliente no puede
 * falsificarlo: las rules de products están cerradas (`allow write: if false`) y
 * `validateProductPatch` jamás acepta `quality` ni los campos de sync/meta. Aunque un valor
 * persistido se corrompiera, NINGÚN gate confía en él: la habilitación de sync re-evalúa
 * `syncEnableBlockers` y la activación de venta re-evalúa este módulo sobre el doc fresco.
 *
 * PURO: sin E/S. `Timestamp` se usa solo como tipo de dato (no requiere app inicializada).
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { CatalogQualityProfile, Product, ProductQuality, QualityObservation, QualityObservationOrigin, QualitySeverity } from '@vpw/shared';
import { DEFAULT_STOPWORDS, normalizeText, significantTokens, syncEnableBlockers, type SyncEnableBlocker } from '../meta/catalogReconcile.js';

/** Días que una observación RESUELTA se conserva como histórico antes de podarse. */
const RESOLVED_RETENTION_DAYS = 30;

/**
 * Bloqueos que impiden ACTIVAR LA VENTA (status ACTIVE). Deliberadamente mínimos: un
 * producto sin nombre o sin precio real no puede ofrecerse ni cobrarse. El resto de los
 * BLOCKING solo frena la sincronización con Meta, no la venta local.
 */
export const SALE_BLOCKING_CODES: readonly string[] = ['name_missing', 'price_invalid'];

/** Snapshot mínimo del artículo remoto para detectar drift local↔Meta en un importado. */
export interface QualityRemoteSnapshot {
  name: string;
  /** Precio remoto ya parseado en guaraníes (0 = no interpretable: no se compara). */
  priceGs: number;
  description: string;
  imageUrl: string;
}

export interface QualityEvalContext {
  profile?: CatalogQualityProfile | null;
  /** Nombres normalizados de OTROS productos locales no archivados (sin el propio). */
  localNames?: ReadonlySet<string>;
  /** Artículo remoto vinculado, si el llamador lo conoce (import run). */
  remoteSnapshot?: QualityRemoteSnapshot | null;
  /** Calidad previa persistida: preserva firstSeenAt y sella resolvedAt. */
  previous?: ProductQuality | null;
  origin?: QualityObservationOrigin;
  /**
   * true si el retailer_id efectivo YA existe en Meta (la primera sync sería UPDATE).
   * Default derivado: hay vínculo confirmado ⇒ existe remoto. Sin red no se adivina más.
   */
  remoteHasIdentity?: boolean;
  now?: Timestamp;
}

// ---------------------------------------------------------------------------
// Mensajería por código (español, orientada a la corrección)
// ---------------------------------------------------------------------------

/** Campo del producto al que apunta cada bloqueo del gate (para el fingerprint estable). */
const BLOCKER_FIELD: Record<SyncEnableBlocker, string> = {
  not_active: 'status',
  name_missing: 'name',
  price_invalid: 'price',
  currency_not_pyg: 'currency',
  image_not_https: 'images',
  category_missing: 'categoryId',
  stock_pending_review: 'inventory',
  not_sellable_now: 'inventory',
  unconfirmed_remote_match: 'metaRetailerId',
  no_identity: 'inventory.sku',
  identity_too_long: 'inventory.sku',
  description_missing: 'description',
  brand_missing: 'brand',
  product_url_missing: 'productUrl',
  product_url_not_https: 'productUrl',
};

const BLOCKER_TEXT: Record<SyncEnableBlocker, { message: string; action: string }> = {
  not_active: { message: 'El producto no está activo.', action: 'Revisá los datos y activalo cuando esté listo para venderse.' },
  name_missing: { message: 'El producto no tiene nombre.', action: 'Cargale un nombre descriptivo.' },
  price_invalid: { message: 'El precio no es válido (tiene que ser mayor a 0).', action: 'Cargá el precio real de venta.' },
  currency_not_pyg: { message: 'La moneda no es guaraníes (PYG).', action: 'Corregí la moneda del producto.' },
  image_not_https: { message: 'No hay ninguna imagen con dirección segura (https).', action: 'Cargá al menos una imagen alojada en https.' },
  category_missing: { message: 'El producto no tiene categoría.', action: 'Asignale una categoría del catálogo.' },
  stock_pending_review: { message: 'El stock vino de la importación y nadie lo revisó todavía.', action: 'Revisá y guardá el inventario real.' },
  not_sellable_now: { message: 'Está activo pero sin stock disponible.', action: 'Reponé stock o desactivá el control de stock si no aplica.' },
  unconfirmed_remote_match: { message: 'Su código coincide con un artículo de Meta que nadie confirmó como propio.', action: 'Confirmá el vínculo desde la reconciliación antes de habilitar la sincronización.' },
  no_identity: { message: 'No tiene código identificador (SKU ni vínculo con Meta).', action: 'Cargale un SKU interno.' },
  identity_too_long: { message: 'El código identificador supera los 100 caracteres que admite Meta.', action: 'Acortá el SKU interno.' },
  description_missing: { message: 'Falta la descripción (Meta la exige para crear el artículo).', action: 'Escribí la descripción pública del producto.' },
  brand_missing: { message: 'Falta la marca (Meta la exige para crear el artículo).', action: 'Cargá la marca del producto.' },
  product_url_missing: { message: 'Falta la URL pública del producto (Meta la exige para crear el artículo).', action: 'Cargá el enlace https del producto en tu sitio.' },
  product_url_not_https: { message: 'La URL pública no es https.', action: 'Reemplazala por el enlace https del producto.' },
};

interface FreshObservation {
  code: string;
  severity: QualitySeverity;
  field: string;
  message: string;
  action: string;
}

const fingerprintOf = (o: Pick<FreshObservation, 'code' | 'field'>): string => `${o.code}:${o.field}`;

// ---------------------------------------------------------------------------
// Perfil
// ---------------------------------------------------------------------------

/** Normaliza el perfil guardado en `config/catalog.profile`. Basura ⇒ null (defaults). */
export function normalizeCatalogProfile(v: unknown): CatalogQualityProfile | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  const out: CatalogQualityProfile = {};
  if (typeof d.requireBrand === 'boolean') out.requireBrand = d.requireBrand;
  if (typeof d.requireImage === 'boolean') out.requireImage = d.requireImage;
  if (typeof d.genericNameCheck === 'boolean') out.genericNameCheck = d.genericNameCheck;
  if (Array.isArray(d.stopwords)) {
    const words = d.stopwords.filter((w): w is string => typeof w === 'string' && !!w.trim()).slice(0, 200);
    if (words.length) out.stopwords = words;
  }
  if (d.vertical === 'perfumeria' || d.vertical === 'generic') out.vertical = d.vertical;
  return out;
}

const stopwordsDe = (profile: CatalogQualityProfile | null | undefined): ReadonlySet<string> =>
  profile?.stopwords?.length ? new Set(profile.stopwords.map((w) => normalizeText(w))) : DEFAULT_STOPWORDS;

/** Marca NEUTRAL del producto (misma derivación que outboundBrand, sin truncar). */
const brandDe = (p: Product): string => (p.brand ?? p.perfume?.brand ?? '').trim();

/** Nombres normalizados de otros productos (para probable_duplicate). Excluye archivados y al propio. */
export function localNameSet(products: ReadonlyArray<Pick<Product, 'id' | 'name' | 'status'>>, excludeId?: string): Set<string> {
  const out = new Set<string>();
  for (const p of products) {
    if (p.id === excludeId || p.status === 'ARCHIVED') continue;
    const n = normalizeText(p.name);
    if (n) out.add(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------------

function freshObservations(p: Product, ctx: QualityEvalContext): FreshObservation[] {
  const profile = ctx.profile ?? null;
  const stopwords = stopwordsDe(profile);
  const out: FreshObservation[] = [];
  const remoteHasIdentity = ctx.remoteHasIdentity ?? !!(p.metaRetailerId ?? '').trim();

  // 1) BLOCKING: la lista canónica de los gates, jamás una copia.
  const blockers = syncEnableBlockers(p as Product & { stockPendingReview?: boolean }, { remoteHasIdentity });
  for (const b of blockers) {
    out.push({ code: b, severity: 'BLOCKING', field: BLOCKER_FIELD[b], ...BLOCKER_TEXT[b] });
  }
  const yaObservada = new Set(out.map(fingerprintOf));

  // 2) Marca como calidad de ficha: cuando el gate NO la exige (artículo ya existente en
  //    Meta ⇒ UPDATE parcial) pero el perfil del tenant la pide igual (default conservador).
  if ((profile?.requireBrand ?? true) && !brandDe(p) && !yaObservada.has('brand_missing:brand')) {
    out.push({ code: 'brand_missing', severity: 'WARNING', field: 'brand', ...BLOCKER_TEXT.brand_missing });
  }
  // `requireImage` queda reservado: la imagen https la exige SIEMPRE el contrato de Meta
  // (ya es BLOCKING arriba), así que no hay variante "solo ficha" que agregar hoy.

  const nName = normalizeText(p.name);
  const nBrand = normalizeText(brandDe(p));

  // 3) Nombre genérico: el nombre es (casi) solo la marca — mismo criterio que
  //    analyzeRemoteItems para los artículos remotos.
  const esGenerico = !!nBrand && (nName === nBrand || nName.replace(nBrand, '').trim().length <= 3);
  if ((profile?.genericNameCheck ?? true) && nName && esGenerico) {
    out.push({
      code: 'generic_name',
      severity: 'WARNING',
      field: 'name',
      message: 'El nombre es prácticamente igual a la marca: el bot no puede distinguir este producto de otros de la misma marca.',
      action: 'Agregale al nombre lo que lo identifica (línea, versión, tamaño).',
    });
  }

  // 4) Duplicado probable contra el catálogo LOCAL (nombres normalizados de otros productos).
  if (nName && ctx.localNames?.has(nName)) {
    out.push({
      code: 'probable_duplicate',
      severity: 'WARNING',
      field: 'name',
      message: 'Ya existe otro producto local con este mismo nombre.',
      action: 'Verificá si es el mismo producto (unificalos) o diferencialos en el nombre.',
    });
  }

  // 5) Incoherencia nombre ↔ descripción: mismo criterio que el análisis remoto, con las
  //    stopwords del perfil. No se marca si el nombre ya es genérico (está cubierto arriba).
  if (!esGenerico) {
    const descIni = normalizeText(p.description).slice(0, 80);
    const nameTokens = significantTokens(p.name, stopwords);
    const hit = nameTokens.some((t) => descIni.includes(t)) || (!!nBrand && descIni.includes(nBrand.split(' ')[0]!));
    if (nameTokens.length && descIni && !hit) {
      out.push({
        code: 'name_description_mismatch',
        severity: 'WARNING',
        field: 'description',
        message: 'La descripción no menciona nada del nombre del producto: puede estar pegada de otro artículo.',
        action: 'Revisá que la descripción corresponda a este producto.',
      });
    }
  }

  // 6) Borrador sin clasificar (importación genérica). El gate ya bloquea la sync con
  //    category_missing; esta observación agrega la explicación para el centro de calidad.
  if (!(p.categoryId ?? '').trim()) {
    out.push({
      code: 'category_unclassified',
      severity: 'WARNING',
      field: 'categoryId',
      message: 'Quedó importado como borrador sin clasificar (no había categoría equivalente).',
      action: 'Asignale una categoría real del catálogo.',
    });
  }

  // 7) Drift local ↔ remoto (solo cuando el llamador conoce el artículo de Meta).
  if (ctx.remoteSnapshot) {
    const campos = remoteDriftFields(
      { name: p.name ?? '', price: Number(p.price ?? 0), description: p.description ?? '', imageUrl: (p.images ?? [])[0] ?? '' },
      ctx.remoteSnapshot,
    );
    if (campos.length) {
      out.push({
        code: 'remote_drift',
        severity: 'WARNING',
        field: 'remote',
        message: `El artículo en Meta cambió respecto de lo importado (${campos.join(', ')}).`,
        action: 'Revisá el producto y decidí cuál versión vale antes de habilitar la sincronización.',
      });
    }
  }

  // Dedupe defensivo por fingerprint (dos reglas jamás deberían apuntar al mismo par).
  const vistos = new Set<string>();
  return out.filter((o) => {
    const fp = fingerprintOf(o);
    if (vistos.has(fp)) return false;
    vistos.add(fp);
    return true;
  });
}

/** Campos del importado que difieren del remoto. El precio 0 remoto (no parseable) no se compara. */
export function remoteDriftFields(
  local: { name: string; price: number; description: string; imageUrl: string },
  remote: QualityRemoteSnapshot,
): string[] {
  const out: string[] = [];
  if (remote.name.trim() !== local.name.trim()) out.push('name');
  if (remote.priceGs > 0 && remote.priceGs !== local.price) out.push('price');
  if (remote.description.trim() !== local.description.trim()) out.push('description');
  if (remote.imageUrl.trim() !== local.imageUrl.trim()) out.push('image');
  return out;
}

const toMillis = (t: Timestamp | null | undefined): number | null =>
  t && typeof t.toMillis === 'function' ? t.toMillis() : null;

/**
 * Evalúa el producto y MERGEA con la calidad previa:
 *  - fingerprint ya visto ⇒ conserva firstSeenAt, actualiza lastSeenAt, reabre (resolvedAt=null);
 *  - fingerprint previo que ya no aplica ⇒ se SELLA con resolvedAt=now (histórico corto);
 *  - resueltos hace más de 30 días ⇒ se podan en esta misma escritura.
 *
 * ⚠️ El resultado REEMPLAZA el campo `quality` completo (update, no merge profundo): con un
 * set({merge:true}) los fingerprints podados resucitarían desde el mapa viejo de Firestore.
 */
export function evaluateProductQuality(p: Product, ctx: QualityEvalContext = {}): ProductQuality {
  const now = ctx.now ?? Timestamp.now();
  const origin: QualityObservationOrigin = ctx.origin ?? 'system';
  const fresh = freshObservations(p, ctx);
  const prev = ctx.previous?.fingerprints ?? {};
  const fingerprints: Record<string, QualityObservation> = {};

  for (const o of fresh) {
    const fp = fingerprintOf(o);
    const antes = prev[fp];
    fingerprints[fp] = {
      code: o.code,
      severity: o.severity,
      field: o.field,
      message: o.message,
      action: o.action,
      // La reaparición conserva el firstSeenAt original: la historia no se reinicia.
      firstSeenAt: (antes?.firstSeenAt as Timestamp | undefined) ?? now,
      lastSeenAt: now,
      resolvedAt: null,
      origin: antes?.origin ?? origin,
    };
  }

  const retentionMs = RESOLVED_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const [fp, o] of Object.entries(prev)) {
    if (fingerprints[fp]) continue; // sigue activa (o reabierta): ya está arriba
    const resueltaEn = toMillis(o.resolvedAt as Timestamp | null);
    if (resueltaEn === null) {
      // Dejó de aplicar en ESTE recompute: se sella, no se borra (el panel muestra "resuelta").
      fingerprints[fp] = { ...o, resolvedAt: now };
    } else if (now.toMillis() - resueltaEn <= retentionMs) {
      fingerprints[fp] = o; // histórico reciente: se conserva tal cual
    }
    // resuelta hace >30 días ⇒ poda (no se copia)
  }

  let blocking = 0;
  let warning = 0;
  for (const o of Object.values(fingerprints)) {
    if (o.resolvedAt !== null) continue;
    if (o.severity === 'BLOCKING') blocking++;
    else warning++;
  }
  return { blocking, warning, fingerprints, evaluatedAt: now };
}

// ---------------------------------------------------------------------------
// Helpers de consumo (gate de venta, panel)
// ---------------------------------------------------------------------------

/** Observaciones ACTIVAS (sin las resueltas). */
export function activeObservations(q: ProductQuality): QualityObservation[] {
  return Object.values(q.fingerprints).filter((o) => o.resolvedAt === null);
}

/** Códigos de bloqueo de VENTA activos (subset de SALE_BLOCKING_CODES). */
export function saleBlockingCodes(q: ProductQuality): string[] {
  return activeObservations(q)
    .filter((o) => o.severity === 'BLOCKING' && SALE_BLOCKING_CODES.includes(o.code))
    .map((o) => o.code)
    .sort();
}

export interface QualityObservationRef {
  code: string;
  field: string;
  severity: QualitySeverity;
  message: string;
}

/** Qué resolvió y qué quedó pendiente ESTE recompute (para el "guardar" del editor). */
export function diffQuality(previous: ProductQuality | null | undefined, next: ProductQuality): { resueltas: QualityObservationRef[]; pendientes: QualityObservationRef[] } {
  const ref = (o: QualityObservation): QualityObservationRef => ({ code: o.code, field: o.field, severity: o.severity, message: o.message });
  const activasAntes = new Set(
    Object.entries(previous?.fingerprints ?? {})
      .filter(([, o]) => o.resolvedAt === null)
      .map(([fp]) => fp),
  );
  const resueltas = Object.entries(next.fingerprints)
    .filter(([fp, o]) => o.resolvedAt !== null && activasAntes.has(fp))
    .map(([, o]) => ref(o));
  const pendientes = activeObservations(next).map(ref);
  return { resueltas, pendientes };
}
