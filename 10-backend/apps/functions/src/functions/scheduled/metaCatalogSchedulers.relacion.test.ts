import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0022 §4/§7 — los DOS crons resuelven la relación POR TENANT y saltean lo incompatible
 * SIN romper el aislamiento. Lo que discrimina:
 *  · outbox: el claim se saltea para relación ≠ managed (mirror y none: CERO drenaje) y un
 *    tenant con la config rota no corta el barrido de los demás;
 *  · verificación: el opt-out explícito se cuenta APARTE (`relacionNone`) y el barrido sigue;
 *  · cero jobs Meta creados por los crons al cambiar de modo (el worker ni se invoca).
 */

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// El scheduler del outbox importa `localPublicView` de meta/catalog.js (pesado): mock liviano.
vi.mock('../../meta/catalog.js', () => ({ localPublicView: vi.fn() }));

const workerCalls: Array<{ tenantId: string; skipDrain: boolean }> = [];
vi.mock('../../meta/catalogOutboxWorker.js', () => ({
  runCatalogOutboxForTenant: vi.fn(async (tenantId: string, _pv: unknown, opts?: { skipDrain?: boolean }) => {
    workerCalls.push({ tenantId, skipDrain: opts?.skipDrain === true });
    return { drain: { claimed: 0, submitted: 0 }, reconcile: { checked: 0, succeeded: 0, failed: 0 }, sweep: { normalized: 0, aged: 0 } };
  }),
}));

const verifCalls: string[] = [];
vi.mock('../../meta/catalogVerification.js', () => {
  class CatalogVerificationUnavailableError extends Error {
    constructor(message: string, readonly skipReason?: string) {
      super(message);
    }
  }
  class CatalogVerificationBlockedError extends CatalogVerificationUnavailableError {
    constructor(readonly reason: string, message: string) {
      super(message);
    }
  }
  class CatalogVerificationAlreadyRunningError extends Error {}
  return {
    CatalogVerificationUnavailableError,
    CatalogVerificationBlockedError,
    CatalogVerificationAlreadyRunningError,
    runCatalogVerificationForTenant: vi.fn(async ({ tenantId }: { tenantId: string }) => {
      verifCalls.push(tenantId);
      if (tenantId === 't_optout') throw new CatalogVerificationUnavailableError('opt-out', 'relationship_none');
      if (tenantId === 't_sinconfig') throw new CatalogVerificationUnavailableError('sin config', 'no_catalog_sync');
      if (tenantId === 't_roto') throw new Error('boom');
      return {
        runId: `run_${tenantId}`,
        status: 'completed',
        phase: 'done',
        pagesDone: 1,
        counters: { verified: 1, drifted: 0, driftedExternal: 0, remoteMissing: 0 },
      };
    }),
  };
});

const docs = new Map<string, Record<string, unknown>>();
const fallanGet = new Set<string>();

const snapDe = (path: string) => ({ exists: docs.has(path), id: path.slice(path.lastIndexOf('/') + 1), data: () => docs.get(path) });

vi.mock('../../lib/firebase.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/firebase.js')>();
  return {
    ...actual,
    db: () => ({
      doc: (path: string) => ({
        async get() {
          if (fallanGet.has(path)) throw new Error('doc roto');
          return snapDe(path);
        },
      }),
      collection: (path: string) => ({
        select: () => ({
          async get() {
            const prefijo = `${path}/`;
            const encontrados = [...docs.keys()]
              .filter((p) => p.startsWith(prefijo) && !p.slice(prefijo.length).includes('/'))
              .sort()
              .map(snapDe);
            return { docs: encontrados, size: encontrados.length };
          },
        }),
      }),
    }),
  };
});

const { runMetaCatalogOutboxMaintenance } = await import('./metaCatalogOutbox.js');
const { runMetaCatalogVerificationMaintenance } = await import('./metaCatalogVerification.js');

