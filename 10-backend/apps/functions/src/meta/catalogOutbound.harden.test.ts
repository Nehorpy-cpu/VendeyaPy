import { describe, it, expect } from 'vitest';
import type { Product } from '@vpw/shared';
import {
  buildCatalogCreatePayload,
  buildCatalogUpdatePatch,
  buildCatalogDisablePatch,
  createBlockers,
  updateBlockers,
  outboundId,
  type CatalogBatchRequest,
} from './catalogOutbound.js';
import { assertItemsBatchBody, assertBatchRequestShape } from './catalogClient.js';
import { localPublicView, planCatalogSync as planConPropiedad } from './catalog.js';
import { normalizeCatalogOwnership, WRITABLE_FIELDS } from './catalogOwnership.js';
import type { MetaRemoteCatalogItem } from './catalogClient.js';

/** (ADR-0015) Escenario de estos tests: VendeYaPy gobierna todos los campos públicos. */
const PROPIEDAD_TOTAL = normalizeCatalogOwnership({ model: 'vendeyapy_managed', ownedFields: [...WRITABLE_FIELDS], external: null });
const planCatalogSync = (products: Product[], remotos: MetaRemoteCatalogItem[]) => planConPropiedad(products, remotos, PROPIEDAD_TOTAL);

/**
 * META-CATALOG-OUTBOUND-CONTRACT-HARDEN-1 — defectos hallados sobre el contrato ya corregido:
 * identidad truncada silenciosamente, DELETE representable, URL sin validar ni comparar,
 * descripción inventada a partir del título, y campo muerto en el modelo.
 */

const TS = { seconds: 0, nanoseconds: 0 } as unknown as Product['createdAt'];

const prod = (over: Partial<Product> & { id: string }): Product =>
  ({
    tenantId: 't1',
    name: 'Armaf Odyssey Mega',
    description: 'Perfume fresco para el día a día',
    price: 250000,
    compareAtPrice: null,
    aiNotes: 'NOTA-INTERNA',
    currency: 'PYG',
    categoryId: 'perfumes',
    images: ['https://cdn.test/odyssey.jpg'],
    emoji: '🌸',
    inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'armaf-odyssey-mega' },
    status: 'ACTIVE',
    featured: false,
    position: 0,
    externalIds: { facebook: null, instagram: null, tiktok: null },
    perfume: { brand: 'Armaf' } as Product['perfume'],
    aiFicha: null,
    productUrl: 'https://arfagi.com/?producto_id=258',
    metaRetailerId: 'ARM-744646-5202',
    syncToMeta: true,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }) as Product;

const remote = (over: Partial<MetaRemoteCatalogItem> = {}): MetaRemoteCatalogItem => ({
  id: 'itm-1',
  retailerId: 'ARM-744646-5202',
  name: 'Armaf Odyssey Mega',
  description: 'Perfume fresco para el día a día',
  availability: 'in stock',
  price: '₲250.000',
  imageUrl: 'https://cdn.test/odyssey.jpg',
  brand: 'Armaf',
  url: 'https://arfagi.com/?producto_id=258',
  ...over,
});

// ---------------------------------------------------------------------------
// 1. IDENTIDAD: jamás truncada
// ---------------------------------------------------------------------------

