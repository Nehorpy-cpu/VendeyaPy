import { describe, it, expect, vi } from 'vitest';

/**
 * HARDEN-1 — FENCING GENERACIONAL del run de importación (ADR-0014 §4b):
 * cada claim lleva una generación inmutable (puntero metaCatalogImportState/current,
 * copiada al run) y TODA escritura posterior demuestra ownership antes de aplicar.
 * Un worker vencido (lease expirada + takeover) no escribe NADA: ni productos/locks,
 * ni drift, ni cursor/contadores, ni el cierre del run, ni el puntero. Cursor y
 * contadores jamás retroceden (guard monotónico en saveProgress).
 *
 * El "mundo" en memoria replica la semántica del store real de Firestore usando LAS
 * MISMAS primitivas puras (`ownsImportRun` / `importProgressRegression`) que usa
 * `firestoreImportStore` en sus transacciones.
 */
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  runImportPages,
  emptyImportCounters,
  importProgressRegression,
  ownsImportRun,
  ImportRunClaimLostError,
  type ImportLocalIndex,
  type ImportProgressPatch,
  type ImportRunStore,
} from './catalogImport.js';
import { FakeMetaCatalogClient } from './catalogClient.js';

const fxItem = (rid: string): Record<string, unknown> => ({
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
});

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

describe('ownsImportRun / importProgressRegression — primitivas puras del fencing', () => {
  it('ownsImportRun: running + generación exacta; cualquier otra cosa => false', () => {
    expect(ownsImportRun({ status: 'running', generation: 3 }, 3)).toBe(true);
    expect(ownsImportRun({ status: 'running', generation: 4 }, 3)).toBe(false); // takeover
    expect(ownsImportRun({ status: 'running', generation: 2 }, 3)).toBe(false); // gen vieja jamas valida
    expect(ownsImportRun({ status: 'completed', generation: 3 }, 3)).toBe(false); // terminal
    expect(ownsImportRun({ status: 'failed', generation: 3 }, 3)).toBe(false);
    expect(ownsImportRun(undefined, 3)).toBe(false); // el run ya no existe
    expect(ownsImportRun({ status: 'running' }, 0)).toBe(true); // docs pre-HARDEN: gen 0
  });

  it('importProgressRegression: cursor/contadores jamas retroceden; iguales o mayores pasan', () => {
    const current = { pagesDone: 2, processed: 40, counters: { ...emptyImportCounters(), imported: 30, skipped: 5 } };
    const ok = { pagesDone: 3, processed: 60, counters: { ...emptyImportCounters(), imported: 45, skipped: 5 } };
    expect(importProgressRegression(current, ok)).toBeNull();
    // El retry legitimo re-escribe LO MISMO: igual no es regresion.
    expect(
      importProgressRegression(current, { pagesDone: 2, processed: 40, counters: { ...emptyImportCounters(), imported: 30, skipped: 5 } }),
    ).toBeNull();
    expect(importProgressRegression(current, { ...ok, pagesDone: 1 })).toMatch(/pagesDone/);
    expect(importProgressRegression(current, { ...ok, processed: 10 })).toMatch(/processed/);
    expect(importProgressRegression(current, { ...ok, counters: { ...emptyImportCounters(), imported: 29, skipped: 5 } })).toMatch(/imported/);
    // Un reset de cursor NO es regresion: la monotonicidad vive en los contadores.
    const reset = { pagesDone: 2, processed: 40, counters: { ...emptyImportCounters(), imported: 30, skipped: 5, cursorResets: 1 } };
    expect(importProgressRegression(current, reset)).toBeNull();
  });
});

