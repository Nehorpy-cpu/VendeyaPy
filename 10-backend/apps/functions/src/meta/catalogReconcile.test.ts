import { describe, it, expect } from 'vitest';
import type { Product } from '@vpw/shared';
import {
  analyzeRemoteItems,
  buildImportedProduct,
  genderFromProductType,
  parseRemotePriceGs,
  rankMappingCandidates,
  retailerIdLockKey,
  syncEnableBlockers,
  type RemoteCandidate,
} from './catalogReconcile.js';
import type { MetaRemoteCatalogItem } from './catalogClient.js';

/**
 * META-CATALOG-RECONCILIATION-1 — reconciliación con un catálogo de Meta preexistente:
 * flags de calidad, ranking determinístico de candidatos (jamás automático) y construcción
 * del producto importado (INACTIVE, syncToMeta=false, sin costo ni stock inventados).
 */

const TS = { seconds: 0, nanoseconds: 0 } as unknown as Product['createdAt'];

const remote = (over: Partial<MetaRemoteCatalogItem> & { retailerId: string }): MetaRemoteCatalogItem => ({
  id: `itm-${over.retailerId}`,
  name: 'ARMAF ODYSSEY MEGA LIMITED EDITION EDP',
  description: 'Odyssey mega limited edition edp 100ML',
  availability: 'in stock',
  price: '₲130.000',
  imageUrl: 'https://arfagi.com/x.jpg',
  brand: 'ARMAF',
  url: 'https://arfagi.com/?producto_id=258',
  productType: 'Perfumes > Perfume > Masculino',
  ...over,
});

const prod = (over: Partial<Product> & { id: string }): Product =>
  ({
    tenantId: 't1',
    name: 'Armaf Odyssey Mega',
    description: 'perfume fresco para el dia a dia',
    price: 250000,
    compareAtPrice: null,
    aiNotes: '',
    currency: 'PYG',
    categoryId: 'perfumes',
    images: ['https://cdn.test/a.jpg'],
    emoji: '🌸',
    inventory: { trackStock: true, stock: 1, lowStockThreshold: 1, sku: 'armaf-odyssey-mega' },
    status: 'ACTIVE',
    featured: false,
    position: 0,
    externalIds: { facebook: null, instagram: null, tiktok: null },
    perfume: { brand: 'Armaf' } as Product['perfume'],
    aiFicha: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }) as Product;

describe('parseRemotePriceGs', () => {
  it.each([
    ['₲130.000', 130000],
    ['PYG 250,000', 250000],
    ['PYG 250,000.00', 250000],
    ['USD 250', 0], // moneda ajena embebida: no se asume conversión
    ['', 0],
  ])('%s → %i', (raw, expected) => expect(parseRemotePriceGs(raw)).toBe(expected));

  it('la moneda DECLARADA por Meta manda sobre el formato del string', () => {
    // "250.00" formateado sin ISO parecería ₲250 sin este chequeo.
    expect(parseRemotePriceGs('250.00', 'USD')).toBe(0);
    expect(parseRemotePriceGs('₲130.000', 'PYG')).toBe(130000);
  });
});

describe('retailerIdLockKey', () => {
  it('sanea caracteres que romperían un doc path', () => {
    expect(retailerIdLockKey('ARM/744646#5202')).toMatch(/^ARM_744646_5202~[0-9a-f]{12}$/);
  });
  it('es estable para el mismo retailer_id (idempotencia de la importación)', () => {
    expect(retailerIdLockKey('ARM-744646-5202')).toBe(retailerIdLockKey('ARM-744646-5202'));
  });

  it('un id ya seguro queda TAL CUAL (no huerfaniza locks ni productos ya importados)', () => {
    expect(retailerIdLockKey('ARM-744646-5202')).toBe('ARM-744646-5202');
    expect(retailerIdLockKey('  sku_1.2-3  ')).toBe('sku_1.2-3');
  });

  it('dos retailer_id DISTINTOS jamás comparten clave', () => {
    // Colapsarlos dejaba al segundo artículo "ya vinculado a otro producto" para siempre.
    expect(retailerIdLockKey('ARM/1')).not.toBe(retailerIdLockKey('ARM#1'));
    expect(retailerIdLockKey('ARM/1')).not.toBe(retailerIdLockKey('ARM_1'));
    const largoA = `${'X'.repeat(400)}A`;
    const largoB = `${'X'.repeat(400)}B`;
    expect(retailerIdLockKey(largoA)).not.toBe(retailerIdLockKey(largoB));
  });

  it('la clave saneada sigue siendo un id de doc válido', () => {
    const k = retailerIdLockKey('ARM/744646#5202');
    expect(k).not.toContain('/');
    expect(k.length).toBeLessThanOrEqual(400);
  });
});