describe('identidad exacta — truncar está PROHIBIDO', () => {
  const LARGO_A = 'PREFIJO-COMUN-'.repeat(7) + 'AAA'; // > 100
  const LARGO_B = 'PREFIJO-COMUN-'.repeat(7) + 'BBB';

  it('outboundId devuelve la identidad EXACTA almacenada, sin recortar', () => {
    const p = prod({ id: 'p1', metaRetailerId: LARGO_A });
    expect(outboundId(p)).toBe(LARGO_A);
    expect(outboundId(p).length).toBeGreaterThan(100);
  });

  it('una identidad de 101 caracteres BLOQUEA en vez de truncar', () => {
    const p = prod({ id: 'p1', metaRetailerId: 'X'.repeat(101) });
    expect(createBlockers(p)).toContain('identity_too_long');
  });

  it('exactamente 100 caracteres es válido (el tope es inclusivo)', () => {
    const p = prod({ id: 'p1', metaRetailerId: 'X'.repeat(100) });
    expect(createBlockers(p)).not.toContain('identity_too_long');
  });

  it('DOS identidades largas con el MISMO prefijo jamás colapsan en una sola', () => {
    // Con el truncado anterior ambas se volvían idénticas: dos productos distintos habrían
    // escrito sobre el mismo artículo de Meta.
    expect(outboundId(prod({ id: 'a', metaRetailerId: LARGO_A }))).not.toBe(
      outboundId(prod({ id: 'b', metaRetailerId: LARGO_B })),
    );
  });

  it('CREATE, UPDATE y DISABLE quedan bloqueados ANTES del transporte', () => {
    const p = prod({ id: 'p1', metaRetailerId: 'X'.repeat(101) });
    expect(() => buildCatalogCreatePayload(p)).toThrow(/identity_too_long|demasiado larga/i);
    expect(() => buildCatalogUpdatePatch(p, ['price'])).toThrow(/identity_too_long|demasiado larga/i);
    expect(() => buildCatalogDisablePatch(p)).toThrow(/identity_too_long|demasiado larga/i);
  });

  it('el plan bloquea el producto sin alterar el retailerId persistido', () => {
    const largo = 'X'.repeat(101);
    const plan = planCatalogSync([prod({ id: 'p1', metaRetailerId: largo })], []);
    expect(plan.entries[0]!.action).toBe('blocked');
    expect(plan.entries[0]!.sku).toBe(largo); // se reporta la identidad REAL, no una recortada
  });
});

// ---------------------------------------------------------------------------
// 2. DELETE no es representable ni enviable
// ---------------------------------------------------------------------------

describe('DELETE — VendeyaPy no lo implementa', () => {
  it('un DELETE colado por cast se rechaza en la validación de forma', () => {
    const colado = { method: 'DELETE', data: { id: 'S' } } as unknown as CatalogBatchRequest;
    expect(() => assertBatchRequestShape(colado)).toThrow(/no permitido/);
  });

  it('el body completo se valida: item_type, allow_upsert y requests', () => {
    const ok = { item_type: 'PRODUCT_ITEM', allow_upsert: false, requests: [buildCatalogUpdatePatch(prod({ id: 'p1' }), ['price'])] };
    expect(() => assertItemsBatchBody(ok)).not.toThrow();
    expect(() => assertItemsBatchBody({ ...ok, item_type: 'DESTINATION' })).toThrow(/item_type/);
    expect(() => assertItemsBatchBody({ ...ok, allow_upsert: true })).toThrow(/allow_upsert/);
    expect(() => assertItemsBatchBody({ ...ok, requests: [] })).toThrow(/vac/i);
    expect(() => assertItemsBatchBody({ ...ok, requests: new Array(5001).fill(ok.requests[0]) })).toThrow(/límite|limite/i);
  });

  it('un request malformado dentro del body se rechaza', () => {
    const body = { item_type: 'PRODUCT_ITEM', allow_upsert: false, requests: [{ method: 'DELETE', data: { id: 'S' } }] };
    expect(() => assertItemsBatchBody(body)).toThrow(/no permitido/);
  });
});

// ---------------------------------------------------------------------------
// 3. URL del producto: HTTPS obligatorio para CREATE
// ---------------------------------------------------------------------------

describe('product URL — fail-closed', () => {
  it.each([
    ['http', 'http://arfagi.com/p/1'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<h1>x</h1>'],
    ['relativa', '/productos/1'],
    ['basura', 'no-es-una-url'],
    ['solo espacios', '   '],
  ])('URL %s ⇒ bloqueada', (_l, url) => {
    const p = prod({ id: 'p1', productUrl: url });
    const blockers = createBlockers(p);
    expect(blockers.some((b) => b === 'product_url_not_https' || b === 'product_url_missing')).toBe(true);
    expect(() => buildCatalogCreatePayload(p)).toThrow();
  });

  it('una URL HTTPS válida pasa', () => {
    expect(createBlockers(prod({ id: 'p1' }))).toEqual([]);
  });

  it('un producto con URL inválida NO impide planificar los demás', () => {
    const malo = prod({ id: 'malo', productUrl: 'javascript:alert(1)', inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'SKU-MALO' }, metaRetailerId: undefined });
    const bueno = prod({ id: 'bueno', name: 'Otro', inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'SKU-OK' }, metaRetailerId: undefined });
    const plan = planCatalogSync([malo, bueno], []);
    expect(plan.entries.find((e) => e.productId === 'malo')?.action).toBe('blocked');
    expect(plan.entries.find((e) => e.productId === 'bueno')?.action).toBe('create');
  });
});

