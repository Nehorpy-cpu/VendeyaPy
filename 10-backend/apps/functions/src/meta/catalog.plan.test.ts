import { describe, it, expect } from 'vitest';
import type { Product } from '@vpw/shared';
import { localPublicView, planCatalogSync, priceEquals, productAvailability } from './catalog.js';
import type { MetaRemoteCatalogItem } from './catalogClient.js';

/**
 * META-CATALOG-LIVE-1 — plan y payload PUROS:
 *  - payload solo con campos públicos (jamás costo/margen/aiNotes/aiFicha);
 *  - matching SOLO por retailer_id === SKU; nombre = sugerencia que BLOQUEA;
 *  - SKU vacío/duplicado, moneda ≠ PYG, precio inválido e imagen no-HTTPS bloquean;
 *  - disponibilidad por stock/ARCHIVED; jamás una acción 'delete'.
 */

const TS = { seconds: 0, nanoseconds: 0 } as unknown as Product['createdAt'];

const prod = (over: Partial<Product> & { id: string }): Product =>
  ({
    tenantId: 't1',
    name: 'Perfume A',
    description: 'Descripción pública',
    price: 250000,
    compareAtPrice: null,
    aiNotes: 'NOTA-INTERNA-DE-VENTA',
    currency: 'PYG',
    categoryId: 'c1',
    images: ['https://cdn.example.com/a.jpg'],
    emoji: '🌸',
    inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'SKU-A' },
    // Opt-in explícito: sin esto el producto queda FUERA del plan (fail-closed). Los tests
    // de este archivo prueban el comportamiento de los productos YA gestionados.
    syncToMeta: true,
    status: 'ACTIVE',
    featured: false,
    position: 0,
    externalIds: { facebook: null, instagram: null, tiktok: null },
    // Marca y URL: obligatorias del contrato de CREACIÓN de Meta. Sin ellas todo `create`
    // queda bloqueado (META-CATALOG-OUTBOUND-CONTRACT-1), así que el producto base las trae.
    perfume: { brand: 'MarcaTest' },
    productUrl: 'https://tienda.test/p/sku-a',
    aiFicha: { cuandoRecomendar: 'FICHA-INTERNA' },
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }) as Product;

const remote = (over: Partial<MetaRemoteCatalogItem> = {}): MetaRemoteCatalogItem => ({
  id: 'itm-1',
  retailerId: 'SKU-A',
  name: 'Perfume A',
  description: 'Descripción pública',
  availability: 'in stock',
  price: '₲250.000',
  imageUrl: 'https://cdn.example.com/a.jpg',
  brand: 'MarcaTest', // espeja la marca del producto base: si difiere, el diff marca `brand`
  url: 'https://tienda.test/p/sku-a', // espeja productUrl: la URL entra al diff
  ...over,
});