describe('analyzeRemoteItems — flags de calidad', () => {
  it('nombre = solo la marca ⇒ generic_name', () => {
    const [r] = analyzeRemoteItems([remote({ retailerId: 'ANT-1', name: 'ANTONIO BANDERAS', brand: 'ANTONIO BANDERAS', description: 'King of Seduction es una fragancia masculina' })]);
    expect(r!.flags).toContain('generic_name');
  });

  it('nombre descriptivo real NO se marca como genérico', () => {
    const [r] = analyzeRemoteItems([remote({ retailerId: 'ARM-1' })]);
    expect(r!.flags).not.toContain('generic_name');
  });

  it('artículos con la MISMA descripción ⇒ probable_duplicate mutuo con duplicateOf ordenado', () => {
    const items = analyzeRemoteItems([
      remote({ retailerId: 'SAB-B', name: 'SABRINA', description: 'Sweet tooth caramel dream 250ML' }),
      remote({ retailerId: 'SAB-A', name: 'SABRINA', description: 'Sweet tooth caramel dream 250ML' }),
    ]);
    expect(items[0]!.flags).toContain('probable_duplicate');
    expect(items[1]!.flags).toContain('probable_duplicate');
    expect(items[0]!.duplicateOf).toEqual(['SAB-A']); // determinístico (ordenado), no orden de lectura
  });

  it('perfumes DISTINTOS con el mismo nombre genérico NO son duplicados', () => {
    const items = analyzeRemoteItems([
      remote({ retailerId: 'ANT-1', name: 'ANTONIO BANDERAS', brand: 'ANTONIO BANDERAS', description: 'King of Seduction es una fragancia' }),
      remote({ retailerId: 'ANT-2', name: 'ANTONIO BANDERAS', brand: 'ANTONIO BANDERAS', description: 'Blue Seduction para hombre es fresca' }),
    ]);
    expect(items.every((i) => !i.flags.includes('probable_duplicate'))).toBe(true);
  });

  it('sin marca / sin stock / precio inválido / imagen insegura se marcan y bloquean donde corresponde', () => {
    const [sinMarca] = analyzeRemoteItems([remote({ retailerId: 'A', brand: '' })]);
    expect(sinMarca!.flags).toContain('missing_brand');
    expect(sinMarca!.importable).toBe(true); // no bloquea importar

    const [sinStock] = analyzeRemoteItems([remote({ retailerId: 'B', availability: 'out of stock' })]);
    expect(sinStock!.flags).toContain('out_of_stock');
    expect(sinStock!.importable).toBe(true);

    const [malPrecio] = analyzeRemoteItems([remote({ retailerId: 'C', price: 'USD 100' })]);
    expect(malPrecio!.flags).toContain('invalid_price');
    expect(malPrecio!.importable).toBe(false); // sí bloquea

    const [malImg] = analyzeRemoteItems([remote({ retailerId: 'D', imageUrl: 'http://inseguro/x.jpg' })]);
    expect(malImg!.flags).toContain('image_not_https');
    expect(malImg!.importable).toBe(false);
  });

  it('incoherencia nombre ↔ descripción se marca solo si el nombre NO es genérico', () => {
    const [incoh] = analyzeRemoteItems([remote({ retailerId: 'YAR-1', name: 'YARA LATTAFA', brand: 'LATTAFA', description: 'Tous edp 100ML' })]);
    expect(incoh!.flags).toContain('name_description_mismatch');
  });

  it('extrae el producto_id de negocio de la url', () => {
    const [r] = analyzeRemoteItems([remote({ retailerId: 'X' })]);
    expect(r!.businessId).toBe('258');
  });
});

