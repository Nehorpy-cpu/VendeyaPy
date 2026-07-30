import { describe, it, expect, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaDrift, Product } from '@vpw/shared';

/**
 * ADR-0015 §5/§6 — Estado ACTUAL contra Meta y reconciliación periódica.
 *
 * Lo que estos tests defienden:
 *  · el caso Odyssey: un producto VINCULADO MANUALMENTE cuyo precio remoto lo gobierna el
 *    feed externo (₲130.000 contra ₲250.000 local) queda `drifted_external` — el barrido de
 *    importación lo daba por `already_linked` sin comparar NADA;
 *  · `verified` JAMÁS se escribe sin lectura remota real;
 *  · un job `succeeded` del outbox no protege de nada: el estado actual lo dice el remoto;
 *  · `stale` se DERIVA por TTL y nunca se persiste;
 *  · idempotencia, reanudación y aislamiento entre tenants;
 *  · nada se escribe en Meta, nada se borra, y los valores observados van SANEADOS
 *    (jamás la query string de una URL firmada).
 */
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  buildVerificationPatch,
  driftSignature,
  effectiveMetaSyncState,
  emptyVerificationCounters,
  fieldOwner,
  mergeDrift,
  runVerificationPages,
  sanitizeObservedValue,
  verificationClaimDecision,
  verificationTtlMs,
  verificationIsUnchanged,
  verifyProduct,
  VERIFICATION_LEASE_MS,
  VERIFICATION_MAX_TTL_MS,
  type ProductVerification,
  type VerificationProgressPatch,
  type VerificationStore,
} from './catalogVerification.js';
import { normalizeCatalogOwnership, WRITABLE_FIELDS, type EffectiveOwnership } from './catalogOwnership.js';
import { classifyPageItems } from './catalogImport.js';
import { analyzeRemoteItems } from './catalogReconcile.js';
import type { MetaCatalogItemsPage, MetaRemoteCatalogItem } from './catalogClient.js';
import { MetaCatalogApiError } from './catalogClient.js';

const T0_MS = 1_700_000_000_000;
const T0 = Timestamp.fromMillis(T0_MS);
const TS = T0 as unknown as Product['createdAt'];
const at = (ms: number) => Timestamp.fromMillis(ms) as unknown as Product['createdAt'];

const prod = (id: string, over: Partial<Product> = {}): Product =>
  ({
    id,
    tenantId: 't1',
    name: 'Odyssey Armani 100ml',
    description: 'Perfume Odyssey de Armani, 100ml, original',
    price: 250000,
    compareAtPrice: null,
    aiNotes: '',
    currency: 'PYG',
    categoryId: 'cat-1',
    images: ['https://cdn.test/odyssey.jpg'],
    emoji: '',
    inventory: { trackStock: true, stock: 4, lowStockThreshold: 1, sku: `sku-${id}` },
    status: 'ACTIVE',
    featured: false,
    position: 0,
    externalIds: { facebook: null, instagram: null, tiktok: null },
    perfume: null,
    aiFicha: null,
    productUrl: 'https://tienda.test/p/odyssey',
    brand: 'Armani',
    syncToMeta: false,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }) as Product;

/** Artículo remoto que COINCIDE con `prod()` en todos los campos observables. */
const remoteOk = (over: Partial<MetaRemoteCatalogItem> = {}): MetaRemoteCatalogItem => ({
  id: 'item-1',
  retailerId: 'ODY-1',
  name: 'Odyssey Armani 100ml',
  description: 'Perfume Odyssey de Armani, 100ml, original',
  availability: 'in stock',
  price: '250000 PYG',
  currency: 'PYG',
  imageUrl: 'https://cdn.test/odyssey.jpg',
  brand: 'Armani',
  url: 'https://tienda.test/p/odyssey',
  condition: 'new',
  ...over,
});

// El feed del sitio gobierna TODOS los campos públicos (decisión del owner para arfagi).
const EXTERNAL_MANAGED: EffectiveOwnership = normalizeCatalogOwnership({
  model: 'external_managed',
  ownedFields: [],
  external: {
    kind: 'meta_feed',
    acknowledgedSourceIds: ['feed-sitio'],
    declaredFields: [...WRITABLE_FIELDS],
    fingerprint: 'fp-saneada',
    acknowledgedAt: T0,
    acknowledgedByUid: 'uid-owner',
  },
});

// Matriz explícita: el precio es NUESTRO, el resto lo publica el feed.
const HYBRID_PRECIO_PROPIO: EffectiveOwnership = normalizeCatalogOwnership({
  model: 'hybrid',
  ownedFields: ['price'],
  external: {
    kind: 'meta_feed',
    acknowledgedSourceIds: ['feed-sitio'],
    declaredFields: ['title', 'description', 'image', 'url', 'brand', 'availability'],
    fingerprint: 'fp-saneada',
    acknowledgedAt: T0,
    acknowledgedByUid: 'uid-owner',
  },
});

/** Documento legacy (solo sourceOfTruth): propiedad DEGRADADA, nivel 2 fail-closed. */
const DEGRADADA: EffectiveOwnership = normalizeCatalogOwnership(undefined);

// ---------------------------------------------------------------------------
// Núcleo puro
// ---------------------------------------------------------------------------

