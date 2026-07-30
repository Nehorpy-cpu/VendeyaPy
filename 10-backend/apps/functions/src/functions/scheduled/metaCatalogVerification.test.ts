import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0015 §6 — Scheduler de la reconciliación (hallazgo CRÍTICO de revisión).
 *
 * Por qué es crítico: declarar la propiedad deja todos los productos sin `metaVerifiedAt`, y
 * sin `metaVerifiedAt` el estado efectivo es `stale`; `stale` bloquea la venta automática. Sin
 * nadie que refresque la evidencia, la venta automática quedaba apagada de forma PERMANENTE.
 *
 * Lo que estos tests defienden:
 *  · un tenant SIN config de catálogo (credipower) no gasta NI UNA llamada;
 *  · un tenant con config corre, con presupuesto ACOTADO por corrida;
 *  · solo tenants ACTIVE y sin `deletedAt`;
 *  · idempotencia y aislamiento: un tenant que falla no frena a los demás y una corrida ya
 *    tomada por el owner se cede en vez de correr en paralelo;
 *  · CERO escrituras en Meta (el scheduler solo delega en la costura que hace GET).
 */
// `vi.hoisted` porque el factory de `vi.mock` se evalúa ANTES de los consts del módulo: sin
// esto, el doble del logger no existiría todavía cuando se resuelve el mock.
const { logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/logger.js', () => ({ logger }));

const tenants: Array<{ id: string; status?: string; deletedAt?: unknown }> = [];
vi.mock('../../lib/firebase.js', () => ({
  db: () => ({
    collection: (_p: string) => ({
      select: (..._f: string[]) => ({
        async get() {
          return { docs: tenants.map((t) => ({ id: t.id, data: () => ({ status: t.status, deletedAt: t.deletedAt }) })) };
        },
      }),
    }),
  }),
  paths: {},
}));

const corridas: Array<{ tenantId: string; trigger?: string; maxPages: number }> = [];
let comportamiento: (tenantId: string) => unknown = () => ({});

vi.mock('../../meta/catalogVerification.js', async () => {
  // Se conservan las clases de error REALES: el scheduler distingue por `instanceof`, y un
  // doble falso haría pasar el test sin probar la distinción que importa.
  const real = await vi.importActual<typeof import('../../meta/catalogVerification.js')>('../../meta/catalogVerification.js');
  return {
    ...real,
    runCatalogVerificationForTenant: vi.fn(async (opts: { tenantId: string; trigger?: string; maxPages: number }) => {
      corridas.push({ tenantId: opts.tenantId, trigger: opts.trigger, maxPages: opts.maxPages });
      const r = comportamiento(opts.tenantId);
      if (r instanceof Error) throw r;
      return {
        runId: `run-${opts.tenantId}`,
        status: 'completed' as const,
        phase: 'done' as const,
        pagesDone: 1,
        counters: real.emptyVerificationCounters(),
        hasCursor: false,
        missingDetectionSkipped: false,
        ttlMs: real.VERIFICATION_MAX_TTL_MS,
        ...(r as Record<string, unknown>),
      };
    }),
  };
});

import {
  MAX_PAGES_POR_TENANT,
  runMetaCatalogVerificationMaintenance,
} from './metaCatalogVerification.js';
import {
  CatalogVerificationAlreadyRunningError,
  CatalogVerificationBlockedError,
  CatalogVerificationUnavailableError,
} from '../../meta/catalogVerification.js';

beforeEach(() => {
  tenants.length = 0;
  corridas.length = 0;
  comportamiento = () => ({});
  logger.error.mockClear();
  logger.info.mockClear();
});

describe('runMetaCatalogVerificationMaintenance', () => {
  it('un tenant sin config de catálogo NO gasta llamadas y no ensucia los errores', async () => {
    // Es el caso credipower: el nivel 1 del fail-closed corta antes de tocar la red y la
    // costura lanza `CatalogVerificationUnavailableError`. Eso NO es un fallo del scheduler.
    tenants.push({ id: 'credipower', status: 'ACTIVE' });
    comportamiento = () => new CatalogVerificationUnavailableError('sin config');

    const r = await runMetaCatalogVerificationMaintenance();

    expect(r.tenants).toBe(1);
    expect(r.saltadas).toBe(1);
    expect(r.corridas).toBe(0);
    expect(r.errores).toBe(0);
    expect(r.bloqueadas).toBe(0);
  });

  it('un tenant con el guard ACTIVO y sin poder verificar se cuenta APARTE y se grita', async () => {
    // HALLAZGO B1: contar esto como una "saltada" silenciosa es exactamente lo que hizo invisible
    // el apagado permanente de la venta automática. `CatalogVerificationBlockedError` ES un
    // `CatalogVerificationUnavailableError` (subclase), así que si la distinción no se hace DENTRO
    // de esa rama, este tenant vuelve a desaparecer en el bucket de las salteadas.
    tenants.push({ id: 'arfagi', status: 'ACTIVE' });
    comportamiento = () => new CatalogVerificationBlockedError('external_without_catalog', 'config contradictoria');

    const r = await runMetaCatalogVerificationMaintenance();

    expect(r.bloqueadas).toBe(1);
    expect(r.saltadas).toBe(0); // jamás una salteada silenciosa
    expect(r.errores).toBe(0); // tampoco un error de red: es una config que una persona tiene que arreglar
    expect(r.corridas).toBe(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [mensaje, , contexto] = logger.error.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(mensaje).toMatch(/contradictoria/i);
    expect(contexto).toMatchObject({ tenantId: 'arfagi', motivo: 'external_without_catalog' });
  });

  it('un tenant bloqueado NO frena a los demás ni contamina sus contadores', async () => {
    tenants.push({ id: 'arfagi', status: 'ACTIVE' }, { id: 'roto', status: 'ACTIVE' }, { id: 'credipower', status: 'ACTIVE' });
    comportamiento = (id) => {
      if (id === 'roto') return new CatalogVerificationBlockedError('external_without_catalog', 'config contradictoria');
      if (id === 'credipower') return new CatalogVerificationUnavailableError('sin config');
      return {};
    };

    const r = await runMetaCatalogVerificationMaintenance();

    expect(r).toMatchObject({ tenants: 3, corridas: 1, completadas: 1, saltadas: 1, bloqueadas: 1, errores: 0 });
  });

  it('un tenant con config corre, con presupuesto acotado y marcado como scheduler', async () => {
    tenants.push({ id: 'arfagi', status: 'ACTIVE' });

    const r = await runMetaCatalogVerificationMaintenance();

    expect(corridas).toEqual([{ tenantId: 'arfagi', trigger: 'scheduler', maxPages: MAX_PAGES_POR_TENANT }]);
    expect(MAX_PAGES_POR_TENANT).toBeGreaterThan(0);
    expect(r).toMatchObject({ tenants: 1, corridas: 1, completadas: 1, errores: 0 });
  });

  it('solo tenants ACTIVE y sin baja: una empresa suspendida no gasta ni una llamada', async () => {
    tenants.push(
      { id: 'activo', status: 'ACTIVE' },
      { id: 'suspendido', status: 'SUSPENDED' },
      { id: 'dado-de-baja', status: 'ACTIVE', deletedAt: { seconds: 1 } },
      { id: 'sin-estado' },
    );

    const r = await runMetaCatalogVerificationMaintenance();

    expect(corridas.map((c) => c.tenantId)).toEqual(['activo']);
    expect(r.tenants).toBe(1);
  });

  it('un tenant que falla NO frena a los demás', async () => {
    tenants.push({ id: 't1', status: 'ACTIVE' }, { id: 'roto', status: 'ACTIVE' }, { id: 't2', status: 'ACTIVE' });
    comportamiento = (id) => (id === 'roto' ? new Error('Meta no respondió') : {});

    const r = await runMetaCatalogVerificationMaintenance();

    expect(corridas.map((c) => c.tenantId)).toEqual(['t1', 'roto', 't2']);
    expect(r.errores).toBe(1);
    expect(r.completadas).toBe(2);
  });

  it('si el owner ya tiene una corrida tomada, el scheduler CEDE (no corre en paralelo)', async () => {
    tenants.push({ id: 'arfagi', status: 'ACTIVE' });
    comportamiento = () =>
      new CatalogVerificationAlreadyRunningError({ runId: 'r1', status: 'running' } as never);

    const r = await runMetaCatalogVerificationMaintenance();

    expect(r.saltadas).toBe(1);
    expect(r.errores).toBe(0);
  });

  it('idempotente: dos corridas seguidas hacen exactamente lo mismo, sin acumular estado', async () => {
    tenants.push({ id: 'arfagi', status: 'ACTIVE' });
    const a = await runMetaCatalogVerificationMaintenance();
    const b = await runMetaCatalogVerificationMaintenance();
    expect(b).toEqual(a);
    expect(corridas).toHaveLength(2);
    expect(corridas[0]).toEqual(corridas[1]);
  });

  it('una corrida que queda a mitad se reporta en curso, jamás como completada', async () => {
    tenants.push({ id: 'grande', status: 'ACTIVE' });
    comportamiento = () => ({ status: 'running', hasCursor: true, stopReason: 'pages_budget' });

    const r = await runMetaCatalogVerificationMaintenance();

    expect(r.corridas).toBe(1);
    expect(r.completadas).toBe(0);
  });
});
