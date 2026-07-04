/**
 * ai/tools/sanitize.ts — Sanitizadores por whitelist EXPLÍCITA (AG-2)
 * ==================================================================
 * Construyen objetos NUEVOS con solo los campos permitidos. Nunca hacen spread del doc original,
 * así un campo nuevo/sensible no se filtra por accidente. El sales agent público jamás debe ver
 * costo/margen/ganancia/financials/tenantId/secretos.
 */
import type { Product, Promotion, PromotionType, Currency, TenantStatsPublic, TenantStatsPrivate, ProductUnitsAgg, ProductProfitAgg } from '@vpw/shared';

/** Topes hacia el modelo (F1B): material de venta sin inflar el payload/tokens. */
const DESCRIPTION_MAX_CHARS = 200;
const AI_NOTES_MAX_CHARS = 300;
/** Topes de la ficha estructurada (CAT-2): por campo, para que el payload quede acotado. */
const FICHA_TEXT_MAX_CHARS = 160;
const FICHA_LIST_MAX_ITEMS = 6;
const FICHA_ITEM_MAX_CHARS = 40;

/** Truncado por code points (no parte surrogate pairs/emojis a la mitad). */
const truncate = (s: string, max: number): string => Array.from(s.trim()).slice(0, max).join('');

/**
 * Ficha estructurada COMPACTA para el sales agent (CAT-2). Reemplaza depender solo de aiNotes
 * (cuyo tope de 300 dejaba fuera "cuándo NO recomendarlo"). Todo opcional: los campos vacíos
 * NO viajan. Sin datos privados: la ficha es guía de venta, no incluye costos/márgenes.
 */
export interface PublicProductFicha {
  concentracion?: string;
  familia?: string;
  notas?: { salida?: string[]; corazon?: string[]; fondo?: string[] };
  duracion?: string;
  proyeccion?: string;
  ocasiones?: string[];
  clima?: string[];
  perfil?: string;
  cuandoRecomendar?: string;
  cuandoNoRecomendar?: string;
  objeciones?: string;
  frasesVenta?: string[];
  similares?: string[];
}

/** Producto PÚBLICO para el sales agent. SIN costo/margen/financials/tenantId/meta/inventario exacto. */
export interface PublicProduct {
  id: string;
  name: string;
  brand: string | null;
  price: number;
  compareAtPrice: number | null;
  currency: Currency;
  description: string;
  styleTags: string[];
  available: boolean;
  lowStock: boolean;
  featured: boolean;
  aiNotes: string;
  /** Ficha estructurada (CAT-2). Ausente si el producto no tiene datos de ficha. */
  ficha?: PublicProductFicha;
}

const fichaText = (s: string | undefined | null): string | undefined => {
  const t = (s ?? '').trim();
  return t ? truncate(t, FICHA_TEXT_MAX_CHARS) : undefined;
};
const fichaList = (a: string[] | undefined | null): string[] | undefined => {
  const items = (a ?? []).map((x) => truncate(String(x ?? ''), FICHA_ITEM_MAX_CHARS)).filter(Boolean).slice(0, FICHA_LIST_MAX_ITEMS);
  return items.length ? items : undefined;
};

