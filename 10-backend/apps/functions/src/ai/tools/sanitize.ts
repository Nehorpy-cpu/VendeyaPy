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

/** Truncado por code points (no parte surrogate pairs/emojis a la mitad). */
const truncate = (s: string, max: number): string => Array.from(s.trim()).slice(0, max).join('');

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
}

export function sanitizeProduct(p: Product): PublicProduct {
  const stock = p.inventory?.stock ?? 0;
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
