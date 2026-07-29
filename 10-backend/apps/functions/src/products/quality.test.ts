import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Product, ProductQuality } from '@vpw/shared';
import {
  evaluateProductQuality,
  diffQuality,
  effectiveCatalogPolicy,
  localNameSet,
  normalizeCatalogProfile,
  saleBlockingCodes,
  SALE_BLOCKING_CODES,
} from './quality.js';
import { outboundBrand } from '../meta/catalogOutbound.js';
import { GENERIC_STOPWORDS, PERFUMERIA_STOPWORDS } from '../meta/catalogReconcile.js';

/**
 * META-CATALOG-GENERIC-ONBOARDING-QUALITY-1 — evaluador de calidad PURO del catálogo:
 * BLOCKING derivados de los gates existentes (syncEnableBlockers/createBlockers — jamás
 * una segunda lista), WARNINGs nuevos (genericidad, duplicados locales, incoherencia,
 * sin clasificar, drift remoto), fingerprints estables y merge con historia
 * (firstSeenAt/lastSeenAt/resolvedAt + poda de resueltos viejos).
 */

const T0 = Timestamp.fromMillis(1_700_000_000_000);
const T1 = Timestamp.fromMillis(1_700_000_060_000); // +1 min
const T2 = Timestamp.fromMillis(1_700_000_120_000); // +2 min
const T31D = Timestamp.fromMillis(T2.toMillis() + 31 * 24 * 60 * 60 * 1000);

const TS = T0 as unknown as Product['createdAt'];

/** Producto COMPLETO y sano: sin observaciones activas salvo las que el test rompa. */
const prod = (over: Partial<Product> = {}): Product =>
  ({
    id: 'p1',
    tenantId: 't1',
    name: 'Nova Prime Intense',
    description: 'Nova Prime Intense edición especial con estuche',
    price: 250000,
    compareAtPrice: null,
    aiNotes: '',
    currency: 'PYG',
    categoryId: 'cat-1',
    images: ['https://cdn.test/a.jpg'],
    emoji: '',
    inventory: { trackStock: true, stock: 3, lowStockThreshold: 1, sku: 'nova-prime' },
    status: 'ACTIVE',
    featured: false,
    position: 0,
    externalIds: { facebook: null, instagram: null, tiktok: null },
    perfume: null,
    aiFicha: null,
    productUrl: 'https://tienda.test/p/1',
    brand: 'Lumen',
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }) as Product;

const fps = (q: ProductQuality) => Object.keys(q.fingerprints).sort();
const activos = (q: ProductQuality) =>
  Object.entries(q.fingerprints)
    .filter(([, o]) => o.resolvedAt === null)
    .map(([fp]) => fp)
    .sort();

describe('evaluateProductQuality — BLOCKING derivados de los gates reales', () => {
  it('un importado recién traído tiene not_active y stock_pending_review como BLOCKING', () => {
    const q = evaluateProductQuality(
      prod({ status: 'INACTIVE', stockPendingReview: true, metaRetailerId: 'RID-1' } as Partial<Product>),
      { now: T0 },
    );
    expect(activos(q)).toContain('not_active:status');
    expect(activos(q)).toContain('stock_pending_review:inventory');
    expect(q.fingerprints['not_active:status']!.severity).toBe('BLOCKING');
    expect(q.blocking).toBeGreaterThanOrEqual(2);
  });

  it('name_missing y price_invalid con field correcto y fingerprint estable `${code}:${field}`', () => {
    const q = evaluateProductQuality(prod({ name: '  ', price: 0 }), { now: T0 });
    expect(q.fingerprints['name_missing:name']).toBeDefined();
    expect(q.fingerprints['price_invalid:price']).toBeDefined();
    expect(q.fingerprints['price_invalid:price']!.severity).toBe('BLOCKING');
    // El mensaje y la acción están en español y orientan al vendedor.
    expect(q.fingerprints['name_missing:name']!.message).toMatch(/nombre/i);
    expect(q.fingerprints['name_missing:name']!.action.length).toBeGreaterThan(0);
  });

  it('producto genérico con brand top-level (sin perfume) NO tiene brand_missing (marca neutral)', () => {
    const q = evaluateProductQuality(prod({ brand: 'Lumen', perfume: null }), { now: T0, remoteHasIdentity: false });
    expect(activos(q)).not.toContain('brand_missing:brand');
    expect(q.blocking).toBe(0);
  });

  it('outboundBrand lee la marca neutral con fallback a perfume.brand (contrato de Meta)', () => {
    expect(outboundBrand(prod({ brand: 'Lumen', perfume: null }))).toBe('Lumen');
    expect(outboundBrand(prod({ brand: undefined, perfume: { brand: 'Aris' } as Product['perfume'] }))).toBe('Aris');
    expect(outboundBrand(prod({ brand: undefined, perfume: null }))).toBe('');
  });

  it('ya vinculado (remoteHasIdentity=true): los CREATE-only no aplican (description_missing ausente)', () => {
    const q = evaluateProductQuality(
      prod({ description: '', metaRetailerId: 'RID-9', brand: '' } as Partial<Product>),
      { now: T0, remoteHasIdentity: true, profile: { requireBrand: false } },
    );
    expect(activos(q)).not.toContain('description_missing:description');
    expect(activos(q)).not.toContain('brand_missing:brand');
  });

  it('sin marca en camino de CREATE ⇒ brand_missing BLOCKING (contrato de Meta, no configurable)', () => {
    const q = evaluateProductQuality(prod({ brand: '', perfume: null }), {
      now: T0,
      remoteHasIdentity: false,
      profile: { requireBrand: false },
    });
    expect(q.fingerprints['brand_missing:brand']!.severity).toBe('BLOCKING');
  });

  it('requireBrand (default) agrega brand_missing como WARNING cuando el gate no lo exige', () => {
    // Producto ya vinculado (UPDATE path): el gate no pide marca, el perfil sí como calidad de ficha.
    const conPerfil = evaluateProductQuality(prod({ brand: '', metaRetailerId: 'RID-9' } as Partial<Product>), {
      now: T0,
      remoteHasIdentity: true,
    });
    expect(conPerfil.fingerprints['brand_missing:brand']!.severity).toBe('WARNING');
    const sinRequisito = evaluateProductQuality(prod({ brand: '', metaRetailerId: 'RID-9' } as Partial<Product>), {
      now: T0,
      remoteHasIdentity: true,
      profile: { requireBrand: false },
    });
    expect(sinRequisito.fingerprints['brand_missing:brand']).toBeUndefined();
  });
});