/** Arma la ficha compacta desde aiFicha + perfumería (familia/notas). undefined si quedó vacía. */
export function buildPublicFicha(p: Product): PublicProductFicha | undefined {
  const f = p.aiFicha ?? {};
  const notasRaw = {
    salida: fichaList(p.perfume?.notes?.top),
    corazon: fichaList(p.perfume?.notes?.heart),
    fondo: fichaList(p.perfume?.notes?.base),
  };
  const notas = Object.fromEntries(Object.entries(notasRaw).filter(([, v]) => v !== undefined));
  const ficha: PublicProductFicha = {
    ...(fichaText(f.concentracion) ? { concentracion: fichaText(f.concentracion) } : {}),
    ...(fichaText(p.perfume?.olfactiveFamily) ? { familia: fichaText(p.perfume?.olfactiveFamily) } : {}),
    ...(Object.keys(notas).length ? { notas } : {}),
    ...(fichaText(f.duracion) ? { duracion: fichaText(f.duracion) } : {}),
    ...(fichaText(f.proyeccion) ? { proyeccion: fichaText(f.proyeccion) } : {}),
    ...(fichaList(f.ocasiones) ? { ocasiones: fichaList(f.ocasiones) } : {}),
    ...(fichaList(f.clima) ? { clima: fichaList(f.clima) } : {}),
    ...(fichaText(f.perfil) ? { perfil: fichaText(f.perfil) } : {}),
    ...(fichaText(f.cuandoRecomendar) ? { cuandoRecomendar: fichaText(f.cuandoRecomendar) } : {}),
    ...(fichaText(f.cuandoNoRecomendar) ? { cuandoNoRecomendar: fichaText(f.cuandoNoRecomendar) } : {}),
    ...(fichaText(f.objeciones) ? { objeciones: fichaText(f.objeciones) } : {}),
    ...(fichaList(f.frasesVenta) ? { frasesVenta: fichaList(f.frasesVenta) } : {}),
    ...(fichaList(f.similares) ? { similares: fichaList(f.similares) } : {}),
  };
  return Object.keys(ficha).length ? ficha : undefined;
}

export function sanitizeProduct(p: Product): PublicProduct {
  const stock = p.inventory?.stock ?? 0;
  const ficha = buildPublicFicha(p);
  return {
    id: p.id,
    name: p.name,
    brand: p.perfume?.brand ?? null,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    currency: p.currency,
    description: truncate(p.description ?? '', DESCRIPTION_MAX_CHARS), // pública, truncada (F1B)
    styleTags: p.perfume?.styleTags ?? [],
    available: stock > 0,
    lowStock: stock > 0 && stock <= 3, // disponibilidad, no el stock exacto
    featured: !!p.featured,
    aiNotes: truncate(p.aiNotes ?? '', AI_NOTES_MAX_CHARS), // tope de payload (F1B)
    ...(ficha ? { ficha } : {}), // CAT-2: ausente si no hay datos (payload compacto)
  };
}

const tsToMillis = (ts: { toMillis?: () => number } | null | undefined): number | null =>
  ts && typeof ts.toMillis === 'function' ? ts.toMillis() : null;

/** Promoción PÚBLICA. SIN `objective` (estrategia interna), productIds/categoryIds, status, tenantId. */
export interface PublicPromotion {
  id: string;
  name: string;
  description: string;
  type: PromotionType;
  discountValue: number;
  startDate: number | null;
  endDate: number | null;
}

export function sanitizePromotion(p: Promotion): PublicPromotion {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    type: p.type,
    discountValue: p.discountValue,
    startDate: tsToMillis(p.startDate),
    endDate: tsToMillis(p.endDate),
  };
}

/**
 * Resumen INTERNO (solo internal_growth_assistant, del propio tenant). Acá SÍ se permiten
 * márgenes/ganancia. Se excluyen metadatos crudos (tenantId/updatedAt).
 */
export interface InternalSalesSummary {
  ventas: number;
  ingresos: number;
  ticketPromedio: number;
  pendingOrders: number;
  ganancia: number | null;
  margen: number | null;
  topVendidos: ProductUnitsAgg[];
  topRentables: ProductProfitAgg[];
}

export function sanitizeInternalStats(pub: TenantStatsPublic | null, priv: TenantStatsPrivate | null): InternalSalesSummary {
  return {
    ventas: pub?.ventas ?? 0,
    ingresos: pub?.ingresos ?? 0,
    ticketPromedio: pub?.ticketPromedio ?? 0,
    pendingOrders: pub?.pendingOrders ?? 0,
    ganancia: priv?.ganancia ?? null,
    margen: priv?.margen ?? null,
    topVendidos: pub?.topVendidos ?? [],
    topRentables: priv?.topRentables ?? [],
  };
}