// ---------------------------------------------------------------------------
// 4. URL en el diff, el patch y la verificación
// ---------------------------------------------------------------------------

describe('product URL — diff, patch y verificación', () => {
  it('localPublicView expone la URL con el nombre del contrato de LECTURA (`url`)', () => {
    expect(localPublicView(prod({ id: 'p1' })).url).toBe('https://arfagi.com/?producto_id=258');
  });

  it('un cambio EXCLUSIVO de URL produce { id, link } y nada más', () => {
    const p = prod({ id: 'p1', productUrl: 'https://arfagi.com/?producto_id=999' });
    const plan = planCatalogSync([p], [remote()]);
    expect(plan.entries[0]!.action).toBe('update');
    expect(plan.entries[0]!.changedFields).toEqual(['url']);
    expect(plan.entries[0]!.request?.data).toEqual({ id: 'ARM-744646-5202', link: 'https://arfagi.com/?producto_id=999' });
  });

  it('si la URL remota coincide, no hay cambio', () => {
    expect(planCatalogSync([prod({ id: 'p1' })], [remote()]).entries[0]!.action).toBe('unchanged');
  });

  it.each([
    ['barra final agregada por Meta', 'https://arfagi.com', 'https://arfagi.com/'],
    ['host en mayúsculas', 'https://ARFAGI.com/p/1', 'https://arfagi.com/p/1'],
    ['espacio escapado', 'https://arfagi.com/p/uno dos', 'https://arfagi.com/p/uno%20dos'],
  ])('%s NO produce un UPDATE perpetuo', (_l, local, devueltoPorMeta) => {
    // Meta normaliza lo que recibe. Comparando strings crudos, el `link` figuraría como
    // cambiado en CADA corrida: update infinito que nunca converge a `synced`.
    const plan = planCatalogSync([prod({ id: 'p1', productUrl: local })], [remote({ url: devueltoPorMeta })]);
    expect(plan.entries[0]!.changedFields ?? []).not.toContain('url');
    expect(plan.entries[0]!.action).toBe('unchanged');
  });

  it('si Meta no devuelve `url`, no se asume que cambió', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote({ url: '' })]);
    expect(plan.entries[0]!.action).toBe('unchanged');
  });

  it('el link que se emite ya está en forma canónica (lo mismo que valida el transporte)', () => {
    const req = buildCatalogCreatePayload(prod({ id: 'p1', productUrl: 'HTTPS://ARFAGI.com/p/1' }));
    expect(req.data.link).toBe('https://arfagi.com/p/1');
    expect(() => assertBatchRequestShape(req)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. AISLAMIENTO: un producto roto jamás envenena el lote
// ---------------------------------------------------------------------------

describe('aislamiento por producto', () => {
  it('TODO request que el plan emite pasa la validación de transporte', () => {
    // Invariante central: si el planner pudiera emitir un request inválido, éste explotaría
    // recién en `assertItemsBatchBody` y tumbaría el chunk COMPLETO (y todos los siguientes).
    const variantes: Array<Partial<Product>> = [
      {},
      { name: 'X'.repeat(300) },
      { description: 'D'.repeat(9000) },
      { productUrl: 'HTTPS://ARFAGI.com/p/1' },
      { productUrl: 'https://arfagi.com/p/uno dos' },
      { price: 1 },
      { price: 999_999_999_999 },
      { perfume: { brand: 'B'.repeat(300) } as Product['perfume'] },
      { images: ['http://inseguro/a.jpg', 'https://cdn.test/ok.jpg'] },
      { inventory: { trackStock: true, stock: 0, lowStockThreshold: 1, sku: 'SKU-0' } },
    ];
    // Sin mapping previo y con el catálogo remoto vacío ⇒ todos son CREATE.
    const productos = variantes.map((v, i) =>
      prod({
        id: `p${i}`,
        metaRetailerId: undefined,
        inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: `SKU-${i}` },
        ...v,
      }),
    );
    const plan = planCatalogSync(productos, []);
    const emitidos = plan.entries.filter((e) => e.request);
    expect(emitidos.length).toBeGreaterThan(0);
    for (const e of emitidos) {
      expect(() => assertBatchRequestShape(e.request as CatalogBatchRequest, e.productId)).not.toThrow();
    }
  });

  it('un producto con datos imposibles queda `blocked`, nunca emite request', () => {
    const roto = prod({ id: 'roto', metaRetailerId: undefined, inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'X'.repeat(101) } });
    const sano = prod({ id: 'sano', metaRetailerId: undefined, name: 'Otro', inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'SKU-OK' } });
    const plan = planCatalogSync([roto, sano], []);
    expect(plan.entries.find((e) => e.productId === 'roto')?.request).toBeUndefined();
    expect(plan.entries.find((e) => e.productId === 'sano')?.action).toBe('create');
  });

  it('un precio no representable bloquea en vez de emitir notación exponencial', () => {
    const p = prod({ id: 'p1', price: 1e21 });
    expect(createBlockers(p)).toContain('price_invalid');
    expect(planCatalogSync([p], []).entries[0]!.action).toBe('blocked');
  });

  it('la verificación post-escritura compara la URL: un link remoto distinto NO es synced', () => {
    // El diff es lo que decide `synced` en el apply: si `url` difiere, sigue habiendo cambios.
    const p = prod({ id: 'p1' });
    const plan = planCatalogSync([p], [remote({ url: 'https://otro-sitio.com/x' })]);
    expect(plan.entries[0]!.action).toBe('update');
    expect(plan.entries[0]!.changedFields).toContain('url');
  });
});

