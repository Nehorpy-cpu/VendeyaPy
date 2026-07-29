import { describe, it, expect, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Product, ProductQuality } from '@vpw/shared';

/**
 * HARDEN-1 — Operación de MANTENIMIENTO del catálogo (ADR-0014 §4c):
 * backfill de metaRetailerLocks faltantes + quality de productos que no la tienen,
 * paginado por cursor local, reanudable e idempotente. `preview` (default) NO escribe
 * NADA; `apply` escribe SOLO locks nuevos y el campo `quality` — jamás toca
 * nombre/precio/costo/stock/status/mapping/syncToMeta. Conflictos de identidad se
 * REPORTAN (productIds + rid) sin elegir ganador ni tocar nada ambiguo.
 */
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  emptyMaintenanceCounters,
  runMaintenancePages,
  MAX_STORED_CONFLICTS,
  type MaintenanceProgressPatch,
  type MaintenanceStore,
} from './catalogMaintenance.js';
import { retailerIdLockKey, normalizeText } from './catalogReconcile.js';

const T0 = Timestamp.fromMillis(1_700_000_000_000);
const TS = T0 as unknown as Product['createdAt'];

const prod = (id: string, over: Partial<Product> = {}): Product =>
  ({
    id,
    tenantId: 't1',
    name: `Producto ${id}`,
    description: `Producto ${id} con garantia oficial`,
    price: 150000,
    compareAtPrice: null,
    aiNotes: '',
    currency: 'PYG',
    categoryId: 'cat-1',
    images: ['https://cdn.test/i.jpg'],
    emoji: '',
    inventory: { trackStock: true, stock: 3, lowStockThreshold: 1, sku: `sku-${id}` },
    status: 'ACTIVE',
    featured: false,
    position: 0,
    externalIds: { facebook: null, instagram: null, tiktok: null },
    perfume: null,
    aiFicha: null,
    productUrl: `https://tienda.test/p/${id}`,
    brand: 'Lumen',
    syncToMeta: false,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }) as Product;

const qualityVigente = (): ProductQuality => ({
  blocking: 0,
  warning: 0,
  fingerprints: {
    'price_invalid:price': {
      code: 'price_invalid',
      severity: 'BLOCKING',
      field: 'price',
      message: 'x',
      action: 'x',
      firstSeenAt: T0,
      lastSeenAt: T0,
      resolvedAt: T0, // observación RESUELTA: historia que no debe alterarse
      origin: 'editor',
    },
  },
  evaluatedAt: T0,
});

/** Mundo en memoria de UN tenant: products + locks + writes auditables. */
function memWorld(products: Product[], locks: Record<string, string> = {}) {
  const world = {
    products: new Map(products.map((p) => [p.id, { ...p }])),
    locks: new Map(Object.entries(locks)),
    /** Log de escrituras por producto: SOLO puede contener el campo quality. */
    productWrites: [] as Array<{ productId: string; fields: string[] }>,
    lockWrites: [] as string[],
    progress: [] as MaintenanceProgressPatch[],
    /** Ids cuya escritura de quality debe fallar como error de transacción (C3). */
    failQualityFor: new Set<string>(),
  };
  const ordered = () => [...world.products.values()].sort((a, b) => a.id.localeCompare(b.id));
  const store: MaintenanceStore = {
    async listProductsPage(cursor, pageSize) {
      const all = ordered();
      const start = cursor ? all.findIndex((p) => p.id === cursor) + 1 : 0;
      const page = all.slice(start, start + pageSize);
      const nextCursor = page.length === pageSize ? page[page.length - 1]!.id : null;
      return { products: page.map((p) => ({ ...p })), nextCursor };
    },
    async loadNameCounts() {
      const out = new Map<string, number>();
      for (const p of world.products.values()) {
        if (p.status === 'ARCHIVED') continue;
        const n = normalizeText(p.name);
        if (n) out.set(n, (out.get(n) ?? 0) + 1);
      }
      return out;
    },
    async productsClaimingRid(retailerId) {
      return ordered()
        .filter((p) => (p.metaRetailerId ?? '').trim() === retailerId)
        .map((p) => p.id);
    },
    async getLockOwner(lockKey) {
      return world.locks.get(lockKey) ?? null;
    },
    async createLock({ lockKey, productId }) {
      const owner = world.locks.get(lockKey);
      if (owner) return owner === productId ? 'exists_own' : 'exists_other';
      world.locks.set(lockKey, productId);
      world.lockWrites.push(lockKey);
      return 'created';
    },
    async backfillQuality(productId, evaluate) {
      // Contrato post-C3: resultado con outcome discriminado (los errores de transacción
      // se cuentan aparte de 'missing'); el fallo inyectable simula una tx que lanza.
      if (world.failQualityFor?.has(productId)) return { outcome: 'error', error: 'tx simulada rota' };
      const fresh = world.products.get(productId);
      if (!fresh) return { outcome: 'missing' };
      if (fresh.quality) return { outcome: 'already' };
      const quality = evaluate({ ...fresh });
      world.products.set(productId, { ...fresh, quality });
      world.productWrites.push({ productId, fields: ['quality'] });
      return { outcome: 'written' };
    },
    async saveProgress(patch) {
      world.progress.push(JSON.parse(JSON.stringify(patch)) as MaintenanceProgressPatch);
    },
  };
  return { world, store };
}