describe('verifyProduct — estado actual contra el snapshot remoto', () => {
  it('el caso Odyssey: precio gobernado por el feed que difiere ⇒ drifted_external (no drifted)', () => {
    const p = prod('p-odyssey', { metaRetailerId: 'ODY-1', price: 250000 });
    const v = verifyProduct({
      product: p,
      ownership: EXTERNAL_MANAGED,
      remote: { kind: 'found', item: remoteOk({ price: '130000 PYG' }) },
      now: T0,
      externalSourceId: 'feed-sitio',
    });
    expect(v.state).toBe('drifted_external');
    expect(v.drift?.fields).toEqual(['price']);
    expect(v.drift?.owner).toBe('external');
    // Comercial ⇒ el guard del bot no puede afirmar el precio ni cerrar la venta.
    expect(v.drift?.severity).toBe('commercial');
    expect(v.drift?.externalSourceId).toBe('feed-sitio');
    expect(v.drift?.observed[0]).toMatchObject({ field: 'price', local: '250000 PYG', remote: '130000 PYG' });
    expect(v.verifiedAt?.toMillis()).toBe(T0_MS);
  });

  it('un campo PROPIO que difiere ⇒ drifted (lo arregla una escritura nuestra)', () => {
    const p = prod('p1', { metaRetailerId: 'ODY-1' });
    const v = verifyProduct({
      product: p,
      ownership: HYBRID_PRECIO_PROPIO,
      remote: { kind: 'found', item: remoteOk({ price: '130000 PYG' }) },
      now: T0,
    });
    expect(v.state).toBe('drifted');
    expect(v.drift?.owner).toBe('vendeyapy');
  });

  it('deriva mixta (campo propio + campo ajeno) ⇒ drifted y dueño vendeyapy', () => {
    const p = prod('p1', { metaRetailerId: 'ODY-1' });
    const v = verifyProduct({
      product: p,
      ownership: HYBRID_PRECIO_PROPIO,
      remote: { kind: 'found', item: remoteOk({ price: '130000 PYG', name: 'Odyssey (oferta)' }) },
      now: T0,
    });
    expect(v.state).toBe('drifted');
    expect(v.drift?.fields).toEqual(['price', 'title']);
    expect(v.drift?.owner).toBe('vendeyapy');
  });

  it('propiedad DEGRADADA ⇒ el dueño es unknown y jamás se atribuye la deriva a nosotros', () => {
    const p = prod('p1', { metaRetailerId: 'ODY-1' });
    expect(fieldOwner(DEGRADADA, 'price')).toBe('unknown');
    const v = verifyProduct({ product: p, ownership: DEGRADADA, remote: { kind: 'found', item: remoteOk({ price: '130000 PYG' }) }, now: T0 });
    expect(v.state).toBe('drifted_external');
    expect(v.drift?.owner).toBe('unknown');
  });

  it('todo coincide ⇒ verified, sin deriva y con la fecha de la LECTURA', () => {
    const p = prod('p1', { metaRetailerId: 'ODY-1' });
    const v = verifyProduct({ product: p, ownership: EXTERNAL_MANAGED, remote: { kind: 'found', item: remoteOk() }, now: T0 });
    expect(v.state).toBe('verified');
    expect(v.drift).toBeNull();
    expect(v.verifiedAt?.toMillis()).toBe(T0_MS);
    // Stock y categoría NO son observables por el contrato de lectura: se declaran, no se fingen.
    expect(v.unobservedFields).toEqual(['inventory', 'category']);
    expect(v.comparedFields).toContain('price');
  });

  it('disponibilidad divergente (in stock remoto sobre INACTIVE local) ⇒ deriva comercial', () => {
    const p = prod('p1', { metaRetailerId: 'ODY-1', status: 'INACTIVE' });
    const v = verifyProduct({ product: p, ownership: EXTERNAL_MANAGED, remote: { kind: 'found', item: remoteOk() }, now: T0 });
    expect(v.state).toBe('drifted_external');
    expect(v.drift?.fields).toEqual(['availability']);
    expect(v.drift?.severity).toBe('commercial');
  });

  it('divergencia solo cosmética ⇒ severidad cosmetic (no corta la conversación)', () => {
    const p = prod('p1', { metaRetailerId: 'ODY-1' });
    const v = verifyProduct({ product: p, ownership: EXTERNAL_MANAGED, remote: { kind: 'found', item: remoteOk({ name: 'ODYSSEY ARMANI 100ML' }) }, now: T0 });
    expect(v.drift?.severity).toBe('cosmetic');
  });

  it('el artículo no está en el catálogo remoto ⇒ remote_missing (con lectura sellada)', () => {
    const p = prod('p1', { metaRetailerId: 'ODY-1' });
    const v = verifyProduct({ product: p, ownership: EXTERNAL_MANAGED, remote: { kind: 'missing' }, now: T0 });
    expect(v.state).toBe('remote_missing');
    expect(v.verifiedAt?.toMillis()).toBe(T0_MS);
  });

  it('sin lectura remota ⇒ unverifiable y JAMÁS verified (ni fecha de verificación)', () => {
    const p = prod('p1', { metaRetailerId: 'ODY-1' });
    const v = verifyProduct({ product: p, ownership: EXTERNAL_MANAGED, remote: { kind: 'unreadable', reason: 'remote_read_failed' }, now: T0 });
    expect(v.state).toBe('unverifiable');
    expect(v.verifiedAt).toBeNull();
    const patch = buildVerificationPatch(v, null);
    expect(patch).toEqual({ metaSyncState: 'unverifiable' });
    expect(patch).not.toHaveProperty('metaVerifiedAt');
    expect(patch).not.toHaveProperty('metaDrift');
  });

  it('sin identidad remota ⇒ unverifiable con motivo no_identity (nunca se adivina el retailer_id)', () => {
    const p = prod('p1', { metaRetailerId: null, inventory: { trackStock: false, stock: 0, lowStockThreshold: 0, sku: '' } });
    const v = verifyProduct({ product: p, ownership: EXTERNAL_MANAGED, remote: { kind: 'found', item: remoteOk() }, now: T0 });
    expect(v.state).toBe('unverifiable');
    expect(v.reason).toBe('no_identity');
  });

  it('el patch toca SOLO los tres campos del estado actual (nunca el eje histórico)', () => {
    const p = prod('p1', { metaRetailerId: 'ODY-1' });
    const v = verifyProduct({ product: p, ownership: EXTERNAL_MANAGED, remote: { kind: 'found', item: remoteOk() }, now: T0 });
    expect(Object.keys(buildVerificationPatch(v, null)).sort()).toEqual(['metaDrift', 'metaSyncState', 'metaVerifiedAt']);
  });

  it('un precio remoto vacío no inventa deriva (no hay evidencia ⇒ no hay veredicto)', () => {
    const p = prod('p1', { metaRetailerId: 'ODY-1' });
    const v = verifyProduct({ product: p, ownership: EXTERNAL_MANAGED, remote: { kind: 'found', item: remoteOk({ price: '' }) }, now: T0 });
    expect(v.state).toBe('verified');
    expect(v.unobservedFields).toContain('price');
  });
});

describe('saneamiento de los valores observados', () => {
  it('de una URL firmada guarda host + path y NUNCA la query string', () => {
    const firmada = 'https://cdn.feed.test/img/odyssey.jpg?token=SECRETO123&sig=abcdef';
    const out = sanitizeObservedValue('image', firmada);
    expect(out).toBe('cdn.feed.test/img/odyssey.jpg');
    expect(out).not.toContain('token');
    expect(out).not.toContain('SECRETO123');
  });

  it('la deriva de imagen persiste el valor SANEADO (nada de tokens en Firestore)', () => {
    const p = prod('p1', { metaRetailerId: 'ODY-1', images: ['https://cdn.test/odyssey.jpg'] });
    const v = verifyProduct({
      product: p,
      ownership: EXTERNAL_MANAGED,
      remote: { kind: 'found', item: remoteOk({ imageUrl: 'https://cdn.feed.test/x.jpg?sig=SECRETO' }) },
      now: T0,
    });
    const serializado = JSON.stringify(v.drift);
    expect(serializado).not.toContain('SECRETO');
    expect(serializado).not.toContain('sig=');
  });

  it('recorta el texto largo del remoto', () => {
    expect(sanitizeObservedValue('description', 'x'.repeat(500)).length).toBe(120);
  });
});

describe('mergeDrift — la misma deriva es el MISMO incidente (no se re-alerta)', () => {
  const base = (over: Partial<MetaDrift> = {}): MetaDrift => ({
    fields: ['price'],
    owner: 'external',
    severity: 'commercial',
    detectedAt: T0 as unknown as MetaDrift['detectedAt'],
    lastSeenAt: T0 as unknown as MetaDrift['lastSeenAt'],
    observed: [],
    externalSourceId: 'feed-sitio',
    ...over,
  });

  it('misma firma ⇒ conserva detectedAt y actualiza lastSeenAt', () => {
    const previa = base();
    const nueva = base({ detectedAt: at(T0_MS + 86_400_000) as unknown as MetaDrift['detectedAt'], lastSeenAt: at(T0_MS + 86_400_000) as unknown as MetaDrift['lastSeenAt'] });
    const merged = mergeDrift(previa, nueva)!;
    expect(merged.detectedAt.toMillis()).toBe(T0_MS);
    expect(merged.lastSeenAt.toMillis()).toBe(T0_MS + 86_400_000);
  });

  it('firma distinta ⇒ incidente nuevo con su propia fecha', () => {
    const previa = base();
    const nueva = base({ fields: ['price', 'title'], detectedAt: at(T0_MS + 1000) as unknown as MetaDrift['detectedAt'] });
    expect(mergeDrift(previa, nueva)!.detectedAt.toMillis()).toBe(T0_MS + 1000);
    expect(driftSignature(previa)).not.toBe(driftSignature(nueva));
  });
});

