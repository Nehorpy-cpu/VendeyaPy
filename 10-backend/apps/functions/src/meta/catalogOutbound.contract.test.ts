import { describe, it, expect } from 'vitest';
import type { Product } from '@vpw/shared';
import {
  buildCatalogCreatePayload,
  buildCatalogUpdatePatch,
  buildCatalogDisablePatch,
  createBlockers,
  ITEMS_BATCH_ALLOW_UPSERT,
  type CatalogBatchRequest,
} from './catalogOutbound.js';
import { assertBatchRequestShape } from './catalogClient.js';

/**
 * META-CATALOG-OUTBOUND-CONTRACT-1 — tests DISCRIMINANTES del contrato de ESCRITURA de
 * Graph API v23, `POST /{catalog_id}/items_batch` con `item_type: PRODUCT_ITEM`.
 *
 * Contrato oficial verificado (no confundir con el de LECTURA, que devuelve
 * name/image_url/url):
 *   body        : { item_type, allow_upsert, requests: [{ method, data }] }
 *   identidad   : `data.id` (NUNCA un `retailer_id` hermano de `data`), máx 100 chars
 *   CREATE      : id, title, description, link, price, availability, condition, brand, image
 *   UPDATE      : id + SOLO los campos modificados (parcial)
 *   DELETE      : id
 *   image       : array de { url, tag? }   ·   availability: "in stock" | "out of stock"
 *
 * Cada test de este archivo falla con el serializador anterior (que mandaba `name`,
 * `image_url` y el id fuera de `data`, y clasificaba todo como UPDATE).
 */

const TS = { seconds: 0, nanoseconds: 0 } as unknown as Product['createdAt'];

const prod = (over: Partial<Product> & { id: string }): Product =>
  ({
    tenantId: 't1',
    name: 'Armaf Odyssey Mega',
    description: 'Perfume fresco para el día a día',
    price: 250000,
    compareAtPrice: null,
    aiNotes: 'NOTA-INTERNA-DE-VENTA',
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
    aiFicha: { cuandoRecomendar: 'FICHA-INTERNA' } as Product['aiFicha'],
    productUrl: 'https://arfagi.com/?producto_id=258',
    metaRetailerId: 'ARM-744646-5202',
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }) as Product;

// ---------------------------------------------------------------------------
// 1. IDENTIDAD: va DENTRO de data como `id`
// ---------------------------------------------------------------------------

describe('identidad del artículo', () => {
  it('CREATE pone la identidad en data.id, jamás como hermano de data', () => {
    const req = buildCatalogCreatePayload(prod({ id: 'p1' }));
    expect(req.data.id).toBe('ARM-744646-5202');
    expect(req).not.toHaveProperty('retailer_id');
    expect(req.data).not.toHaveProperty('retailer_id');
  });

  it('UPDATE pone la identidad en data.id', () => {
    const req = buildCatalogUpdatePatch(prod({ id: 'p1' }), ['price']);
    expect(req.data.id).toBe('ARM-744646-5202');
    expect(req).not.toHaveProperty('retailer_id');
  });

  it('DISABLE pone la identidad en data.id', () => {
    const req = buildCatalogDisablePatch(prod({ id: 'p1' }));
    expect(req.data.id).toBe('ARM-744646-5202');
    expect(req).not.toHaveProperty('retailer_id');
  });

  it('una identidad de más de 100 caracteres bloquea (jamás se trunca)', () => {
    const largo = 'X'.repeat(140);
    expect(() => buildCatalogUpdatePatch(prod({ id: 'p1', metaRetailerId: largo }), ['price'])).toThrow(/identity_too_long/);
  });
});

// ---------------------------------------------------------------------------
// 2. NOMBRES DE CAMPO: contrato de ESCRITURA, no el de lectura
// ---------------------------------------------------------------------------