const args = (over: Partial<Parameters<typeof runMaintenancePages>[0]>) => ({
  tenantId: 't1',
  mode: 'preview' as const,
  profile: null,
  cursor: null as string | null,
  counters: emptyMaintenanceCounters(),
  conflicts: [],
  conflictsTruncated: false,
  pagesDone: 0,
  maxPages: 10,
  pageSize: 200,
  now: () => T0,
  ...over,
});

describe('runMaintenancePages — preview (default) NO escribe nada', () => {
  it('cuenta lo que HARÍA (locks + quality) con cero escrituras', async () => {
    const { world, store } = memWorld([
      prod('a1', { metaRetailerId: 'RID-1' }), // sin lock, sin quality
      prod('a2', { quality: qualityVigente() }), // sin rid, quality vigente
      prod('a3'), // sin rid, sin quality
    ]);
    const r = await runMaintenancePages(args({ store, mode: 'preview' }));
    expect(r.status).toBe('completed');
    expect(r.counters).toEqual({
      examinados: 3,
      locksCreados: 1, // lo que SE HARÍA
      locksExistentes: 0,
      conflictos: 0,
      qualityCalculada: 2, // a1 + a3
      qualityVigente: 1,
      archivadosSalteados: 0,
      erroresQuality: 0,
    });
    expect(world.lockWrites).toEqual([]); // NADA escrito
    expect(world.productWrites).toEqual([]);
    expect(world.locks.size).toBe(0);
    expect([...world.products.values()].filter((p) => p.quality).length).toBe(1); // solo la previa
  });

  it('apply sin confirmación explícita NO existe en el core: el modo viene validado del callable', async () => {
    // El core recibe mode ya validado; el gate confirm:true vive en el callable (fail-closed).
    const { world, store } = memWorld([prod('a1')]);
    const r = await runMaintenancePages(args({ store, mode: 'preview' }));
    expect(r.status).toBe('completed');
    expect(world.productWrites).toEqual([]);
  });
});