describe('evaluateProductQuality — WARNINGs nuevos', () => {
  it('generic_name: nombre ≈ marca (y se apaga con profile.genericNameCheck=false)', () => {
    const p = prod({ name: 'LUMEN', brand: 'LUMEN' });
    const q = evaluateProductQuality(p, { now: T0 });
    expect(q.fingerprints['generic_name:name']!.severity).toBe('WARNING');
    const off = evaluateProductQuality(p, { now: T0, profile: { genericNameCheck: false } });
    expect(off.fingerprints['generic_name:name']).toBeUndefined();
  });

  it('probable_duplicate: el nombre normalizado ya existe en otro producto local', () => {
    const q = evaluateProductQuality(prod({ name: 'Nova Prime Intense' }), {
      now: T0,
      localNames: new Set(['nova prime intense']),
    });
    expect(q.fingerprints['probable_duplicate:name']!.severity).toBe('WARNING');
    const sin = evaluateProductQuality(prod({ name: 'Nova Prime Intense' }), { now: T0, localNames: new Set(['otra cosa']) });
    expect(sin.fingerprints['probable_duplicate:name']).toBeUndefined();
  });

  it('name_description_mismatch: ningún token del nombre aparece al inicio de la descripción', () => {
    const q = evaluateProductQuality(
      prod({ name: 'Nova Prime', description: 'Juego de puntas magnéticas para taladro con estuche' }),
      { now: T0 },
    );
    expect(q.fingerprints['name_description_mismatch:description']!.severity).toBe('WARNING');
    const coherente = evaluateProductQuality(prod(), { now: T0 });
    expect(coherente.fingerprints['name_description_mismatch:description']).toBeUndefined();
  });

  it('las stopwords del perfil cambian qué tokens cuentan (vertical distinto de perfumería)', () => {
    const p = prod({ name: 'Kit Destornillador', description: 'Juego de puntas magnéticas con estuche' });
    const conDefault = evaluateProductQuality(p, { now: T0 });
    expect(conDefault.fingerprints['name_description_mismatch:description']).toBeDefined();
    // Si el vertical declara esos tokens como ruido comercial, no queda nada que comparar.
    const conPerfil = evaluateProductQuality(p, { now: T0, profile: { stopwords: ['kit', 'destornillador'] } });
    expect(conPerfil.fingerprints['name_description_mismatch:description']).toBeUndefined();
  });

  it('category_unclassified (WARNING) convive con category_missing (BLOCKING del gate)', () => {
    const q = evaluateProductQuality(prod({ categoryId: '' }), { now: T0 });
    expect(q.fingerprints['category_unclassified:categoryId']!.severity).toBe('WARNING');
    expect(q.fingerprints['category_missing:categoryId']!.severity).toBe('BLOCKING');
  });

  it('remote_drift: el remoto difiere del local (y desaparece cuando coinciden)', () => {
    const p = prod();
    const drift = evaluateProductQuality(p, {
      now: T0,
      remoteSnapshot: { name: 'OTRO NOMBRE', priceGs: p.price, description: p.description, imageUrl: p.images[0]! },
    });
    expect(drift.fingerprints['remote_drift:remote']!.severity).toBe('WARNING');
    expect(drift.fingerprints['remote_drift:remote']!.message).toMatch(/name|nombre/i);
    const igual = evaluateProductQuality(p, {
      now: T0,
      remoteSnapshot: { name: p.name, priceGs: p.price, description: p.description, imageUrl: p.images[0]! },
    });
    expect(igual.fingerprints['remote_drift:remote']).toBeUndefined();
  });

  it('HARDEN-1: sin perfil el default es GENERIC — el vocabulario de perfumería NO es ruido', () => {
    // Nombre compuesto SOLO de vocabulario de perfumería, descripción ajena. Sin perfil,
    // 'perfume'/'edp'/'100ml' son tokens REALES (el tenant no declaró el rubro) ⇒
    // incoherencia detectada. Con el perfil explícito 'perfumeria' son ruido ⇒ nada que
    // comparar (comportamiento vigente de arfagi, ahora SOLO por configuración).
    const p = prod({ name: 'Perfume EDP 100ml', brand: '', description: 'Estuche de regalo con lazo dorado' });
    const sinPerfil = evaluateProductQuality(p, { now: T0 });
    expect(sinPerfil.fingerprints['name_description_mismatch:description']).toBeDefined();
    const perfumeria = evaluateProductQuality(p, { now: T0, profile: { vertical: 'perfumeria' } });
    expect(perfumeria.fingerprints['name_description_mismatch:description']).toBeUndefined();
  });

  it('HARDEN-1: perfil inválido/corrupto ⇒ fallback generic seguro (misma política que sin perfil)', () => {
    const p = prod({ name: 'Perfume EDP 100ml', brand: '', description: 'Estuche de regalo con lazo dorado' });
    for (const basura of ['texto', 42, ['x'], { vertical: 'zapatos' }] as unknown[]) {
      const q = evaluateProductQuality(p, { now: T0, profile: normalizeCatalogProfile(basura) });
      expect(q.fingerprints['name_description_mismatch:description']).toBeDefined();
    }
  });
});