describe('nombres de campo del contrato de escritura', () => {
  it('usa `title`, nunca `name` (name es del contrato de LECTURA)', () => {
    const req = buildCatalogCreatePayload(prod({ id: 'p1' }));
    expect(req.data.title).toBe('Armaf Odyssey Mega');
    expect(req.data).not.toHaveProperty('name');
  });

  it('usa `image` como array de {url}, nunca `image_url` (que es de lectura)', () => {
    const req = buildCatalogCreatePayload(prod({ id: 'p1' }));
    expect(req.data.image).toEqual([{ url: 'https://cdn.test/odyssey.jpg' }]);
    expect(req.data).not.toHaveProperty('image_url');
  });

  it('usa `link`, nunca `url` (que es de lectura)', () => {
    const req = buildCatalogCreatePayload(prod({ id: 'p1' }));
    expect(req.data.link).toBe('https://arfagi.com/?producto_id=258');
    expect(req.data).not.toHaveProperty('url');
  });

  it('availability con el literal exacto de dos palabras', () => {
    expect(buildCatalogCreatePayload(prod({ id: 'p1' })).data.availability).toBe('in stock');
    expect(buildCatalogDisablePatch(prod({ id: 'p1' })).data.availability).toBe('out of stock');
  });

  it('el precio va como "<entero> PYG" (formato monto + ISO)', () => {
    expect(buildCatalogCreatePayload(prod({ id: 'p1' })).data.price).toBe('250000 PYG');
  });
});

// ---------------------------------------------------------------------------
// 3. CREATE: fail-closed ante campos obligatorios faltantes
// ---------------------------------------------------------------------------

describe('CREATE — obligatorios del contrato (fail-closed)', () => {
  it('un producto completo no tiene bloqueos y usa method CREATE', () => {
    const p = prod({ id: 'p1' });
    expect(createBlockers(p)).toEqual([]);
    expect(buildCatalogCreatePayload(p).method).toBe('CREATE');
  });

  it('emite EXACTAMENTE los 9 campos obligatorios del contrato, sin extras', () => {
    const req = buildCatalogCreatePayload(prod({ id: 'p1' }));
    expect(Object.keys(req.data).sort()).toEqual(
      ['availability', 'brand', 'condition', 'description', 'id', 'image', 'link', 'price', 'title'],
    );
  });

  it('sin link (productUrl) ⇒ product_url_missing y JAMÁS se inventa una URL', () => {
    const sinUrl = prod({ id: 'p1', productUrl: undefined });
    expect(createBlockers(sinUrl)).toContain('product_url_missing');
    expect(() => buildCatalogCreatePayload(sinUrl)).toThrow();
  });

  it('sin marca ⇒ brand_missing y JAMÁS se inventa una marca', () => {
    const sinMarca = prod({ id: 'p1', perfume: null });
    expect(createBlockers(sinMarca)).toContain('brand_missing');
    expect(() => buildCatalogCreatePayload(sinMarca)).toThrow();
  });

  it('la descripción vacía BLOQUEA: no se inventa a partir del título', () => {
    const sinDesc = prod({ id: 'p1', description: '   ' });
    expect(createBlockers(sinDesc)).toContain('description_missing');
    expect(() => buildCatalogCreatePayload(sinDesc)).toThrow();
  });

  it.each([
    ['sin título ni descripción', { name: '   ', description: '  ' }, 'description_missing'],
    ['precio inválido', { price: 0 }, 'price_invalid'],
    ['moneda ajena', { currency: 'USD' as Product['currency'] }, 'currency_not_pyg'],
    ['imagen no HTTPS', { images: ['http://inseguro/x.jpg'] }, 'image_missing'],
    ['sin identidad', { metaRetailerId: null, inventory: { trackStock: false, stock: 0, lowStockThreshold: 0, sku: '' } }, 'identity_missing'],
  ])('%s ⇒ %s', (_l, over, esperado) => {
    expect(createBlockers(prod({ id: 'p1', ...over }))).toContain(esperado as never);
  });
});

// ---------------------------------------------------------------------------
// 4. UPDATE: parcial de verdad
// ---------------------------------------------------------------------------