describe('localPublicView — vista de LECTURA para el diff (solo campos públicos)', () => {
  it('contiene EXACTAMENTE los campos públicos permitidos, con precio "N PYG" y condition new', () => {
    const payload = localPublicView(prod({ id: 'p1', perfume: null }));
    expect(Object.keys(payload).sort()).toEqual(['availability', 'condition', 'description', 'image_url', 'name', 'price', 'retailer_id', 'url']);
    expect(payload).toMatchObject({
      retailer_id: 'SKU-A',
      name: 'Perfume A',
      description: 'Descripción pública',
      price: '250000 PYG',
      condition: 'new',
      availability: 'in stock',
      image_url: 'https://cdn.example.com/a.jpg',
    });
  });

  it('agrega brand solo si el producto tiene marca', () => {
    const payload = localPublicView(prod({ id: 'p1', perfume: { brand: 'Armaf' } as Product['perfume'] }));
    expect(payload.brand).toBe('Armaf');
  });

  it('JAMÁS filtra datos internos: ni aiNotes, ni aiFicha, ni costo/margen', () => {
    const payload = localPublicView(prod({ id: 'p1', perfume: null }));
    const json = JSON.stringify(payload);
    expect(json).not.toContain('NOTA-INTERNA');
    expect(json).not.toContain('FICHA-INTERNA');
    expect(json).not.toMatch(/aiNotes|aiFicha|cost|margin|costPrice/i);
  });

  it('disponibilidad: ACTIVE+stock ⇒ in stock; sin stock / INACTIVE / ARCHIVED ⇒ out of stock', () => {
    expect(productAvailability(prod({ id: 'p1' }))).toBe('in stock');
    expect(productAvailability(prod({ id: 'p2', inventory: { trackStock: true, stock: 0, lowStockThreshold: 1, sku: 'S' } }))).toBe('out of stock');
    expect(productAvailability(prod({ id: 'p3', status: 'INACTIVE' }))).toBe('out of stock');
    expect(productAvailability(prod({ id: 'p4', status: 'ARCHIVED' }))).toBe('out of stock');
    // Sin tracking de stock, ACTIVE alcanza.
    expect(productAvailability(prod({ id: 'p5', inventory: { trackStock: false, stock: 0, lowStockThreshold: 1, sku: 'S' } }))).toBe('in stock');
  });
});

describe('GATE FAIL-CLOSED: solo participan los productos con syncToMeta === true', () => {
  it('un producto SIN opt-in queda totalmente fuera del plan (ni create, ni update, ni disable)', () => {
    const sinOptIn = prod({ id: 'p1', syncToMeta: undefined });
    const plan = planCatalogSync([sinOptIn], [remote()]);
    expect(plan.entries).toHaveLength(0);
    expect(plan.excludedNotManaged).toBe(1);
    expect(plan.summary).toMatchObject({ create: 0, update: 0, disable: 0, unchanged: 0, blocked: 0 });
  });

  it('syncToMeta:false explícito ⇒ misma exclusión total', () => {
    const plan = planCatalogSync([prod({ id: 'p1', syncToMeta: false })], [remote()]);
    expect(plan.entries).toHaveLength(0);
    expect(plan.excludedNotManaged).toBe(1);
  });

  it('EL INVARIANTE CRÍTICO: un importado INACTIVE + syncToMeta:false JAMÁS produce disable', () => {
    // Escenario real: se importan los artículos vivos de Meta como INACTIVE. Sin el gate,
    // el plan los vería "no vendibles" y apagaría el catálogo productivo del negocio.
    const importados = Array.from({ length: 5 }, (_, i) =>
      prod({
        id: `imp${i}`,
        status: 'INACTIVE',
        syncToMeta: false,
        metaRetailerId: `RID-${i}`,
        inventory: { trackStock: false, stock: 0, lowStockThreshold: 0, sku: `RID-${i}` },
      }),
    );
    const remotos = Array.from({ length: 5 }, (_, i) => remote({ id: `itm-${i}`, retailerId: `RID-${i}`, availability: 'in stock' }));
    const plan = planCatalogSync(importados, remotos);
    expect(plan.entries).toHaveLength(0);
    expect(plan.summary.disable).toBe(0);
    expect(plan.excludedNotManaged).toBe(5);
  });

  it('DEFENSA EN PROFUNDIDAD: syncToMeta:true forzado a mano pero stock sin validar ⇒ igual excluido', () => {
    // Escenario: alguien pone syncToMeta:true desde la consola de Firebase sobre un importado.
    // El segundo gate (stockPendingReview) evita que su artículo vivo termine en disable.
    const forzado = prod({
      id: 'imp',
      status: 'INACTIVE',
      syncToMeta: true,
      stockPendingReview: true,
      metaRetailerId: 'RID-1',
      inventory: { trackStock: false, stock: 0, lowStockThreshold: 0, sku: 'RID-1' },
    });
    const plan = planCatalogSync([forzado], [remote({ retailerId: 'RID-1', availability: 'in stock' })]);
    expect(plan.entries).toHaveLength(0);
    expect(plan.summary.disable).toBe(0);
    expect(plan.excludedNotManaged).toBe(1);
  });

  it('mezcla: solo el habilitado genera acción; los demás ni aparecen', () => {
    const plan = planCatalogSync(
      [
        prod({ id: 'gestionado' }),
        prod({ id: 'importado', status: 'INACTIVE', syncToMeta: false, metaRetailerId: 'OTRO', inventory: { trackStock: false, stock: 0, lowStockThreshold: 0, sku: 'OTRO' } }),
      ],
      [remote(), remote({ id: 'itm-otro', retailerId: 'OTRO' })],
    );
    expect(plan.entries.map((e) => e.productId)).toEqual(['gestionado']);
    expect(plan.excludedNotManaged).toBe(1);
  });

  it('habilitar el opt-in produce la acción correcta (update sobre su artículo mapeado)', () => {
    const habilitado = prod({ id: 'p1', syncToMeta: true, metaRetailerId: 'ARM-744646-5202', description: 'nueva descripción' });
    const plan = planCatalogSync([habilitado], [remote({ retailerId: 'ARM-744646-5202' })]);
    expect(plan.entries[0]).toMatchObject({ action: 'update', sku: 'ARM-744646-5202', mapped: true });
  });
});