describe('evaluateProductQuality — merge con historia (fingerprints)', () => {
  it('firstSeenAt se preserva y lastSeenAt avanza entre corridas', () => {
    const p = prod({ price: 0 });
    const q0 = evaluateProductQuality(p, { now: T0 });
    const q1 = evaluateProductQuality(p, { now: T1, previous: q0 });
    const o = q1.fingerprints['price_invalid:price']!;
    expect(o.firstSeenAt.toMillis()).toBe(T0.toMillis());
    expect(o.lastSeenAt.toMillis()).toBe(T1.toMillis());
    expect(o.resolvedAt).toBeNull();
  });

  it('al corregirse, la observación queda sellada con resolvedAt (histórico, no borrada)', () => {
    const q0 = evaluateProductQuality(prod({ price: 0 }), { now: T0 });
    const q1 = evaluateProductQuality(prod({ price: 150000 }), { now: T1, previous: q0 });
    const o = q1.fingerprints['price_invalid:price']!;
    expect(o.resolvedAt).not.toBeNull();
    expect(o.resolvedAt!.toMillis()).toBe(T1.toMillis());
    expect(q1.blocking).toBe(0); // las resueltas no cuentan
  });

  it('si reaparece, conserva el firstSeenAt original y vuelve a estar activa', () => {
    const q0 = evaluateProductQuality(prod({ price: 0 }), { now: T0 });
    const q1 = evaluateProductQuality(prod({ price: 150000 }), { now: T1, previous: q0 });
    const q2 = evaluateProductQuality(prod({ price: 0 }), { now: T2, previous: q1 });
    const o = q2.fingerprints['price_invalid:price']!;
    expect(o.firstSeenAt.toMillis()).toBe(T0.toMillis());
    expect(o.resolvedAt).toBeNull();
    expect(q2.blocking).toBeGreaterThan(0);
  });

  it('las resueltas hace más de 30 días se podan en el mismo recompute', () => {
    const q0 = evaluateProductQuality(prod({ price: 0 }), { now: T0 });
    const q1 = evaluateProductQuality(prod({ price: 150000 }), { now: T1, previous: q0 });
    expect(fps(q1)).toContain('price_invalid:price'); // recién resuelta: se conserva
    const q2 = evaluateProductQuality(prod({ price: 150000 }), { now: T31D, previous: q1 });
    expect(fps(q2)).not.toContain('price_invalid:price'); // >30 días: podada
  });

  it('blocking/warning cuentan SOLO observaciones activas', () => {
    const q0 = evaluateProductQuality(prod({ price: 0, name: 'LUMEN', brand: 'LUMEN' }), { now: T0 });
    expect(q0.blocking).toBe(1);
    expect(q0.warning).toBeGreaterThanOrEqual(1);
    const q1 = evaluateProductQuality(prod({ price: 200000, name: 'LUMEN', brand: 'LUMEN' }), { now: T1, previous: q0 });
    expect(q1.blocking).toBe(0);
    expect(q1.warning).toBeGreaterThanOrEqual(1);
  });
});

