import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0022 §4 — asimetría RBAC corregida: `catalogSyncApply` (publicar a Meta) exige
 * TENANT_OWNER / PLATFORM_ADMIN TAMBIÉN en el backend de `runTenantJob`. Antes la UI lo
 * escondía pero un MANAGER podía invocarlo directo. El preview (`catalogSync`) sigue siendo
 * manager+: es un dry-run sin escrituras — el test lo fija para que la corrección no se pase
 * de rosca en silencio.
 */

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// El módulo arrastra el motor de conversación y el catálogo enteros: acá solo se prueba la
// AUTORIZACIÓN, así que todo lo demás se reemplaza por dobles livianos.
const runPanelJob = vi.fn(async () => ({ ok: true }));
vi.mock('../../panel/jobs.js', () => ({
  PANEL_JOB_ACTIONS: ['catalogSync', 'catalogSyncApply'],
  isPanelJobAction: (a: string) => a === 'catalogSync' || a === 'catalogSyncApply',
  JOB_REQUIREMENTS: { catalogSync: { meter: 'jobs' }, catalogSyncApply: { meter: 'jobs' } },
  runPanelJob,
}));
vi.mock('../../entitlements/entitlements.js', () => ({
  assertFeatureEnabled: vi.fn(async () => {}),
  assertWithinLimit: vi.fn(async () => {}),
  meterUsage: vi.fn(async () => {}),
}));
vi.mock('../../conversation/engine.js', () => ({ handleMessage: vi.fn() }));
vi.mock('../../ai/aiSecret.js', () => ({ ANTHROPIC_API_KEY: { name: 'ANTHROPIC_API_KEY' } }));

const { runTenantJob } = await import('./panelActions.js');

const invocar = (action: string, rol?: string, tenantId?: string) =>
  (runTenantJob as unknown as { run: (r: unknown) => Promise<unknown> }).run({
    data: { action, ...(tenantId ? { tenantId } : {}) },
    auth: rol ? { uid: `uid_${rol}`, token: { role: rol, ...(rol === 'PLATFORM_ADMIN' ? {} : { tenantId: 't1' }) } } : undefined,
    rawRequest: {},
  });

const esperarError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string };
  }
  throw new Error('se esperaba un error');
};

beforeEach(() => runPanelJob.mockClear());

describe('runTenantJob — RBAC de catalogSyncApply (backend, no solo UI)', () => {
  it('MANAGER, SELLER y VIEWER quedan DENEGADOS en catalogSyncApply sin llegar al job', async () => {
    for (const rol of ['TENANT_MANAGER', 'TENANT_SELLER', 'TENANT_VIEWER']) {
      const e = await esperarError(invocar('catalogSyncApply', rol));
      expect(e.code).toBe('permission-denied');
    }
    expect(runPanelJob).not.toHaveBeenCalled();
  });

  it('TENANT_OWNER y PLATFORM_ADMIN (con tenantId) SÍ ejecutan catalogSyncApply', async () => {
    await invocar('catalogSyncApply', 'TENANT_OWNER');
    await invocar('catalogSyncApply', 'PLATFORM_ADMIN', 't9');
    expect(runPanelJob).toHaveBeenCalledTimes(2);
    expect(runPanelJob).toHaveBeenCalledWith('catalogSyncApply', 't1', expect.anything(), undefined);
    expect(runPanelJob).toHaveBeenCalledWith('catalogSyncApply', 't9', expect.anything(), undefined);
  });

  it('PLATFORM_ADMIN sin tenantId ⇒ invalid-argument; sin sesión ⇒ unauthenticated', async () => {
    expect((await esperarError(invocar('catalogSyncApply', 'PLATFORM_ADMIN'))).code).toBe('invalid-argument');
    expect((await esperarError(invocar('catalogSyncApply'))).code).toBe('unauthenticated');
  });

  it('el preview (catalogSync) SIGUE siendo manager+ — la corrección es solo sobre el apply', async () => {
    await invocar('catalogSync', 'TENANT_MANAGER');
    expect(runPanelJob).toHaveBeenCalledWith('catalogSync', 't1', expect.anything(), undefined);
    // …pero un vendedor sigue afuera de TODO (regla previa intacta).
    expect((await esperarError(invocar('catalogSync', 'TENANT_SELLER'))).code).toBe('permission-denied');
  });
});
