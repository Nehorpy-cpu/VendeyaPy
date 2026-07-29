/**
 * Helpers PUROS del centro de calidad del catálogo (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1).
 *
 * Sin imports de Firebase (solo tipos): testeables con vitest sin mocks. La ELEGIBILIDAD real
 * la decide siempre el backend (syncEnableBlockers/quality server-side) — acá solo se REFLEJA
 * lo que el servidor ya evaluó, para decidir qué controles mostrar. Nunca se re-implementan
 * las reglas de negocio.
 */

import type {
  ProductConCalidad,
  QualityFingerprintEntry,
  QualityOrigin,
  QualitySeverity,
} from './catalog';

// --- Etiquetas no técnicas (español) -----------------------------------------

/** Códigos de observación → texto entendible para un comerciante (fallback: mensaje del server). */
export const QUALITY_CODE_LABEL: Record<string, string> = {
  // Bloqueantes (espejo de syncEnableBlockers/createBlockers del backend)
  not_active: 'el producto no está activo',
  name_missing: 'falta el nombre',
  price_invalid: 'el precio no es válido',
  currency_not_pyg: 'la moneda no es PYG',
  image_not_https: 'falta una imagen segura (https)',
  category_missing: 'falta la categoría',
  stock_pending_review: 'falta revisar el stock',
  not_sellable_now: 'hoy no es vendible (sin stock)',
  unconfirmed_remote_match: 'su código ya existe en Meta sin vínculo confirmado',
  no_identity: 'falta el SKU o el vínculo con Meta',
  identity_too_long: 'el código supera los 100 caracteres',
  description_missing: 'falta la descripción',
  brand_missing: 'falta la marca',
  product_url_missing: 'falta el enlace al producto',
  product_url_not_https: 'el enlace al producto no es https',
  // Advertencias del programa
  generic_name: 'el nombre es demasiado genérico',
  probable_duplicate: 'parece duplicado de otro producto',
  name_description_mismatch: 'el nombre y la descripción no coinciden',
  category_unclassified: 'quedó sin clasificar al importarlo',
  remote_drift: 'en Meta el artículo quedó distinto que acá',
};

export const ORIGEN_LABEL: Record<QualityOrigin, string> = {
  import: 'Importación',
  editor: 'Edición',
  sync_gate: 'Requisitos de Meta',
  system: 'Sistema',
};

export function etiquetaCodigo(code: string): string {
  return QUALITY_CODE_LABEL[code] ?? code;
}

// --- Filas del centro de calidad ----------------------------------------------

/** Una observación "aplanada" para listarla: producto + entrada de fingerprint. */
export interface FilaCalidad {
  productId: string;
  productName: string;
  fingerprint: string;
  entry: QualityFingerprintEntry;
  /** true si la observación sigue abierta (sin resolvedAt). */
  abierta: boolean;
}

/**
 * Aplana las observaciones de los productos YA cargados en el panel (quality.fingerprints).
 * Ordena: bloqueantes primero, después por nombre de producto (estable y predecible).
 */
export function filasDeCalidad(products: ProductConCalidad[]): FilaCalidad[] {
  const filas: FilaCalidad[] = [];
  for (const p of products) {
    const fps = p.quality?.fingerprints;
    if (!fps) continue;
    for (const [fingerprint, entry] of Object.entries(fps)) {
      if (!entry || typeof entry !== 'object') continue;
      filas.push({
        productId: p.id,
        productName: p.name,
        fingerprint,
        entry,
        abierta: entry.resolvedAt == null,
      });
    }
  }
  filas.sort((a, b) => {
    if (a.entry.severity !== b.entry.severity) return a.entry.severity === 'BLOCKING' ? -1 : 1;
    if (a.productName !== b.productName) return a.productName.localeCompare(b.productName, 'es');
    return a.fingerprint.localeCompare(b.fingerprint);
  });
  return filas;
}

export interface FiltrosCalidad {
  severidad: 'todas' | QualitySeverity;
  estado: 'abiertas' | 'resueltas' | 'todas';
  origen: 'todos' | QualityOrigin;
  codigo: string; // '' = todos
}

export const FILTROS_CALIDAD_DEFAULT: FiltrosCalidad = {
  severidad: 'todas',
  estado: 'abiertas',
  origen: 'todos',
  codigo: '',
};

export function filtrarFilas(filas: FilaCalidad[], f: FiltrosCalidad): FilaCalidad[] {
  return filas.filter((fila) => {
    if (f.severidad !== 'todas' && fila.entry.severity !== f.severidad) return false;
    if (f.estado === 'abiertas' && !fila.abierta) return false;
    if (f.estado === 'resueltas' && fila.abierta) return false;
    if (f.origen !== 'todos' && fila.entry.origin !== f.origen) return false;
    if (f.codigo && fila.entry.code !== f.codigo) return false;
    return true;
  });
}

/** Observaciones ABIERTAS de un producto (para el badge/detalle de la fila de la grilla). */
export function observacionesAbiertas(p: ProductConCalidad): QualityFingerprintEntry[] {
  const fps = p.quality?.fingerprints;
  if (!fps) return [];
  return Object.values(fps)
    .filter((e) => e && typeof e === 'object' && e.resolvedAt == null)
    .sort((a, b) => (a.severity === b.severity ? a.code.localeCompare(b.code) : a.severity === 'BLOCKING' ? -1 : 1));
}

// --- Selección masiva de elegibles ---------------------------------------------

/**
 * Elegible para tildar en la selección masiva de "habilitar sincronización":
 * sin sync ya activa y SIN bloqueos según la evaluación del servidor. Si el producto
 * todavía no tiene `quality` (no evaluado), solo se ofrece si no hay bloqueos EVIDENTES
 * que el panel ya conoce (inactivo / stock sin revisar). El backend re-valida igual.
 */
export function esElegibleParaSync(p: ProductConCalidad): boolean {
  if (p.syncToMeta === true) return false;
  if (p.quality) return p.quality.blocking === 0;
  return p.status === 'ACTIVE' && p.stockPendingReview !== true;
}

export type RazonNoElegible =
  | 'ya_sincroniza'
  | 'con_bloqueos'
  | 'no_activo'
  | 'stock_sin_revisar';

export const RAZON_NO_ELEGIBLE_LABEL: Record<RazonNoElegible, string> = {
  ya_sincroniza: 'ya se sincroniza con Meta',
  con_bloqueos: 'con datos incompletos (bloqueantes)',
  no_activo: 'no está activo',
  stock_sin_revisar: 'con stock sin revisar',
};

/** Por qué un producto NO es elegible (null si es elegible). Para agrupar excluidos. */
export function razonNoElegible(p: ProductConCalidad): RazonNoElegible | null {
  if (p.syncToMeta === true) return 'ya_sincroniza';
  if (p.quality) return p.quality.blocking === 0 ? null : 'con_bloqueos';
  if (p.status !== 'ACTIVE') return 'no_activo';
  if (p.stockPendingReview === true) return 'stock_sin_revisar';
  return null;
}

/** Agrupa los NO elegibles por razón (para "quedaron fuera N: …"). */
export function agruparNoElegibles(products: ProductConCalidad[]): Partial<Record<RazonNoElegible, number>> {
  const out: Partial<Record<RazonNoElegible, number>> = {};
  for (const p of products) {
    const r = razonNoElegible(p);
    if (!r) continue;
    out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}