describe('gate de venta + helpers', () => {
  it('SALE_BLOCKING_CODES cubre exactamente name_missing y price_invalid', () => {
    expect([...SALE_BLOCKING_CODES].sort()).toEqual(['name_missing', 'price_invalid']);
  });

  it('saleBlockingCodes devuelve solo los bloqueos de venta ACTIVOS', () => {
    const q0 = evaluateProductQuality(prod({ price: 0 }), { now: T0 });
    expect(saleBlockingCodes(q0)).toEqual(['price_invalid']);
    const q1 = evaluateProductQuality(prod({ price: 100000 }), { now: T1, previous: q0 });
    expect(saleBlockingCodes(q1)).toEqual([]);
  });

  it('diffQuality reporta resueltas y pendientes del recompute', () => {
    const q0 = evaluateProductQuality(prod({ price: 0, categoryId: '' }), { now: T0 });
    const q1 = evaluateProductQuality(prod({ price: 100000, categoryId: '' }), { now: T1, previous: q0 });
    const d = diffQuality(q0, q1);
    expect(d.resueltas.map((o) => o.code)).toEqual(['price_invalid']);
    expect(d.pendientes.map((o) => o.code)).toContain('category_missing');
  });

  it('localNameSet: nombres normalizados sin archivados y sin el propio producto', () => {
    const set = localNameSet(
      [
        { id: 'a', name: 'Nova Prime', status: 'ACTIVE' },
        { id: 'b', name: 'Viejo', status: 'ARCHIVED' },
        { id: 'c', name: 'Zephyr  Mega!', status: 'INACTIVE' },
      ] as Product[],
      'a',
    );
    expect(set.has('nova prime')).toBe(false); // excluido por id
    expect(set.has('viejo')).toBe(false); // archivado
    expect(set.has('zephyr mega')).toBe(true);
  });

  it('normalizeCatalogProfile: valida forma y descarta basura', () => {
    expect(normalizeCatalogProfile(undefined)).toBeNull();
    expect(normalizeCatalogProfile('x')).toBeNull();
    const p = normalizeCatalogProfile({ requireBrand: false, stopwords: ['kit', 3, 'par'], vertical: 'generic', genericNameCheck: true });
    expect(p).toEqual({ requireBrand: false, genericNameCheck: true, stopwords: ['kit', 'par'], vertical: 'generic' });
    expect(normalizeCatalogProfile({ vertical: 'otra' })?.vertical).toBeUndefined();
  });
});

describe('effectiveCatalogPolicy — resolución ÚNICA perfil → política (HARDEN-1)', () => {
  it('sin perfil ⇒ vertical generic con stopwords idiomáticas mínimas (sin vocabulario de rubro)', () => {
    const pol = effectiveCatalogPolicy(null);
    expect(pol.vertical).toBe('generic');
    expect(pol.stopwords).toBe(GENERIC_STOPWORDS);
    expect(pol.stopwords.has('edp')).toBe(false);
    expect(pol.stopwords.has('perfume')).toBe(false);
    expect(pol.stopwords.has('de')).toBe(true); // núcleo idiomático sí
    expect(pol.requireBrand).toBe(true);
    expect(pol.genericNameCheck).toBe(true);
  });

  it('perfil inválido (normalizado a null o sin vertical) ⇒ generic seguro', () => {
    expect(effectiveCatalogPolicy(normalizeCatalogProfile('basura')).vertical).toBe('generic');
    expect(effectiveCatalogPolicy(normalizeCatalogProfile({ vertical: 'zapatos' })).vertical).toBe('generic');
  });

  it("vertical 'perfumeria' explícito activa la plantilla con las stopwords históricas de arfagi", () => {
    const pol = effectiveCatalogPolicy({ vertical: 'perfumeria' });
    expect(pol.vertical).toBe('perfumeria');
    expect(pol.stopwords).toBe(PERFUMERIA_STOPWORDS);
    expect(pol.stopwords.has('edp')).toBe(true);
    expect(pol.stopwords.has('toilette')).toBe(true);
  });

  it('stopwords personalizadas del perfil GANAN sobre la plantilla del vertical', () => {
    const pol = effectiveCatalogPolicy({ vertical: 'perfumeria', stopwords: ['Talle', 'PAR'] });
    expect(pol.stopwords.has('talle')).toBe(true); // normalizadas
    expect(pol.stopwords.has('edp')).toBe(false); // la plantilla NO se mezcla
  });
});
