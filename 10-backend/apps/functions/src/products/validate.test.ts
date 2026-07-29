import { describe, it, expect } from 'vitest';
import { validateProductPatch, validateProductFinancials, validateCategoryPatch } from './validate.js';

describe('validateProductPatch', () => {
  it('whitelist: descarta campos server/sync/entitlements', () => {
    const r = validateProductPatch(
      { name: 'Perfume', price: 100, currency: 'PYG', status: 'ACTIVE', tenantId: 'evil', id: 'x', syncToMeta: true, metaProductItemId: 'm', planId: 'pro', createdAt: 1 },
      { requireName: true },
    );
    expect(r).toEqual({ name: 'Perfume', price: 100, currency: 'PYG', status: 'ACTIVE' });
    expect(r).not.toHaveProperty('tenantId');
    expect(r).not.toHaveProperty('syncToMeta');
    expect(r).not.toHaveProperty('metaProductItemId');
    expect(r).not.toHaveProperty('planId');
  });
  it('name requerido en create; opcional en update', () => {
    expect(() => validateProductPatch({ price: 1 }, { requireName: true })).toThrow();
    expect(validateProductPatch({ price: 1 }, { requireName: false })).toEqual({ price: 1 });
  });
  it('acepta la marca NEUTRAL (brand) con tope de longitud', () => {
    expect(validateProductPatch({ brand: 'Lumen' }, { requireName: false })).toEqual({ brand: 'Lumen' });
    expect(() => validateProductPatch({ brand: 'x'.repeat(201) }, { requireName: false })).toThrow();
    expect(() => validateProductPatch({ brand: 5 }, { requireName: false })).toThrow();
  });
  it('INVARIANTE: los campos server-only JAMÁS entran a la whitelist (quality/meta*/sync)', () => {
    // Si alguien amplía la whitelist con uno de estos, este test tiene que fallar: `quality`
    // es la autoridad del centro de calidad y los meta*/sync gobiernan el outbox — un cliente
    // que pudiera escribirlos falsificaría gates o resucitaría estados.
    const r = validateProductPatch(
      {
        name: 'x',
        quality: { blocking: 0, warning: 0, fingerprints: {}, evaluatedAt: 1 },
        syncToMeta: true,
        metaRetailerId: 'RID',
        metaProductItemId: 'itm',
        metaSyncStatus: 'synced',
        metaSyncCurrentJobId: 'job',
        metaCatalogId: 'cat',
        metaLastSyncAt: 1,
        metaSyncError: '',
        stockPendingReview: false,
        createdAt: 1,
        updatedAt: 1,
      },
      { requireName: true },
    );
    expect(Object.keys(r).sort()).toEqual(['name']);
  });
  it('valida números, enums y coherencia de precio', () => {
    expect(() => validateProductPatch({ name: 'x', price: -1 }, { requireName: true })).toThrow();
    expect(() => validateProductPatch({ name: 'x', currency: 'EUR' }, { requireName: true })).toThrow();
    expect(() => validateProductPatch({ name: 'x', status: 'BORRADO' }, { requireName: true })).toThrow();
    expect(() => validateProductPatch({ name: 'x', price: 100, compareAtPrice: 50 }, { requireName: true })).toThrow();
  });
  it('valida aiFicha (CAT-1): whitelist, topes y null', () => {
    const ficha = {
      cuandoRecomendar: 'busca duración', cuandoNoRecomendar: 'algo suave', objeciones: 'caro → rinde',
      frasesVenta: ['favorito para regalar'], similares: ['Odyssey'], concentracion: 'EDP',
      duracion: '8h', proyeccion: 'fuerte', ocasiones: ['cita'], clima: ['invierno'], perfil: 'juvenil',
      hack: 'descartado', // fuera de whitelist
    };
    const r = validateProductPatch({ name: 'x', aiFicha: ficha }, { requireName: true });
    expect(r.aiFicha).toMatchObject({ cuandoRecomendar: 'busca duración', frasesVenta: ['favorito para regalar'], proyeccion: 'fuerte' });
    expect(r.aiFicha).not.toHaveProperty('hack');
    // la ficha se normaliza COMPLETA (claves ausentes → ''/[]) para que set(merge:true)
    // las pise: si quedaran ausentes, el merge profundo resucitaría el valor viejo al borrar
    const parcial = validateProductPatch({ name: 'x', aiFicha: { perfil: 'juvenil' } }, { requireName: true }).aiFicha as Record<string, unknown>;
    expect(parcial.perfil).toBe('juvenil');
    expect(parcial.objeciones).toBe('');
    expect(parcial.cuandoRecomendar).toBe('');
    expect(parcial.frasesVenta).toEqual([]);
    expect(parcial.similares).toEqual([]);
    // null borra la ficha; tipos y topes se validan
    expect(validateProductPatch({ name: 'x', aiFicha: null }, { requireName: true }).aiFicha).toBeNull();
    expect(() => validateProductPatch({ name: 'x', aiFicha: { cuandoRecomendar: 5 } }, { requireName: true })).toThrow();
    expect(() => validateProductPatch({ name: 'x', aiFicha: { frasesVenta: 'no-es-lista' } }, { requireName: true })).toThrow();
    expect(() => validateProductPatch({ name: 'x', aiFicha: { perfil: 'x'.repeat(501) } }, { requireName: true })).toThrow();
    expect(() => validateProductPatch({ name: 'x', aiFicha: { similares: Array.from({ length: 21 }, () => 'a') } }, { requireName: true })).toThrow();
  });
  it('valida sub-estructuras (inventory, perfume)', () => {
    const r = validateProductPatch({ name: 'x', inventory: { trackStock: true, stock: 5, sku: 'A1' }, perfume: { gender: 'Femenino', sizeMl: 100 } }, { requireName: true });
    expect(r.inventory).toMatchObject({ trackStock: true, stock: 5, sku: 'A1' });
    expect(r.perfume).toMatchObject({ gender: 'Femenino', sizeMl: 100 });
    expect(() => validateProductPatch({ name: 'x', inventory: { stock: -1 } }, { requireName: true })).toThrow();
    expect(() => validateProductPatch({ name: 'x', perfume: { gender: 'Otro' } }, { requireName: true })).toThrow();
    expect(validateProductPatch({ name: 'x', perfume: null }, { requireName: true }).perfume).toBeNull();
  });
});

describe('validateProductFinancials', () => {
  it('valida costo y rangos; permite null', () => {
    expect(validateProductFinancials({ costPrice: 50, priorityScore: 8, maxDiscountPercentage: 20 })).toEqual({ costPrice: 50, priorityScore: 8, maxDiscountPercentage: 20 });
    expect(validateProductFinancials({ costPrice: null })).toEqual({ costPrice: null });
    expect(() => validateProductFinancials({ costPrice: -1 })).toThrow();
    expect(() => validateProductFinancials({ priorityScore: 99 })).toThrow();
    expect(() => validateProductFinancials({ maxDiscountPercentage: 200 })).toThrow();
  });
});

describe('validateCategoryPatch', () => {
  it('whitelist + name requerido en create', () => {
    expect(validateCategoryPatch({ name: 'Perfumes', isActive: true, tenantId: 'evil' }, { requireName: true })).toEqual({ name: 'Perfumes', isActive: true });
    expect(() => validateCategoryPatch({ isActive: true }, { requireName: true })).toThrow();
  });
});
