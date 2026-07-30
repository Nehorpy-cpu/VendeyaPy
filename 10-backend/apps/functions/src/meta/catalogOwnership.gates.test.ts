import { describe, it, expect } from 'vitest';
import type { Product } from '@vpw/shared';
import { planCatalogSync } from './catalog.js';
import type { MetaRemoteCatalogItem } from './catalogClient.js';
import { normalizeCatalogOwnership, WRITABLE_FIELDS, type EffectiveOwnership } from './catalogOwnership.js';
import {
  assertPatchOwned,
  CatalogOwnershipViolation,
  outboundFieldsNotOwned,
  ownershipFingerprint,
  patchFieldsNotOwned,
} from './catalogOwnershipGates.js';
import { buildCatalogCreatePayload, CREATE_PAYLOAD_FIELDS } from './catalogOutbound.js';
import { outboxGate, type MetaCatalogOutboxJob } from './catalogOutbox.js';

/**
 * META-CATALOG-OWNERSHIP-MODEL-1 (ADR-0015 §7) — GATES OUTBOUND POR PROPIEDAD.
 *
 * Lo que estos tests fijan, y que ANTES del fix no existía:
 *  - un patch solo puede contener campos que VendeYaPy gobierna (los ajenos se filtran o
 *    bloquean, con razón explícita);
 *  - con `external_managed` no se genera NI UNA acción accionable —el plan explica por qué—
 *    ni se encola nada, aunque la config diga `live`;
 *  - el techo de la propiedad manda sobre el modo de la config;
 *  - el job congela la huella de la propiedad y el gate la revalida antes del POST: si cambió,
 *    el envío se detiene y no se reintenta con permisos viejos;
 *  - el loop diario feed↔VendeYaPy es IMPOSIBLE por construcción: dos ciclos seguidos con el
 *    remoto revertido no producen una sola acción.
 */

const TS = { seconds: 0, nanoseconds: 0 } as unknown as Product['createdAt'];

const prod = (over: Partial<Product> & { id: string }): Product =>
  ({
    tenantId: 'arfagi',
    name: 'Producto A',
    description: 'Descripción pública',
    price: 250000,
    compareAtPrice: null,
    currency: 'PYG',
    categoryId: 'c1',
    images: ['https://cdn.example.com/a.jpg'],
    inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: 'SKU-A' },
    syncToMeta: true,
    status: 'ACTIVE',
    featured: false,
    position: 0,
    brand: 'MarcaTest',
    productUrl: 'https://tienda.test/p/sku-a',
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }) as Product;

const remote = (over: Partial<MetaRemoteCatalogItem> = {}): MetaRemoteCatalogItem => ({
  id: 'itm-1',
  retailerId: 'SKU-A',
  name: 'Producto A',
  description: 'Descripción pública',
  availability: 'in stock',
  price: '₲250.000',
  imageUrl: 'https://cdn.example.com/a.jpg',
  brand: 'MarcaTest',
  url: 'https://tienda.test/p/sku-a',
  ...over,
});

/** Modelo del caso real: el feed del sitio publica TODOS los campos públicos. */
const EXTERNA = normalizeCatalogOwnership({
  model: 'external_managed',
  ownedFields: [],
  external: {
    kind: 'meta_feed',
    acknowledgedSourceIds: ['feed-1'],
    declaredFields: [...WRITABLE_FIELDS],
    fingerprint: 'huella-saneada',
    acknowledgedByUid: 'uid-owner',
    acknowledgedAt: null,
  },
});
/** VendeYaPy gobierna todo (comportamiento histórico). */
const PROPIA = normalizeCatalogOwnership({ model: 'vendeyapy_managed', ownedFields: [...WRITABLE_FIELDS], external: null });
/** Híbrido explícito: nosotros el precio y el stock; el feed, el resto de lo descriptivo. */
const HIBRIDA = normalizeCatalogOwnership({
  model: 'hybrid',
  ownedFields: ['price', 'availability'],
  external: {
    kind: 'meta_feed',
    acknowledgedSourceIds: ['feed-1'],
    declaredFields: ['title', 'description', 'brand', 'image', 'url'],
    fingerprint: 'huella-saneada',
    acknowledgedByUid: 'uid-owner',
    acknowledgedAt: null,
  },
});
/** Documento legacy (solo `sourceOfTruth`): fail-closed de nivel 2. */
const SIN_DECLARAR = normalizeCatalogOwnership(undefined);