describe('caducidad DERIVADA (stale nunca se persiste)', () => {
  it('dentro del TTL conserva el estado; pasado el TTL es stale', () => {
    expect(effectiveMetaSyncState({ state: 'verified', verifiedAtMs: T0_MS, nowMs: T0_MS + 3600_000 })).toBe('verified');
    expect(effectiveMetaSyncState({ state: 'verified', verifiedAtMs: T0_MS, nowMs: T0_MS + VERIFICATION_MAX_TTL_MS + 1 })).toBe('stale');
  });

  it('sin verificación previa ⇒ stale (nunca se leyó: no se afirma nada)', () => {
    expect(effectiveMetaSyncState({ state: null, verifiedAtMs: null, nowMs: T0_MS })).toBe('stale');
    expect(effectiveMetaSyncState({ state: 'verified', verifiedAtMs: null, nowMs: T0_MS })).toBe('stale');
  });

  it('unverifiable se respeta tal cual (ya es honesto)', () => {
    expect(effectiveMetaSyncState({ state: 'unverifiable', verifiedAtMs: null, nowMs: T0_MS })).toBe('unverifiable');
  });

  it('el TTL es el MENOR entre 24 h y el período de la fuente externa', () => {
    expect(verificationTtlMs(null)).toBe(VERIFICATION_MAX_TTL_MS);
    expect(verificationTtlMs(6 * 3600_000)).toBe(6 * 3600_000);
    expect(verificationTtlMs(72 * 3600_000)).toBe(VERIFICATION_MAX_TTL_MS);
    // Un feed de 6 h invalida la foto a las 6 h: sostener 24 h afirmaría un precio viejo.
    expect(effectiveMetaSyncState({ state: 'verified', verifiedAtMs: T0_MS, nowMs: T0_MS + 7 * 3600_000, ttlMs: verificationTtlMs(6 * 3600_000) })).toBe('stale');
  });
});

describe('el hueco que dejó ciego a Odyssey', () => {
  it('la importación marca al vinculado manualmente como already_linked SIN comparar nada', () => {
    const item = remoteOk({ price: '130000 PYG' });
    const [c] = classifyPageItems(analyzeRemoteItems([item]), {
      mappedRids: new Set(['ODY-1']),
      importedByRid: new Map(),
      localSkuRids: new Set(),
      strongCandidateRids: new Set(),
      defaultCategoryId: 'cat-1',
    });
    expect(c!.kind).toBe('already_linked');
    expect(c).not.toHaveProperty('driftFields'); // el barrido de import no lo compara: por acá se escapó
  });

  it('la verificación SÍ lo compara y reporta la deriva del feed', () => {
    const v = verifyProduct({
      product: prod('p-odyssey', { metaRetailerId: 'ODY-1' }),
      ownership: EXTERNAL_MANAGED,
      remote: { kind: 'found', item: remoteOk({ price: '130000 PYG' }) },
      now: T0,
    });
    expect(v.state).toBe('drifted_external');
  });
});

// ---------------------------------------------------------------------------
// Reconciliación periódica (store en memoria)
// ---------------------------------------------------------------------------

/** Mundo en memoria multi-tenant: el store SIEMPRE filtra por tenant. */
function memWorld(products: Product[]) {
  const world = {
    products: new Map(products.map((p) => [`${p.tenantId}/${p.id}`, { ...p }])),
    /** locks que NADIE debe borrar (se verifican al final de los tests). */
    locks: new Map(products.filter((p) => p.metaRetailerId).map((p) => [`${p.tenantId}/${p.metaRetailerId}`, p.id])),
    patches: [] as VerificationProgressPatch[],
    writes: [] as Array<{ productId: string; patch: Record<string, unknown> }>,
    failWritesFor: new Set<string>(),
    /** Simula una edición del producto ENTRE la lectura remota y la escritura. */
    editarAntesDeEscribir: null as null | ((p: Product) => Product),
  };
  return world;
}
type MemWorld = ReturnType<typeof memWorld>;

function memStore(world: MemWorld, tenantId: string, _pageSize = 100): VerificationStore {
  const míos = () => [...world.products.values()].filter((p) => p.tenantId === tenantId).sort((a, b) => a.id.localeCompare(b.id));
  return {
    async loadMappedIndex() {
      // Espejo EXACTO del store real: dos mapas DISJUNTOS (por item id van SOLO los que no
      // tienen retailer id), así ningún artículo remoto resuelve al mismo producto dos veces.
      const byRetailerId = new Map<string, Product>();
      const byItemId = new Map<string, Product>();
      for (const p of míos()) {
        const rid = (p.metaRetailerId ?? '').trim();
        if (rid) {
          byRetailerId.set(rid, { ...p });
          continue;
        }
        const item = (p.metaProductItemId ?? '').trim();
        if (item) byItemId.set(item, { ...p });
      }
      return { byRetailerId, byItemId };
    },
    async listProductsPage(cursor, size) {
      const todos = míos();
      const desde = cursor ? todos.findIndex((p) => p.id === cursor) + 1 : 0;
      const page = todos.slice(desde, desde + size);
      const nextCursor = page.length === size ? (page[page.length - 1]?.id ?? null) : null;
      return { products: page.map((p) => ({ ...p })), nextCursor };
    },
    async applyState(productId, verify: (fresh: Product) => ProductVerification, guardVerifiedBeforeMs) {
      if (world.failWritesFor.has(productId)) return { outcome: 'error', error: 'transacción fallida' };
      const key = `${tenantId}/${productId}`;
      if (world.editarAntesDeEscribir) {
        const actual = world.products.get(key);
        if (actual) world.products.set(key, world.editarAntesDeEscribir({ ...actual }));
      }
      const fresh = world.products.get(key);
      if (!fresh) return { outcome: 'missing' };
      if (typeof guardVerifiedBeforeMs === 'number') {
        const visto = fresh.metaVerifiedAt?.toMillis?.() ?? 0;
        if (visto >= guardVerifiedBeforeMs) return { outcome: 'skipped' };
      }
      // Espejo del store real: el veredicto se calcula sobre el doc FRESCO y la comparación
      // de "sin cambio" usa EXACTAMENTE el mismo helper que Firestore.
      const v = verify({ ...fresh });
      const sinCambio = verificationIsUnchanged(fresh, v);
      const patch = buildVerificationPatch(v, fresh.metaDrift ?? null);
      world.writes.push({ productId, patch });
      world.products.set(key, { ...fresh, ...(patch as Partial<Product>) });
      return { outcome: sinCambio ? 'unchanged' : 'written', state: v.state };
    },
    async saveProgress(patch) {
      world.patches.push({ ...patch, counters: { ...patch.counters } });
    },
  };
}

/** Cliente de catálogo fake: SOLO listItemsPage (GET). Cualquier escritura sería un error de tipo. */
function fakeClient(pages: MetaCatalogItemsPage[], opts: { failOnPage?: number; error?: unknown } = {}) {
  let llamadas = 0;
  return {
    get llamadas() {
      return llamadas;
    },
    async listItemsPage(_catalogId: string, cursor?: string | null): Promise<MetaCatalogItemsPage> {
      const idx = cursor ? pages.findIndex((p) => p.nextCursor === cursor) + 1 : 0;
      llamadas++;
      if (opts.failOnPage === idx) throw opts.error ?? new MetaCatalogApiError('Meta no respondió.', 'http', 500, null, true);
      const page = pages[idx];
      if (!page) return { items: [], nextCursor: null };
      return page;
    },
  };
}

