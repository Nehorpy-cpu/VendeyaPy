import { describe, it, expect } from 'vitest';
import { componerResultados, type CatalogFilters } from './search.js';
import type { Product } from '@vpw/shared';

/**
 * F7: fidelidad estricta en consultas por producto/marca. El bug de prod: "¿qué perfumes tienen
 * que sean X?" devolvía el match + relleno por similitud, y la IA presentó el relleno como si
 * fuera de la marca consultada. Catálogo GENÉRICO: la lógica no conoce marcas ni tenants.
 */

const prod = (over: Partial<Product> & { name: string }): Product =>
  ({
    id: over.name.toLowerCase().replace(/\s+/g, '-'),
    tenantId: 't1',
    description: '',
    price: 100000,
    compareAtPrice: null,
    currency: 'PYG',
    status: 'ACTIVE',
    featured: false,
    inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: over.name },
    ...over,
  }) as unknown as Product;

// Catálogo genérico: 2 productos de la marca "Lumen", 1 de "Aris", 1 sin marca.
const lumenPrime = prod({ name: 'Nova Prime', perfume: { brand: 'Lumen', gender: 'Unisex', styleTags: ['fresco'], olfactiveFamily: '', notes: { top: [], heart: [], base: [] }, priceRange: 'MID', sizeMl: null, isNew: false } as Product['perfume'] });
const lumenNoir = prod({ name: 'Nova Noir Intense', perfume: { brand: 'Lumen', gender: 'Unisex', styleTags: ['intenso'], olfactiveFamily: '', notes: { top: [], heart: [], base: [] }, priceRange: 'MID', sizeMl: null, isNew: false } as Product['perfume'] });
const arisMega = prod({ name: 'Zephyr Mega', perfume: { brand: 'Aris', gender: 'Unisex', styleTags: ['fresco', 'dulce'], olfactiveFamily: '', notes: { top: [], heart: [], base: [] }, priceRange: 'MID', sizeMl: null, isNew: false } as Product['perfume'] });
const simple = prod({ name: 'Esencia Clara' });

const catalogo = [lumenPrime, lumenNoir, arisMega, simple];
const buscar = (filters: CatalogFilters) => componerResultados(catalogo, filters).map((p) => p.name);

describe('catalog/search componerResultados — F7 fidelidad estricta', () => {
  it('BUG PROD: consulta por nombre devuelve SOLO la coincidencia, sin relleno por similitud', () => {
    // Antes: [Nova Prime, <relleno hasta limit>] — el relleno se presentaba como "otra opción Nova".
    expect(buscar({ query: 'que tienen que sea prime', texto: 'que tienen que sea prime', limit: 3 })).toEqual(['Nova Prime']);
  });

  it('variantes de la MISMA familia de nombre sí acompañan (coincidencia real, no relleno)', () => {
    // "nova" identifica a ambos Nova (como "Good Girl" / "Good Girl Suprême") — lo prohibido es
    // el relleno cross-entidad (Zephyr/Esencia jamás aparecen para "nova").
    const res = buscar({ query: 'nova prime', limit: 3 });
    expect(res[0]).toBe('Nova Prime'); // la cobertura del nombre exacto gana el orden
    expect(res).not.toContain('Zephyr Mega');
    expect(res).not.toContain('Esencia Clara');
  });

  it('consulta directa por el otro producto devuelve ese producto', () => {
    expect(buscar({ query: 'tenes el zephyr?', texto: 'tenes el zephyr?', limit: 3 })).toEqual(['Zephyr Mega']);
  });

  it('marca con VARIOS productos devuelve solo los de esa marca', () => {
    const res = buscar({ query: 'mostrame los lumen', limit: 3 });
    expect(res).toHaveLength(2);
    expect(res).toContain('Nova Prime');
    expect(res).toContain('Nova Noir Intense');
    expect(res).not.toContain('Zephyr Mega');
  });

  it('normalización: mayúsculas, acentos y puntuación no rompen la coincidencia', () => {
    expect(buscar({ query: '¿Tenés el ZÉPHYR?', limit: 3 })).toEqual(['Zephyr Mega']);
    const res = buscar({ query: '  PRIME!!! ', limit: 3 });
    expect(res).toEqual(['Nova Prime']);
  });

  it('similitud explícita (allowSimilar) SÍ permite acompañar con alternativas', () => {
    const res = buscar({ query: 'algo parecido al zephyr', texto: 'algo parecido al zephyr', limit: 3, allowSimilar: true });
    expect(res[0]).toBe('Zephyr Mega'); // el consultado primero (pinned)
    expect(res.length).toBeGreaterThan(1); // y alternativas detrás
  });

  it('sin coincidencia estricta: devuelve alternativas rankeadas (el caller las etiqueta)', () => {
    const res = buscar({ query: 'tienen algo de marcainventada?', texto: 'algo dulce', limit: 3 });
    expect(res.length).toBeGreaterThan(0);
    expect(res).not.toContain('marcainventada');
  });

  it('respeta limit también en coincidencias estrictas', () => {
    expect(buscar({ query: 'lumen', limit: 1 })).toHaveLength(1);
  });

  it('los filtros explícitos (precio) siguen aplicando antes del pinning', () => {
    const caro = prod({ name: 'Nova Lux', price: 900000, perfume: { brand: 'Lumen', gender: 'Unisex', styleTags: [], olfactiveFamily: '', notes: { top: [], heart: [], base: [] }, priceRange: 'LUJO', sizeMl: null, isNew: false } as Product['perfume'] });
    const res = componerResultados([...catalogo, caro], { query: 'nova', maxPrice: 200000, limit: 5 }).map((p) => p.name);
    expect(res).toContain('Nova Prime');
    expect(res).not.toContain('Nova Lux'); // filtrado por precio aunque matchee el nombre
  });
});

describe('catalog/search componerResultados — F7 review: gate de entidad', () => {
  const dulceTentacion = prod({ name: 'Dulce Tentación', perfume: { brand: 'Lumen', gender: 'Femenino', styleTags: ['dulce'], olfactiveFamily: '', notes: { top: [], heart: [], base: [] }, priceRange: 'MID', sizeMl: null, isNew: false } as Product['perfume'] });

  it('colisión de ESTILO en el nombre no dispara la fidelidad estricta (búsqueda por tipo)', () => {
    const res = componerResultados([...catalogo, dulceTentacion], { query: 'algo dulce', texto: 'algo dulce', limit: 3 }).map((p) => p.name);
    expect(res[0]).toBe('Dulce Tentación'); // pinned primero (orden F1B, como siempre)
    expect(res.length).toBeGreaterThan(1); // pero NO recorta: sigue siendo un listado por estilo
  });

  it('entidad + estilo en la misma consulta: solo coincidencias reales de lo pedido, sin relleno', () => {
    // "tenés zephyr o algo dulce" pide DOS cosas: el Zephyr (entidad) y lo dulce (estilo con
    // match de nombre). Ambos son coincidencias reales; lo prohibido es el relleno no pedido.
    const res = componerResultados([...catalogo, dulceTentacion], { query: 'tenes zephyr o algo dulce', texto: 'algo dulce', limit: 3 }).map((p) => p.name);
    expect(res[0]).toBe('Zephyr Mega'); // la entidad nombrada gana el orden
    expect(res).toContain('Dulce Tentación');
    expect(res).not.toContain('Nova Prime');
    expect(res).not.toContain('Esencia Clara');
  });
});
