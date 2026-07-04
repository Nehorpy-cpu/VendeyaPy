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
  it('expone solo la whitelist pública (precio/marca/estilo/disponibilidad/descripción)', () => {
    const out = sanitizeProduct(rogueProduct);
    expect(out).toEqual({
      id: 'p1', name: 'Good Girl', brand: 'Carolina Herrera', price: 250000, compareAtPrice: 300000,
      currency: 'PYG', description: 'd', styleTags: ['dulce', 'floral'], available: true, lowStock: true, featured: true, aiNotes: 'best seller',
    });
  });

  it('F1B: la descripción se trunca a 200 chars (control de payload/tokens)', () => {
    const p = { ...rogueProduct, description: 'x'.repeat(500) } as unknown as Product;
    expect(sanitizeProduct(p).description).toHaveLength(200);
    const sinDesc = { ...rogueProduct, description: undefined } as unknown as Product;
    expect(sanitizeProduct(sinDesc).description).toBe('');
  });

  it('F1B: aiNotes también tiene tope (300) y el truncado no parte emojis (code points)', () => {
    const p = { ...rogueProduct, aiNotes: 'n'.repeat(999) } as unknown as Product;
    expect(Array.from(sanitizeProduct(p).aiNotes)).toHaveLength(300);
    // emoji justo en el borde del truncado → no queda un surrogate suelto
    const conEmoji = { ...rogueProduct, description: 'x'.repeat(199) + '😀y' } as unknown as Product;
    const desc = sanitizeProduct(conEmoji).description;
    expect(Array.from(desc)).toHaveLength(200);
    expect(/[\uD800-\uDBFF]$/.test(desc)).toBe(false); // sin lone surrogate al final
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

  // ===== CAT-2: ficha estructurada compacta =====

  it('CAT-2: sin aiFicha ni datos de perfumería extra → el campo `ficha` NO viaja', () => {
    // rogueProduct no tiene aiFicha/olfactiveFamily/notes → payload idéntico al de F1B.
    expect('ficha' in sanitizeProduct(rogueProduct)).toBe(false);
  });

  it('CAT-2: la ficha viaja completa y compacta (aiFicha + familia + pirámide), sin vacíos', () => {
    const p = {
      ...rogueProduct,
      perfume: {
        ...(rogueProduct.perfume ?? {}), olfactiveFamily: 'Cítrico',
        notes: { top: ['naranja', 'limón'], heart: ['piña'], base: [] },
      },
      aiFicha: {
        concentracion: 'EDP', duracion: '5-6 horas', proyeccion: 'moderada',
        ocasiones: ['diario', 'oficina'], clima: ['verano'], perfil: 'juvenil',
        cuandoRecomendar: 'busca algo fresco', cuandoNoRecomendar: 'quiere para la noche',
        objeciones: '"es suave" → ideal oficina', frasesVenta: ['El fresco favorito'],
        similares: ['Otro Cítrico'],
      },
    } as unknown as Product;
    const ficha = sanitizeProduct(p).ficha!;
    expect(ficha).toMatchObject({
      concentracion: 'EDP', familia: 'Cítrico', duracion: '5-6 horas', proyeccion: 'moderada',
      ocasiones: ['diario', 'oficina'], clima: ['verano'], perfil: 'juvenil',
      cuandoRecomendar: 'busca algo fresco', cuandoNoRecomendar: 'quiere para la noche',
    });
    expect(ficha.notas).toEqual({ salida: ['naranja', 'limón'], corazon: ['piña'] }); // base vacía NO viaja
    expect('fondo' in (ficha.notas ?? {})).toBe(false);
  });

  it('CAT-2: topes por campo — textos a 160, listas a 6 items de 40 chars', () => {
    const p = {
      ...rogueProduct,
      aiFicha: {
        cuandoRecomendar: 'x'.repeat(500),
        ocasiones: Array.from({ length: 12 }, (_, i) => `ocasión-${i}-` + 'y'.repeat(80)),
      },
    } as unknown as Product;
    const ficha = sanitizeProduct(p).ficha!;
    expect(Array.from(ficha.cuandoRecomendar!)).toHaveLength(160);
    expect(ficha.ocasiones).toHaveLength(6);
    for (const o of ficha.ocasiones!) expect(Array.from(o).length).toBeLessThanOrEqual(40);
  });

  it('CAT-2: el payload con ficha máxima queda acotado (compacto para el modelo)', () => {
    const maxFicha = Object.fromEntries([
      ...['concentracion', 'duracion', 'proyeccion', 'perfil', 'cuandoRecomendar', 'cuandoNoRecomendar', 'objeciones'].map((k) => [k, 'z'.repeat(500)]),
      ...['ocasiones', 'clima', 'frasesVenta', 'similares'].map((k) => [k, Array.from({ length: 20 }, () => 'w'.repeat(200))]),
    ]);
    const p = {
      ...rogueProduct,
      description: 'd'.repeat(5000), aiNotes: 'n'.repeat(5000),
      perfume: { ...(rogueProduct.perfume ?? {}), olfactiveFamily: 'f'.repeat(500), notes: { top: Array(50).fill('nota-larguisima-de-prueba'), heart: [], base: [] } },
      aiFicha: maxFicha,
    } as unknown as Product;
    // Cota generosa pero real: 1 producto ≲ 3.5KB ⇒ 5 resultados ≲ 18KB de payload de tool.
    expect(JSON.stringify(sanitizeProduct(p)).length).toBeLessThan(3500);
  });

  it('CAT-2: la ficha NUNCA incluye datos privados aunque el doc los tenga', () => {
    const p = { ...rogueProduct, aiFicha: { duracion: '8h', costPrice: 90000, margen: 0.5 } } as unknown as Product;
    const ficha = sanitizeProduct(p).ficha as Record<string, unknown>;
    expect(ficha.duracion).toBe('8h');
    expect('costPrice' in ficha).toBe(false);
    expect('margen' in ficha).toBe(false);
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
