import { describe, it, expect, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaCatalogDetectedSource, Product } from '@vpw/shared';

/**
 * META-CATALOG-OWNERSHIP-MODEL-1 (ADR-0015 §9) — MIGRACIÓN preview/apply de la propiedad.
 *
 * `preview` (default) NO escribe NADA: propone el modelo, muestra los feeds detectados
 * (metadata SANEADA), los productos afectados, los estados que cambiarían y los bloqueos.
 * `apply` escribe SOLO `catalogSync.ownership` (updateMask del campo anidado, jamás el mapa
 * entero) y el `metaSyncState` de los productos con identidad remota que aún no lo tienen —
 * nunca nombre/precio/costo/stock/status/mapping/syncToMeta, y NUNCA en Meta.
 */
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  combinedFingerprint,
  emptyOwnershipMigrationCounters,
  ownershipMigrationDecision,
  ownershipProgressRegression,
  OwnershipMigrationPreconditionError,
  planOwnershipMigration,
  runOwnershipMigrationPages,
  sanitizeFingerprint,
  type OwnershipMigrationProgressPatch,
  type OwnershipMigrationStore,
} from './catalogOwnershipMigration.js';
import { catalogSourceSetFingerprint } from './catalogSourceDetection.js';
import { normalizeCatalogSyncConfig, CATALOG_SYNC_DISABLED, type MetaCatalogSyncConfig } from './catalogSyncConfig.js';
import { normalizeCatalogOwnership, WRITABLE_FIELDS, type CatalogOwnership } from './catalogOwnership.js';

const T0 = Timestamp.fromMillis(1_700_000_000_000);
const TS = T0 as unknown as Product['createdAt'];