// ---------------------------------------------------------------------------
// 5. Descripción: no se inventa
// ---------------------------------------------------------------------------

describe('descripción — fail-closed, jamás derivada del título', () => {
  it('descripción vacía ⇒ description_missing (no se usa el título)', () => {
    const p = prod({ id: 'p1', description: '   ' });
    expect(createBlockers(p)).toContain('description_missing');
    expect(() => buildCatalogCreatePayload(p)).toThrow();
  });

  it('la vista de lectura tampoco inventa: descripción vacía es cadena vacía', () => {
    expect(localPublicView(prod({ id: 'p1', description: '' })).description).toBe('');
  });

  it('un UPDATE SOLO de precio no se bloquea por descripción local ausente', () => {
    const p = prod({ id: 'p1', description: '' });
    expect(buildCatalogUpdatePatch(p, ['price']).data).toEqual({ id: 'ARM-744646-5202', price: '250000 PYG' });
  });

  it('pedir explícitamente sincronizar `description` vacía se bloquea de forma ESTRUCTURADA', () => {
    const p = prod({ id: 'p1', description: '' });
    expect(updateBlockers(p, ['description'])).toContain('description_missing');
    const err = (() => { try { buildCatalogUpdatePatch(p, ['description']); return null; } catch (e) { return e as { blockers?: string[] }; } })();
    expect(err?.blockers).toContain('description_missing');
  });

  it('el plan bloquea (no rompe) un producto cuyo único cambio es una descripción vacía', () => {
    const p = prod({ id: 'p1', description: '' });
    const plan = planCatalogSync([p], [remote({ description: 'descripción vieja en Meta' })]);
    expect(plan.entries[0]!.action).toBe('blocked');
    expect(plan.entries[0]!.blockedReasons).toContain('description_missing');
  });
});

// ---------------------------------------------------------------------------
// 8. REGRESIONES del contrato ya validado
// ---------------------------------------------------------------------------

describe('regresiones del contrato', () => {
  it('UPDATE solo de precio sigue siendo exactamente { id, price }', () => {
    expect(buildCatalogUpdatePatch(prod({ id: 'p1' }), ['price']).data).toEqual({ id: 'ARM-744646-5202', price: '250000 PYG' });
  });

  it('DISABLE sigue siendo exactamente { id, availability }', () => {
    expect(buildCatalogDisablePatch(prod({ id: 'p1' })).data).toEqual({ id: 'ARM-744646-5202', availability: 'out of stock' });
  });

  it('CREATE mantiene exclusivamente los 9 obligatorios', () => {
    expect(Object.keys(buildCatalogCreatePayload(prod({ id: 'p1' })).data).sort()).toEqual(
      ['availability', 'brand', 'condition', 'description', 'id', 'image', 'link', 'price', 'title'],
    );
  });

  it('cero campos privados en los tres builders', () => {
    const privados = /NOTA-INTERNA|costPrice|margen|ganancia|aiNotes|aiFicha/i;
    const p = prod({ id: 'p1' });
    expect(JSON.stringify(buildCatalogCreatePayload(p))).not.toMatch(privados);
    expect(JSON.stringify(buildCatalogUpdatePatch(p, ['price', 'title']))).not.toMatch(privados);
    expect(JSON.stringify(buildCatalogDisablePatch(p))).not.toMatch(privados);
  });
});