describe('identidad efectiva: metaRetailerId manda, SKU es fallback', () => {
  it('un producto MAPEADO matchea por metaRetailerId aunque su SKU sea otro', () => {
    const p = prod({ id: 'p1', metaRetailerId: 'ARM-744646-5202', inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'armaf-odyssey-mega' } });
    const plan = planCatalogSync([p], [remote({ retailerId: 'ARM-744646-5202' })]);
    expect(plan.entries[0]!.action).toBe('unchanged');
    expect(plan.entries[0]!.sku).toBe('ARM-744646-5202');
    expect(plan.entries[0]!.internalSku).toBe('armaf-odyssey-mega');
    expect(plan.entries[0]!.mapped).toBe(true);
  });

  it('cambiar el SKU interno NO rompe el vínculo confirmado', () => {
    const antes = prod({ id: 'p1', metaRetailerId: 'ARM-1', inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'viejo' } });
    const despues = prod({ id: 'p1', metaRetailerId: 'ARM-1', inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'nuevo-sku' } });
    const r = [remote({ retailerId: 'ARM-1' })];
    expect(planCatalogSync([antes], r)[0 as never] ?? planCatalogSync([antes], r).entries[0]!.sku).toBe('ARM-1');
    expect(planCatalogSync([despues], r).entries[0]!.sku).toBe('ARM-1');
  });

  it('sin vínculo, el SKU sigue siendo la identidad (producto nuevo a crear)', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], []);
    expect(plan.entries[0]).toMatchObject({ action: 'create', sku: 'SKU-A', mapped: false });
  });

  it('colisión metaRetailerId de A == SKU de B ⇒ ambos bloqueados, jamás auto-vinculan', () => {
    const a = prod({ id: 'a', metaRetailerId: 'CHOQUE', inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'sku-a' } });
    const b = prod({ id: 'b', name: 'Otro', inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'CHOQUE' } });
    const plan = planCatalogSync([a, b], [remote({ retailerId: 'CHOQUE' })]);
    expect(plan.entries.map((e) => e.action)).toEqual(['blocked', 'blocked']);
    expect(plan.entries[0]!.blockedReasons).toContain('retailer_id_duplicated');
    expect(plan.entries[1]!.blockedReasons).toContain('sku_duplicated');
  });

  it('mapeado cuyo artículo remoto desapareció ⇒ bloqueado, NO se re-crea a ciegas', () => {
    const plan = planCatalogSync([prod({ id: 'p1', metaRetailerId: 'FANTASMA' })], []);
    expect(plan.entries[0]!.action).toBe('blocked');
    expect(plan.entries[0]!.note).toBe('mapeado_sin_item_remoto');
    expect(plan.summary.create).toBe(0);
  });
});