const prod = (id: string, over: Partial<Product> = {}): Product =>
  ({
    id,
    tenantId: 't1',
    name: `Producto ${id}`,
    description: `Producto ${id}`,
    price: 250000,
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

/** Fuente detectada SANEADA (así la entrega el detector: sin URL firmada, sin token). */
const feedDetectado = (over: Partial<MetaCatalogDetectedSource> = {}): MetaCatalogDetectedSource => ({
  kind: 'meta_feed',
  sourceId: 'ds-1',
  name: 'Feed del sitio',
  host: 'tienda.test',
  schedule: '03:33',
  timezone: 'America/Asuncion',
  deletesMissingItems: true,
  detectedFields: ['title', 'description', 'price', 'currency', 'availability', 'inventory', 'brand', 'category', 'image', 'url'],
  itemCount: 181,
  fingerprint: 'meta_feed:ds-1|tienda.test|03:33|10campos',
  lastSeenAtMs: T0.toMillis(),
  ...over,
});

const cfgHabilitada = (over: Record<string, unknown> = {}): MetaCatalogSyncConfig =>
  normalizeCatalogSyncConfig({ enabled: true, mode: 'dry_run', catalogId: 'CAT-1', sourceOfTruth: 'vendeyapy', ...over });

const planArgs = (over: Partial<Parameters<typeof planOwnershipMigration>[0]> = {}) => ({
  tenantId: 't1',
  config: cfgHabilitada(),
  detection: { available: true, sources: [feedDetectado()] },
  requested: null,
  actorUid: 'uid-owner',
  now: T0,
  ...over,
});

/** Mundo en memoria de UN tenant: config + products + log de escrituras auditable. */
function memWorld(products: Product[], configOverride: Record<string, unknown> = {}) {
  const world = {
    /** Documento COMPLETO de config: sirve para probar que el apply no pisa el mapa. */
    configDoc: {
      catalogSync: { enabled: true, mode: 'dry_run', catalogId: 'CAT-1', sourceOfTruth: 'vendeyapy', ...configOverride },
      otroCampo: 'no se toca',
    } as Record<string, unknown>,
    products: new Map(products.map((p) => [p.id, { ...p }])),
    productWrites: [] as Array<{ productId: string; fields: string[] }>,
    ownershipWrites: [] as CatalogOwnership[],
    progress: [] as OwnershipMigrationProgressPatch[],
    /** Ids cuya siembra debe fallar como error de transacción. */
    failSeedFor: new Set<string>(),
    /** Fuerza el desenlace de writeOwnership (precondición rota a mitad del apply). */
    forceOwnershipOutcome: null as null | 'conflict' | 'precondition_failed',
  };
  const ordered = () => [...world.products.values()].sort((a, b) => a.id.localeCompare(b.id));
  const store: OwnershipMigrationStore = {
    async listProductsPage(cursor, pageSize) {
      const all = ordered();
      const start = cursor ? all.findIndex((p) => p.id === cursor) + 1 : 0;
      const page = all.slice(start, start + pageSize);
      const nextCursor = page.length === pageSize ? page[page.length - 1]!.id : null;
      return { products: page.map((p) => ({ ...p })), nextCursor };
    },
    async writeOwnership(proposal, expectedCatalogId) {
      if (world.forceOwnershipOutcome) return world.forceOwnershipOutcome;
      const cs = world.configDoc.catalogSync as Record<string, unknown>;
      const cfg = normalizeCatalogSyncConfig(cs);
      if (!cfg.enabled || cfg.catalogId !== expectedCatalogId) return 'precondition_failed';
      if (!cfg.ownership.degraded) {
        const igual = JSON.stringify(cfg.ownership) === JSON.stringify(normalizeCatalogOwnership(proposal));
        return igual ? 'already' : 'conflict';
      }
      // Espejo del updateMask del campo ANIDADO: se toca SOLO catalogSync.ownership.
      cs.ownership = proposal;
      world.ownershipWrites.push(proposal);
      return 'written';
    },
    async seedState(productId, estado) {
      if (world.failSeedFor.has(productId)) return { outcome: 'error', error: 'tx simulada rota' };
      const fresh = world.products.get(productId);
      if (!fresh) return { outcome: 'missing' };
      if (fresh.metaSyncState) return { outcome: 'already' };
      world.products.set(productId, { ...fresh, metaSyncState: estado });
      world.productWrites.push({ productId, fields: ['metaSyncState'] });
      return { outcome: 'written' };
    },
    async saveProgress(patch) {
      world.progress.push(JSON.parse(JSON.stringify(patch)) as OwnershipMigrationProgressPatch);
    },
  };
  return { world, store };
}

const runArgs = (over: Partial<Parameters<typeof runOwnershipMigrationPages>[0]>) => ({
  tenantId: 't1',
  mode: 'preview' as const,
  proposal: null as CatalogOwnership | null,
  catalogId: 'CAT-1',
  cursor: null as string | null,
  counters: emptyOwnershipMigrationCounters(),
  porEstado: {} as Record<string, number>,
  pagesDone: 0,
  ownershipWritten: false,
  maxPages: 10,
  pageSize: 200,
  ...over,
}) as Parameters<typeof runOwnershipMigrationPages>[0];

/** Propuesta válida derivada del plan (la que el apply escribiría). */
const propuestaExterna = (): CatalogOwnership => {
  const { proposal } = planOwnershipMigration(planArgs());
  if (!proposal) throw new Error('el plan debería proponer external_managed');
  return proposal;
};

// ---------------------------------------------------------------------------
// Plan: derivación, bloqueos y saneado
// ---------------------------------------------------------------------------

describe('planOwnershipMigration — derivación con un feed detectado (caso arfagi)', () => {
  it('propone external_managed: cero campos propios, todos los públicos del feed, techo dry_run', () => {
    const { plan, proposal, alreadyMigrated } = planOwnershipMigration(planArgs());
    expect(plan.blockers).toEqual([]);
    expect(plan.proposedModel).toBe('external_managed');
    expect(plan.proposedOwnedFields).toEqual([]);
    expect(plan.proposedExternalFields).toEqual([...WRITABLE_FIELDS]);
    // Con cero campos propios NO existe patch posible: el loop diario feed↔apply es inalcanzable.
    expect(plan.effectiveModeAfter).toBe('dry_run');
    expect(alreadyMigrated).toBe(false);
    expect(proposal?.model).toBe('external_managed');
    expect(proposal?.external?.acknowledgedSourceIds).toEqual(['ds-1']);
    expect(proposal?.external?.acknowledgedByUid).toBe('uid-owner');
    // La propuesta sobrevive al MISMO normalizador que la va a leer después.
    expect(normalizeCatalogOwnership(proposal).degraded).toBe(false);
  });

  it('con mode:live configurado, el modo EFECTIVO igual cae a dry_run (el techo manda)', () => {
    const { plan } = planOwnershipMigration(planArgs({ config: cfgHabilitada({ mode: 'live' }) }));
    expect(plan.configMode).toBe('live');
    expect(plan.effectiveModeAfter).toBe('dry_run');
  });

  it('si el detector no informó columnas, se asume que el feed publica TODO (dirección segura)', () => {
    const { plan } = planOwnershipMigration(
      planArgs({ detection: { available: true, sources: [feedDetectado({ detectedFields: [] })] } }),
    );
    expect(plan.proposedExternalFields).toEqual([...WRITABLE_FIELDS]);
    expect(plan.proposedOwnedFields).toEqual([]);
  });

  it('varias fuentes del mismo tipo se reconocen juntas, con ids ordenados y huella combinada', () => {
    const fuentes = [feedDetectado({ sourceId: 'ds-9', fingerprint: 'f-9' }), feedDetectado({ sourceId: 'ds-2', fingerprint: 'f-2' })];
    const { proposal } = planOwnershipMigration(planArgs({ detection: { available: true, sources: fuentes } }));
    expect(proposal?.external?.acknowledgedSourceIds).toEqual(['ds-2', 'ds-9']);
    // La huella persistida es la MISMA definición de conjunto que usa la verificación previa al
    // POST (`catalogSourceSetFingerprint`): si acá se guardara otra cosa, cada chequeo diría
    // `fingerprint_cambiado` sobre un feed que nadie tocó.
    expect(proposal?.external?.fingerprint).toBe(
      catalogSourceSetFingerprint([
        { sourceId: 'ds-9', fingerprint: 'f-9' },
        { sourceId: 'ds-2', fingerprint: 'f-2' },
      ]),
    );
    // …y NO es una concatenación de huellas: no crece con la cantidad de feeds (no se trunca).
    expect(proposal?.external?.fingerprint).not.toContain('|');
    // La huella no depende del orden en que el detector devolvió las fuentes.
    expect(combinedFingerprint([...fuentes].reverse())).toBe(combinedFingerprint(fuentes));
  });

  it('con tipos mixtos gana el feed (la fuente que publica), y las demás quedan visibles', () => {
    const fuentes = [feedDetectado({ kind: 'other_api', sourceId: 'api-1' }), feedDetectado({ sourceId: 'ds-1' })];
    const { plan, proposal } = planOwnershipMigration(planArgs({ detection: { available: true, sources: fuentes } }));
    expect(proposal?.external?.kind).toBe('meta_feed');
    expect(proposal?.external?.acknowledgedSourceIds).toEqual(['ds-1']);
    expect(plan.detectedSources).toHaveLength(2); // la persona ve las dos
  });
});

describe('planOwnershipMigration — bloqueos (jamás se fuerza nada)', () => {
  it('tenant SIN config de sync (credipower) ⇒ sync_disabled y cero propuesta', () => {
    const { plan, proposal } = planOwnershipMigration(planArgs({ config: CATALOG_SYNC_DISABLED }));
    expect(plan.blockers).toEqual(['sync_disabled']);
    expect(plan.proposedModel).toBeNull();
    expect(proposal).toBeNull();
    // Y no se inventa nada sobre su propiedad: sigue degradada, como corresponde.
    expect(plan.current.degraded).toBe(true);
    expect(plan.current.writable).toEqual([]);
  });

  it('detector no disponible ⇒ detection_unavailable + external_source_unknown, sin propuesta', () => {
    const { plan, proposal } = planOwnershipMigration(planArgs({ detection: { available: false, sources: [] } }));
    expect(plan.blockers).toEqual(['detection_unavailable', 'external_source_unknown']);
    expect(proposal).toBeNull();
  });

  it('sin fuentes y sin declaración humana ⇒ external_source_unknown (no se deriva "mandamos nosotros")', () => {
    const { plan, proposal } = planOwnershipMigration(planArgs({ detection: { available: true, sources: [] } }));
    expect(plan.blockers).toEqual(['external_source_unknown']);
    expect(plan.proposedModel).toBeNull();
    expect(proposal).toBeNull();
  });

  it('model pedido desconocido ⇒ proposal_invalid', () => {
    const { plan, proposal } = planOwnershipMigration(planArgs({ requested: { model: 'meta_manda' } }));
    expect(plan.blockers).toEqual(['proposal_invalid']);
    expect(proposal).toBeNull();
  });

  it('vendeyapy_managed pedido SIN campos ⇒ proposal_invalid (no sobrevive al normalizador)', () => {
    const { plan, proposal } = planOwnershipMigration(
      planArgs({ requested: { model: 'vendeyapy_managed', ownedFields: [] }, detection: { available: true, sources: [] } }),
    );
    expect(plan.blockers).toEqual(['proposal_invalid']);
    expect(proposal).toBeNull();
  });

  it('hybrid pedido cuyos campos chocan con los del feed ⇒ proposal_invalid (un campo, un dueño)', () => {
    const { plan, proposal } = planOwnershipMigration(
      planArgs({ requested: { model: 'hybrid', ownedFields: ['price', 'inventory'] } }),
    );
    expect(plan.blockers).toEqual(['proposal_invalid']);
    expect(proposal).toBeNull();
  });

  it('hybrid pedido con partición disjunta ⇒ propuesta válida con techo live', () => {
    const feedParcial = feedDetectado({ detectedFields: ['title', 'description', 'image'] });
    const { plan, proposal } = planOwnershipMigration(
      planArgs({
        detection: { available: true, sources: [feedParcial] },
        requested: { model: 'hybrid', ownedFields: ['price', 'inventory'] },
        config: cfgHabilitada({ mode: 'live' }),
      }),
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.proposedOwnedFields).toEqual(['price', 'inventory']);
    expect(plan.proposedExternalFields).toEqual(['title', 'description', 'image']);
    expect(plan.effectiveModeAfter).toBe('live');
    expect(proposal?.model).toBe('hybrid');
  });

  it('vendeyapy_managed pedido MIENTRAS un feed publica esos campos ⇒ proposal_invalid', () => {
    // El pedido explícito no alcanza para ignorar la evidencia: si el feed publica el precio y
    // pedimos gobernarlo, hay dos escritores del mismo campo — el loop diario que este programa
    // vino a cerrar. La fuente detectada se declara igual para que el conflicto sea visible.
    const { plan, proposal } = planOwnershipMigration(
      planArgs({ requested: { model: 'vendeyapy_managed', ownedFields: ['price'] } }),
    );
    expect(plan.blockers).toEqual(['proposal_invalid']);
    expect(proposal).toBeNull();
  });

  /**
   * CONTRATO CAMBIADO (fix de este programa). Antes esto se aceptaba y quedaba `vendeyapy_managed`
   * con techo `live` frente a un feed reconocido "mudo". Pero el detector casi nunca informa
   * columnas —no se las pedimos a Graph—, así que `detectedFields: []` es el caso NORMAL, no la
   * excepción: por esa puerta volvía a ser alcanzable el loop diario (feed revierte → plan
   * detecta → apply reescribe). Hoy el normalizador degrada por la MERA PRESENCIA de la fuente,
   * y el plan lo reporta como `proposal_invalid` en vez de escribir una propiedad que degrada.
   */
  it('vendeyapy_managed pedido con un feed detectado (aunque no publique campos) ⇒ proposal_invalid', () => {
    const feedMudo = feedDetectado({ detectedFields: [] });
    const { plan, proposal } = planOwnershipMigration(
      planArgs({
        detection: { available: true, sources: [feedMudo] },
        requested: { model: 'vendeyapy_managed', ownedFields: ['price'] },
        config: cfgHabilitada({ mode: 'live' }),
      }),
    );
    expect(plan.blockers).toEqual(['proposal_invalid']);
    expect(proposal).toBeNull();
    // Y el modo efectivo NO sube: sin propuesta escribible el techo lo pone la propiedad vigente.
    expect(plan.effectiveModeAfter).toBe('dry_run');
  });

  it('vendeyapy_managed SIN ninguna fuente detectada sigue siendo una propuesta válida', () => {
    // El camino legítimo del modelo: nadie más publica el catálogo, así que gobernamos nosotros.
    const { plan, proposal } = planOwnershipMigration(
      planArgs({
        detection: { available: true, sources: [] },
        requested: { model: 'vendeyapy_managed', ownedFields: ['price'] },
        config: cfgHabilitada({ mode: 'live' }),
      }),
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.proposedOwnedFields).toEqual(['price']);
    expect(plan.effectiveModeAfter).toBe('live');
    expect(proposal?.external).toBeNull();
  });

  it('external_managed pedido CON campos propios es contradictorio ⇒ proposal_invalid', () => {
    const { plan, proposal } = planOwnershipMigration(
      planArgs({ requested: { model: 'external_managed', ownedFields: ['price'] } }),
    );
    expect(plan.blockers).toEqual(['proposal_invalid']);
    expect(proposal).toBeNull();
  });

  it('un campo INTERNO pedido como propio nunca llega a la propuesta ⇒ proposal_invalid', () => {
    const { plan, proposal } = planOwnershipMigration(
      planArgs({
        detection: { available: true, sources: [] },
        requested: { model: 'vendeyapy_managed', ownedFields: ['price', 'cost'] },
      }),
    );
    // `cost` se filtra por no ser público y `price` solo no alcanza para un modelo con fuente
    // externa ausente… pero lo que importa: jamás se propone publicar un dato interno.
    expect(proposal?.ownedFields ?? []).not.toContain('cost');
    expect(plan.proposedOwnedFields).not.toContain('cost');
  });

  it('sin uid del actor no se puede reconocer nada ⇒ proposal_invalid (el permiso lleva firma)', () => {
    const { plan, proposal } = planOwnershipMigration(planArgs({ actorUid: null }));
    expect(plan.blockers).toEqual(['proposal_invalid']);
    expect(proposal).toBeNull();
  });

  it('propiedad ya declarada y DISTINTA ⇒ ownership_already_declared (cambiarla es humano)', () => {
    const config = cfgHabilitada({
      ownership: { model: 'vendeyapy_managed', ownedFields: ['price'], external: null },
    });
    const { plan, proposal } = planOwnershipMigration(planArgs({ config }));
    expect(plan.blockers).toEqual(['ownership_already_declared']);
    expect(proposal).toBeNull();
  });

  it('mismas fuentes con huella CAMBIADA ⇒ external_fingerprint_changed (hay que re-reconocer)', () => {
    const vigente = propuestaExterna();
    const config = cfgHabilitada({ ownership: { ...vigente, external: { ...vigente.external!, fingerprint: 'huella-vieja' } } });
    const { plan, proposal } = planOwnershipMigration(planArgs({ config }));
    expect(plan.blockers).toEqual(['external_fingerprint_changed']);
    expect(proposal).toBeNull();
  });

  it('la MISMA declaración ya vigente ⇒ sin bloqueos y alreadyMigrated (idempotencia)', () => {
    const config = cfgHabilitada({ ownership: propuestaExterna() });
    const { plan, alreadyMigrated, proposal } = planOwnershipMigration(planArgs({ config }));
    expect(plan.blockers).toEqual([]);
    expect(alreadyMigrated).toBe(true);
    expect(proposal).not.toBeNull();
  });
});

describe('saneado de la huella (nunca una URL firmada ni una query string)', () => {
  it('corta la query string y recorta', () => {
    expect(sanitizeFingerprint('meta_feed:ds-1|tienda.test/feed.csv?token=SECRETO&sig=abc')).toBe(
      'meta_feed:ds-1|tienda.test/feed.csv',
    );
    expect(sanitizeFingerprint('x'.repeat(500)).length).toBeLessThanOrEqual(240);
  });

  it('la propuesta persistida no arrastra la query string aunque el detector se equivoque', () => {
    const sucio = feedDetectado({ fingerprint: 'meta_feed:ds-1|tienda.test/feed.csv?access_token=SECRETO' });
    const { proposal } = planOwnershipMigration(planArgs({ detection: { available: true, sources: [sucio] } }));
    // La huella se calcula sobre la parte YA saneada (sin query string): el token no puede
    // sobrevivir ni siquiera como insumo del hash.
    expect(proposal?.external?.fingerprint).toBe(
      catalogSourceSetFingerprint([{ sourceId: 'ds-1', fingerprint: 'meta_feed:ds-1|tienda.test/feed.csv' }]),
    );
    expect(JSON.stringify(proposal)).not.toContain('SECRETO');
    expect(JSON.stringify(proposal)).not.toContain('access_token');
  });

  it('el plan tampoco muestra ni persiste una URL firmada que llegue en el nombre o el host', () => {
    const sucio = feedDetectado({
      name: 'Feed diario https://tienda.test/feed.csv?token=SECRETO',
      host: 'tienda.test/feed.csv?sig=SECRETO',
    });
    const { plan } = planOwnershipMigration(planArgs({ detection: { available: true, sources: [sucio] } }));
    expect(JSON.stringify(plan)).not.toContain('SECRETO');
    expect(plan.detectedSources[0]!.host).toBe('tienda.test/feed.csv');
    expect(plan.detectedSources[0]!.name).toBe('Feed diario https://tienda.test/feed.csv');
  });
});

// ---------------------------------------------------------------------------
// Decisión por producto
// ---------------------------------------------------------------------------

describe('ownershipMigrationDecision — estado honesto por producto', () => {
  it('producto "synced" con identidad remota ⇒ se siembra unverifiable (el verde falso se corta)', () => {
    const d = ownershipMigrationDecision(prod('a1', { metaRetailerId: 'RID-1', metaSyncStatus: 'synced' }));
    expect(d).toEqual({ accion: 'sembrar', estado: 'unverifiable', syncedNoVerificado: true });
  });

  it('mapeado por item id de Meta (vinculado a mano) también entra: es el hueco que dejó ciego a Odyssey', () => {
    const d = ownershipMigrationDecision(prod('a2', { metaProductItemId: 'ITEM-9' }));
    expect(d).toEqual({ accion: 'sembrar', estado: 'unverifiable', syncedNoVerificado: false });
  });

  it('sin identidad remota ⇒ sin_mapeo (no hay nada que afirmar, no se escribe)', () => {
    expect(ownershipMigrationDecision(prod('a3'))).toEqual({ accion: 'sin_mapeo' });
    expect(ownershipMigrationDecision(prod('a4', { metaRetailerId: '   ' }))).toEqual({ accion: 'sin_mapeo' });
  });

  it('con metaSyncState ya escrito ⇒ vigente (la reconciliación leyó Meta: sabe más que nosotros)', () => {
    expect(ownershipMigrationDecision(prod('a5', { metaRetailerId: 'RID-1', metaSyncState: 'drifted_external' }))).toEqual({
      accion: 'vigente',
    });
  });
});

// ---------------------------------------------------------------------------
// Corrida: preview
// ---------------------------------------------------------------------------

describe('runOwnershipMigrationPages — preview (default) NO escribe nada', () => {
  it('cuenta lo que HARÍA y deja config y productos intactos', async () => {
    const { world, store } = memWorld([
      prod('a1', { metaRetailerId: 'RID-1', metaSyncStatus: 'synced' }),
      prod('a2', { metaProductItemId: 'ITEM-2' }),
      prod('a3'), // sin mapeo
      prod('a4', { metaRetailerId: 'RID-4', metaSyncState: 'verified' }),
    ]);
    const r = await runOwnershipMigrationPages(runArgs({ store, mode: 'preview', proposal: propuestaExterna() }));
    expect(r.status).toBe('completed');
    expect(r.counters).toEqual({
      examinados: 4,
      estadoSembrado: 2,
      estadoVigente: 1,
      syncedNoVerificados: 1,
      sinMapeo: 1,
      errores: 0,
    });
    expect(r.porEstado).toEqual({ unverifiable: 2 });
    expect(r.ownershipWritten).toBe(false);
    expect(world.ownershipWrites).toEqual([]);
    expect(world.productWrites).toEqual([]);
    expect(world.configDoc.catalogSync).not.toHaveProperty('ownership');
  });
});

// ---------------------------------------------------------------------------
// Corrida: apply
// ---------------------------------------------------------------------------

describe('runOwnershipMigrationPages — apply', () => {
  it('escribe la propiedad ANTES de tocar los estados (primero se cierra la puerta)', async () => {
    const { world, store } = memWorld([prod('a1', { metaRetailerId: 'RID-1' })]);
    const orden: string[] = [];
    const espia: OwnershipMigrationStore = {
      ...store,
      async writeOwnership(p, c) {
        orden.push('ownership');
        return store.writeOwnership(p, c);
      },
      async seedState(id, e) {
        orden.push(`estado:${id}`);
        return store.seedState(id, e);
      },
    };
    const r = await runOwnershipMigrationPages(runArgs({ store: espia, mode: 'apply', proposal: propuestaExterna() }));
    expect(orden).toEqual(['ownership', 'estado:a1']);
    expect(r.ownershipWritten).toBe(true);
    expect(world.ownershipWrites).toHaveLength(1);
  });

  it('escribe SOLO catalogSync.ownership: el resto del mapa y del documento quedan intactos', async () => {
    const { world, store } = memWorld([prod('a1', { metaRetailerId: 'RID-1' })]);
    await runOwnershipMigrationPages(runArgs({ store, mode: 'apply', proposal: propuestaExterna() }));
    const cs = world.configDoc.catalogSync as Record<string, unknown>;
    expect(cs.enabled).toBe(true);
    expect(cs.mode).toBe('dry_run');
    expect(cs.catalogId).toBe('CAT-1');
    expect(world.configDoc.otroCampo).toBe('no se toca');
    // Y la propiedad escrita es exactamente la que el normalizador acepta sin degradar.
    const cfg = normalizeCatalogSyncConfig(cs);
    expect(cfg.ownership.degraded).toBe(false);
    expect(cfg.ownership.model).toBe('external_managed');
    expect(cfg.ownership.writable).toEqual([]);
    expect(cfg.ownership.modeCeiling).toBe('dry_run');
  });

  it('escribe SOLO metaSyncState de los productos afectados: nada más del producto cambia', async () => {
    const { world, store } = memWorld([prod('a1', { metaRetailerId: 'RID-1', metaSyncStatus: 'synced' }), prod('a2')]);
    const r = await runOwnershipMigrationPages(runArgs({ store, mode: 'apply', proposal: propuestaExterna() }));
    expect(r.counters.estadoSembrado).toBe(1);
    expect(r.counters.syncedNoVerificados).toBe(1);
    expect(world.productWrites).toEqual([{ productId: 'a1', fields: ['metaSyncState'] }]);
    const p = world.products.get('a1')!;
    expect(p.metaSyncState).toBe('unverifiable');
    // El eje HISTÓRICO no se toca: el job que terminó `succeeded` sigue siendo evidencia.
    expect(p.metaSyncStatus).toBe('synced');
    expect(p.price).toBe(250000);
    expect(p.status).toBe('ACTIVE');
    expect(p.syncToMeta).toBe(false);
    expect(p.inventory.stock).toBe(3);
    expect(world.products.get('a2')!.metaSyncState).toBeUndefined();
  });

  it('la reconciliación que escribió el estado a mitad de camino NO se pisa', async () => {
    const { world, store } = memWorld([prod('a1', { metaRetailerId: 'RID-1' })]);
    const carrera: OwnershipMigrationStore = {
      ...store,
      async seedState(id, e) {
        // Alguien (la verificación remota) escribió `drifted_external` entre la página y acá.
        world.products.set(id, { ...world.products.get(id)!, metaSyncState: 'drifted_external' });
        return store.seedState(id, e);
      },
    };
    const r = await runOwnershipMigrationPages(runArgs({ store: carrera, mode: 'apply', proposal: propuestaExterna() }));
    expect(r.counters.estadoVigente).toBe(1);
    expect(r.counters.estadoSembrado).toBe(0);
    expect(world.products.get('a1')!.metaSyncState).toBe('drifted_external');
  });

  it('re-ejecución COMPLETA: cero escrituras nuevas (idempotente de punta a punta)', async () => {
    const { world, store } = memWorld([prod('a1', { metaRetailerId: 'RID-1' }), prod('a2')]);
    const r1 = await runOwnershipMigrationPages(runArgs({ store, mode: 'apply', proposal: propuestaExterna() }));
    expect(r1.counters.estadoSembrado).toBe(1);
    const snapshot = JSON.parse(JSON.stringify([...world.products.values()])) as Product[];
    const r2 = await runOwnershipMigrationPages(runArgs({ store, mode: 'apply', proposal: propuestaExterna() }));
    expect(r2.counters.estadoSembrado).toBe(0);
    expect(r2.counters.estadoVigente).toBe(1);
    expect(world.productWrites).toHaveLength(1); // solo la primera corrida escribió
    expect(world.ownershipWrites).toHaveLength(1); // la segunda encontró 'already'
    expect(JSON.parse(JSON.stringify([...world.products.values()]))).toEqual(snapshot);
  });

  it('una tx de siembra que falla se CUENTA y sella lastError; el resto sigue', async () => {
    const { world, store } = memWorld([prod('e1', { metaRetailerId: 'RID-1' }), prod('e2', { metaRetailerId: 'RID-2' })]);
    world.failSeedFor.add('e1');
    const r = await runOwnershipMigrationPages(runArgs({ store, mode: 'apply', proposal: propuestaExterna() }));
    expect(r.status).toBe('completed');
    expect(r.counters.errores).toBe(1);
    expect(r.counters.estadoSembrado).toBe(1);
    expect(world.products.get('e1')!.metaSyncState).toBeUndefined();
    expect(world.progress.at(-1)!.lastError).toContain('e1');
  });
});

describe('runOwnershipMigrationPages — precondiciones frescas del apply', () => {
  it.each([['conflict'], ['precondition_failed']] as const)(
    'writeOwnership devuelve %s ⇒ corta ANTES de tocar un solo producto',
    async (outcome) => {
      const { world, store } = memWorld([prod('a1', { metaRetailerId: 'RID-1' })]);
      world.forceOwnershipOutcome = outcome;
      await expect(
        runOwnershipMigrationPages(runArgs({ store, mode: 'apply', proposal: propuestaExterna() })),
      ).rejects.toBeInstanceOf(OwnershipMigrationPreconditionError);
      expect(world.productWrites).toEqual([]);
      expect(world.progress).toEqual([]);
    },
  );

  it('el catalogId del run tiene que seguir siendo el de la config (mudanza de catálogo ⇒ corta)', async () => {
    const { world, store } = memWorld([prod('a1', { metaRetailerId: 'RID-1' })]);
    await expect(
      runOwnershipMigrationPages(runArgs({ store, mode: 'apply', proposal: propuestaExterna(), catalogId: 'OTRO-CAT' })),
    ).rejects.toBeInstanceOf(OwnershipMigrationPreconditionError);
    expect(world.productWrites).toEqual([]);
  });

  it('una propiedad AJENA declarada entre el preview y el apply no se pisa', async () => {
    const { world, store } = memWorld([prod('a1', { metaRetailerId: 'RID-1' })], {
      ownership: { model: 'vendeyapy_managed', ownedFields: ['price'], external: null },
    });
    await expect(
      runOwnershipMigrationPages(runArgs({ store, mode: 'apply', proposal: propuestaExterna() })),
    ).rejects.toBeInstanceOf(OwnershipMigrationPreconditionError);
    const cs = world.configDoc.catalogSync as Record<string, unknown>;
    expect((cs.ownership as { model: string }).model).toBe('vendeyapy_managed'); // intacta
  });
});

// ---------------------------------------------------------------------------
// Paginación, reanudación y guards
// ---------------------------------------------------------------------------

describe('runOwnershipMigrationPages — paginación y reanudación', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => prod(`p${String(i + 1).padStart(2, '0')}`, { metaRetailerId: `RID-${i}` }));

  it('respeta el presupuesto de páginas: queda running con cursor (jamás se presenta completo)', async () => {
    const { world, store } = memWorld(many(5));
    const r = await runOwnershipMigrationPages(
      runArgs({ store, mode: 'apply', proposal: propuestaExterna(), pageSize: 2, maxPages: 1 }),
    );
    expect(r.status).toBe('running');
    expect(r.stopReason).toBe('pages_budget');
    expect(r.cursor).toBe('p02');
    expect(r.counters.examinados).toBe(2);
    expect(world.progress.at(-1)!.status).toBe('running');
  });

  it('reanuda desde el cursor y NO reescribe la propiedad (ownershipWritten viaja en el run)', async () => {
    const { world, store } = memWorld(many(5));
    const r1 = await runOwnershipMigrationPages(
      runArgs({ store, mode: 'apply', proposal: propuestaExterna(), pageSize: 2, maxPages: 1 }),
    );
    const r2 = await runOwnershipMigrationPages(
      runArgs({
        store,
        mode: 'apply',
        proposal: propuestaExterna(),
        pageSize: 2,
        maxPages: 10,
        cursor: r1.cursor,
        counters: r1.counters,
        porEstado: r1.porEstado,
        pagesDone: r1.pagesDone,
        ownershipWritten: r1.ownershipWritten,
      }),
    );
    expect(r2.status).toBe('completed');
    expect(r2.counters.examinados).toBe(5);
    expect(r2.counters.estadoSembrado).toBe(5);
    expect(r2.porEstado).toEqual({ unverifiable: 5 });
    expect(world.ownershipWrites).toHaveLength(1); // una sola vez, en la primera invocación
    expect(world.productWrites).toHaveLength(5);
  });

  it('el lastError heredado no se borra si la reanudación sale limpia', async () => {
    const { store } = memWorld(many(2));
    const r = await runOwnershipMigrationPages(
      runArgs({ store, mode: 'apply', proposal: propuestaExterna(), lastError: 'falla previa de p01' }),
    );
    expect(r.status).toBe('completed');
    expect(r.lastError).toBe('falla previa de p01');
  });
});