describe('precondiciones de los fixtures (si esto falla, el resto no prueba lo que dice)', () => {
  it('las cuatro propiedades quedan como el ADR manda', () => {
    expect(PROPIA).toMatchObject({ writable: [...WRITABLE_FIELDS], modeCeiling: 'live', degraded: false });
    expect(EXTERNA).toMatchObject({ writable: [], modeCeiling: 'dry_run', degraded: false });
    expect(HIBRIDA).toMatchObject({ writable: ['price', 'availability'], modeCeiling: 'live', degraded: false });
    expect(SIN_DECLARAR).toMatchObject({ writable: [], modeCeiling: 'dry_run', degraded: true });
  });
});

// ---------------------------------------------------------------------------
// 1. Traducción entre vocabularios: el contrato de escritura NO es el de propiedad
// ---------------------------------------------------------------------------

describe('outboundFieldsNotOwned — `link` es `url`, `condition` es estructural', () => {
  it('EL FIX: `link` se resuelve contra la propiedad de `url`, no contra un nombre inexistente', () => {
    // Con propiedad total, `link` es NUESTRO aunque la lista de propiedad lo llame `url`.
    expect(outboundFieldsNotOwned(PROPIA, ['link'])).toEqual([]);
    // Y con el feed gobernando `url`, `link` es ajeno: la traducción funciona en los dos sentidos.
    expect(outboundFieldsNotOwned(HIBRIDA, ['link'])).toEqual(['link']);
  });

  it('`condition` es un literal fijo del contrato: no tiene dueño que disputar', () => {
    expect(outboundFieldsNotOwned(EXTERNA, ['condition'])).toEqual([]);
    expect(outboundFieldsNotOwned(SIN_DECLARAR, ['condition'])).toEqual([]);
  });

  it('un campo que ni pertenece al contrato público JAMÁS es nuestro por omisión', () => {
    // Ni con propiedad total: `costPrice` no es publicable en ningún modelo (ADR-0015 §1).
    expect(outboundFieldsNotOwned(PROPIA, ['costPrice'])).toEqual(['costPrice']);
    expect(outboundFieldsNotOwned(PROPIA, ['aiFicha', 'margin'])).toEqual(['aiFicha', 'margin']);
  });

  it('el híbrido parte la lista exactamente donde dice la matriz', () => {
    expect(outboundFieldsNotOwned(HIBRIDA, ['price', 'availability', 'title', 'image'])).toEqual(['title', 'image']);
  });

  it('sin propiedad declarada, NADA es escribible', () => {
    expect(outboundFieldsNotOwned(SIN_DECLARAR, ['price'])).toEqual(['price']);
  });
});