describe('resiliencia y coherencia con el contrato de escritura', () => {
  it('un producto con descripción vacía se BLOQUEA sin romper el plan (no se inventa)', () => {
    const sinDesc = prod({ id: 'p1', description: '' });
    const plan = planCatalogSync([sinDesc], [remote({ description: 'descripción vieja' })]);
    expect(plan.entries[0]!.action).toBe('blocked');
    expect(plan.entries[0]!.blockedReasons).toContain('description_missing');
  });

  it('un producto roto se marca bloqueado SIN cancelar el plan de los demás', () => {
    // El precio NaN sobrevive a los chequeos previos y hace fallar la serialización.
    const roto = { ...prod({ id: 'roto' }), price: Number.NaN } as Product;
    const sano = prod({ id: 'sano', name: 'Perfume B', inventory: { trackStock: true, stock: 3, lowStockThreshold: 1, sku: 'SKU-B' } });
    const plan = planCatalogSync([roto, sano], []);
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries.find((e) => e.productId === 'sano')?.action).toBe('create');
    expect(plan.entries.find((e) => e.productId === 'roto')?.action).toBe('blocked');
  });

  it('crear exige los obligatorios del contrato de Meta: sin URL del producto queda bloqueado', () => {
    const plan = planCatalogSync([prod({ id: 'p1', productUrl: undefined })], []);
    expect(plan.entries[0]!.action).toBe('blocked');
    expect(plan.entries[0]!.blockedReasons).toContain('product_url_missing');
    expect(plan.summary.create).toBe(0);
  });

  it('ACTUALIZAR un artículo existente NO exige URL ni marca (caso Odyssey: solo precio)', () => {
    const odyssey = prod({ id: 'p1', productUrl: undefined, perfume: null, metaRetailerId: 'ARM-1', price: 250000 });
    const plan = planCatalogSync([odyssey], [remote({ retailerId: 'ARM-1', price: '₲130.000', brand: '' })]);
    expect(plan.entries[0]!.action).toBe('update');
    expect(plan.entries[0]!.request?.data).toEqual({ id: 'ARM-1', price: '250000 PYG' });
  });

  it('una identidad de más de 100 caracteres BLOQUEA (jamás se trunca)', () => {
    const skuLargo = 'X'.repeat(140);
    const plan = planCatalogSync([prod({ id: 'p1', metaRetailerId: skuLargo })], []);
    expect(plan.entries[0]!.action).toBe('blocked');
    expect(plan.entries[0]!.blockedReasons).toContain('identity_too_long');
    expect(plan.entries[0]!.sku).toBe(skuLargo); // se reporta la identidad REAL
  });

  it('un nombre largo no genera updates perpetuos (mismo truncado en el diff y en el envío)', () => {
    const nombreLargo = 'A'.repeat(150);
    const p = prod({ id: 'p1', name: nombreLargo, metaRetailerId: 'ARM-1' });
    // El remoto tiene el nombre YA truncado por Meta a 100.
    const plan = planCatalogSync([p], [remote({ retailerId: 'ARM-1', name: nombreLargo.slice(0, 100) })]);
    expect(plan.entries[0]!.action).toBe('unchanged');
  });
});

describe('remoteOnly excluye lo ya vinculado', () => {
  it('un artículo con vínculo confirmado deja de ser candidato de importación', () => {
    const mapeado = prod({ id: 'p1', syncToMeta: false, metaRetailerId: 'ARM-1', inventory: { trackStock: true, stock: 1, lowStockThreshold: 1, sku: 'interno' } });
    const plan = planCatalogSync([mapeado], [remote({ retailerId: 'ARM-1' }), remote({ id: 'itm-x', retailerId: 'LIBRE' })]);
    expect(plan.remoteOnly.map((r) => r.retailerId)).toEqual(['LIBRE']);
  });

  it('el SKU de un producto NO habilitado no reclama artículos remotos', () => {
    const sinOptIn = prod({ id: 'p1', syncToMeta: false });
    const plan = planCatalogSync([sinOptIn], [remote({ retailerId: 'SKU-A' })]);
    expect(plan.remoteOnly.map((r) => r.retailerId)).toEqual(['SKU-A']);
  });
});