describe('runMaintenancePages — apply: locks', () => {
  it('lock faltante se crea; lock propio existente se cuenta; jamás se pisa uno ajeno', async () => {
    const { world, store } = memWorld(
      [
        prod('a1', { metaRetailerId: 'RID-1' }), // falta lock => crear
        prod('a2', { metaRetailerId: 'RID-2' }), // lock propio => ok
        prod('a3', { metaRetailerId: 'RID-3' }), // lock de OTRO => conflicto
      ],
      { [retailerIdLockKey('RID-2')]: 'a2', [retailerIdLockKey('RID-3')]: 'zz-otro' },
    );
    const r = await runMaintenancePages(args({ store, mode: 'apply' }));
    expect(r.counters.locksCreados).toBe(1);
    expect(r.counters.locksExistentes).toBe(1);
    expect(r.counters.conflictos).toBe(1);
    expect(world.locks.get(retailerIdLockKey('RID-1'))).toBe('a1');
    expect(world.locks.get(retailerIdLockKey('RID-3'))).toBe('zz-otro'); // intacto
    expect(r.conflicts).toEqual([{ retailerId: 'RID-3', productIds: ['a3', 'zz-otro'] }]);
  });

  it('dos productos reclamando el MISMO rid => conflicto con ambos productIds, sin ganador ni escrituras', async () => {
    const { world, store } = memWorld([
      prod('a1', { metaRetailerId: 'RID-X' }),
      prod('a2', { metaRetailerId: 'RID-X' }),
    ]);
    const r = await runMaintenancePages(args({ store, mode: 'apply' }));
    expect(r.counters.conflictos).toBe(1); // UN rid en conflicto (no dos)
    expect(r.conflicts).toEqual([{ retailerId: 'RID-X', productIds: ['a1', 'a2'] }]);
    expect(world.lockWrites).toEqual([]); // JAMÁS se elige ganador
    // Los productos ambiguos tampoco reciben quality (no se toca nada ambiguo).
    expect(world.productWrites).toEqual([]);
  });

  it('el producto conflictivo no recibe quality, pero los sanos de la misma corrida sí', async () => {
    const { world, store } = memWorld([
      prod('a1', { metaRetailerId: 'RID-X' }),
      prod('a2', { metaRetailerId: 'RID-X' }),
      prod('a3'),
    ]);
    const r = await runMaintenancePages(args({ store, mode: 'apply' }));
    expect(r.counters.qualityCalculada).toBe(1);
    expect(world.productWrites).toEqual([{ productId: 'a3', fields: ['quality'] }]);
  });
});

describe('runMaintenancePages — apply: backfill de quality', () => {
  it('producto sin quality: se calcula con el perfil efectivo y se escribe SOLO quality', async () => {
    const { world, store } = memWorld([prod('a1', { price: 0 })]); // price_invalid real
    const r = await runMaintenancePages(args({ store, mode: 'apply' }));
    expect(r.counters.qualityCalculada).toBe(1);
    expect(world.productWrites).toEqual([{ productId: 'a1', fields: ['quality'] }]);
    const p = world.products.get('a1')!;
    expect(p.quality!.blocking).toBeGreaterThan(0);
    expect(p.quality!.fingerprints['price_invalid:price']).toBeDefined();
    // NADA MÁS cambió: nombre/precio/stock/status/sync intactos.
    expect(p.price).toBe(0);
    expect(p.status).toBe('ACTIVE');
    expect(p.syncToMeta).toBe(false);
    expect(p.inventory.stock).toBe(3);
  });

  it('quality vigente NO se recalcula ni se toca (incluida la que tiene observaciones resueltas)', async () => {
    const previa = qualityVigente();
    const { world, store } = memWorld([prod('a1', { quality: previa })]);
    const r = await runMaintenancePages(args({ store, mode: 'apply' }));
    expect(r.counters.qualityVigente).toBe(1);
    expect(r.counters.qualityCalculada).toBe(0);
    expect(world.productWrites).toEqual([]);
    // La historia (resolvedAt sellado) quedó EXACTAMENTE igual.
    expect(world.products.get('a1')!.quality).toEqual(previa);
  });

  it('el perfil del tenant llega al evaluador (vertical perfumeria vs generic)', async () => {
    // Nombre = puro vocabulario de perfumería + descripción ajena: mismatch SOLO en generic.
    const base = () => [prod('a1', { name: 'Perfume EDP 100ml', brand: '', description: 'Estuche de regalo con lazo' })];
    const generico = memWorld(base());
    await runMaintenancePages(args({ store: generico.store, mode: 'apply', profile: null }));
    expect(generico.world.products.get('a1')!.quality!.fingerprints['name_description_mismatch:description']).toBeDefined();
    const perfumeria = memWorld(base());
    await runMaintenancePages(args({ store: perfumeria.store, mode: 'apply', profile: { vertical: 'perfumeria' } }));
    expect(perfumeria.world.products.get('a1')!.quality!.fingerprints['name_description_mismatch:description']).toBeUndefined();
  });

  it('probable_duplicate usa los nombres del propio tenant (excluyendo el propio salvo homónimos)', async () => {
    const { world, store } = memWorld([
      prod('a1', { name: 'Gemelo Exacto' }),
      prod('a2', { name: 'Gemelo Exacto' }),
      prod('a3', { name: 'Nombre Unico Real' }),
    ]);
    await runMaintenancePages(args({ store, mode: 'apply' }));
    expect(world.products.get('a1')!.quality!.fingerprints['probable_duplicate:name']).toBeDefined();
    expect(world.products.get('a2')!.quality!.fingerprints['probable_duplicate:name']).toBeDefined();
    expect(world.products.get('a3')!.quality!.fingerprints['probable_duplicate:name']).toBeUndefined();
  });
});

