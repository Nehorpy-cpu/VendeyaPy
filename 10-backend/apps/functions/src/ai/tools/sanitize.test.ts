import { describe, it, expect } from 'vitest';
import { sanitizeProduct, sanitizePromotion, sanitizeInternalStats } from './sanitize.js';
import type { Product, Promotion, TenantStatsPublic, TenantStatsPrivate } from '@vpw/shared';

// Producto con campos RANCIOS/sensibles (cost/margin/profit/financials/tenantId) que NO deben filtrarse.
const rogueProduct = {
  id: 'p1', tenantId: 'perfumeria', name: 'Good Girl', description: 'd', price: 250000, compareAtPrice: 300000,
  currency: 'PYG', aiNotes: 'best seller', categoryId: 'perfumes', images: [], emoji: '🌸',
  inventory: { stock: 2 }, status: 'ACTIVE', featured: true, position: 0,
  perfume: { brand: 'Carolina Herrera', styleTags: ['dulce', 'floral'] },
  // --- campos que NUNCA deben aparecer ---
  cost: 90000, costPrice: 90000, margin: 0.64, grossProfit: 160000, profit: 160000,
  productFinancials: { costPrice: 90000 }, metaCatalogId: 'meta-123',
} as unknown as Product;

describe('ai/sanitize sanitizeProduct', () => {
  it('expone solo la whitelist pública (precio/marca/estilo/disponibilidad)', () => {
    const out = sanitizeProduct(rogueProduct);
    expect(out).toEqual({
      id: 'p1', name: 'Good Girl', brand: 'Carolina Herrera', price: 250000, compareAtPrice: 300000,
      currency: 'PYG', styleTags: ['dulce', 'floral'], available: true, lowStock: true, featured: true, aiNotes: 'best seller',
    });
  });

  it('NUNCA filtra costo/margen/ganancia/financials/tenantId', () => {
    const out = sanitizeProduct(rogueProduct) as Record<string, unknown>;
    for (const k of ['cost', 'costPrice', 'margin', 'grossProfit', 'profit', 'productFinancials', 'tenantId', 'metaCatalogId']) {
      expect(k in out).toBe(false);
    }
  });

  it('available=false cuando no hay stock', () => {
    const p = { ...rogueProduct, inventory: { stock: 0 } } as unknown as Product;
    expect(sanitizeProduct(p).available).toBe(false);
  });
});

const roguePromo = {
  id: 'promo1', tenantId: 'perfumeria', name: '2x1 Árabes', description: 'Llevá 2 pagá 1',
  type: 'BUNDLE', discountValue: 0, objective: 'rotar stock viejo', productIds: ['a', 'b'], categoryIds: ['arabes'],
  startDate: { toMillis: () => 1000 }, endDate: null, status: 'ACTIVE', createdAt: {}, updatedAt: {},
} as unknown as Promotion;

describe('ai/sanitize sanitizePromotion', () => {
  it('solo campos públicos; sin objective/productIds/status/tenantId', () => {
    const out = sanitizePromotion(roguePromo);
    expect(out).toEqual({ id: 'promo1', name: '2x1 Árabes', description: 'Llevá 2 pagá 1', type: 'BUNDLE', discountValue: 0, startDate: 1000, endDate: null });
    const rec = out as Record<string, unknown>;
    for (const k of ['objective', 'productIds', 'categoryIds', 'status', 'tenantId']) expect(k in rec).toBe(false);
  });
});

describe('ai/sanitize sanitizeInternalStats', () => {
  it('contexto interno SÍ puede ver ganancia/margen (agregado del propio tenant)', () => {
    const pub = { ventas: 10, ingresos: 1000, ticketPromedio: 100, pendingOrders: 1, topVendidos: [] } as unknown as TenantStatsPublic;
    const priv = { ganancia: 400, margen: 0.4, topRentables: [] } as unknown as TenantStatsPrivate;
    const out = sanitizeInternalStats(pub, priv);
    expect(out.ventas).toBe(10);
    expect(out.ganancia).toBe(400);
    expect(out.margen).toBe(0.4);
  });

  it('tolera stats ausentes', () => {
    const out = sanitizeInternalStats(null, null);
    expect(out.ventas).toBe(0);
    expect(out.ganancia).toBeNull();
  });
});
