import { describe, it, expect } from 'vitest';
import { buscarProductos, listarPromocionesActivas } from './salesTools.js';
import type { Product, Promotion } from '@vpw/shared';
import type { CatalogFilters } from '../../catalog/search.js';

const product = (over: Partial<Record<string, unknown>>) => ({
  id: 'p1', tenantId: 'X', name: 'X', description: '', price: 100, compareAtPrice: null, currency: 'PYG',
  aiNotes: '', categoryId: 'c', images: [], emoji: '🌸', inventory: { stock: 3 }, status: 'ACTIVE',
  featured: false, position: 0, perfume: { brand: 'B', styleTags: [] },
  costPrice: 40, margin: 0.6, // rancios
  ...over,
} as unknown as Product);

describe('ai/salesTools buscar_productos', () => {
  it('usa el tenantId del CONTEXTO e ignora el tenantId malicioso del input; profitMode SIEMPRE false', async () => {
    let seen: { tenantId?: string; filters?: CatalogFilters } = {};
    const deps = {
      searchCatalog: async (tenantId: string, filters: CatalogFilters) => {
        seen = { tenantId, filters };
        return [product({})];
      },
    };
    await buscarProductos.execute('perfumeria', { tenantId: 'boutique-demo', genero: 'Femenino', precioMax: 200 }, deps);
    expect(seen.tenantId).toBe('perfumeria'); // NO boutique-demo
    expect(seen.filters?.profitMode).toBe(false);
    expect(seen.filters?.gender).toBe('Femenino');
    expect(seen.filters?.maxPrice).toBe(200);
  });

  it('F1B: pasa `consulta` como query a searchCatalog (búsqueda por nombre/marca)', async () => {
    let seen: { filters?: CatalogFilters } = {};
    const deps = {
      searchCatalog: async (_t: string, filters: CatalogFilters) => { seen = { filters }; return []; },
    };
    await buscarProductos.execute('perfumeria', { consulta: 'Supremacy', estilo: 'dulce' }, deps);
    expect(seen.filters?.query).toBe('Supremacy');
    expect(seen.filters?.styleTag).toBe('dulce'); // los filtros siguen funcionando
    await buscarProductos.execute('perfumeria', { consulta: '   ' }, deps);
    expect(seen.filters?.query).toBeUndefined(); // consulta vacía no viaja
  });

  it('sanitiza: la salida no incluye costo/margen', async () => {
    const deps = { searchCatalog: async () => [product({ costPrice: 40, margin: 0.6 })] };
    const out = (await buscarProductos.execute('perfumeria', {}, deps)) as Record<string, unknown>[];
    expect(out[0]).toBeDefined();
    expect('costPrice' in out[0]!).toBe(false);
    expect('margin' in out[0]!).toBe(false);
    expect(out[0]!.price).toBe(100);
  });
});

const promo = (over: Partial<Record<string, unknown>>) => ({
  id: 'pr', tenantId: 'X', name: 'Promo', description: 'd', type: 'PERCENTAGE', discountValue: 10,
  objective: 'interno', productIds: ['a'], categoryIds: [], startDate: null, endDate: null, status: 'ACTIVE',
  createdAt: {}, updatedAt: {}, ...over,
} as unknown as Promotion);

describe('ai/salesTools listar_promociones_activas', () => {
  it('oculta las FINISHED y sanitiza (sin objective/productIds)', async () => {
    const deps = {
      listPromotions: async (_t: string) => [promo({ id: 'a', status: 'ACTIVE' }), promo({ id: 'b', status: 'FINISHED' })],
    };
    const out = (await listarPromocionesActivas.execute('perfumeria', {}, deps)) as Record<string, unknown>[];
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('a');
    expect('objective' in out[0]!).toBe(false);
    expect('productIds' in out[0]!).toBe(false);
  });
});