describe('rankMappingCandidates — sugerencia determinística', () => {
  const candidatos = (items: MetaRemoteCatalogItem[]) => analyzeRemoteItems(items);

  it('el artículo con nombre casi idéntico y misma marca queda primero con confianza alta', () => {
    const out = rankMappingCandidates(
      prod({ id: 'p1' }),
      candidatos([
        remote({ retailerId: 'ANI-1', name: 'ANIMALE', brand: 'ANIMALE', description: 'Un oriental especiado' }),
        remote({ retailerId: 'ARM-744646-5202' }),
      ]),
    );
    expect(out[0]!.retailerId).toBe('ARM-744646-5202');
    expect(out[0]!.confidence).toBe('alta');
    expect(out[0]!.reasons).toContain('misma marca');
  });

  it('avisa la diferencia de precio en los motivos (no la esconde)', () => {
    const out = rankMappingCandidates(prod({ id: 'p1' }), candidatos([remote({ retailerId: 'ARM-744646-5202' })]));
    expect(out[0]!.reasons.some((r) => r.includes('precio distinto'))).toBe(true);
  });

  it('empate de puntaje ⇒ desempata por retailerId (nunca por orden de lectura)', () => {
    const gemelo = (rid: string) => remote({ retailerId: rid, name: 'OTRA COSA', brand: 'OTRA', description: `desc ${rid}` });
    const a = rankMappingCandidates(prod({ id: 'p1' }), candidatos([gemelo('ZZZ-1'), gemelo('AAA-1')]));
    const b = rankMappingCandidates(prod({ id: 'p1' }), candidatos([gemelo('AAA-1'), gemelo('ZZZ-1')]));
    expect(a.map((c) => c.retailerId)).toEqual(b.map((c) => c.retailerId));
    expect(a[0]!.retailerId).toBe('AAA-1');
  });

  it('la descripción discrimina entre artículos HOMÓNIMOS con nombre genérico', () => {
    // Cinco artículos se llaman igual ("ANTONIO BANDERAS"): solo la descripción dice cuál
    // es cuál. El ranking debe elegir el que corresponde al producto local.
    const out = rankMappingCandidates(
      prod({ id: 'p1', name: 'King of Seduction', perfume: { brand: 'Antonio Banderas' } as Product['perfume'] }),
      candidatos([
        remote({ retailerId: 'ANT-BLUE', name: 'ANTONIO BANDERAS', brand: 'ANTONIO BANDERAS', description: 'Blue Seduction para hombre es fresca y magnética' }),
        remote({ retailerId: 'ANT-KING', name: 'ANTONIO BANDERAS', brand: 'ANTONIO BANDERAS', description: 'King of Seduction es una fragancia masculina fresca' }),
        remote({ retailerId: 'ANT-BLACK', name: 'ANTONIO BANDERAS', brand: 'ANTONIO BANDERAS', description: 'Black Seduction combina grosella negra y bergamota' }),
      ]),
    );
    expect(out[0]!.retailerId).toBe('ANT-KING');
    expect(out[0]!.confidence).not.toBe('baja');
  });

  it('cuando la descripción es el único puente, aparece como motivo explícito', () => {
    const out = rankMappingCandidates(
      prod({ id: 'p1', name: 'Amber Oud Gold Edition', perfume: null }),
      candidatos([remote({ retailerId: 'ALH-1', name: 'ALHARAMAIN', brand: 'ALHARAMAIN', description: 'Amber Oud Gold Edition combina una apertura cítrico-verde' })]),
    );
    expect(out[0]!.reasons).toContain('coincide con la descripción del artículo');
  });

  it('Supremacy local NO produce coincidencia alta con Collector\'s Edition (son distintos)', () => {
    const out = rankMappingCandidates(
      prod({ id: 'p2', name: 'Perfume Supremacy Not Only Intense', perfume: { brand: 'Afnan' } as Product['perfume'], price: 250000 }),
      candidatos([remote({ retailerId: 'AFN-745089-0432', name: "Afnan Supremacy Collector's Edition EDP", brand: 'AFNAN', price: '₲350.000', description: "Supremacy Collector's Edition combina frutas frescas" })]),
    );
    expect(out[0]!.confidence).not.toBe('alta');
  });
});