describe('patchFieldsNotOwned / assertPatchOwned — última barrera antes de persistir', () => {
  it('la identidad no es contenido: `id` nunca se cuenta como campo ajeno', () => {
    expect(patchFieldsNotOwned(EXTERNA, { id: 'SKU-A' })).toEqual([]);
  });

  it('EL TEST DISCRIMINANTE: un patch con un campo ajeno se RECHAZA con el campo en el mensaje', () => {
    const patch = { id: 'SKU-A', price: '250000 PYG', title: 'Nombre nuevo' };
    expect(patchFieldsNotOwned(HIBRIDA, patch)).toEqual(['title']);
    expect(() => assertPatchOwned(HIBRIDA, patch, 'producto p1')).toThrow(CatalogOwnershipViolation);
    try {
      assertPatchOwned(HIBRIDA, patch, 'producto p1');
      expect.unreachable('debía lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogOwnershipViolation);
      expect((e as CatalogOwnershipViolation).fields).toEqual(['title']);
      expect((e as Error).message).toContain('title');
    }
  });

  it('un patch íntegramente nuestro pasa sin ruido', () => {
    expect(() => assertPatchOwned(HIBRIDA, { id: 'SKU-A', price: '250000 PYG', availability: 'out of stock' })).not.toThrow();
  });

  it('con propiedad externa NO existe patch posible: hasta el apagado mínimo es ajeno', () => {
    expect(patchFieldsNotOwned(EXTERNA, { id: 'SKU-A', availability: 'out of stock' })).toEqual(['availability']);
  });
});

describe('CREATE_PAYLOAD_FIELDS refleja EXACTAMENTE lo que emite el builder', () => {
  it('una lista paralela desincronizada sería un agujero: acá se comparan las dos', () => {
    const emitidos = Object.keys(buildCatalogCreatePayload(prod({ id: 'p1' })).data).filter((k) => k !== 'id');
    expect([...emitidos].sort()).toEqual([...CREATE_PAYLOAD_FIELDS].sort());
  });
});

// ---------------------------------------------------------------------------
// 2. Huella de la propiedad
// ---------------------------------------------------------------------------

describe('ownershipFingerprint', () => {
  it('la misma propiedad da siempre la misma huella', () => {
    expect(ownershipFingerprint(PROPIA)).toBe(ownershipFingerprint(normalizeCatalogOwnership({ model: 'vendeyapy_managed', ownedFields: [...WRITABLE_FIELDS], external: null })));
  });

  it('modelos distintos, campos distintos o techo distinto ⇒ huellas distintas', () => {
    const huellas = new Set([PROPIA, EXTERNA, HIBRIDA, SIN_DECLARAR].map(ownershipFingerprint));
    expect(huellas.size).toBe(4);
  });

  it('cambiar la fuente externa reconocida cambia la huella (hay que volver a reconocer)', () => {
    const otra = normalizeCatalogOwnership({
      model: 'hybrid',
      ownedFields: ['price', 'availability'],
      external: { kind: 'meta_feed', acknowledgedSourceIds: ['feed-1'], declaredFields: ['title', 'description', 'brand', 'image', 'url'], fingerprint: 'OTRA-huella', acknowledgedByUid: 'uid-owner', acknowledgedAt: null },
    });
    expect(ownershipFingerprint(otra)).not.toBe(ownershipFingerprint(HIBRIDA));
  });

  it('no filtra la huella externa en claro (es un hash, no un volcado)', () => {
    expect(ownershipFingerprint(HIBRIDA)).not.toContain('huella-saneada');
    expect(ownershipFingerprint(HIBRIDA)).toMatch(/^own_[a-f0-9]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// 3. El plan bajo cada modelo de propiedad
// ---------------------------------------------------------------------------

describe('planCatalogSync — la propiedad decide qué se puede proponer', () => {
  it('EXTERNAL_MANAGED: cero acciones accionables y el plan EXPLICA por qué', () => {
    // Caso real: 181 artículos que publica un feed diario. Sin este gate el plan proponía
    // updates que el feed revertía cada madrugada.
    const productos = [
      prod({ id: 'p1', price: 250000 }), // el remoto dice ₲130.000 ⇒ "update" en el mundo viejo
      prod({ id: 'p2', name: 'Producto B', inventory: { trackStock: true, stock: 3, lowStockThreshold: 1, sku: 'SKU-B' } }), // create
      prod({ id: 'p3', name: 'Producto C', inventory: { trackStock: true, stock: 0, lowStockThreshold: 1, sku: 'SKU-C' } }), // disable
    ];
    const remotos = [remote({ price: '₲130.000' }), remote({ id: 'itm-3', retailerId: 'SKU-C', name: 'Producto C' })];
    const plan = planCatalogSync(productos, remotos, EXTERNA);

    expect(plan.summary).toMatchObject({ create: 0, update: 0, disable: 0 });
    expect(plan.entries.every((e) => !e.request)).toBe(true);
    expect(plan.ownership).toMatchObject({ model: 'external_managed', ownedFields: [], blockedActions: 3 });
    for (const e of plan.entries) {
      expect(e.blockedReasons).toContain('externally_owned');
      expect(e.note).toBe('campos_gobernados_por_fuente_externa');
      expect((e.notOwnedFields ?? []).length).toBeGreaterThan(0);
    }
  });

  it('la explicación distingue "no está declarado" de "manda otro"', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote({ price: '₲130.000' })], SIN_DECLARAR);
    expect(plan.entries[0]!.note).toBe('propiedad_no_declarada');
    expect(plan.ownership.degraded).toBe(true);
    expect(plan.ownership.reasons).toContain('ownership_missing');
  });

  it('HÍBRIDO: el patch lleva SOLO lo nuestro y reporta lo que quedó afuera', () => {
    // Difieren precio Y nombre; gobernamos el precio. Se propaga el precio, se avisa del nombre.
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote({ price: '₲130.000', name: 'Nombre del feed' })], HIBRIDA);
    const e = plan.entries[0]!;
    expect(e.action).toBe('update');
    expect(e.changedFields).toEqual(expect.arrayContaining(['price', 'name']));
    expect(e.request?.data).toEqual({ id: 'SKU-A', price: '250000 PYG' });
    expect(e.notOwnedFields).toEqual(['title']);
  });

  it('HÍBRIDO sin nada nuestro cambiado ⇒ bloqueado por propiedad, jamás un update vacío', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote({ name: 'Nombre del feed' })], HIBRIDA);
    const e = plan.entries[0]!;
    expect(e.action).toBe('blocked');
    expect(e.blockedReasons).toEqual(['externally_owned']);
    expect(e.notOwnedFields).toEqual(['title']);
  });

  it('HÍBRIDO: el apagado sigue siendo posible porque `availability` es nuestra', () => {
    const p = prod({ id: 'p1', inventory: { trackStock: true, stock: 0, lowStockThreshold: 1, sku: 'SKU-A' } });
    const plan = planCatalogSync([p], [remote()], HIBRIDA);
    expect(plan.entries[0]!.action).toBe('disable');
    expect(plan.entries[0]!.request?.data).toEqual({ id: 'SKU-A', availability: 'out of stock' });
  });

  it('EXTERNAL_MANAGED: ni siquiera el disable MÍNIMO de un producto bloqueado se propone', () => {
    // El disable mínimo existe para que un producto con campos rotos igual se pueda ocultar.
    // Si `availability` la publica el feed, tampoco eso es nuestro.
    const p = prod({ id: 'p1', images: ['http://inseguro/x.jpg'], inventory: { trackStock: true, stock: 0, lowStockThreshold: 1, sku: 'SKU-A' } });
    const plan = planCatalogSync([p], [remote()], EXTERNA);
    const e = plan.entries[0]!;
    expect(e.action).toBe('blocked');
    expect(e.blockedReasons).toEqual(expect.arrayContaining(['image_not_https', 'externally_owned']));
    expect(plan.summary.disable).toBe(0);
  });

  it('el diagnóstico de un CREATE ajeno habla de propiedad, no de campos faltantes', () => {
    // Sin este orden, al dueño de un catálogo gobernado por su feed se le pedía cargar una
    // descripción que jamás iba a viajar a Meta.
    const plan = planCatalogSync([prod({ id: 'p1', description: '' })], [], EXTERNA);
    expect(plan.entries[0]!.blockedReasons).toEqual(['externally_owned']);
    expect(plan.entries[0]!.blockedReasons).not.toContain('description_missing');
  });

  it('con propiedad total el plan se comporta EXACTAMENTE como antes del ADR', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote({ price: '₲130.000' })], PROPIA);
    expect(plan.entries[0]!.action).toBe('update');
    expect(plan.entries[0]!.request?.data).toEqual({ id: 'SKU-A', price: '250000 PYG' });
    expect(plan.entries[0]!.notOwnedFields).toBeUndefined();
    expect(plan.ownership.blockedActions).toBe(0);
  });

  it('un `unchanged` no necesita propiedad: no hay nada que escribir', () => {
    const plan = planCatalogSync([prod({ id: 'p1' })], [remote()], EXTERNA);
    expect(plan.entries[0]!.action).toBe('unchanged');
    expect(plan.ownership.blockedActions).toBe(0);
  });
});

