import { describe, it, expect, vi } from 'vitest';
import type { Product } from '@vpw/shared';

/**
 * META-CATALOG-GENERIC-ONBOARDING-QUALITY-1 — importación PAGINADA y reanudable:
 *  - listItemsPage en el cliente (HTTP real: una página por llamada; fake: pagina el fixture);
 *  - clasificación PURA por ítem (already_linked / already_imported+drift / ambiguous /
 *    conflicted / skipped / importable / sin clasificar);
 *  - runImportPages: cursor persistido tras CADA página, ALREADY_EXISTS contado (jamás
 *    aborta), cursor inválido ⇒ reset con cursorResets++, presupuesto de páginas.
 */
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  classifyPageItems,
  strongCandidateRidsForPage,
  runImportPages,
  emptyImportCounters,
  type ImportLocalIndex,
  type ImportProgressPatch,
  type ImportRunStore,
} from './catalogImport.js';
import { analyzeRemoteItems, retailerIdLockKey, type RemoteCandidate } from './catalogReconcile.js';
import {
  FakeMetaCatalogClient,
  HttpMetaCatalogClient,
  MetaCatalogApiError,
  REMOTE_ITEM_FIELDS,
  type CatalogHttpResponse,
  type MetaRemoteCatalogItem,
} from './catalogClient.js';

// ---------------------------------------------------------------------------
// Fábricas
// ---------------------------------------------------------------------------

/** Item crudo del fixture (contrato de LECTURA de Meta, snake_case). */
const fxItem = (rid: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `itm-${rid}`,
  retailer_id: rid,
  name: `Producto ${rid}`,
  description: `Producto ${rid} original con garantia oficial`,
  availability: 'in stock',
  price: '₲150.000',
  currency: 'PYG',
  image_url: 'https://cdn.test/i.jpg',
  brand: 'Lumen',
  url: 'https://tienda.test/p1',
  condition: 'new',
  product_type: '',
  ...over,
});

/** Candidato ya analizado (camelCase) para la clasificación pura. */
const cand = (rid: string, over: Partial<MetaRemoteCatalogItem> = {}): RemoteCandidate =>
  analyzeRemoteItems([
    {
      id: `itm-${rid}`,
      retailerId: rid,
      name: `Producto ${rid}`,
      description: `Producto ${rid} original con garantia oficial`,
      availability: 'in stock',
      price: '₲150.000',
      currency: 'PYG',
      imageUrl: 'https://cdn.test/i.jpg',
      brand: 'Lumen',
      url: 'https://tienda.test/p1',
      condition: 'new',
      productType: '',
      ...over,
    },
  ])[0]!;

const baseCtx = () => ({
  mappedRids: new Set<string>(),
  importedByRid: new Map<string, { productId: string; name: string; price: number; description: string; imageUrl: string }>(),
  localSkuRids: new Set<string>(),
  strongCandidateRids: new Set<string>(),
  defaultCategoryId: 'cat-1',
});

const prodLocal = (over: Partial<Product> & { id: string }): Product =>
  ({
    tenantId: 't1',
    name: 'Producto X1',
    description: '',
    price: 150000,
    compareAtPrice: null,
    aiNotes: '',
    currency: 'PYG',
    categoryId: 'cat-1',
    images: ['https://cdn.test/i.jpg'],
    emoji: '',
    inventory: { trackStock: true, stock: 1, lowStockThreshold: 1, sku: `sku-${over.id}` },
    status: 'ACTIVE',
    featured: false,
    position: 0,
    externalIds: { facebook: null, instagram: null, tiktok: null },
    perfume: null,
    aiFicha: null,
    createdAt: { seconds: 0, nanoseconds: 0 } as unknown as Product['createdAt'],
    updatedAt: { seconds: 0, nanoseconds: 0 } as unknown as Product['updatedAt'],
    ...over,
  }) as Product;