describe('buildImportedProduct — invariantes de importación', () => {
  const item: RemoteCandidate = analyzeRemoteItems([remote({ retailerId: 'ARM-9', price: '₲180.000' })])[0]!;
  const built = buildImportedProduct(item, { productId: 'newid', tenantId: 't1', categoryId: 'perfumes', catalogId: 'CAT1', position: 5 });

  it('siempre INACTIVE (el bot no puede ofrecerlo)', () => expect(built.status).toBe('INACTIVE'));
  it('siempre syncToMeta=false (no puede modificar ni apagar Meta)', () => expect(built.syncToMeta).toBe(false));
  it('conserva la identidad remota sin tocar nada más', () => {
    expect(built.metaRetailerId).toBe('ARM-9');
    expect(built.metaProductItemId).toBe('itm-ARM-9');
    expect(built.metaCatalogId).toBe('CAT1');
  });
  it('no inventa stock: trackStock=false y marca pendiente de revisión', () => {
    expect(built.inventory.trackStock).toBe(false);
    expect(built.inventory.stock).toBe(0);
    expect(built.stockPendingReview).toBe(true);
  });
  it('no inventa costo: el objeto no contiene ningún campo de costo', () => {
    expect(JSON.stringify(built)).not.toMatch(/costPrice|cost|margin/i);
  });
  it('importa solo campos públicos con precio parseado y moneda PYG', () => {
    expect(built.price).toBe(180000);
    expect(built.currency).toBe('PYG');
    expect(built.images).toEqual(['https://arfagi.com/x.jpg']);
  });
  it('deriva el género de la taxonomía de Meta', () => {
    expect(genderFromProductType('Perfumes > Perfume > Masculino')).toBe('Masculino');
    expect(genderFromProductType('Perfumes > Perfume > Femenino')).toBe('Femenino');
    expect(genderFromProductType('Perfumes > Perfume > Unisex')).toBe('Unisex');
    expect(genderFromProductType('')).toBeNull();
  });
});