describe('ownershipProgressRegression — el progreso jamás retrocede', () => {
  const c = (over: Partial<ReturnType<typeof emptyOwnershipMigrationCounters>> = {}) => ({
    ...emptyOwnershipMigrationCounters(),
    ...over,
  });

  it('acepta el avance normal', () => {
    expect(ownershipProgressRegression({ pagesDone: 1, counters: c({ examinados: 10 }) }, { pagesDone: 2, counters: c({ examinados: 20 }) })).toBeNull();
  });

  it('rechaza pagesDone o contadores que bajan (llamador con estado viejo)', () => {
    expect(ownershipProgressRegression({ pagesDone: 3, counters: c() }, { pagesDone: 2, counters: c() })).toContain('pagesDone');
    expect(
      ownershipProgressRegression({ pagesDone: 1, counters: c({ estadoSembrado: 9 }) }, { pagesDone: 1, counters: c({ estadoSembrado: 4 }) }),
    ).toContain('counters.estadoSembrado');
  });

  it('un run sin contadores previos (doc viejo) no bloquea el avance', () => {
    expect(ownershipProgressRegression({}, { pagesDone: 1, counters: c({ examinados: 5 }) })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Aislamiento por tenant
// ---------------------------------------------------------------------------

describe('aislamiento por tenant', () => {
  it('dos tenants con productos homónimos: cada mundo con su config y sus estados', async () => {
    const a = memWorld([prod('p1', { metaRetailerId: 'RID-1' })]);
    const b = memWorld([prod('p1', { metaRetailerId: 'RID-1' })]);
    await runOwnershipMigrationPages(runArgs({ tenantId: 'tenant-a', store: a.store, mode: 'apply', proposal: propuestaExterna() }));
    await runOwnershipMigrationPages(runArgs({ tenantId: 'tenant-b', store: b.store, mode: 'preview', proposal: propuestaExterna() }));
    expect(a.world.products.get('p1')!.metaSyncState).toBe('unverifiable');
    expect(a.world.ownershipWrites).toHaveLength(1);
    // El preview del tenant B no escribió NADA, ni siquiera habiendo apply en el otro.
    expect(b.world.products.get('p1')!.metaSyncState).toBeUndefined();
    expect(b.world.ownershipWrites).toEqual([]);
  });
});
