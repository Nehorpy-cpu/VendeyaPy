import { describe, it, expect } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  SCHEDULED_GROWTH_JOBS,
  isEligibleTenant,
  runGrowthJobsForTenant,
  refreshGrowthJobsForActiveTenants,
  type RunJobFn,
} from './scheduler.js';
import { isPanelJobAction, type PanelJobAction } from '../panel/jobs.js';

/** Fake `db` que solo soporta `doc(path).get()` (la rama `tenantId` del scheduler). */
function fakeDbForTenant(data: Record<string, unknown> | null): Firestore {
  return {
    doc: () => ({
      get: async () => ({ exists: data != null, id: 'tnt-1', data: () => data }),
    }),
  } as unknown as Firestore;
}

/** runJob que registra las acciones y, opcionalmente, falla en una. */
function recordingRunJob(failOn?: PanelJobAction): { fn: RunJobFn; calls: PanelJobAction[] } {
  const calls: PanelJobAction[] = [];
  const fn: RunJobFn = async (action) => {
    calls.push(action);
    if (action === failOn) throw new Error('boom');
    return 0;
  };
  return { fn, calls };
}

describe('growth scheduler — jobs seguros', () => {
  it('incluye exactamente los 4 jobs rule-based (sin IA / sin Meta)', () => {
    expect([...SCHEDULED_GROWTH_JOBS].sort()).toEqual(
      ['computeTracking', 'generateAudits', 'generateFollowups', 'generateWinningReplies'].sort(),
    );
  });

  it('todos los jobs programados son acciones válidas de panel/jobs', () => {
    for (const job of SCHEDULED_GROWTH_JOBS) expect(isPanelJobAction(job)).toBe(true);
  });

  it('NO incluye jobs que dependen de Meta/spend ni IA generativa', () => {
    for (const excluded of ['computeAttribution', 'metaAdsSync', 'catalogSync', 'processConversions']) {
      expect((SCHEDULED_GROWTH_JOBS as readonly string[]).includes(excluded)).toBe(false);
    }
  });
});

describe('growth scheduler — elegibilidad de tenant', () => {
  it('solo procesa tenants ACTIVE, no demo y no borrados', () => {
    expect(isEligibleTenant({ status: 'ACTIVE', isDemo: false, deletedAt: null })).toBe(true);
    expect(isEligibleTenant({ status: 'ACTIVE', isDemo: undefined, deletedAt: null })).toBe(true);
    expect(isEligibleTenant({ status: 'ONBOARDING', isDemo: false, deletedAt: null })).toBe(false);
    expect(isEligibleTenant({ status: 'SUSPENDED', isDemo: false, deletedAt: null })).toBe(false);
    expect(isEligibleTenant({ status: 'ACTIVE', isDemo: true, deletedAt: null })).toBe(false);
    expect(isEligibleTenant({ status: 'ACTIVE', isDemo: false, deletedAt: { seconds: 1, nanoseconds: 0 } as never })).toBe(false);
  });
});

describe('growth scheduler — corrida por tenant (aislamiento de errores)', () => {
  it('corre los 4 jobs y cuenta ok cuando todos andan', async () => {
    const { fn, calls } = recordingRunJob();
    const r = await runGrowthJobsForTenant('tnt-1', fn);
    expect(calls).toEqual([...SCHEDULED_GROWTH_JOBS]);
    expect(r).toEqual({ ok: 4, error: 0 });
  });

  it('si un job falla, igual corre los demás y lo cuenta como error', async () => {
    const { fn, calls } = recordingRunJob('generateAudits');
    const r = await runGrowthJobsForTenant('tnt-1', fn);
    expect(calls).toEqual([...SCHEDULED_GROWTH_JOBS]); // no corta: corrió los 4
    expect(r).toEqual({ ok: 3, error: 1 });
  });
});

describe('growth scheduler — orquestador (rama tenantId)', () => {
  it('procesa un tenant ACTIVE elegible y corre sus 4 jobs', async () => {
    const { fn } = recordingRunJob();
    const summary = await refreshGrowthJobsForActiveTenants(
      fakeDbForTenant({ status: 'ACTIVE', isDemo: false, deletedAt: null }),
      { tenantId: 'tnt-1', runJob: fn },
    );
    expect(summary.tenantsProcessed).toBe(1);
    expect(summary.tenantsSkipped).toBe(0);
    expect(summary.jobsOk).toBe(4);
    expect(summary.jobsError).toBe(0);
  });

  it('saltea un tenant demo sin correr jobs', async () => {
    const { fn, calls } = recordingRunJob();
    const summary = await refreshGrowthJobsForActiveTenants(
      fakeDbForTenant({ status: 'ACTIVE', isDemo: true, deletedAt: null }),
      { tenantId: 'tnt-demo', runJob: fn },
    );
    expect(summary.tenantsProcessed).toBe(0);
    expect(summary.tenantsSkipped).toBe(1);
    expect(summary.jobsOk).toBe(0);
    expect(calls).toEqual([]);
  });
});