describe('syncEnableBlockers — gates de habilitación', () => {
  const ok = prod({ id: 'p1', metaRetailerId: 'ARM-1', perfume: { brand: 'Armaf' } as Product['perfume'], productUrl: 'https://arfagi.com/p/1' });

  it('un producto completo y ACTIVO no tiene bloqueos', () => expect(syncEnableBlockers(ok)).toEqual([]));

  // -------------------------------------------------------------------------
  // El gate y el planificador tienen que coincidir: habilitar un producto que el
  // planificador va a bloquear para siempre es prometerle al dueño algo que no va a pasar.
  // -------------------------------------------------------------------------

  it.each([
    ['sin URL de producto', { productUrl: undefined }, 'product_url_missing'],
    ['URL no https', { productUrl: 'http://arfagi.com/p/1' }, 'product_url_not_https'],
    ['sin descripción', { description: '   ' }, 'description_missing'],
    ['sin marca', { perfume: null }, 'brand_missing'],
  ])('CREAR en Meta exige los obligatorios del contrato: %s ⇒ %s', (_l, over, expected) => {
    const p = prod({ id: 'p1', metaRetailerId: 'ARM-NUEVO', perfume: { brand: 'Armaf' } as Product['perfume'], productUrl: 'https://arfagi.com/p/1', ...over });
    expect(syncEnableBlockers(p, { remoteHasIdentity: false })).toContain(expected as never);
  });

  it.each([
    ['sin URL de producto', { productUrl: undefined }],
    ['sin descripción', { description: '   ' }],
    ['sin marca', { perfume: null }],
  ])('ACTUALIZAR un artículo que YA existe en Meta no exige obligatorios de creación: %s', (_l, over) => {
    // El artículo ya está publicado en Meta con esos datos: un UPDATE parcial no los manda.
    const p = prod({ id: 'p1', metaRetailerId: 'ARM-1', perfume: { brand: 'Armaf' } as Product['perfume'], productUrl: 'https://arfagi.com/p/1', ...over });
    expect(syncEnableBlockers(p, { remoteHasIdentity: true })).toEqual([]);
  });

  it('una identidad de más de 100 caracteres bloquea en AMBOS caminos', () => {
    const p = prod({ id: 'p1', metaRetailerId: 'X'.repeat(101), perfume: { brand: 'Armaf' } as Product['perfume'], productUrl: 'https://arfagi.com/p/1' });
    expect(syncEnableBlockers(p, { remoteHasIdentity: false })).toContain('identity_too_long');
    expect(syncEnableBlockers(p, { remoteHasIdentity: true })).toContain('identity_too_long');
  });

  it('EL GATE ANTI-APAGADO: sin vínculo confirmado pero con el SKU ya en Meta ⇒ bloqueado', () => {
    // Escenario: el SKU local coincide con un retailer_id vivo de Meta por casualidad (o
    // porque alguien lo copió). Habilitarlo reclamaría ese artículo sin confirmación humana
    // y, si el producto no fuera vendible, lo APAGARÍA.
    const sinVinculo = prod({ id: 'p1', perfume: { brand: 'Armaf' } as Product['perfume'], inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'ARM-744646-5202' } });
    expect(syncEnableBlockers(sinVinculo, { remoteHasIdentity: true })).toContain('unconfirmed_remote_match');
    // Con vínculo confirmado, el mismo caso está permitido (alguien lo confirmó).
    expect(syncEnableBlockers({ ...sinVinculo, metaRetailerId: 'ARM-744646-5202' }, { remoteHasIdentity: true })).toEqual([]);
  });

  it('producto ACTIVE pero sin stock ⇒ not_sellable_now (no se habilita para publicarlo agotado)', () => {
    const agotado = prod({ id: 'p1', metaRetailerId: 'ARM-1', perfume: { brand: 'Armaf' } as Product['perfume'], inventory: { trackStock: true, stock: 0, lowStockThreshold: 1, sku: 's' } });
    expect(syncEnableBlockers(agotado)).toContain('not_sellable_now');
  });

  it('la marca no se exige por rubro, sino porque Meta la pide para CREAR', () => {
    // Nada acá conoce "perfumería": el requisito viene del contrato de escritura, y solo
    // cuando el artículo todavía no existe en Meta.
    const sinMarca = prod({ id: 'p1', metaRetailerId: 'ARM-1', perfume: null, productUrl: 'https://arfagi.com/p/1' });
    expect(syncEnableBlockers(sinMarca, { remoteHasIdentity: true })).toEqual([]);
  });

  it('el importado trae el enlace que Meta ya publica (no se inventa)', () => {
    const imp = buildImportedProduct(
      analyzeRemoteItems([remote({ retailerId: 'ARM-9', url: 'https://ARFAGI.com/?producto_id=258' })])[0]!,
      { productId: 'x', tenantId: 't1', categoryId: 'perfumes', catalogId: 'C', position: 0 },
    );
    expect(imp.productUrl).toBe('https://arfagi.com/?producto_id=258');
    // Sin url remota queda vacío: el gate lo pedirá antes de habilitar la sincronización.
    const sinUrl = buildImportedProduct(
      analyzeRemoteItems([remote({ retailerId: 'ARM-9', url: '' })])[0]!,
      { productId: 'x', tenantId: 't1', categoryId: 'perfumes', catalogId: 'C', position: 0 },
    );
    expect(sinUrl.productUrl).toBe('');
  });

  it('un producto recién importado NUNCA se puede habilitar solo', () => {
    const importado = buildImportedProduct(
      analyzeRemoteItems([remote({ retailerId: 'ARM-9' })])[0]!,
      { productId: 'x', tenantId: 't1', categoryId: 'perfumes', catalogId: 'C', position: 0 },
    ) as unknown as Product & { stockPendingReview: boolean };
    const blockers = syncEnableBlockers(importado);
    expect(blockers).toContain('not_active');
    expect(blockers).toContain('stock_pending_review');
  });

  it.each([
    ['sin nombre', { name: '  ' }, 'name_missing'],
    ['precio 0', { price: 0 }, 'price_invalid'],
    ['moneda ajena', { currency: 'USD' as Product['currency'] }, 'currency_not_pyg'],
    ['imagen insegura', { images: ['http://x/a.jpg'] }, 'image_not_https'],
    ['sin categoría', { categoryId: '' }, 'category_missing'],
  ])('%s ⇒ %s', (_l, over, expected) => {
    expect(syncEnableBlockers(prod({ id: 'p1', metaRetailerId: 'ARM-1', perfume: { brand: 'Armaf' } as Product['perfume'], ...over }))).toContain(expected as never);
  });

  it('sin identidad remota ni SKU ⇒ no_identity', () => {
    expect(syncEnableBlockers(prod({ id: 'p1', perfume: { brand: 'A' } as Product['perfume'], inventory: { trackStock: false, stock: 0, lowStockThreshold: 0, sku: '' } }))).toContain('no_identity');
  });
});