describe('EL LOOP DIARIO ES IMPOSIBLE POR CONSTRUCCIÓN', () => {
  it('dos ciclos seguidos con el remoto revertido por el feed ⇒ cero acciones, siempre', () => {
    // Reproduce el caso Odyssey: local ₲250.000, el feed republica ₲130.000 cada madrugada.
    // Con `external_managed` el planificador nunca propone la escritura, así que el ciclo
    // feed→VendeYaPy→feed no puede arrancar ni siquiera una vez.
    const p = prod({ id: 'odyssey', price: 250000, metaRetailerId: 'ARM-1' });
    const revertidoPorElFeed = [remote({ retailerId: 'ARM-1', price: '₲130.000' })];

    const ciclo1 = planCatalogSync([p], revertidoPorElFeed, EXTERNA);
    const ciclo2 = planCatalogSync([p], revertidoPorElFeed, EXTERNA);

    for (const plan of [ciclo1, ciclo2]) {
      expect(plan.summary.create + plan.summary.update + plan.summary.disable).toBe(0);
      expect(plan.entries.filter((e) => e.request).length).toBe(0);
      expect(plan.ownership.blockedActions).toBe(1);
    }
    // Y el plan es IDÉNTICO en los dos ciclos: no hay estado que se degrade ni deriva que
    // acumule trabajo. El sistema simplemente no tiene nada que hacer con ese campo.
    expect(JSON.stringify(ciclo1.summary)).toBe(JSON.stringify(ciclo2.summary));
  });

  it('con propiedad total el MISMO escenario sí propondría la escritura (el test discrimina)', () => {
    // Prueba de que el test de arriba mide la propiedad y no un accidente del fixture.
    const p = prod({ id: 'odyssey', price: 250000, metaRetailerId: 'ARM-1' });
    const plan = planCatalogSync([p], [remote({ retailerId: 'ARM-1', price: '₲130.000' })], PROPIA);
    expect(plan.summary.update).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Gate del outbox: techo de modo, snapshot de propiedad y campos del patch
// ---------------------------------------------------------------------------

const jobDe = (own: EffectiveOwnership, over: Partial<MetaCatalogOutboxJob> = {}): MetaCatalogOutboxJob =>
  ({
    id: 'mco_x',
    tenantId: 'arfagi',
    catalogId: 'cat-1',
    productId: 'p1',
    retailerId: 'SKU-A',
    action: 'update',
    intendedPatch: { id: 'SKU-A', price: '250000 PYG' },
    intendedContentHash: 'h1',
    ownershipFingerprint: ownershipFingerprint(own),
    ownedFields: [...own.writable],
    productSnapshotHash: 'snap1',
    status: 'queued',
    attempts: 0,
    error: '',
    ...over,
  }) as MetaCatalogOutboxJob;

const ctx = (own: EffectiveOwnership, over: Partial<{ mode: 'off' | 'dry_run' | 'live' }> = {}) => ({
  tenantId: 'arfagi',
  config: { enabled: true, mode: over.mode ?? ('live' as const), catalogId: 'cat-1' },
  ownership: own,
  product: { exists: true, syncToMeta: true, stockPendingReview: false, snapshotHash: 'snap1' },
});

describe('outboxGate — el techo de la propiedad no lo supera la config', () => {
  it('EL FIX: `mode:live` + propiedad externa ⇒ NO sale nada (held, ownership_not_writable)', () => {
    expect(outboxGate(jobDe(EXTERNA), ctx(EXTERNA))).toEqual({ go: false, status: 'held', reason: 'ownership_not_writable' });
  });

  it('`mode:live` + propiedad sin declarar ⇒ tampoco sale nada', () => {
    expect(outboxGate(jobDe(SIN_DECLARAR), ctx(SIN_DECLARAR))).toEqual({ go: false, status: 'held', reason: 'ownership_not_writable' });
  });

  it('con la config en dry_run el motivo sigue siendo el de la config (no se lo tapa)', () => {
    expect(outboxGate(jobDe(PROPIA), ctx(PROPIA, { mode: 'dry_run' }))).toEqual({ go: false, status: 'held', reason: 'mode_not_live' });
  });

  it('propiedad híbrida con el patch íntegramente nuestro ⇒ autoriza', () => {
    expect(outboxGate(jobDe(HIBRIDA), ctx(HIBRIDA))).toEqual({ go: true });
  });
});

describe('outboxGate — snapshot de propiedad revalidado antes del POST', () => {
  it('EL TEST DISCRIMINANTE: la propiedad cambió durante el lease ⇒ needs_action, jamás se envía', () => {
    // El job se encoló con propiedad total; para cuando el worker lo reclama, el dueño declaró
    // que el título lo publica el feed. Ese envío ya no tiene el permiso con el que se aprobó.
    const job = jobDe(PROPIA);
    expect(outboxGate(job, ctx(HIBRIDA))).toEqual({ go: false, status: 'needs_action', reason: 'ownership_changed' });
  });

  it('`needs_action` NO vuelve solo a la cola: exige una decisión humana', () => {
    // El drenaje reclama únicamente `queued` y `held`; un `needs_action` queda fuera de esa
    // consulta, que es lo que garantiza "jamás se reintenta con permisos viejos".
    const r = outboxGate(jobDe(PROPIA), ctx(HIBRIDA));
    expect(r).toMatchObject({ go: false, status: 'needs_action' });
    expect(['queued', 'held']).not.toContain((r as { status: string }).status);
  });

  it('un job LEGACY sin huella (encolado antes del contrato) también se frena: fail-closed', () => {
    const legacy = jobDe(PROPIA, { ownershipFingerprint: '' as unknown as string });
    expect(outboxGate(legacy, ctx(PROPIA))).toEqual({ go: false, status: 'needs_action', reason: 'ownership_changed' });
  });

  it('DEFENSA EN PROFUNDIDAD: huella correcta pero un campo ajeno en el patch ⇒ tampoco sale', () => {
    // Escenario de bug: una huella que coincide por un error de normalización no puede
    // alcanzar para que viaje un campo que no es nuestro.
    const job = jobDe(HIBRIDA, { intendedPatch: { id: 'SKU-A', price: '250000 PYG', title: 'Nombre nuestro' } });
    expect(outboxGate(job, ctx(HIBRIDA))).toEqual({ go: false, status: 'needs_action', reason: 'ownership_not_writable' });
  });

  it('la config apagada sigue ganando sobre la propiedad (el kill-switch manda siempre)', () => {
    const r = outboxGate(jobDe(PROPIA), { ...ctx(HIBRIDA), config: { enabled: false, mode: 'live', catalogId: 'cat-1' } });
    expect(r).toEqual({ go: false, status: 'held', reason: 'config_disabled' });
  });

  it('el aislamiento de tenant sigue ganando sobre todo lo demás', () => {
    const r = outboxGate(jobDe(PROPIA, { tenantId: 'credipower' }), ctx(EXTERNA));
    expect(r).toEqual({ go: false, status: 'needs_action', reason: 'tenant_mismatch' });
  });
});