describe('priceEquals (formateo de Meta)', () => {
  it.each([
    ['símbolo y puntos de miles', '250000 PYG', '₲250.000', true],
    ['ISO con comas', '250000 PYG', 'PYG 250,000', true],
    ['decimales .00 finales', '250000 PYG', 'PYG 250,000.00', true],
    ['decimales ,00 finales', '2500 PYG', '₲ 2.500,00', true],
    ['moneda distinta con mismos dígitos', '250000 PYG', 'USD 250,000', false],
    ['monto distinto', '250000 PYG', '₲250.001', false],
    ['remoto vacío', '250000 PYG', '', false],
  ])('%s → %s', (_label, local, remoteStr, expected) => {
    expect(priceEquals(local, remoteStr)).toBe(expected);
  });
});

describe('planCatalogSync — matching y bloqueos', () => {
  it('producto nuevo válido sin item remoto ⇒ create con payload', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], []);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ productId: 'p1', action: 'create', sku: 'SKU-A' });
    expect(plan.entries[0].payload).toBeDefined();
    expect(plan.summary.create).toBe(1);
  });

  it('matching por retailer_id: remoto idéntico ⇒ unchanged (idempotencia del dry-run)', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote()]);
    expect(plan.entries[0].action).toBe('unchanged');
    expect(plan.entries[0].remoteItemId).toBe('itm-1');
  });

  it('el precio se compara pese al formateo de Meta', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote({ price: 'PYG 250,000' })]);
    expect(plan.entries[0].action).toBe('unchanged');
  });

  it('decimales ",00"/".00" del formateo remoto no generan updates perpetuos', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote({ price: 'PYG 250,000.00' })]);
    expect(plan.entries[0].action).toBe('unchanged');
  });

  it('moneda remota distinta de PYG ⇒ update (corrige el drift aunque los dígitos coincidan)', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote({ price: 'USD 250,000' })]);
    expect(plan.entries[0].action).toBe('update');
    expect(plan.entries[0].changedFields).toContain('price');
  });

  it('difiere un campo público ⇒ update con changedFields', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote({ description: 'vieja' })]);
    expect(plan.entries[0].action).toBe('update');
    expect(plan.entries[0].changedFields).toEqual(['description']);
  });

  it('sin stock con item remoto visible ⇒ disable (availability out of stock), jamás delete', () => {
    const plan = planCatalogSync(
      [prod({ id: 'p1', inventory: { trackStock: true, stock: 0, lowStockThreshold: 1, sku: 'SKU-A' } })],
      [remote()],
    );
    expect(plan.entries[0].action).toBe('disable');
    expect(plan.entries[0].payload?.availability).toBe('out of stock');
  });

  it('el disable MÍNIMO de un producto con bloqueos lleva el snapshot público COMPLETO', () => {
    // El outbox usa `payload` como snapshot para detectar si el producto cambió desde el
    // preview. Un payload reducido nunca coincidiría con el que recalcula el worker y el
    // apagado quedaría `stale` para siempre: el artículo jamás se ocultaría en Meta.
    const p = prod({
      id: 'p1',
      images: ['http://inseguro/x.jpg'], // bloquea create/update
      inventory: { trackStock: true, stock: 0, lowStockThreshold: 1, sku: 'SKU-A' },
    });
    const plan = planCatalogSync([p], [remote()]);
    const e = plan.entries[0]!;
    expect(e.action).toBe('disable');
    expect(e.note).toBe('disable_minimo_con_bloqueos');
    expect(e.payload).toEqual(localPublicView(p));
    // El REQUEST sigue siendo mínimo: el snapshot no cambia lo que viaja a Meta.
    expect(Object.keys(e.request?.data ?? {}).sort()).toEqual(['availability', 'id']);
  });

  it('ARCHIVED con item remoto ⇒ disable; ARCHIVED sin item remoto ⇒ se ignora', () => {
    const conRemoto = planCatalogSync([prod({ id: 'p1', status: 'ARCHIVED' })], [remote()]);
    expect(conRemoto.entries[0].action).toBe('disable');
    const sinRemoto = planCatalogSync([prod({ id: 'p1', status: 'ARCHIVED' })], []);
    expect(sinRemoto.entries).toHaveLength(0);
    expect(sinRemoto.ignoredArchived).toBe(1);
  });

  it('un ARCHIVED no bloquea el reuso de su SKU: soft-delete + reemplazo es flujo normal', () => {
    const plan = planCatalogSync(
      [prod({ id: 'viejo', status: 'ARCHIVED' }), prod({ id: 'nuevo', name: 'Perfume A v2' })],
      [],
    );
    expect(plan.ignoredArchived).toBe(1);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ productId: 'nuevo', action: 'create' });
    expect(plan.entries[0].blockedReasons).toBeUndefined();
  });

  it('ARCHIVED con remoto pero SKU reclamado por un producto vivo ⇒ el item es del reemplazo', () => {
    const plan = planCatalogSync(
      [prod({ id: 'viejo', status: 'ARCHIVED' }), prod({ id: 'nuevo', name: 'Perfume A v2' })],
      [remote()],
    );
    expect(plan.ignoredArchived).toBe(1);
    const nuevo = plan.entries.find((e) => e.productId === 'nuevo');
    expect(nuevo?.action).toBe('update'); // difiere el nombre; identidad por SKU intacta
  });

  it('producto BLOQUEADO (precio inválido) con item remoto visible y sin stock ⇒ disable MÍNIMO igual', () => {
    const p = prod({ id: 'p1', price: 0, inventory: { trackStock: true, stock: 0, lowStockThreshold: 1, sku: 'SKU-A' } });
    const plan = planCatalogSync([p], [remote()]);
    expect(plan.entries[0].action).toBe('disable');
    expect(plan.entries[0].blockedReasons).toContain('price_invalid');
    // Lo MÍNIMO es lo que VIAJA: el request lleva solo la palanca de availability, ningún
    // campo bloqueado. (El `payload` no viaja: es el snapshot local con el que el outbox
    // detecta si el producto cambió — por eso es la vista pública completa.)
    expect(Object.keys(plan.entries[0].request?.data ?? {}).sort()).toEqual(['availability', 'id']);
    expect(plan.entries[0].payload).toEqual(localPublicView(p));
  });

  it('SKU duplicado con remoto y sin stock ⇒ NO hay disable (identidad ambigua): sigue blocked', () => {
    const plan = planCatalogSync(
      [
        prod({ id: 'p1', inventory: { trackStock: true, stock: 0, lowStockThreshold: 1, sku: 'SKU-A' } }),
        prod({ id: 'p2', name: 'Perfume B' }),
      ],
      [remote()],
    );
    expect(plan.entries.map((e) => e.action)).toEqual(['blocked', 'blocked']);
  });

  it('nombre vacío bloquea (name_missing)', () => {
    const plan = planCatalogSync([prod({ id: 'p1', name: '   ' })], []);
    expect(plan.entries[0].blockedReasons).toContain('name_missing');
  });

  it('unchanged con remoto lleva payload (lo usa la convergencia del apply)', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote()]);
    expect(plan.entries[0].action).toBe('unchanged');
    expect(plan.entries[0].payload).toBeDefined();
  });

  it('no vendible y sin item remoto ⇒ NO se crea un item oculto', () => {
    const plan = planCatalogSync([prod({ id: 'p1', inventory: { trackStock: true, stock: 0, lowStockThreshold: 1, sku: 'SKU-A' } })], []);
    expect(plan.entries[0].action).toBe('unchanged');
    expect(plan.entries[0].note).toBe('no_vendible_sin_item_remoto');
    expect(plan.summary.create).toBe(0);
  });

  it('SKU vacío bloquea', () => {
    const plan = planCatalogSync([prod({ id: 'p1', inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: '  ' } })], []);
    expect(plan.entries[0].action).toBe('blocked');
    expect(plan.entries[0].blockedReasons).toContain('sku_missing');
  });

  it('SKU duplicado bloquea a TODOS los que lo comparten', () => {
    const plan = planCatalogSync([prod({ id: 'p1' }), prod({ id: 'p2', name: 'Perfume B' })], []);
    expect(plan.entries.map((e) => e.action)).toEqual(['blocked', 'blocked']);
    expect(plan.entries[0].blockedReasons).toContain('sku_duplicated');
    expect(plan.entries[1].blockedReasons).toContain('sku_duplicated');
  });

  it('moneda distinta de PYG bloquea', () => {
    const plan = planCatalogSync([prod({ id: 'p1', currency: 'USD' as Product['currency'] })], []);
    expect(plan.entries[0].blockedReasons).toContain('currency_not_pyg');
  });

  it('precio inválido (0 / negativo / NaN) bloquea', () => {
    for (const price of [0, -100, Number.NaN]) {
      const plan = planCatalogSync([prod({ id: 'p1', price })], []);
      expect(plan.entries[0].blockedReasons).toContain('price_invalid');
    }
  });

  it('imagen no-HTTPS (o sin imagen) bloquea', () => {
    const http = planCatalogSync([prod({ id: 'p1', images: ['http://inseguro.com/a.jpg'] })], []);
    expect(http.entries[0].blockedReasons).toContain('image_not_https');
    const sin = planCatalogSync([prod({ id: 'p1', images: [] })], []);
    expect(sin.entries[0].blockedReasons).toContain('image_not_https');
  });

  it('coincidencia por NOMBRE con otro retailer_id ⇒ BLOQUEA con sugerencia (jamás auto-vincula ni crea duplicado)', () => {
    const plan = planCatalogSync(
      [prod({ id: 'p1', name: '  perfume  A ' })],
      [remote({ retailerId: 'OTRO-SKU', name: 'Perfume A' })],
    );
    expect(plan.entries[0].action).toBe('blocked');
    expect(plan.entries[0].blockedReasons).toEqual(['name_conflict_requires_confirmation']);
    expect(plan.entries[0].suggestion).toEqual({ remoteRetailerId: 'OTRO-SKU', remoteName: 'Perfume A' });
    expect(plan.summary.create).toBe(0);
  });

  it('items remotos sin producto local ⇒ remoteOnly (solo reporte, nunca delete)', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote(), remote({ id: 'itm-9', retailerId: 'HUERFANO', name: 'Viejo' })]);
    expect(plan.remoteOnly).toEqual([{ retailerId: 'HUERFANO', name: 'Viejo' }]);
    const acciones = new Set(plan.entries.map((e) => e.action));
    expect([...acciones].every((a) => ['create', 'update', 'disable', 'unchanged', 'blocked'].includes(a))).toBe(true);
  });

  it('summary consistente con las entradas', () => {
    const plan = planCatalogSync(
      [
        prod({ id: 'p1' }), // unchanged (remoto idéntico)
        prod({ id: 'p2', name: 'Perfume B', inventory: { trackStock: true, stock: 3, lowStockThreshold: 1, sku: 'SKU-B' } }), // create
        prod({ id: 'p3', name: 'Perfume C', inventory: { trackStock: true, stock: 3, lowStockThreshold: 1, sku: '' } }), // blocked
      ],
      [remote(), remote({ id: 'itm-9', retailerId: 'HUERFANO', name: 'Viejo' })],
    );
    expect(plan.summary).toEqual({ create: 1, update: 0, disable: 0, unchanged: 1, blocked: 1, remoteOnly: 1 });
  });
});
