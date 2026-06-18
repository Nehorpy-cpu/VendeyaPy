/**
 * panel/jobs.ts — Acciones de mantenimiento del panel (Hardening F2)
 * =================================================================
 * Mapea cada acción del panel a su función núcleo (las mismas que hoy llaman los
 * endpoints dev*). Esta capa NO autoriza (lo hace panel/auth.ts) ni expone HTTP;
 * la consumen los callables autenticados en functions/panel/panelActions.ts.
 */
import type { PlanFeatures } from '@vpw/shared';
import { syncMetaAdsDemo } from '../meta/ads.js';
import { computeAttribution } from '../meta/attribution.js';
import { syncProductsToMetaDemo } from '../meta/catalog.js';
import { generateFollowUpTasks } from '../followups/generate.js';
import { generateAgentAudits } from '../audits/generate.js';
import { computeTrackingAttribution } from '../tracking/tracking.js';
import { generateWinningReplies } from '../replies/mine.js';
import { backfillBusinessEvents, sendConversionEvents } from '../events/businessEvents.js';

export const PANEL_JOB_ACTIONS = [
  'metaAdsSync',
  'computeAttribution',
  'catalogSync',
  'generateFollowups',
  'generateAudits',
  'computeTracking',
  'generateWinningReplies',
  'processConversions',
] as const;
export type PanelJobAction = (typeof PANEL_JOB_ACTIONS)[number];

const JOBS: Record<PanelJobAction, (tenantId: string) => Promise<unknown>> = {
  metaAdsSync: (t) => syncMetaAdsDemo(t),
  computeAttribution: (t) => computeAttribution(t),
  catalogSync: (t) => syncProductsToMetaDemo(t),
  generateFollowups: (t) => generateFollowUpTasks(t),
  generateAudits: (t) => generateAgentAudits(t),
  computeTracking: (t) => computeTrackingAttribution(t),
  generateWinningReplies: (t) => generateWinningReplies(t),
  processConversions: async (t) => {
    const events = await backfillBusinessEvents(t);
    const send = await sendConversionEvents(t);
    return { events, ...send };
  },
};

/**
 * Requisitos de entitlements por job (Fase 5A): `feature` premium requerida (si aplica),
 * `quota` a verificar antes de correr, y `meter` el contador mensual a incrementar después.
 * Los jobs de marketing (ads/catalog/atribución/conversiones) requieren marketingAutomation.
 */
export interface JobRequirement {
  feature?: keyof PlanFeatures;
  quota?: 'adSyncs';
  meter: 'jobs' | 'adSyncs';
}
export const JOB_REQUIREMENTS: Record<PanelJobAction, JobRequirement> = {
  metaAdsSync: { feature: 'marketingAutomation', quota: 'adSyncs', meter: 'adSyncs' },
  computeAttribution: { feature: 'marketingAutomation', meter: 'jobs' },
  catalogSync: { feature: 'marketingAutomation', meter: 'jobs' },
  processConversions: { feature: 'marketingAutomation', meter: 'jobs' },
  generateFollowups: { meter: 'jobs' },
  generateAudits: { meter: 'jobs' },
  computeTracking: { meter: 'jobs' },
  generateWinningReplies: { meter: 'jobs' },
};

export function isPanelJobAction(action: string): action is PanelJobAction {
  return (PANEL_JOB_ACTIONS as readonly string[]).includes(action);
}

export function runPanelJob(action: PanelJobAction, tenantId: string): Promise<unknown> {
  return JOBS[action](tenantId);
}