// ---------------------------------------------------------------------------
// FakeMetaCatalogClient.listItemsPage — paginación del fixture
// ---------------------------------------------------------------------------

describe('FakeMetaCatalogClient.listItemsPage', () => {
  const seed = { items: [fxItem('A1'), fxItem('A2'), fxItem('A3'), fxItem('A4'), fxItem('A5'), fxItem('A6')], pagesPerList: 3 };

  it('pagina el fixture según pagesPerList con cursores sintéticos page:<n>', async () => {
    const fake = new FakeMetaCatalogClient(seed);
    const p0 = await fake.listItemsPage('CAT', null);
    expect(p0.items.map((i) => i.retailerId)).toEqual(['A1', 'A2']);
    expect(p0.nextCursor).toBe('page:1');
    const p1 = await fake.listItemsPage('CAT', p0.nextCursor);
    expect(p1.items.map((i) => i.retailerId)).toEqual(['A3', 'A4']);
    const p2 = await fake.listItemsPage('CAT', p1.nextCursor);
    expect(p2.items.map((i) => i.retailerId)).toEqual(['A5', 'A6']);
    expect(p2.nextCursor).toBeNull();
    expect(fake.callsMade).toBe(3); // una llamada por página, como el cliente real
  });

  it('sin pagesPerList devuelve todo en una página; catálogo vacío ⇒ página vacía sin cursor', async () => {
    const todo = await new FakeMetaCatalogClient({ items: [fxItem('B1')] }).listItemsPage('CAT');
    expect(todo.items).toHaveLength(1);
    expect(todo.nextCursor).toBeNull();
    const vacio = await new FakeMetaCatalogClient({}).listItemsPage('CAT');
    expect(vacio.items).toEqual([]);
    expect(vacio.nextCursor).toBeNull();
  });

  it('cursor malformado o fuera de rango ⇒ error clasificable invalid_cursor', async () => {
    const fake = new FakeMetaCatalogClient(seed);
    const e1 = await fake.listItemsPage('CAT', 'basura').catch((e) => e);
    expect(e1).toBeInstanceOf(MetaCatalogApiError);
    expect((e1 as MetaCatalogApiError).kind).toBe('invalid_cursor');
    const e2 = await fake.listItemsPage('CAT', 'page:99').catch((e) => e);
    expect((e2 as MetaCatalogApiError).kind).toBe('invalid_cursor');
  });

  it('failWith op listItems también aplica a la lectura paginada', async () => {
    const fake = new FakeMetaCatalogClient({ ...seed, failWith: { op: 'listItems', status: 500, message: 'boom' } });
    const err = await fake.listItemsPage('CAT').catch((e) => e);
    expect(err).toBeInstanceOf(MetaCatalogApiError);
    expect((err as MetaCatalogApiError).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// HttpMetaCatalogClient.listItemsPage — una página por llamada
// ---------------------------------------------------------------------------

function makeTransport(responses: Array<CatalogHttpResponse | Error>) {
  const calls: Array<{ method: string; url: string }> = [];
  const transport = async (req: { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; data?: unknown; timeoutMs: number }) => {
    calls.push({ method: req.method, url: req.url });
    const next = responses.shift();
    if (!next) throw new Error('transport agotado');
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls };
}
const ok = (data: unknown): CatalogHttpResponse => ({ status: 200, headers: {}, data });

describe('HttpMetaCatalogClient.listItemsPage', () => {
  const NEXT = 'https://graph.facebook.com/v23.0/CAT/products?after=abc';

  it('primera página: mismo request que listItems y nextCursor = paging.next validado', async () => {
    const { transport, calls } = makeTransport([ok({ data: [fxItem('A1')], paging: { next: NEXT } })]);
    const c = new HttpMetaCatalogClient('tok', { version: 'v23.0', transport, sleep: async () => {} });
    const page = await c.listItemsPage('CAT');
    expect(calls[0]!.url).toBe(`https://graph.facebook.com/v23.0/CAT/products?fields=${REMOTE_ITEM_FIELDS}&limit=100`);
    expect(page.items[0]!.retailerId).toBe('A1');
    expect(page.items[0]!.imageUrl).toBe('https://cdn.test/i.jpg'); // mismo mapeo que listItems
    expect(page.nextCursor).toBe(NEXT);
    expect(c.callsMade).toBe(1);
  });

  it('con cursor: usa la URL next tal cual; última página devuelve nextCursor null', async () => {
    const { transport, calls } = makeTransport([ok({ data: [fxItem('A2')] })]);
    const c = new HttpMetaCatalogClient('tok', { version: 'v23.0', transport, sleep: async () => {} });
    const page = await c.listItemsPage('CAT', NEXT);
    expect(calls[0]!.url).toBe(NEXT);
    expect(page.nextCursor).toBeNull();
  });

  it('cursor con host inesperado ⇒ invalid_cursor SIN llamar a la red (el Bearer no viaja)', async () => {
    const { transport, calls } = makeTransport([]);
    const c = new HttpMetaCatalogClient('tok', { version: 'v23.0', transport, sleep: async () => {} });
    const err = await c.listItemsPage('CAT', 'https://malo.example/products').catch((e) => e);
    expect((err as MetaCatalogApiError).kind).toBe('invalid_cursor');
    expect(calls).toHaveLength(0);
  });

  it('Graph 400 code 100 al SEGUIR un cursor ⇒ invalid_cursor (vencido); en la primera página NO', async () => {
    const rechazo: CatalogHttpResponse = { status: 400, headers: {}, data: { error: { message: 'cursor expired', code: 100 } } };
    const c1 = new HttpMetaCatalogClient('tok', { version: 'v23.0', transport: makeTransport([rechazo]).transport, sleep: async () => {} });
    const e1 = await c1.listItemsPage('CAT', NEXT).catch((e) => e);
    expect((e1 as MetaCatalogApiError).kind).toBe('invalid_cursor');
    const c2 = new HttpMetaCatalogClient('tok', { version: 'v23.0', transport: makeTransport([rechazo]).transport, sleep: async () => {} });
    const e2 = await c2.listItemsPage('CAT').catch((e) => e);
    expect((e2 as MetaCatalogApiError).kind).toBe('http'); // error real del catálogo, no del cursor
  });

  it('paging.next con host ajeno en la RESPUESTA ⇒ aborta como listItems (jamás se sigue)', async () => {
    const { transport } = makeTransport([ok({ data: [], paging: { next: 'https://evil.example/x' } })]);
    const c = new HttpMetaCatalogClient('tok', { version: 'v23.0', transport, sleep: async () => {} });
    const err = await c.listItemsPage('CAT').catch((e) => e);
    expect(err).toBeInstanceOf(MetaCatalogApiError);
    expect((err as MetaCatalogApiError).kind).toBe('http');
  });
});

// ---------------------------------------------------------------------------
// classifyPageItems — clasificación PURA por ítem
// ---------------------------------------------------------------------------

describe('classifyPageItems', () => {
  it('ya vinculado (metaRetailerId local) ⇒ already_linked, aunque también exista como importado', () => {
    const ctx = baseCtx();
    ctx.mappedRids.add('A1');
    ctx.importedByRid.set('A1', { productId: 'meta_A1', name: 'Producto A1', price: 150000, description: '', imageUrl: '' });
    const [c] = classifyPageItems([cand('A1')], ctx);
    expect(c!.kind).toBe('already_linked');
  });

  it('ya importado sin cambios ⇒ already_imported sin drift', () => {
    const ctx = baseCtx();
    const item = cand('A1');
    ctx.importedByRid.set('A1', {
      productId: 'meta_A1',
      name: item.name,
      price: item.priceGs,
      description: item.description,
      imageUrl: item.imageUrl,
    });
    const [c] = classifyPageItems([item], ctx);
    expect(c!.kind).toBe('already_imported');
    if (c!.kind === 'already_imported') {
      expect(c.productId).toBe('meta_A1');
      expect(c.driftFields).toEqual([]);
    }
  });

  it('ya importado con el remoto cambiado ⇒ already_imported con driftFields (remote_drift)', () => {
    const ctx = baseCtx();
    ctx.importedByRid.set('A1', { productId: 'meta_A1', name: 'Nombre viejo', price: 99000, description: 'otra', imageUrl: 'https://cdn.test/vieja.jpg' });
    const [c] = classifyPageItems([cand('A1')], ctx);
    expect(c!.kind).toBe('already_imported');
    if (c!.kind === 'already_imported') {
      expect(c.driftFields).toEqual(expect.arrayContaining(['name', 'price', 'description', 'image']));
    }
  });

  it('candidato FUERTE de mapping local ⇒ ambiguous (requiere humano, jamás se importa)', () => {
    const ctx = baseCtx();
    ctx.strongCandidateRids.add('A1');
    const [c] = classifyPageItems([cand('A1')], ctx);
    expect(c!.kind).toBe('ambiguous');
  });

  it('rid que choca con el SKU de un producto local NO importado ⇒ conflicted (no "ya importado")', () => {
    const ctx = baseCtx();
    ctx.localSkuRids.add('A1');
    const [c] = classifyPageItems([cand('A1')], ctx);
    expect(c!.kind).toBe('conflicted');
    if (c!.kind === 'conflicted') expect(c.reason).toBe('sku_taken_by_local');
  });

  it('flags bloqueantes ⇒ skipped con razón (invalid_price / image_not_https)', () => {
    const [precio] = classifyPageItems([cand('A1', { price: 'USD 90', currency: 'USD' })], baseCtx());
    expect(precio!.kind).toBe('skipped');
    if (precio!.kind === 'skipped') expect(precio.reason).toBe('invalid_price');
    const [img] = classifyPageItems([cand('A2', { imageUrl: 'http://inseguro.test/i.jpg' })], baseCtx());
    expect(img!.kind).toBe('skipped');
    if (img!.kind === 'skipped') expect(img.reason).toBe('image_not_https');
  });

  it('importable limpio con categoría; sin defaultCategoryId ⇒ borrador sin clasificar (categoryId vacío)', () => {
    const [conCat] = classifyPageItems([cand('A1')], baseCtx());
    expect(conCat!.kind).toBe('importable');
    if (conCat!.kind === 'importable') {
      expect(conCat.categoryId).toBe('cat-1');
      expect(conCat.unclassified).toBe(false);
    }
    const [sinCat] = classifyPageItems([cand('A1')], { ...baseCtx(), defaultCategoryId: '' });
    expect(sinCat!.kind).toBe('importable');
    if (sinCat!.kind === 'importable') {
      expect(sinCat.categoryId).toBe('');
      expect(sinCat.unclassified).toBe(true);
    }
  });

  it('strongCandidateRidsForPage detecta por página el mismo bloqueo que el import clásico', () => {
    const local = prodLocal({ id: 'x1', name: 'Producto A1 Lumen', perfume: null });
    const rids = strongCandidateRidsForPage([local], [cand('A1')]);
    expect(rids.has('A1')).toBe(true);
    const ajeno = prodLocal({ id: 'x2', name: 'Zapatilla Runner 42' });
    expect(strongCandidateRidsForPage([ajeno], [cand('A1')]).has('A1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runImportPages — cursor persistido, idempotencia por ítem, presupuesto
// ---------------------------------------------------------------------------

function memStore(over: Partial<ImportLocalIndex> = {}) {
  const creates: Array<{ productId: string; lockKey: string; retailerId: string; doc: Record<string, unknown> }> = [];
  const drifts: Array<{ productId: string; driftFields: string[] }> = [];
  const progress: ImportProgressPatch[] = [];
  const outcomes = new Map<string, 'created' | 'already_imported' | 'lock_conflict'>();
  const index: ImportLocalIndex = {
    mappedRids: new Set(),
    importedByRid: new Map(),
    localSkuRids: new Set(),
    localNames: new Set(),
    unlinkedProducts: [],
    productsCount: 0,
    ...over,
  };
  const store: ImportRunStore = {
    loadLocalIndex: async () => index,
    createImported: async (a) => {
      creates.push(a);
      return outcomes.get(a.retailerId) ?? 'created';
    },
    markRemoteDrift: async (productId, _item, driftFields) => {
      drifts.push({ productId, driftFields });
    },
    saveProgress: async (p) => {
      progress.push(JSON.parse(JSON.stringify(p)) as ImportProgressPatch);
    },
  };
  return { store, creates, drifts, progress, outcomes, index };
}

const runArgs = (over: Partial<Parameters<typeof runImportPages>[0]>) => ({
  tenantId: 't1',
  catalogId: 'CAT',
  cursor: null as string | null,
  counters: emptyImportCounters(),
  blockedByReason: {},
  pagesDone: 0,
  processed: 0,
  maxPages: 5,
  defaultCategoryId: 'cat-1',
  profile: null,
  ...over,
});

describe('runImportPages', () => {
  const seed6 = { items: [fxItem('A1'), fxItem('A2'), fxItem('A3'), fxItem('A4'), fxItem('A5'), fxItem('A6')], pagesPerList: 3 };

  it('maxPages agota el presupuesto: cursor y contadores persistidos tras CADA página, status running', async () => {
    const { store, creates, progress } = memStore();
    const client = new FakeMetaCatalogClient(seed6);
    const r = await runImportPages(runArgs({ client, store, maxPages: 1 }));
    expect(r.status).toBe('running');
    expect(r.stopReason).toBe('pages_budget');
    expect(r.cursor).toBe('page:1');
    expect(r.pagesDone).toBe(1);
    expect(r.counters.imported).toBe(2);
    expect(creates).toHaveLength(2);
    // El progreso quedó persistido DESPUÉS de la página (crash ⇒ reanuda desde acá).
    expect(progress.at(-1)!.cursor).toBe('page:1');
    expect(progress.at(-1)!.status).toBe('running');
    expect(progress.at(-1)!.counters.imported).toBe(2);
  });

  it('reanudación desde el cursor persistido completa el catálogo sin re-crear lo anterior', async () => {
    const { store, creates, progress } = memStore();
    const client = new FakeMetaCatalogClient(seed6);
    const r = await runImportPages(runArgs({ client, store, cursor: 'page:1', counters: { ...emptyImportCounters(), imported: 2 }, pagesDone: 1, processed: 2 }));
    expect(r.status).toBe('completed');
    expect(r.cursor).toBeNull();
    expect(r.pagesDone).toBe(3);
    expect(r.processed).toBe(6);
    expect(r.counters.imported).toBe(6); // 2 previos + 4 nuevos
    expect(creates.map((c) => c.retailerId)).toEqual(['A3', 'A4', 'A5', 'A6']);
    expect(progress.at(-1)!.status).toBe('completed');
  });

  it('ALREADY_EXISTS por ítem se cuenta como alreadyImported y JAMÁS aborta la página', async () => {
    const { store, creates, outcomes } = memStore();
    outcomes.set('A1', 'already_imported');
    const client = new FakeMetaCatalogClient({ items: [fxItem('A1'), fxItem('A2')] });
    const r = await runImportPages(runArgs({ client, store }));
    expect(r.status).toBe('completed');
    expect(r.counters.alreadyImported).toBe(1);
    expect(r.counters.imported).toBe(1);
    expect(creates).toHaveLength(2); // se intentaron los dos; el conflicto se absorbió por ítem
  });

  it('re-procesar una página ya escrita es un no-op declarado (idempotencia de la reanudación)', async () => {
    const { store, outcomes } = memStore();
    outcomes.set('A1', 'already_imported');
    outcomes.set('A2', 'already_imported');
    const client = new FakeMetaCatalogClient({ items: [fxItem('A1'), fxItem('A2')] });
    const r = await runImportPages(runArgs({ client, store }));
    expect(r.counters.imported).toBe(0);
    expect(r.counters.alreadyImported).toBe(2);
  });

  it('lock ajeno ⇒ conflicted (dos productos jamás comparten retailer_id)', async () => {
    const { store, outcomes } = memStore();
    outcomes.set('A1', 'lock_conflict');
    const client = new FakeMetaCatalogClient({ items: [fxItem('A1')] });
    const r = await runImportPages(runArgs({ client, store }));
    expect(r.counters.conflicted).toBe(1);
    expect(r.counters.imported).toBe(0);
  });

  it('cursor inválido ⇒ reset a null con cursorResets++ y el barrido continúa (idempotente)', async () => {
    const { store, progress } = memStore();
    const client = new FakeMetaCatalogClient({ items: [fxItem('A1'), fxItem('A2')], pagesPerList: 2 });
    const r = await runImportPages(runArgs({ client, store, cursor: 'page:99', maxPages: 4 }));
    expect(r.counters.cursorResets).toBe(1);
    expect(r.status).toBe('completed');
    expect(r.counters.imported).toBe(2);
    // El reset quedó persistido antes de seguir (crash después del reset no pierde el estado).
    expect(progress.some((p) => p.cursor === null && p.counters.cursorResets === 1)).toBe(true);
  });

  it('error remoto NO-cursor ⇒ corta la invocación con lastError saneado y cursor intacto', async () => {
    const { store, progress } = memStore();
    const client = new FakeMetaCatalogClient({ items: [fxItem('A1')], failWith: { op: 'listItems', status: 500, message: 'boom' } });
    const r = await runImportPages(runArgs({ client, store }));
    expect(r.status).toBe('running');
    expect(r.stopReason).toBe('remote_error');
    expect(r.lastError).toBeTruthy();
    expect(r.counters.imported).toBe(0);
    expect(progress.at(-1)!.lastError).toBeTruthy();
  });

  it('cuota agotada ⇒ para ANTES de escribir la página, con estado explícito reanudable', async () => {
    const { store, creates } = memStore();
    const client = new FakeMetaCatalogClient({ items: [fxItem('A1'), fxItem('A2')] });
    const r = await runImportPages(
      runArgs({
        client,
        store,
        assertQuota: async () => {
          throw new Error('límite del plan alcanzado');
        },
      }),
    );
    expect(r.status).toBe('running');
    expect(r.stopReason).toBe('quota');
    expect(creates).toHaveLength(0);
  });

  it('el doc importado lleva id determinístico, lock del retailer_id, brand neutral y quality', async () => {
    const { store, creates } = memStore();
    const client = new FakeMetaCatalogClient({ items: [fxItem('A1')] });
    await runImportPages(runArgs({ client, store }));
    const c = creates[0]!;
    expect(c.productId).toBe(`meta_${retailerIdLockKey('A1')}`);
    expect(c.lockKey).toBe(retailerIdLockKey('A1'));
    expect(c.doc.brand).toBe('Lumen'); // marca NEUTRAL top-level (no atrapada en perfume)
    expect(c.doc.syncToMeta).toBe(false);
    expect(c.doc.status).toBe('INACTIVE');
    const quality = c.doc.quality as { blocking: number; fingerprints: Record<string, { origin: string }> };
    expect(quality.blocking).toBeGreaterThan(0); // not_active + stock_pending_review, mínimo
    expect(Object.values(quality.fingerprints)[0]!.origin).toBe('import');
  });

  it('sin defaultCategoryId importa IGUAL como borrador sin clasificar, con la observación', async () => {
    const { store, creates } = memStore();
    const client = new FakeMetaCatalogClient({ items: [fxItem('A1')] });
    const r = await runImportPages(runArgs({ client, store, defaultCategoryId: '' }));
    expect(r.counters.imported).toBe(1);
    expect(r.counters.unclassified).toBe(1);
    const doc = creates[0]!.doc;
    expect(doc.categoryId).toBe('');
    const q = doc.quality as { fingerprints: Record<string, unknown> };
    expect(q.fingerprints['category_unclassified:categoryId']).toBeDefined();
  });

  it('perfil arfagi (default) arma perfume con la marca; vertical generic NO fabrica perfume', async () => {
    const mkClient = () => new FakeMetaCatalogClient({ items: [fxItem('A1', { product_type: 'Perfumes > Perfume > Femenino' })] });
    const def = memStore();
    await runImportPages(runArgs({ client: mkClient(), store: def.store }));
    expect((def.creates[0]!.doc.perfume as { brand: string }).brand).toBe('Lumen');
    const gen = memStore();
    await runImportPages(runArgs({ client: mkClient(), store: gen.store, profile: { vertical: 'generic' } }));
    expect(gen.creates[0]!.doc.perfume).toBeNull();
    expect(gen.creates[0]!.doc.brand).toBe('Lumen');
  });

  it('already_imported con drift dispara markRemoteDrift sobre el producto local (jamás lo pisa)', async () => {
    const { store, drifts, creates, index } = memStore();
    index.importedByRid.set('A1', { productId: 'meta_A1', name: 'Nombre viejo', price: 150000, description: 'Producto A1 original con garantia oficial', imageUrl: 'https://cdn.test/i.jpg' });
    const client = new FakeMetaCatalogClient({ items: [fxItem('A1')] });
    const r = await runImportPages(runArgs({ client, store }));
    expect(r.counters.alreadyImported).toBe(1);
    expect(creates).toHaveLength(0);
    expect(drifts).toEqual([{ productId: 'meta_A1', driftFields: ['name'] }]);
  });

  it('ambiguous y skipped quedan contados por razón (bloqueosPorRazon del run)', async () => {
    const { store, index } = memStore();
    index.unlinkedProducts.push(prodLocal({ id: 'x1', name: 'Producto A1 Lumen' }));
    const client = new FakeMetaCatalogClient({ items: [fxItem('A1'), fxItem('A2', { price: 'USD 9', currency: 'USD' })] });
    const r = await runImportPages(runArgs({ client, store }));
    expect(r.counters.ambiguous).toBe(1);
    expect(r.counters.skipped).toBe(1);
    expect(r.blockedByReason.strong_mapping_candidate).toBe(1);
    expect(r.blockedByReason.invalid_price).toBe(1);
  });

  it('la posición de los importados es determinística: sigue al catálogo local existente', async () => {
    const { store, creates } = memStore({ productsCount: 10 });
    const client = new FakeMetaCatalogClient({ items: [fxItem('A1'), fxItem('A2')] });
    await runImportPages(runArgs({ client, store }));
    expect(creates.map((c) => c.doc.position)).toEqual([10, 11]);
  });

  it('un duplicado local de nombre se importa IGUAL pero con probable_duplicate (WARNING)', async () => {
    const { store, creates } = memStore({ localNames: new Set(['producto a1']) });
    const client = new FakeMetaCatalogClient({ items: [fxItem('A1', { name: 'Producto A1' })] });
    const r = await runImportPages(runArgs({ client, store }));
    expect(r.counters.imported).toBe(1);
    const q = creates[0]!.doc.quality as { fingerprints: Record<string, unknown> };
    expect(q.fingerprints['probable_duplicate:name']).toBeDefined();
  });
});