describe('UPDATE — patch parcial', () => {
  it('un cambio SOLO de precio manda exclusivamente id + price', () => {
    const req = buildCatalogUpdatePatch(prod({ id: 'p1' }), ['price']);
    expect(req.method).toBe('UPDATE');
    expect(Object.keys(req.data).sort()).toEqual(['id', 'price']);
    expect(req.data.price).toBe('250000 PYG');
  });

  it('no reenvía el objeto completo: title/description/image/link quedan fuera', () => {
    const req = buildCatalogUpdatePatch(prod({ id: 'p1' }), ['price']);
    for (const campo of ['title', 'description', 'image', 'link', 'brand', 'condition', 'availability']) {
      expect(req.data).not.toHaveProperty(campo);
    }
  });

  it('varios campos modificados ⇒ solo esos viajan', () => {
    const req = buildCatalogUpdatePatch(prod({ id: 'p1' }), ['title', 'availability']);
    expect(Object.keys(req.data).sort()).toEqual(['availability', 'id', 'title']);
  });

  it('NO exige productUrl ni marca cuando esos campos no se modifican (caso Odyssey: solo precio)', () => {
    const odysseySinUrl = prod({ id: 'p1', productUrl: undefined, perfume: null });
    const req = buildCatalogUpdatePatch(odysseySinUrl, ['price']);
    expect(Object.keys(req.data).sort()).toEqual(['id', 'price']);
  });

  it('un patch sin campos modificados es un error de programación (no se manda un no-op)', () => {
    expect(() => buildCatalogUpdatePatch(prod({ id: 'p1' }), [])).toThrow();
  });

  it('ignora campos desconocidos que no pertenecen al contrato público', () => {
    const req = buildCatalogUpdatePatch(prod({ id: 'p1' }), ['price', 'costPrice' as never, 'aiFicha' as never]);
    expect(Object.keys(req.data).sort()).toEqual(['id', 'price']);
  });
});

// ---------------------------------------------------------------------------
// 5. DISABLE: identidad + availability, nada más
// ---------------------------------------------------------------------------

describe('DISABLE — mínimo absoluto', () => {
  it('manda EXCLUSIVAMENTE id + availability out of stock', () => {
    const req = buildCatalogDisablePatch(prod({ id: 'p1' }));
    expect(req.method).toBe('UPDATE');
    expect(req.data).toEqual({ id: 'ARM-744646-5202', availability: 'out of stock' });
  });

  it('jamás toca nombre, precio, imagen, descripción ni URL', () => {
    const req = buildCatalogDisablePatch(prod({ id: 'p1' }));
    for (const campo of ['title', 'price', 'image', 'description', 'link', 'brand']) {
      expect(req.data).not.toHaveProperty(campo);
    }
  });

  it('funciona aunque al producto le falten datos para un CREATE', () => {
    // La palanca de apagado no puede depender de campos que no se están enviando.
    const incompleto = prod({ id: 'p1', productUrl: undefined, perfume: null, images: [] });
    expect(buildCatalogDisablePatch(incompleto).data).toEqual({ id: 'ARM-744646-5202', availability: 'out of stock' });
  });
});

// ---------------------------------------------------------------------------
// 6. allow_upsert explícito: un CREATE nunca viaja disfrazado de UPDATE
// ---------------------------------------------------------------------------

describe('allow_upsert y semántica de creación', () => {
  it('el body declara allow_upsert=false explícitamente (fail-closed)', () => {
    // El default de Meta es true: un UPDATE crearía el item en silencio. Lo apagamos para
    // que crear sea SIEMPRE una decisión explícita del planner (method CREATE).
    expect(ITEMS_BATCH_ALLOW_UPSERT).toBe(false);
  });

  it('crear usa method CREATE, no un UPDATE que dependa del upsert implícito', () => {
    expect(buildCatalogCreatePayload(prod({ id: 'p1' })).method).toBe('CREATE');
  });

  it('los tres builders devuelven métodos tipados y distinguibles (nunca DELETE)', () => {
    const c: CatalogBatchRequest = buildCatalogCreatePayload(prod({ id: 'p1' }));
    const u: CatalogBatchRequest = buildCatalogUpdatePatch(prod({ id: 'p1' }), ['price']);
    const d: CatalogBatchRequest = buildCatalogDisablePatch(prod({ id: 'p1' }));
    expect([c.method, u.method, d.method]).toEqual(['CREATE', 'UPDATE', 'UPDATE']);
  });
});

// ---------------------------------------------------------------------------
// 6b. EL FAKE VALIDA EL CONTRATO (antes aceptaba cualquier forma)
// ---------------------------------------------------------------------------

