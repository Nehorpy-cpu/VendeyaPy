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

  it('CAT-2: pasa `consulta` también como `texto` (ranking por ficha) y la salida incluye la ficha compacta', async () => {
    let seen: { filters?: CatalogFilters } = {};
    const conFicha = product({
      aiFicha: { duracion: '8-10', proyeccion: 'fuerte', ocasiones: ['noche'], cuandoNoRecomendar: 'para oficina' },
      perfume: { brand: 'B', styleTags: [], olfactiveFamily: 'Oriental', notes: { top: ['piña'], heart: [], base: [] } },
    });
    const deps = {
      searchCatalog: async (_t: string, filters: CatalogFilters) => { seen = { filters }; return [conFicha]; },
    };
    const out = (await buscarProductos.execute('perfumeria', { consulta: 'para salir de noche' }, deps)) as Array<Record<string, unknown>>;
    expect(seen.filters?.texto).toBe('para salir de noche');
    const ficha = out[0]!.ficha as Record<string, unknown>;
    expect(ficha).toMatchObject({ duracion: '8-10', proyeccion: 'fuerte', ocasiones: ['noche'], cuandoNoRecomendar: 'para oficina', familia: 'Oriental' });
    expect(ficha.notas).toEqual({ salida: ['piña'] });
  });

  it('CAT-2: producto sin ficha → el campo `ficha` no viaja (payload compacto, legacy intacto)', async () => {
    const deps = { searchCatalog: async () => [product({})] };
    const out = (await buscarProductos.execute('perfumeria', {}, deps)) as Array<Record<string, unknown>>;
    expect('ficha' in out[0]!).toBe(false);
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

/**
 * F7 (fidelidad de marca/nombre): la pertenencia es DETERMINÍSTICA — cada resultado viaja marcado
 * `coincidencia: exacta|alternativa` (mismo matcher que el pinning) y la similitud explícita
 * ("parecido a X") habilita `allowSimilar`. El bug de prod: consulta "Supremacy" devolvió también
 * Odyssey y la IA lo presentó como "opción Supremacy".
 */
describe('ai/salesTools buscar_productos — F7 fidelidad de marca/nombre', () => {
  const nova = product({ id: 'nova', name: 'Nova Prime', perfume: { brand: 'Lumen', styleTags: [] } });
  const zephyr = product({ id: 'zephyr', name: 'Zephyr Mega', perfume: { brand: 'Aris', styleTags: [] } });

  it('consulta directa: NO habilita allowSimilar y marca exacta/alternativa por matcher', async () => {
    let seen: { filters?: CatalogFilters } = {};
    const deps = {
      searchCatalog: async (_t: string, filters: CatalogFilters) => { seen = { filters }; return [nova]; },
    };
    const out = (await buscarProductos.execute('perfumeria', { consulta: '¿tenés el Nova Prime?' }, deps)) as Array<Record<string, unknown>>;
    expect(seen.filters?.allowSimilar).toBe(false);
    expect(out[0]!.coincidencia).toBe('exacta');
  });

  it('pedido de similares: habilita allowSimilar y las no-coincidencias van como alternativa', async () => {
    let seen: { filters?: CatalogFilters } = {};
    const deps = {
      searchCatalog: async (_t: string, filters: CatalogFilters) => { seen = { filters }; return [nova, zephyr]; },
    };
    const out = (await buscarProductos.execute('perfumeria', { consulta: 'algo parecido al nova' }, deps)) as Array<Record<string, unknown>>;
    expect(seen.filters?.allowSimilar).toBe(true);
    expect(out.find((p) => p.id === 'nova')!.coincidencia).toBe('exacta');
    expect(out.find((p) => p.id === 'zephyr')!.coincidencia).toBe('alternativa');
  });

  it('sin coincidencia real: TODOS los resultados van marcados alternativa', async () => {
    const deps = { searchCatalog: async () => [nova, zephyr] };
    const out = (await buscarProductos.execute('perfumeria', { consulta: 'tienen algo de marcafantasma?' }, deps)) as Array<Record<string, unknown>>;
    expect(out.every((p) => p.coincidencia === 'alternativa')).toBe(true);
  });

  it('sin consulta: no viaja el campo coincidencia (recomendación general)', async () => {
    const deps = { searchCatalog: async () => [nova] };
    const out = (await buscarProductos.execute('perfumeria', { estilo: 'dulce' }, deps)) as Array<Record<string, unknown>>;
    expect('coincidencia' in out[0]!).toBe(false);
  });

  it('normalización: acentos/mayúsculas/puntuación no rompen la marca de pertenencia', async () => {
    const deps = { searchCatalog: async () => [nova] };
    const out = (await buscarProductos.execute('perfumeria', { consulta: '¿NÓVA prime?!' }, deps)) as Array<Record<string, unknown>>;
    expect(out[0]!.coincidencia).toBe('exacta');
  });
});

describe('ai/salesTools buscar_productos — F7 review: gate de entidad y fueraDeFiltros', () => {
  const nova2 = product({ id: 'nova', name: 'Nova Prime', perfume: { brand: 'Lumen', styleTags: [] } });
  const zephyr2 = product({ id: 'zephyr', name: 'Zephyr Mega', perfume: { brand: 'Aris', styleTags: [] } });

  it('consulta GENÉRICA (estilo/ocasión): el campo coincidencia NO viaja', async () => {
    const deps = { searchCatalog: async () => [nova2, zephyr2] };
    const out = (await buscarProductos.execute('perfumeria', { consulta: 'algo dulce para la noche' }, deps)) as Array<Record<string, unknown>>;
    expect(out.every((p) => 'coincidencia' in p === false)).toBe(true);
  });

  it('coincidencia excluida por PRECIO: viaja primero, exacta + fueraDeFiltros (nunca "no lo tenemos")', async () => {
    const caro = product({ id: 'caro', name: 'Nova Lux', price: 900000, perfume: { brand: 'Lumen', styleTags: [] } });
    const deps = {
      searchCatalog: async (_t: string, filters: CatalogFilters) => (filters.maxPrice ? [zephyr2] : [caro]),
    };
    const out = (await buscarProductos.execute('perfumeria', { consulta: '¿tenés el nova lux?', precioMax: 200000 }, deps)) as Array<Record<string, unknown>>;
    expect(out[0]!.name).toBe('Nova Lux');
    expect(out[0]!.coincidencia).toBe('exacta');
    expect(out[0]!.fueraDeFiltros).toBe(true);
    expect(out.find((p) => p.id === 'zephyr')!.coincidencia).toBe('alternativa');
  });

  it('coincidencia excluida por GÉNERO: mismo rescate', async () => {
    const masc = product({ id: 'masc', name: 'Nova Homme', perfume: { brand: 'Lumen', gender: 'Masculino', styleTags: [] } });
    const deps = {
      searchCatalog: async (_t: string, filters: CatalogFilters) => (filters.gender ? [] : [masc]),
    };
    const out = (await buscarProductos.execute('perfumeria', { consulta: 'nova homme para mujer', genero: 'Femenino' }, deps)) as Array<Record<string, unknown>>;
    expect(out[0]!.name).toBe('Nova Homme');
    expect(out[0]!.fueraDeFiltros).toBe(true);
  });
});