describe('runMaintenancePages — paginación, reanudación e idempotencia', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => prod(`p${String(i + 1).padStart(2, '0')}`));

  it('respeta el presupuesto de páginas: queda running con cursor (jamás se presenta como completo)', async () => {
    const { world, store } = memWorld(many(5));
    const r = await runMaintenancePages(args({ store, mode: 'apply', pageSize: 2, maxPages: 1 }));
    expect(r.status).toBe('running');
    expect(r.stopReason).toBe('pages_budget');
    expect(r.cursor).toBe('p02');
    expect(r.counters.examinados).toBe(2);
    expect(world.progress.at(-1)!.status).toBe('running');
    expect(world.progress.at(-1)!.cursor).toBe('p02');
  });

  it('reanuda desde el cursor persistido y completa sin re-escribir lo anterior', async () => {
    const { world, store } = memWorld(many(5));
    const r1 = await runMaintenancePages(args({ store, mode: 'apply', pageSize: 2, maxPages: 1 }));
    const writesTrasPrimera = world.productWrites.length;
    const r2 = await runMaintenancePages(
      args({ store, mode: 'apply', pageSize: 2, maxPages: 10, cursor: r1.cursor, counters: r1.counters, pagesDone: r1.pagesDone }),
    );
    expect(r2.status).toBe('completed');
    expect(r2.counters.examinados).toBe(5);
    expect(r2.counters.qualityCalculada).toBe(5);
    expect(world.productWrites.length).toBe(5); // 2 de la primera + 3 nuevas
    expect(writesTrasPrimera).toBe(2);
    expect(world.progress.at(-1)!.status).toBe('completed');
  });

  it('re-ejecución COMPLETA posterior: cero escrituras nuevas, historia intacta', async () => {
    const productos = [prod('a1', { metaRetailerId: 'RID-1' }), prod('a2')];
    const { world, store } = memWorld(productos);
    const r1 = await runMaintenancePages(args({ store, mode: 'apply' }));
    expect(r1.counters.locksCreados).toBe(1);
    expect(r1.counters.qualityCalculada).toBe(2);
    const snapshot = JSON.parse(JSON.stringify([...world.products.values()])) as Product[];
    // Segunda corrida (run nuevo, contadores desde cero): todo ya está — no duplica nada.
    const r2 = await runMaintenancePages(args({ store, mode: 'apply' }));
    expect(r2.counters.locksCreados).toBe(0);
    expect(r2.counters.locksExistentes).toBe(1);
    expect(r2.counters.qualityCalculada).toBe(0);
    expect(r2.counters.qualityVigente).toBe(2);
    expect(world.lockWrites.length).toBe(1); // solo la primera corrida escribió
    expect(world.productWrites.length).toBe(2);
    expect(JSON.parse(JSON.stringify([...world.products.values()]))).toEqual(snapshot);
  });

  it('un conflicto ya reportado no se duplica al re-examinar (dedupe por rid, contador honesto)', async () => {
    const productos = [prod('a1', { metaRetailerId: 'RID-X' }), prod('a2', { metaRetailerId: 'RID-X' })];
    const { store } = memWorld(productos);
    const r1 = await runMaintenancePages(args({ store, mode: 'apply', pageSize: 1, maxPages: 1 }));
    expect(r1.counters.conflictos).toBe(1);
    // Reanudación que re-encuentra el MISMO conflicto en la página siguiente.
    const r2 = await runMaintenancePages(
      args({ store, mode: 'apply', pageSize: 1, maxPages: 10, cursor: r1.cursor, counters: r1.counters, conflicts: r1.conflicts, pagesDone: r1.pagesDone }),
    );
    expect(r2.counters.conflictos).toBe(1); // no se cuenta dos veces
    expect(r2.conflicts).toHaveLength(1);
  });

  it('el tope de conflictos almacenados marca truncamiento sin mentir el contador', async () => {
    const conflictosPrevios = Array.from({ length: MAX_STORED_CONFLICTS }, (_, i) => ({
      retailerId: `PREV-${i}`,
      productIds: ['x', 'y'],
    }));
    const { store } = memWorld([prod('a1', { metaRetailerId: 'RID-X' }), prod('a2', { metaRetailerId: 'RID-X' })]);
    const r = await runMaintenancePages(
      args({ store, mode: 'apply', conflicts: conflictosPrevios, counters: { ...emptyMaintenanceCounters(), conflictos: MAX_STORED_CONFLICTS } }),
    );
    expect(r.counters.conflictos).toBe(MAX_STORED_CONFLICTS + 1); // contado igual
    expect(r.conflicts).toHaveLength(MAX_STORED_CONFLICTS); // la lista es un piso
    expect(r.conflictsTruncated).toBe(true);
  });
});

