/**
 * growth/scheduler.ts — Core REUTILIZABLE del refresco automático de jobs de growth (GROWTH-JOBS-SCHEDULER-1)
 * ==========================================================================================================
 * Corre, una vez al día, los MISMOS core jobs que el callable `runTenantJob` (vía `runPanelJob`), pero
 * automáticamente para los tenants ACTIVE — así el owner no depende de apretar botones.
 *
 * SOLO jobs SEGUROS: rule-based (SIN IA / sin Claude) y sin dependencia de Meta/spend:
 *   - computeTracking          (tracking/tracking.ts — agregación)
 *   - generateWinningReplies   (replies/mine.ts — "Sin IA")
 *   - generateFollowups        (followups/generate.ts — "Reglas baratas, sin IA")
 *   - generateAudits           (audits/generate.ts — "Sin IA")
 * Excluidos a propósito: computeAttribution/metaAdsSync/catalogSync/processConversions (Meta/spend real),
 * y generateInsights/generatePromotionSuggestions (no existen como acción de panel/jobs.ts).
 *
 * NO pasa por gates de uso ni mete cuota (es mantenimiento del sistema, no acción del usuario). Aislamiento
 * por tenant/job: un fallo se loguea y se salta, el scheduler sigue. Loguea SOLO metadata (tenantId, job,
 * ok/error, durationMs, count) — nunca PII, prompts ni mensajes. Testeable: `runJob` es inyectable.
 */
import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { Tenant } from '@vpw/shared';
import { paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { runPanelJob, type PanelJobAction } from '../panel/jobs.js';

/** Jobs de growth SEGUROS para correr automáticamente (rule-based, sin IA, sin Meta/spend). */
export const SCHEDULED_GROWTH_JOBS = [
  'computeTracking',
  'generateWinningReplies',
  'generateFollowups',
  'generateAudits',
] as const satisfies readonly PanelJobAction[];

/** Tope de tenants por corrida (cota de costo de lecturas Firestore). */
const DEFAULT_MAX_TENANTS = 500;
/** Tamaño de página al recorrer tenants (paginación por cursor). */
const PAGE_SIZE = 200;

/** Corre un job de un tenant. Inyectable para tests (default = el core real `runPanelJob`). */
export type RunJobFn = (action: PanelJobAction, tenantId: string) => Promise<unknown>;

export interface GrowthSchedulerOptions {
  /** Máximo de tenants a procesar por corrida. Default 500. */
  maxTenants?: number;
  /** Procesar SOLO este tenant (smoke/targeted); si se omite, recorre los ACTIVE. */
  tenantId?: string;
  /** Inyectable para tests. Default = runPanelJob (el mismo core que runTenantJob). */
  runJob?: RunJobFn;
}

export interface GrowthSchedulerSummary {
  tenantsScanned: number;
  tenantsProcessed: number;
  tenantsSkipped: number;
  jobsOk: number;
  jobsError: number;
  durationMs: number;
}

/** Un tenant es elegible para el refresco automático si está ACTIVE, no es demo y no está borrado. */
export function isEligibleTenant(t: Pick<Tenant, 'status' | 'isDemo' | 'deletedAt'>): boolean {
  return t.status === 'ACTIVE' && t.isDemo !== true && t.deletedAt == null;
}

/**
 * Corre los 4 jobs seguros para UN tenant. Aísla errores por job (un fallo no corta los demás) y loguea
 * SOLO metadata. Devuelve los counts ok/error. No mete cuota ni gates (mantenimiento del sistema).
 */
export async function runGrowthJobsForTenant(tenantId: string, runJob: RunJobFn): Promise<{ ok: number; error: number }> {
  let ok = 0;
  let error = 0;
  for (const job of SCHEDULED_GROWTH_JOBS) {
    const t0 = Date.now();
    try {
      const result = await runJob(job, tenantId);
      const count = typeof result === 'number' ? result : undefined;
      ok++;
      logger.info('growthScheduler: job ok', { tenantId, job, ok: true, durationMs: Date.now() - t0, count });
    } catch (e) {
      error++;
      logger.error('growthScheduler: job falló (se salta, el scheduler sigue)', e, { tenantId, job, ok: false, durationMs: Date.now() - t0 });
    }
  }
  return { ok, error };
}

/** Recorre los tenants ACTIVE (paginado por cursor, con tope) y devuelve solo los elegibles, hasta `maxTenants`. */
async function* iterEligibleTenants(db: Firestore, maxTenants: number, onlyTenantId?: string): AsyncGenerator<{ id: string; data: Tenant }> {
  if (onlyTenantId) {
    const snap = await db.doc(paths.tenant(onlyTenantId)).get();
    if (snap.exists) yield { id: snap.id, data: snap.data() as Tenant };
    return;
  }
  let last: QueryDocumentSnapshot | undefined;
  let fetched = 0;
  while (fetched < maxTenants) {
    let q = db
      .collection(paths.tenants())
      .where('status', '==', 'ACTIVE')
      .limit(Math.min(PAGE_SIZE, maxTenants - fetched));
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) return;
    for (const d of snap.docs) yield { id: d.id, data: d.data() as Tenant };
    fetched += snap.size;
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE_SIZE) return;
  }
}

/**
 * Refresca los jobs de growth seguros para todos los tenants ACTIVE elegibles. Devuelve el resumen
 * (solo metadata). Es el core que comparte la scheduled function `refreshGrowthJobsDaily`.
 */
export async function refreshGrowthJobsForActiveTenants(db: Firestore, opts: GrowthSchedulerOptions = {}): Promise<GrowthSchedulerSummary> {
  const startedMs = Date.now();
  const maxTenants = opts.maxTenants ?? DEFAULT_MAX_TENANTS;
  const runJob = opts.runJob ?? runPanelJob;
  const summary: GrowthSchedulerSummary = {
    tenantsScanned: 0,
    tenantsProcessed: 0,
    tenantsSkipped: 0,
    jobsOk: 0,
    jobsError: 0,
    durationMs: 0,
  };

  for await (const t of iterEligibleTenants(db, maxTenants, opts.tenantId)) {
    summary.tenantsScanned++;
    if (!isEligibleTenant(t.data)) {
      summary.tenantsSkipped++;
      continue;
    }
    summary.tenantsProcessed++;
    const { ok, error } = await runGrowthJobsForTenant(t.id, runJob);
    summary.jobsOk += ok;
    summary.jobsError += error;
  }

  summary.durationMs = Date.now() - startedMs;
  return summary;
}