describe('runImportPages — fencing generacional', () => {
  function fencedWorld(over: Partial<ImportLocalIndex> = {}) {
    const world = {
      state: { activeRunId: 'run-1' as string | null, lastRunId: null as string | null, generation: 0 },
      run: {
        status: 'running' as string,
        generation: 0,
        pagesDone: 0,
        processed: 0,
        cursor: null as string | null,
        counters: emptyImportCounters(),
      },
      products: new Map<string, Record<string, unknown>>(),
      locks: new Map<string, string>(),
      drifts: [] as string[],
      regressions: [] as string[],
    };
    /** Un claim (creacion o takeover) SIEMPRE estrena generacion. */
    const claim = (): number => {
      world.state.generation++;
      world.run.generation = world.state.generation;
      world.run.status = 'running';
      return world.state.generation;
    };
    const storeFor = (
      gen: number,
      hooks: { beforeCreate?: (nthCreate: number) => void; beforeSave?: (patch: ImportProgressPatch) => void } = {},
    ) => {
      let createCalls = 0;
      const creates: string[] = [];
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
          createCalls++;
          hooks.beforeCreate?.(createCalls);
          if (!ownsImportRun(world.run, gen)) throw new ImportRunClaimLostError();
          const lockOwner = world.locks.get(a.lockKey);
          if (lockOwner && lockOwner !== a.productId) return 'lock_conflict';
          if (world.products.has(a.productId)) return 'already_imported';
          world.products.set(a.productId, a.doc);
          world.locks.set(a.lockKey, a.productId);
          creates.push(a.retailerId);
          return 'created';
        },
        markRemoteDrift: async (productId) => {
          if (!ownsImportRun(world.run, gen)) throw new ImportRunClaimLostError();
          world.drifts.push(productId);
        },
        saveProgress: async (patch) => {
          hooks.beforeSave?.(patch);
          if (!ownsImportRun(world.run, gen)) throw new ImportRunClaimLostError();
          const regresion = importProgressRegression(world.run, patch);
          if (regresion) {
            world.regressions.push(regresion);
            return; // se descarta: jamas se pisa progreso durable con valores viejos
          }
          Object.assign(world.run, {
            status: patch.status,
            cursor: patch.cursor,
            pagesDone: patch.pagesDone,
            processed: patch.processed,
            counters: JSON.parse(JSON.stringify(patch.counters)) as typeof world.run.counters,
          });
          if (patch.status === 'completed' && world.state.activeRunId === 'run-1') {
            world.state.activeRunId = null;
            world.state.lastRunId = 'run-1';
          }
        },
      };
      return { store, creates };
    };
    return { world, claim, storeFor };
  }

  const seed4 = () => new FakeMetaCatalogClient({ items: [fxItem('F1'), fxItem('F2'), fxItem('F3'), fxItem('F4')], pagesPerList: 2 });

  it('A suspendido mas alla del lease -> B reclama (gen nueva) -> A despierta: CERO escrituras tardias de A; B completa intacto', async () => {
    const { world, claim, storeFor } = fencedWorld();
    const genA = claim(); // A reclama
    // A queda "suspendido": antes de su PRIMERA escritura, B ya hizo el takeover.
    const genB = claim();
    const a = storeFor(genA, {});
    const rA = await runImportPages(runArgs({ client: seed4(), store: a.store }));
    expect(rA.status).toBe('running');
    expect(rA.stopReason).toBe('claim_lost');
    expect(a.creates).toHaveLength(0); // ni productos ni locks
    expect(world.products.size).toBe(0);
    expect(world.run.pagesDone).toBe(0); // ni cursor ni contadores
    expect(world.state.activeRunId).toBe('run-1'); // ni el puntero
    // B (claim vigente) corre el MISMO run hasta el final sin interferencia.
    const b = storeFor(genB, {});
    const rB = await runImportPages(runArgs({ client: seed4(), store: b.store }));
    expect(rB.status).toBe('completed');
    expect(rB.counters.imported).toBe(4);
    expect(world.products.size).toBe(4);
    expect(world.state.activeRunId).toBeNull(); // el puntero lo libera SOLO el dueno
    expect(world.run.status).toBe('completed');
  });

  it('takeover DURANTE la lectura de Meta: la primera escritura posterior ya no aplica', async () => {
    const { world, claim, storeFor } = fencedWorld();
    const genA = claim();
    const a = storeFor(genA, {});
    const client = seed4();
    const conTakeover = {
      listItemsPage: async (catalogId: string, cursor?: string | null) => {
        claim(); // B reclama mientras A espera la respuesta de Meta
        return client.listItemsPage(catalogId, cursor ?? null);
      },
    };
    const r = await runImportPages(runArgs({ client: conTakeover, store: a.store }));
    expect(r.stopReason).toBe('claim_lost');
    expect(world.products.size).toBe(0);
    expect(world.run.pagesDone).toBe(0);
  });

  it('takeover DURANTE la creacion por item: lo escrito como dueno queda; desde ahi, nada mas', async () => {
    const { world, claim, storeFor } = fencedWorld();
    const genA = claim();
    const a = storeFor(genA, {
      beforeCreate: (n) => {
        if (n === 2) claim();
      },
    });
    const r = await runImportPages(runArgs({ client: seed4(), store: a.store }));
    expect(r.stopReason).toBe('claim_lost');
    expect(a.creates).toEqual(['F1']); // el item 1 fue escrito SIENDO dueno (legitimo)
    expect(world.products.size).toBe(1);
    expect(world.run.pagesDone).toBe(0); // el cursor de A jamas llego a persistirse
    expect(world.state.activeRunId).toBe('run-1');
    // El re-barrido del dueno nuevo cuenta lo de A como alreadyImported (idempotencia).
    const b = storeFor(world.state.generation, {});
    const rB = await runImportPages(runArgs({ client: seed4(), store: b.store }));
    expect(rB.status).toBe('completed');
    expect(rB.counters.imported).toBe(3);
    expect(rB.counters.alreadyImported).toBe(1);
    expect(world.products.size).toBe(4);
  });

  it('takeover ANTES de saveProgress: la pagina procesada de A NO persiste cursor/contadores', async () => {
    const { world, claim, storeFor } = fencedWorld();
    const genA = claim();
    let saves = 0;
    const a = storeFor(genA, {
      beforeSave: () => {
        saves++;
        if (saves === 1) claim();
      },
    });
    const r = await runImportPages(runArgs({ client: seed4(), store: a.store }));
    expect(r.stopReason).toBe('claim_lost');
    expect(world.run.pagesDone).toBe(0);
    expect(world.run.counters.imported).toBe(0);
    expect(world.state.activeRunId).toBe('run-1');
  });

  it('takeover ANTES de completar: A no cierra el run ni libera el puntero de B', async () => {
    const { world, claim, storeFor } = fencedWorld();
    const genA = claim();
    const a = storeFor(genA, {
      beforeSave: (patch) => {
        if (patch.status === 'completed') claim();
      },
    });
    const r = await runImportPages(runArgs({ client: seed4(), store: a.store }));
    expect(r.stopReason).toBe('claim_lost');
    expect(world.run.status).toBe('running'); // JAMAS completed por un worker vencido
    expect(world.run.pagesDone).toBe(1); // la pagina 1 se persistio siendo dueno
    expect(world.state.activeRunId).toBe('run-1'); // el puntero sigue reclamado
  });

  it('takeover con drift pendiente: markRemoteDrift tampoco escribe vencido', async () => {
    const { world, claim, storeFor } = fencedWorld({
      importedByRid: new Map([
        ['F1', { productId: 'meta_F1', name: 'Nombre viejo', price: 150000, description: 'otra', imageUrl: 'https://cdn.test/i.jpg' }],
      ]),
    });
    const genA = claim();
    claim(); // takeover ANTES de que A despierte
    const a = storeFor(genA, {});
    const r = await runImportPages(runArgs({ client: seed4(), store: a.store }));
    expect(r.stopReason).toBe('claim_lost');
    expect(world.drifts).toEqual([]); // la quality del producto de B no se toco
  });

  it('dos reclaims consecutivos: la generacion intermedia tambien queda vencida', async () => {
    const { world, claim, storeFor } = fencedWorld();
    claim(); // gen 1 (A)
    const genB = claim(); // gen 2 (B)
    const genC = claim(); // gen 3 (C) — dos takeovers seguidos
    const b = storeFor(genB, {});
    const rB = await runImportPages(runArgs({ client: seed4(), store: b.store }));
    expect(rB.stopReason).toBe('claim_lost');
    expect(world.products.size).toBe(0);
    const c = storeFor(genC, {});
    const rC = await runImportPages(runArgs({ client: seed4(), store: c.store }));
    expect(rC.status).toBe('completed');
    expect(world.products.size).toBe(4);
  });

  it('retry legitimo del propietario VIGENTE: sigue escribiendo entre invocaciones sin perder nada', async () => {
    const { world, claim, storeFor } = fencedWorld();
    const gen = claim();
    const a = storeFor(gen, {});
    const r1 = await runImportPages(runArgs({ client: seed4(), store: a.store, maxPages: 1 }));
    expect(r1.status).toBe('running');
    expect(world.run.pagesDone).toBe(1);
    // Misma generacion (el claim sigue vigente): la reanudacion aplica normalmente.
    const r2 = await runImportPages(
      runArgs({
        client: seed4(),
        store: a.store,
        cursor: world.run.cursor,
        counters: world.run.counters,
        pagesDone: world.run.pagesDone,
        processed: world.run.processed,
      }),
    );
    expect(r2.status).toBe('completed');
    expect(world.run.counters.imported).toBe(4);
    expect(world.state.activeRunId).toBeNull();
    expect(world.regressions).toEqual([]);
  });

  it('una escritura REGRESIVA del dueno se descarta sin pisar el progreso durable', async () => {
    const { world, claim, storeFor } = fencedWorld();
    const gen = claim();
    const a = storeFor(gen, {});
    await runImportPages(runArgs({ client: seed4(), store: a.store, maxPages: 1 }));
    expect(world.run.counters.imported).toBe(2);
    // Un llamador con estado viejo intenta persistir MENOS progreso: se descarta.
    await a.store.saveProgress({ status: 'running', cursor: null, counters: emptyImportCounters(), blockedByReason: {}, pagesDone: 0, processed: 0 });
    expect(world.regressions).toHaveLength(1);
    expect(world.run.counters.imported).toBe(2); // intacto
    expect(world.run.pagesDone).toBe(1);
  });
});