const correr = (world: MemWorld, args: Partial<Parameters<typeof runVerificationPages>[0]> & { tenantId: string; client: { listItemsPage: (c: string, cur?: string | null) => Promise<MetaCatalogItemsPage> } }) =>
  runVerificationPages({
    catalogId: 'CAT-1',
    ownership: EXTERNAL_MANAGED,
    store: memStore(world, args.tenantId),
    phase: 'remote',
    cursor: null,
    localCursor: null,
    counters: emptyVerificationCounters(),
    pagesDone: 0,
    sweepStartedAtMs: T0_MS,
    missingDetectionSkipped: false,
    maxPages: 10,
    now: () => Timestamp.fromMillis(T0_MS + 1000),
    ...args,
  });

describe('runVerificationPages — reconciliación periódica', () => {
  it('detecta la deriva de un VINCULADO MANUALMENTE y no toca el eje histórico', async () => {
    const odyssey = prod('p-odyssey', {
      metaRetailerId: 'ODY-1',
      metaCatalogId: 'CAT-1',
      // Job del outbox `succeeded` en su momento: evidencia histórica que NO caduca sola.
      metaSyncStatus: 'synced',
      metaLastSyncAt: TS,
      syncToMeta: true,
    });
    const world = memWorld([odyssey]);
    const client = fakeClient([{ items: [remoteOk({ price: '130000 PYG' })], nextCursor: null }]);

    const res = await correr(world, { tenantId: 't1', client });

    expect(res.status).toBe('completed');
    expect(res.counters.driftedExternal).toBe(1);
    const p = world.products.get('t1/p-odyssey')!;
    expect(p.metaSyncState).toBe('drifted_external');
    expect(p.metaDrift?.fields).toEqual(['price']);
    // El histórico queda INTACTO: `synced` es lo que pasó, no lo que Meta muestra hoy.
    expect(p.metaSyncStatus).toBe('synced');
    expect(p.metaLastSyncAt?.toMillis()).toBe(T0_MS);
    // Ni el producto ni su lock se tocan jamás.
    expect(world.locks.get('t1/ODY-1')).toBe('p-odyssey');
  });

  it('artículo eliminado por el feed ⇒ remote_missing, sin borrar producto ni lock', async () => {
    const world = memWorld([
      prod('p-vive', { metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' }),
      prod('p-borrado', { metaRetailerId: 'BORRADO-9', metaCatalogId: 'CAT-1', metaVerifiedAt: at(T0_MS - 86_400_000) }),
    ]);
    const client = fakeClient([{ items: [remoteOk()], nextCursor: null }]);

    const res = await correr(world, { tenantId: 't1', client });

    expect(res.status).toBe('completed');
    expect(res.counters.remoteMissing).toBe(1);
    expect(world.products.get('t1/p-borrado')!.metaSyncState).toBe('remote_missing');
    expect(world.products.get('t1/p-vive')!.metaSyncState).toBe('verified');
    expect(world.products.has('t1/p-borrado')).toBe(true);
    expect(world.locks.get('t1/BORRADO-9')).toBe('p-borrado');
  });

  it('producto vinculado a OTRO catálogo ⇒ unverifiable (jamás se lo acusa de faltante)', async () => {
    const world = memWorld([prod('p-otro', { metaRetailerId: 'OTRO-1', metaCatalogId: 'CAT-VIEJO' })]);
    const client = fakeClient([{ items: [], nextCursor: null }]);

    const res = await correr(world, { tenantId: 't1', client });

    expect(res.counters.unverifiable).toBe(1);
    expect(res.counters.remoteMissing).toBe(0);
    const p = world.products.get('t1/p-otro')!;
    expect(p.metaSyncState).toBe('unverifiable');
    // Sin lectura no se sella fecha: el estado envejece y la derivación lo muestra stale.
    expect(p.metaVerifiedAt ?? null).toBeNull();
  });

  it('un error remoto NO declara nada verified: los estados quedan como estaban', async () => {
    const world = memWorld([prod('p1', { metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' })]);
    const client = fakeClient([], { failOnPage: 0 });

    const res = await correr(world, { tenantId: 't1', client });

    expect(res.status).toBe('running');
    expect(res.stopReason).toBe('remote_error');
    expect(world.writes).toHaveLength(0);
    expect(world.products.get('t1/p1')!.metaSyncState).toBeUndefined();
  });

  it('con errores de escritura NO se declara ningún remote_missing (evidencia incompleta)', async () => {
    const world = memWorld([
      prod('p1', { metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' }),
      prod('p2', { metaRetailerId: 'OTRO-2', metaCatalogId: 'CAT-1' }),
    ]);
    world.failWritesFor.add('p1');
    const client = fakeClient([{ items: [remoteOk()], nextCursor: null }]);

    const res = await correr(world, { tenantId: 't1', client });

    expect(res.status).toBe('completed');
    expect(res.counters.errors).toBe(1);
    expect(res.missingDetectionSkipped).toBe(true);
    expect(res.counters.remoteMissing).toBe(0);
    expect(world.products.get('t1/p2')!.metaSyncState).toBeUndefined();
    expect(res.lastError).toContain('p1');
  });

  it('es idempotente: la segunda corrida no cambia estados ni re-fecha la deriva', async () => {
    const world = memWorld([prod('p-odyssey', { metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' })]);
    const pages = [{ items: [remoteOk({ price: '130000 PYG' })], nextCursor: null }];

    const r1 = await correr(world, { tenantId: 't1', client: fakeClient(pages) });
    const detectada = world.products.get('t1/p-odyssey')!.metaDrift!.detectedAt.toMillis();

    const r2 = await runVerificationPages({
      tenantId: 't1',
      catalogId: 'CAT-1',
      ownership: EXTERNAL_MANAGED,
      client: fakeClient(pages),
      store: memStore(world, 't1'),
      phase: 'remote',
      cursor: null,
      localCursor: null,
      counters: emptyVerificationCounters(),
      pagesDone: 0,
      // Barrido NUEVO: época posterior (si no, la fase de faltantes saltearía todo).
      sweepStartedAtMs: T0_MS + 10_000,
      missingDetectionSkipped: false,
      maxPages: 10,
      now: () => Timestamp.fromMillis(T0_MS + 20_000),
    });

    expect(r1.counters.driftedExternal).toBe(1);
    expect(r2.counters.driftedExternal).toBe(1);
    expect(r2.counters.unchanged).toBe(1); // el estado ya era ese: no hay aviso nuevo
    const p = world.products.get('t1/p-odyssey')!;
    expect(p.metaSyncState).toBe('drifted_external');
    expect(p.metaDrift!.detectedAt.toMillis()).toBe(detectada); // MISMO incidente
    expect(p.metaDrift!.lastSeenAt.toMillis()).toBe(T0_MS + 20_000);
  });

  it('es reanudable: dos invocaciones de una página dan el mismo resultado que una de dos', async () => {
    const world = memWorld([
      prod('p1', { metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' }),
      prod('p2', { metaRetailerId: 'ODY-2', metaCatalogId: 'CAT-1', price: 99000 }),
    ]);
    const pages: MetaCatalogItemsPage[] = [
      { items: [remoteOk()], nextCursor: 'cur-1' },
      { items: [remoteOk({ retailerId: 'ODY-2', id: 'item-2', price: '130000 PYG' })], nextCursor: null },
    ];

    const r1 = await correr(world, { tenantId: 't1', client: fakeClient(pages), maxPages: 1 });
    expect(r1.status).toBe('running');
    expect(r1.stopReason).toBe('pages_budget');
    expect(r1.cursor).toBe('cur-1');
    expect(r1.counters.verified).toBe(1);

    const r2 = await runVerificationPages({
      tenantId: 't1',
      catalogId: 'CAT-1',
      ownership: EXTERNAL_MANAGED,
      client: fakeClient(pages),
      store: memStore(world, 't1'),
      phase: r1.phase,
      cursor: r1.cursor,
      localCursor: r1.localCursor,
      counters: r1.counters,
      pagesDone: r1.pagesDone,
      sweepStartedAtMs: r1.sweepStartedAtMs,
      missingDetectionSkipped: r1.missingDetectionSkipped,
      maxPages: 10,
      now: () => Timestamp.fromMillis(T0_MS + 2000),
    });

    expect(r2.status).toBe('completed');
    expect(r2.counters.verified).toBe(1);
    expect(r2.counters.driftedExternal).toBe(1);
    expect(r2.counters.remoteMissing).toBe(0); // ninguno quedó "no visto" por la reanudación
    expect(world.products.get('t1/p2')!.metaSyncState).toBe('drifted_external');
  });

  it('un cursor vencido reinicia el barrido y la ÉPOCA (no se pierden faltantes)', async () => {
    const world = memWorld([prod('p1', { metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' })]);
    let primera = true;
    const client = {
      async listItemsPage(_c: string, cursor?: string | null): Promise<MetaCatalogItemsPage> {
        if (primera) {
          primera = false;
          throw new MetaCatalogApiError('cursor inválido', 'invalid_cursor');
        }
        expect(cursor ?? null).toBeNull();
        return { items: [remoteOk()], nextCursor: null };
      },
    };

    const res = await correr(world, { tenantId: 't1', client, cursor: 'cur-viejo' });

    expect(res.counters.cursorResets).toBe(1);
    expect(res.status).toBe('completed');
    expect(res.sweepStartedAtMs).toBe(T0_MS + 1000);
    expect(world.products.get('t1/p1')!.metaSyncState).toBe('verified');
  });

  it('aísla tenants: el barrido de t1 no lee ni escribe productos de t2', async () => {
    const world = memWorld([
      prod('p1', { tenantId: 't1', metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' }),
      prod('p2', { tenantId: 't2', metaRetailerId: 'AJENO-2', metaCatalogId: 'CAT-1' }),
    ]);
    // El catálogo remoto trae un artículo cuyo retailer_id pertenece a OTRO tenant.
    const client = fakeClient([{ items: [remoteOk(), remoteOk({ retailerId: 'AJENO-2', id: 'item-2', price: '1 PYG' })], nextCursor: null }]);

    const res = await correr(world, { tenantId: 't1', client });

    expect(res.counters.remoteOnly).toBe(1); // el ajeno se cuenta, no se toca
    expect(world.products.get('t2/p2')!.metaSyncState).toBeUndefined();
    expect(world.writes.every((w) => w.productId === 'p1')).toBe(true);
  });

  it('los remotos sin producto local mapeado se CUENTAN y no se importan', async () => {
    const world = memWorld([prod('p1', { metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' })]);
    const client = fakeClient([{ items: [remoteOk(), remoteOk({ retailerId: 'SIN-LOCAL', id: 'item-9' })], nextCursor: null }]);

    const res = await correr(world, { tenantId: 't1', client });

    expect(res.counters.remoteItems).toBe(2);
    expect(res.counters.matched).toBe(1);
    expect(res.counters.remoteOnly).toBe(1);
    expect(world.products.size).toBe(1); // la verificación jamás crea productos
  });

  it('un unverifiable repetido cuenta como sin cambio y NO borra la deriva conocida', async () => {
    const world = memWorld([
      prod('p-otro', {
        metaRetailerId: 'OTRO-1',
        metaCatalogId: 'CAT-VIEJO',
        metaSyncState: 'unverifiable',
        metaDrift: {
          fields: ['price'],
          owner: 'external',
          severity: 'commercial',
          detectedAt: TS,
          lastSeenAt: TS,
          observed: [],
          externalSourceId: 'feed-sitio',
        },
      }),
    ]);

    const res = await correr(world, { tenantId: 't1', client: fakeClient([{ items: [], nextCursor: null }]) });

    expect(res.counters.unverifiable).toBe(1);
    expect(res.counters.unchanged).toBe(1);
    // La evidencia previa se conserva: sin lectura no se limpia nada.
    expect(world.products.get('t1/p-otro')!.metaDrift?.fields).toEqual(['price']);
  });

  it('compara contra el doc FRESCO: una corrección local a mitad del barrido no queda como deriva', async () => {
    const world = memWorld([prod('p1', { metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1', price: 250000 })]);
    // Entre la lectura remota y la escritura, alguien alinea el precio local con el remoto.
    world.editarAntesDeEscribir = (p) => ({ ...p, price: 130000 });
    const client = fakeClient([{ items: [remoteOk({ price: '130000 PYG' })], nextCursor: null }]);

    const res = await correr(world, { tenantId: 't1', client });

    expect(res.counters.verified).toBe(1);
    expect(res.counters.driftedExternal).toBe(0);
    expect(world.products.get('t1/p1')!.metaDrift).toBeNull();
  });

  it('persiste el progreso después de CADA página (fase, cursores, contadores)', async () => {
    const world = memWorld([prod('p1', { metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' })]);
    await correr(world, { tenantId: 't1', client: fakeClient([{ items: [remoteOk()], nextCursor: null }]) });
    expect(world.patches.length).toBeGreaterThanOrEqual(2); // fin de fase remota + fin de fase de faltantes
    expect(world.patches[world.patches.length - 1]).toMatchObject({ status: 'completed', phase: 'done' });
  });
});

// ---------------------------------------------------------------------------
// `verified` sin haber comparado NADA (hallazgo de revisión)
// ---------------------------------------------------------------------------

/**
 * Partición gestionada que el contrato de LECTURA de Meta no puede observar: el precio solo si
 * el remoto lo trae, y `inventory`/`category` nunca. Es la trampa exacta del hallazgo.
 */
const HYBRID_SOLO_NO_OBSERVABLE: EffectiveOwnership = normalizeCatalogOwnership({
  model: 'hybrid',
  ownedFields: ['price', 'inventory'],
  external: {
    kind: 'meta_feed',
    acknowledgedSourceIds: ['feed-sitio'],
    declaredFields: ['currency', 'category'],
    fingerprint: 'fp-saneada',
    acknowledgedAt: T0,
    acknowledgedByUid: 'uid-owner',
  },
});

describe('verifyProduct — `verified` exige evidencia comparada de verdad', () => {
  it('ningún campo GESTIONADO comparable ⇒ unverifiable, JAMÁS verified', () => {
    // Con el bug, esto salía `verified`: el título y la descripción coincidían, y como ningún
    // campo comparable difería el producto quedaba en verde… sin que nadie hubiera comparado el
    // precio (el remoto no lo trajo) ni el stock (Meta no lo expone). Verde sobre lo único que
    // importa para cerrar una venta — el mismo `synced` sin evidencia que este módulo elimina.
    const v = verifyProduct({
      product: prod('p1', { metaRetailerId: 'ODY-1' }),
      ownership: HYBRID_SOLO_NO_OBSERVABLE,
      remote: { kind: 'found', item: remoteOk({ price: '', currency: '' }) },
      now: T0,
    });
    expect(v.state).toBe('unverifiable');
    expect(v.reason).toBe('nothing_comparable');
    expect(v.comparedFields).not.toContain('price');
    // El artículo SÍ se leyó, así que la fecha se sella (evidencia de que el barrido lo vio) —
    // pero el estado `unverifiable` bloquea la venta igual, caduque o no.
    expect(v.verifiedAt?.toMillis()).toBe(T0_MS);
    expect(buildVerificationPatch(v, null)).toEqual({ metaSyncState: 'unverifiable', metaVerifiedAt: v.verifiedAt });
    expect(effectiveMetaSyncState({ state: v.state, verifiedAtMs: T0_MS, nowMs: T0_MS })).toBe('unverifiable');
  });

  it('la deriva previa NO se borra: no comparamos nada, no podemos desmentirla', () => {
    const previa: MetaDrift = {
      fields: ['price'],
      owner: 'external',
      severity: 'commercial',
      detectedAt: T0 as unknown as MetaDrift['detectedAt'],
      lastSeenAt: T0 as unknown as MetaDrift['lastSeenAt'],
      observed: [],
      externalSourceId: 'feed-sitio',
    };
    const v = verifyProduct({
      product: prod('p1', { metaRetailerId: 'ODY-1' }),
      ownership: HYBRID_SOLO_NO_OBSERVABLE,
      remote: { kind: 'found', item: remoteOk({ price: '', currency: '' }) },
      now: T0,
    });
    expect(buildVerificationPatch(v, previa)).not.toHaveProperty('metaDrift');
  });

  it('una divergencia COSMÉTICA no alcanza para afirmar lo gestionado (fail-closed)', () => {
    const v = verifyProduct({
      product: prod('p1', { metaRetailerId: 'ODY-1' }),
      ownership: HYBRID_SOLO_NO_OBSERVABLE,
      remote: { kind: 'found', item: remoteOk({ price: '', currency: '', name: 'Otro nombre' }) },
      now: T0,
    });
    expect(v.state).toBe('unverifiable');
  });

  it('si el remoto SÍ trae el campo gestionado, se compara y el veredicto es normal', () => {
    const base = { product: prod('p1', { metaRetailerId: 'ODY-1' }), ownership: HYBRID_SOLO_NO_OBSERVABLE, now: T0 };
    expect(verifyProduct({ ...base, remote: { kind: 'found', item: remoteOk() } }).state).toBe('verified');
    expect(verifyProduct({ ...base, remote: { kind: 'found', item: remoteOk({ price: '130000 PYG' }) } }).state).toBe('drifted');
  });

  it('con AL MENOS un campo gestionado comparado, `verified` cubre los comparados y declara el resto', () => {
    const v = verifyProduct({
      product: prod('p1', { metaRetailerId: 'ODY-1' }),
      ownership: EXTERNAL_MANAGED,
      remote: { kind: 'found', item: remoteOk({ price: '' }) },
      now: T0,
    });
    expect(v.state).toBe('verified');
    expect(v.comparedFields.length).toBeGreaterThan(0);
    // Lo no comparable queda ENUMERADO, nunca contado como verificado.
    expect(v.unobservedFields).toContain('price');
    expect(v.unobservedFields).toContain('inventory');
    expect(v.unobservedFields).toContain('category');
    for (const f of v.comparedFields) expect(v.unobservedFields).not.toContain(f);
  });

  it('con propiedad DEGRADADA el criterio cae a "se comparó algo" (no se congela el tenant)', () => {
    // Sin declaración no hay partición que exigir: pedirla dejaría a todo tenant sin migrar
    // permanentemente `unverifiable`, que es peor que el problema que se está arreglando.
    const v = verifyProduct({
      product: prod('p1', { metaRetailerId: 'ODY-1' }),
      ownership: DEGRADADA,
      remote: { kind: 'found', item: remoteOk() },
      now: T0,
    });
    expect(v.state).toBe('verified');
  });

  it('la corrida lo cuenta como unverifiable, no como verificado', async () => {
    const world = memWorld([prod('p1', { metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' })]);
    const res = await correr(world, {
      tenantId: 't1',
      ownership: HYBRID_SOLO_NO_OBSERVABLE,
      client: fakeClient([{ items: [remoteOk({ price: '', currency: '' })], nextCursor: null }]),
    });
    expect(res.counters.verified).toBe(0);
    expect(res.counters.unverifiable).toBe(1);
    expect(world.products.get('t1/p1')!.metaSyncState).toBe('unverifiable');
  });
});

// ---------------------------------------------------------------------------
// `verified` sin haber comparado un solo campo COMERCIAL (hallazgo B2 de revisión)
// ---------------------------------------------------------------------------

describe('verifyProduct — `verified` exige evidencia COMERCIAL, no coincidencia de texto', () => {
  /** Remoto que solo trae texto: ni precio, ni moneda, ni disponibilidad. */
  const soloTexto = (over: Partial<MetaRemoteCatalogItem> = {}) => remoteOk({ price: '', currency: '', availability: '', ...over });
  const base = { product: prod('p1', { metaRetailerId: 'ODY-1' }), ownership: EXTERNAL_MANAGED, now: T0 };

  it('precio VACÍO + moneda y disponibilidad vacías ⇒ unverifiable, JAMÁS verified', () => {
    // Con el bug esto salía `verified` con `metaVerifiedAt` fresco: el título, la descripción, la
    // marca, la imagen y la URL coincidían, y `hayGestionadoComparado` se conformaba con eso
    // porque bajo `external_managed` TODOS los públicos están gestionados. El panel lo pintaba
    // "coincide con lo publicado" y el bot cotizaba un precio que nadie comparó — con `inventory`
    // y `category` no comparables POR DISEÑO, no había una sola prueba sobre plata.
    const v = verifyProduct({ ...base, remote: { kind: 'found', item: soloTexto() } });
    expect(v.state).toBe('unverifiable');
    expect(v.reason).toBe('no_commercial_evidence');
    expect(v.comparedFields).toContain('title'); // sí se comparó texto…
    expect(v.comparedFields).not.toContain('price'); // …pero nada de plata
    // Y queda registrado CUÁLES no se pudieron comparar y POR QUÉ.
    expect(v.uncomparable).toEqual(
      expect.arrayContaining([
        { field: 'price', reason: 'remote_empty' },
        { field: 'currency', reason: 'remote_empty' },
        { field: 'availability', reason: 'remote_empty' },
        { field: 'inventory', reason: 'not_exposed' },
        { field: 'category', reason: 'not_exposed' },
      ]),
    );
    // El artículo SÍ se leyó: se sella la fecha (si no, la fase de faltantes lo acusaría de
    // desaparecido estando publicado) pero el estado bloquea la venta igual.
    expect(v.verifiedAt?.toMillis()).toBe(T0_MS);
    expect(buildVerificationPatch(v, null)).toEqual({ metaSyncState: 'unverifiable', metaVerifiedAt: v.verifiedAt });
  });

  it('precio ILEGIBLE ("[object Object]") ⇒ unverifiable, y el motivo lo dice', () => {
    // El cliente mapea `price: String(raw.price ?? '')`: si el contrato de lectura devolviera un
    // objeto, acá llegaría un texto sin un solo dígito. No es lo mismo que "vino vacío" y el
    // motivo tiene que distinguirlo — es lo que va a leer una persona.
    const v = verifyProduct({ ...base, remote: { kind: 'found', item: soloTexto({ price: '[object Object]' }) } });
    expect(v.state).toBe('unverifiable');
    expect(v.reason).toBe('no_commercial_evidence');
    expect(v.uncomparable).toContainEqual({ field: 'price', reason: 'remote_unreadable' });
  });

  it('una divergencia COSMÉTICA sin evidencia comercial tampoco fabrica un veredicto', () => {
    const v = verifyProduct({ ...base, remote: { kind: 'found', item: soloTexto({ name: 'Otro nombre' }) } });
    expect(v.state).toBe('unverifiable');
    expect(v.state).not.toBe('drifted_external');
  });

  it('precio comparable e IGUAL ⇒ verified (la evidencia existe y coincide)', () => {
    const v = verifyProduct({ ...base, remote: { kind: 'found', item: remoteOk() } });
    expect(v.state).toBe('verified');
    expect(v.comparedFields).toContain('price');
  });

  it('precio comparable y DISTINTO ⇒ deriva comercial (el caso Odyssey)', () => {
    const v = verifyProduct({ ...base, remote: { kind: 'found', item: remoteOk({ price: '130000 PYG' }) } });
    expect(v.state).toBe('drifted_external');
    expect(v.drift?.severity).toBe('commercial');
  });

  it('alcanza con UN campo comercial comparado: sin precio pero con disponibilidad, verified', () => {
    // El límite del contrato, explícito: la evidencia comercial no es "el precio", es el mismo
    // conjunto COMMERCIAL_FIELDS que decide la severidad y que mira el guard del bot. Lo que no
    // se comparó queda declarado en `uncomparable` para que el panel no lo dé por verificado.
    const v = verifyProduct({ ...base, remote: { kind: 'found', item: remoteOk({ price: '', currency: '' }) } });
    expect(v.state).toBe('verified');
    expect(v.comparedFields).toContain('availability');
    expect(v.uncomparable).toContainEqual({ field: 'price', reason: 'remote_empty' });
  });

  it('la corrida lo cuenta como unverifiable y el producto queda BLOQUEADO para el bot', async () => {
    const world = memWorld([prod('p1', { metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' })]);
    const res = await correr(world, {
      tenantId: 't1',
      client: fakeClient([{ items: [soloTexto()], nextCursor: null }]),
    });
    expect(res.counters.verified).toBe(0);
    expect(res.counters.unverifiable).toBe(1);
    const p = world.products.get('t1/p1')!;
    expect(p.metaSyncState).toBe('unverifiable');
    // `unverifiable` no caduca a otra cosa: se respeta tal cual en lectura y corta la venta.
    expect(effectiveMetaSyncState({ state: p.metaSyncState, verifiedAtMs: T0_MS + 1000, nowMs: T0_MS + 1000 })).toBe('unverifiable');
  });
});

// ---------------------------------------------------------------------------
// `remote_missing` tiene SALIDA (hallazgo de revisión)
// ---------------------------------------------------------------------------

describe('remote_missing no es un callejón sin salida', () => {
  const mapeado = () => prod('p1', { metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' });

  it('el artículo desaparece ⇒ remote_missing; reaparece ⇒ vuelve a verified', async () => {
    const world = memWorld([mapeado()]);

    // 1ª corrida: el feed borró el artículo del catálogo remoto.
    const r1 = await correr(world, { tenantId: 't1', client: fakeClient([{ items: [], nextCursor: null }]) });
    expect(r1.counters.remoteMissing).toBe(1);
    expect(world.products.get('t1/p1')!.metaSyncState).toBe('remote_missing');

    // 2ª corrida: el feed lo volvió a publicar y coincide ⇒ el estado se RECALCULA solo.
    const r2 = await correr(world, {
      tenantId: 't1',
      client: fakeClient([{ items: [remoteOk()], nextCursor: null }]),
      sweepStartedAtMs: T0_MS + 10_000,
      now: () => Timestamp.fromMillis(T0_MS + 11_000),
    });
    expect(r2.counters.verified).toBe(1);
    const p = world.products.get('t1/p1')!;
    expect(p.metaSyncState).toBe('verified');
    expect(p.metaDrift).toBeNull();
    expect(p.metaVerifiedAt?.toMillis()).toBe(T0_MS + 11_000);
  });

  it('reaparece con el precio del feed divergente ⇒ drifted_external (no se queda en missing)', async () => {
    const world = memWorld([mapeado()]);
    await correr(world, { tenantId: 't1', client: fakeClient([{ items: [], nextCursor: null }]) });
    expect(world.products.get('t1/p1')!.metaSyncState).toBe('remote_missing');

    const r2 = await correr(world, {
      tenantId: 't1',
      client: fakeClient([{ items: [remoteOk({ price: '130000 PYG' })], nextCursor: null }]),
      sweepStartedAtMs: T0_MS + 10_000,
      now: () => Timestamp.fromMillis(T0_MS + 11_000),
    });
    expect(r2.counters.driftedExternal).toBe(1);
    expect(world.products.get('t1/p1')!.metaSyncState).toBe('drifted_external');
  });

  it('el producto PIERDE su mapping ⇒ la proyección se LIMPIA y vuelve a ser vendible', async () => {
    // Sin esta salida el `remote_missing` sobrevivía al desvínculo, caducaba a `stale` y ese
    // producto no volvía a cerrar una venta automática nunca más, aunque ya no lo publicara nadie.
    const world = memWorld([mapeado()]);
    await correr(world, { tenantId: 't1', client: fakeClient([{ items: [], nextCursor: null }]) });
    expect(world.products.get('t1/p1')!.metaSyncState).toBe('remote_missing');

    // Alguien desvincula el producto de Meta (se le saca retailer_id e item id).
    world.products.set('t1/p1', { ...world.products.get('t1/p1')!, metaRetailerId: null, metaProductItemId: null });

    const r2 = await correr(world, {
      tenantId: 't1',
      client: fakeClient([{ items: [], nextCursor: null }]),
      sweepStartedAtMs: T0_MS + 10_000,
      now: () => Timestamp.fromMillis(T0_MS + 11_000),
    });
    const p = world.products.get('t1/p1')!;
    expect(p.metaSyncState).toBeNull();
    expect(p.metaVerifiedAt).toBeNull();
    expect(p.metaDrift).toBeNull();
    // No se cuenta como estado nuevo: no hay veredicto sobre Meta, se dejó de afirmar.
    expect(r2.counters.remoteMissing).toBe(0);
    // Idempotente: una corrida más no vuelve a escribir nada sobre ese producto.
    const escrituras = world.writes.filter((w) => w.productId === 'p1').length;
    await correr(world, {
      tenantId: 't1',
      client: fakeClient([{ items: [], nextCursor: null }]),
      sweepStartedAtMs: T0_MS + 20_000,
      now: () => Timestamp.fromMillis(T0_MS + 21_000),
    });
    expect(world.writes.filter((w) => w.productId === 'p1').length).toBe(escrituras);
  });

  it('sin retailer_id pero TODAVÍA vinculado por item id: la proyección NO se BORRA — se OBSERVA', async () => {
    // CONTRATO ACTUALIZADO (hallazgo B1). Antes este producto se salteaba entero y conservaba el
    // estado que arrastraba; el test lo daba por bueno con el argumento de que "sigue habiendo un
    // artículo publicado que puede contradecirnos". Pero saltearlo era justamente el bug: la
    // semilla `unverifiable` de la migración no la levantaba NADIE, corrida tras corrida, y la
    // venta automática de ese producto quedaba apagada de forma permanente.
    // Lo que sigue siendo cierto —y es lo que este test defiende ahora— es que la proyección no
    // se BORRA (eso sería volver al verde falso). Lo que cambia es que el barrido completo que no
    // lo trajo por NINGUNA de sus identidades es un DATO OBSERVADO: `remote_missing`.
    const world = memWorld([prod('p1', { metaRetailerId: null, metaProductItemId: 'item-1', metaSyncState: 'drifted_external' })]);
    const res = await correr(world, { tenantId: 't1', client: fakeClient([{ items: [], nextCursor: null }]) });
    const p = world.products.get('t1/p1')!;
    expect(p.metaSyncState).toBe('remote_missing');
    expect(p.metaSyncState).not.toBeNull(); // jamás se limpia mientras haya vínculo
    expect(res.counters.remoteMissing).toBe(1);
    expect(res.counters.unverifiable).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Vinculados SOLO por item id: el camino legacy que la reconciliación no miraba
// (hallazgo B1 de revisión)
// ---------------------------------------------------------------------------

describe('la reconciliación no deja productos trabados en unverifiable', () => {
  /** Semilla de la migración sobre un vínculo manual legacy: item id y NADA de retailer id. */
  const soloItemId = (over: Partial<Product> = {}) =>
    prod('p-manual', {
      metaRetailerId: null,
      metaProductItemId: 'item-1',
      metaCatalogId: 'CAT-1',
      metaSyncStatus: 'synced',
      metaSyncState: 'unverifiable', // lo que sembró la migración: nunca leímos Meta
      ...over,
    });

  it('el vinculado SOLO por item id se compara contra su artículo y SALE de unverifiable', async () => {
    // Con el bug: `loadMappedIndex` solo indexaba por retailer id (y la consulta `!=` de
    // Firestore ni siquiera devuelve los documentos sin ese campo), así que el artículo se
    // contaba como `remoteOnly` y la fase de faltantes lo salteaba por "todavía vinculado".
    const world = memWorld([soloItemId()]);
    const res = await correr(world, {
      tenantId: 't1',
      client: fakeClient([{ items: [remoteOk({ price: '130000 PYG' })], nextCursor: null }]),
    });

    expect(res.counters.matched).toBe(1);
    expect(res.counters.remoteOnly).toBe(0);
    expect(res.counters.driftedExternal).toBe(1);
    const p = world.products.get('t1/p-manual')!;
    expect(p.metaSyncState).toBe('drifted_external');
    expect(p.metaSyncState).not.toBe('unverifiable');
    expect(p.metaVerifiedAt?.toMillis()).toBe(T0_MS + 1000);
    // El eje histórico, intacto como siempre.
    expect(p.metaSyncStatus).toBe('synced');
  });

  it('si coincide campo por campo queda verified (el mismo camino, sin deriva)', async () => {
    const world = memWorld([soloItemId()]);
    const res = await correr(world, { tenantId: 't1', client: fakeClient([{ items: [remoteOk()], nextCursor: null }]) });
    expect(res.counters.verified).toBe(1);
    expect(world.products.get('t1/p-manual')!.metaSyncState).toBe('verified');
  });

  it('si el barrido COMPLETO no lo trae ⇒ remote_missing (dato observado), no unverifiable eterno', async () => {
    const world = memWorld([soloItemId({ metaProductItemId: 'item-9' })]);
    const res = await correr(world, { tenantId: 't1', client: fakeClient([{ items: [], nextCursor: null }]) });

    expect(res.counters.remoteMissing).toBe(1);
    expect(res.counters.unverifiable).toBe(0);
    const p = world.products.get('t1/p-manual')!;
    expect(p.metaSyncState).toBe('remote_missing');
    expect(p.metaVerifiedAt?.toMillis()).toBe(T0_MS + 1000); // ausencia OBSERVADA: se sella
    // Nunca se borra el producto: eso lo decide una persona.
    expect(world.products.has('t1/p-manual')).toBe(true);
  });

  it('vinculado por item id a OTRO catálogo ⇒ unverifiable (ese catálogo no lo leímos)', async () => {
    // Fail-closed: la cobertura nueva NO puede convertirse en una acusación de faltante sobre un
    // catálogo que este barrido nunca abrió.
    const world = memWorld([soloItemId({ metaProductItemId: 'item-9', metaCatalogId: 'CAT-VIEJO' })]);
    const res = await correr(world, { tenantId: 't1', client: fakeClient([{ items: [], nextCursor: null }]) });
    expect(res.counters.remoteMissing).toBe(0);
    expect(res.counters.unverifiable).toBe(1);
    expect(world.products.get('t1/p-manual')!.metaSyncState).toBe('unverifiable');
  });

  it('un producto SIN ninguna identidad no se toca (no hay nada que verificar)', async () => {
    const world = memWorld([
      prod('p-local', {
        metaRetailerId: null,
        metaProductItemId: null,
        inventory: { trackStock: false, stock: 0, lowStockThreshold: 0, sku: '' },
      }),
    ]);
    const res = await correr(world, { tenantId: 't1', client: fakeClient([{ items: [remoteOk()], nextCursor: null }]) });

    expect(world.writes).toEqual([]);
    expect(world.products.get('t1/p-local')!.metaSyncState).toBeUndefined();
    expect(res.counters.remoteMissing).toBe(0);
    expect(res.counters.unverifiable).toBe(0);
    expect(res.counters.remoteOnly).toBe(1); // el artículo remoto solo se cuenta
  });

  it('con las DOS identidades el artículo lo resuelve UNA sola vez (sin duplicar)', async () => {
    const world = memWorld([prod('p-dos', { metaRetailerId: 'ODY-1', metaProductItemId: 'item-1', metaCatalogId: 'CAT-1' })]);
    const res = await correr(world, {
      tenantId: 't1',
      client: fakeClient([{ items: [remoteOk({ price: '130000 PYG' })], nextCursor: null }]),
    });

    expect(res.counters.matched).toBe(1);
    expect(res.counters.driftedExternal).toBe(1);
    expect(world.writes.filter((w) => w.productId === 'p-dos')).toHaveLength(1);
  });

  it('aísla tenants también por item id: el barrido de t1 no toca al vinculado de t2', async () => {
    const world = memWorld([
      prod('p1', { tenantId: 't1', metaRetailerId: 'ODY-1', metaCatalogId: 'CAT-1' }),
      prod('p2', { tenantId: 't2', metaRetailerId: null, metaProductItemId: 'item-ajeno', metaCatalogId: 'CAT-1' }),
    ]);
    const client = fakeClient([{ items: [remoteOk(), remoteOk({ retailerId: '', id: 'item-ajeno', price: '1 PYG' })], nextCursor: null }]);

    const res = await correr(world, { tenantId: 't1', client });

    expect(res.counters.remoteOnly).toBe(1);
    expect(world.products.get('t2/p2')!.metaSyncState).toBeUndefined();
    expect(world.writes.every((w) => w.productId === 'p1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Claim del run: dos corridas concurrentes (hallazgo de revisión)
// ---------------------------------------------------------------------------

describe('verificationClaimDecision — exclusión mutua del run activo', () => {
  const runActivo = (leaseUntilMs?: number) => ({ status: 'running' as const, ...(leaseUntilMs === undefined ? {} : { leaseUntilMs }) });

  it('sin corrida activa ⇒ se crea una', () => {
    expect(verificationClaimDecision(null, T0_MS)).toBe('create');
    expect(verificationClaimDecision(undefined, T0_MS)).toBe('create');
    expect(verificationClaimDecision({ status: 'completed', leaseUntilMs: 0 }, T0_MS)).toBe('create');
  });

  it('corrida activa con claim VIGENTE ⇒ already_running (la segunda invocación NO corre)', () => {
    // Es el fix: antes el read-then-create no tenía exclusión mutua y dos invocaciones
    // simultáneas creaban DOS corridas del mismo tenant (o pisaban el cursor de la misma).
    expect(verificationClaimDecision(runActivo(T0_MS + 1), T0_MS)).toBe('already_running');
    expect(verificationClaimDecision(runActivo(T0_MS + VERIFICATION_LEASE_MS), T0_MS)).toBe('already_running');
  });

  it('corrida activa con claim VENCIDO o libre ⇒ se reanuda (un proceso muerto no la congela)', () => {
    expect(verificationClaimDecision(runActivo(T0_MS), T0_MS)).toBe('resume');
    expect(verificationClaimDecision(runActivo(0), T0_MS)).toBe('resume');
    // Doc viejo sin el campo (creado antes del claim): se reanuda, no se bloquea para siempre.
    expect(verificationClaimDecision(runActivo(), T0_MS)).toBe('resume');
  });
});