describe('assertBatchRequestShape — el fake ya no acepta payloads arbitrarios', () => {
  const ok = () => buildCatalogCreatePayload(prod({ id: 'p1' }));

  it('acepta los requests que emiten los builders', () => {
    expect(() => assertBatchRequestShape(ok())).not.toThrow();
    expect(() => assertBatchRequestShape(buildCatalogUpdatePatch(prod({ id: 'p1' }), ['price']))).not.toThrow();
    expect(() => assertBatchRequestShape(buildCatalogDisablePatch(prod({ id: 'p1' })))).not.toThrow();
  });

  it('RECHAZA la identidad fuera de data (el contrato viejo)', () => {
    expect(() => assertBatchRequestShape({ method: 'UPDATE', retailer_id: 'SKU-A', data: { price: '1 PYG' } })).toThrow(/fuera de data/);
  });

  it('RECHAZA `name` en vez de `title` (campo del contrato de LECTURA)', () => {
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'SKU-A', name: 'X' } })).toThrow(/LECTURA/);
  });

  it('RECHAZA `image_url` y `url` (campos del contrato de LECTURA)', () => {
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'S', image_url: 'https://x/a.jpg' } })).toThrow(/LECTURA/);
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'S', url: 'https://x' } })).toThrow(/LECTURA/);
  });

  it('RECHAZA UPDATE sin identidad', () => {
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { price: '1 PYG' } })).toThrow(/data\.id/);
  });

  it('RECHAZA CREATE sin los obligatorios (link, brand, image…)', () => {
    expect(() => assertBatchRequestShape({ method: 'CREATE', data: { id: 'S', title: 'T' } })).toThrow(/CREATE sin campos obligatorios/);
  });

  it('RECHAZA cualquier campo INTERNO dentro de data (whitelist, no blacklist)', () => {
    // El fake es la última línea de defensa de privacidad del E2E: si aceptara un campo
    // interno, lo persistiría en las escrituras registradas y el centinela no lo vería.
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'S', costPrice: 120000 } })).toThrow(/no pertenece al contrato/);
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'S', aiNotes: 'margen 20%' } })).toThrow(/no pertenece al contrato/);
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'S', bankAccount: '1-1' } })).toThrow(/no pertenece al contrato/);
  });

  it('RECHAZA DELETE: el borrado físico no es una operación de este camino', () => {
    expect(() => assertBatchRequestShape({ method: 'DELETE', data: { id: 'S' } })).toThrow(/no permitido/);
  });

  it('RECHAZA formas inválidas de campos válidos', () => {
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'S', image: 'https://x/a.jpg' } })).toThrow(/array no vacío/);
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'S', image: [{ foo: 1 }] } })).toThrow(/array no vacío/);
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'S', price: 250000 } })).toThrow(/monto/);
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'S', link: 'http://inseguro/x' } })).toThrow(/https/);
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'S', title: 'X'.repeat(101) } })).toThrow(/100 caracteres/);
  });

  it('RECHAZA method inválido y availability/condition fuera del contrato', () => {
    expect(() => assertBatchRequestShape({ method: 'UPSERT', data: { id: 'S' } })).toThrow(/no permitido/);
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'S', availability: 'disponible' } })).toThrow(/availability inválida/);
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'S', condition: 'nuevo' } })).toThrow(/condition inválida/);
  });

  it('RECHAZA un id que supere los 100 caracteres', () => {
    expect(() => assertBatchRequestShape({ method: 'UPDATE', data: { id: 'X'.repeat(101), price: '1 PYG' } })).toThrow(/100 caracteres/);
  });
});

// ---------------------------------------------------------------------------
// 7. CENTINELAS DE PRIVACIDAD: nada interno sale jamás
// ---------------------------------------------------------------------------

describe('whitelist estricta — datos privados', () => {
  const privados = /NOTA-INTERNA|FICHA-INTERNA|costPrice|costo|margin|margen|ganancia|aiNotes|aiFicha|bankAccount|coverage|customer/i;

  it('CREATE no filtra ningún dato interno', () => {
    expect(JSON.stringify(buildCatalogCreatePayload(prod({ id: 'p1' })))).not.toMatch(privados);
  });

  it('UPDATE no filtra ningún dato interno', () => {
    expect(JSON.stringify(buildCatalogUpdatePatch(prod({ id: 'p1' }), ['price', 'title']))).not.toMatch(privados);
  });

  it('DISABLE no filtra ningún dato interno', () => {
    expect(JSON.stringify(buildCatalogDisablePatch(prod({ id: 'p1' })))).not.toMatch(privados);
  });

  it('un producto cargado de datos sensibles sigue emitiendo solo campos públicos', () => {
    const sensible = prod({
      id: 'p1',
      aiNotes: 'costo 200000, margen 20%, cuenta bancaria 1-1',
      aiFicha: { cuandoRecomendar: 'NOTA-INTERNA', objeciones: 'margen bajo' } as Product['aiFicha'],
    });
    const json = JSON.stringify(buildCatalogCreatePayload(sensible));
    expect(json).not.toMatch(privados);
    expect(json).not.toContain('1-1');
  });
});