const managedRaw = () => ({
  enabled: true,
  mode: 'live',
  catalogId: 'cat_m',
  ownership: { model: 'vendeyapy_managed', ownedFields: ['title', 'price'], external: null, lastSourceCheckAt: null },
});

const arfagiRaw = () => ({
  enabled: true,
  mode: 'dry_run',
  catalogId: 'cat_a',
  ownership: {
    model: 'external_managed',
    ownedFields: [],
    external: {
      kind: 'meta_feed',
      acknowledgedSourceIds: ['f1'],
      declaredFields: ['price'],
      fingerprint: 'fp',
      acknowledgedAt: null,
      acknowledgedByUid: 'u',
    },
    lastSourceCheckAt: null,
  },
});

const seedTenant = (id: string, catalogSync?: unknown) => {
  docs.set(`tenants/${id}`, { status: 'ACTIVE' });
  if (catalogSync !== undefined) docs.set(`tenants/${id}/config/meta`, { catalogSync });
};

beforeEach(() => {
  docs.clear();
  fallanGet.clear();
  workerCalls.length = 0;
  verifCalls.length = 0;
});

describe('outbox scheduler — gate por relación POR TENANT (A1: solo el DRENAJE)', () => {
  it('managed drena; mirror (arfagi), none declarado y sin-config corren SOLO sweep+confirmación (skipDrain)', async () => {
    // A1 de la review: saltear el mantenimiento ENTERO dejaba jobs no-terminales zombis bajo
    // mirror/none (nadie los normalizaba) que bloqueaban el regreso a managed. El sweep y la
    // confirmación corren SIEMPRE (no escriben a Meta); lo gateado es el drenaje.
    seedTenant('t_managed', managedRaw());
    seedTenant('t_mirror', arfagiRaw());
    seedTenant('t_none', { ...managedRaw(), relationship: 'none' });
    seedTenant('t_sinconfig');
    await runMetaCatalogOutboxMaintenance();
    expect(workerCalls.sort((a, b) => a.tenantId.localeCompare(b.tenantId))).toEqual([
      { tenantId: 't_managed', skipDrain: false },
      { tenantId: 't_mirror', skipDrain: true },
      { tenantId: 't_none', skipDrain: true },
      { tenantId: 't_sinconfig', skipDrain: true },
    ]);
  });

  it('un tenant con el doc de config ROTO no corta el barrido de los demás (aislamiento intacto)', async () => {
    seedTenant('t_a_roto', managedRaw());
    fallanGet.add('tenants/t_a_roto/config/meta');
    seedTenant('t_b_sano', managedRaw());
    await runMetaCatalogOutboxMaintenance();
    expect(workerCalls).toEqual([{ tenantId: 't_b_sano', skipDrain: false }]);
  });

  it('tenants suspendidos o borrados siguen fuera (regla previa intacta)', async () => {
    docs.set('tenants/t_suspendido', { status: 'SUSPENDED' });
    docs.set(`tenants/t_suspendido/config/meta`, { catalogSync: managedRaw() });
    await runMetaCatalogOutboxMaintenance();
    expect(workerCalls).toEqual([]);
  });
});

describe('verificación scheduler — contadores y aislamiento', () => {
  it('cuenta relacionNone APARTE de saltadas, y un tenant roto no frena a los demás', async () => {
    seedTenant('t_corre');
    seedTenant('t_optout');
    seedTenant('t_sinconfig');
    seedTenant('t_roto');
    const resumen = await runMetaCatalogVerificationMaintenance();
    // TODOS fueron intentados (aislamiento) …
    expect(verifCalls.sort()).toEqual(['t_corre', 't_optout', 't_roto', 't_sinconfig']);
    // … y cada desenlace fue a su contador.
    expect(resumen).toMatchObject({ tenants: 4, corridas: 1, completadas: 1, relacionNone: 1, saltadas: 1, errores: 1 });
  });
});