describe('runMaintenancePages — errores del backfill (C3: jamás se disfrazan de missing)', () => {
  it('una tx que lanza ⇒ erroresQuality contado, lastError sellado, quality NO escrita y el resto sigue', async () => {
    const { world, store } = memWorld([prod('e1'), prod('e2')]);
    world.failQualityFor.add('e1');
    const r = await runMaintenancePages(args({ store, mode: 'apply' }));
    expect(r.status).toBe('completed');
    expect(r.counters.erroresQuality).toBe(1);
    expect(r.counters.qualityCalculada).toBe(1); // e2 sí se evaluó
    expect(world.products.get('e1')!.quality).toBeUndefined();
    expect(world.products.get('e2')!.quality).toBeDefined();
    // El run con errores JAMÁS termina limpio: lastError sellado en el progreso final.
    expect(world.progress.at(-1)!.lastError).toContain('e1');
  });
});

describe('runMaintenancePages — aislamiento por tenant', () => {
  it('dos tenants con retailerIds IGUALES: cada mundo con sus locks y su quality', async () => {
    const a = memWorld([prod('p1', { metaRetailerId: 'RID-1' })]);
    const b = memWorld([prod('p1', { metaRetailerId: 'RID-1' })]);
    const rA = await runMaintenancePages(args({ tenantId: 'tenant-a', store: a.store, mode: 'apply' }));
    const rB = await runMaintenancePages(args({ tenantId: 'tenant-b', store: b.store, mode: 'apply', profile: { vertical: 'perfumeria' } }));
    expect(rA.counters.locksCreados).toBe(1);
    expect(rB.counters.locksCreados).toBe(1);
    expect(a.world.locks.get(retailerIdLockKey('RID-1'))).toBe('p1');
    expect(b.world.locks.get(retailerIdLockKey('RID-1'))).toBe('p1');
    // Ningún cruce: el mundo de A no vio las escrituras de B (stores separados por tenant).
    expect(a.world.lockWrites).toHaveLength(1);
    expect(b.world.lockWrites).toHaveLength(1);
  });
});
