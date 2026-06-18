/**
 * entitlements/entitlements.ts — Entitlements + cuotas + metering por tenant (Fase 5A)
 * ===================================================================================
 * Fuente de verdad de los límites efectivos: `plans/{planId}` + `tenant.limitOverrides`.
 * Tres dimensiones que CADA acción sensible valida en backend (el frontend nunca decide
 * seguridad): (1) rol — en los callables/rules; (2) plan/entitlements — acá; (3) billing
 * — acá (posture); (4) cuota/uso — acá. Los bloqueos importantes se auditan.
 */
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Tenant, PlanLimits, PlanFeatures, PlanTier, SubscriptionStatus, TenantUsage } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { recordAudit } from '../audit/audit.js';
import { getPlan } from '../plans/plans.js';
import { billingPosture, decideQuota, effectiveLimits, isFeatureEnabled, type BillingPosture } from './decide.js';
import { maybeResetUsage } from './usageReset.js';

export interface Entitlements {
  tenantId: string;
  planId: string;
  tier: PlanTier;
  subscriptionStatus: SubscriptionStatus;
  isDemo: boolean;
  limits: PlanLimits; // efectivos (plan + overrides)
  features: PlanFeatures;
  posture: BillingPosture;
}

// ---- Caché por tenant (TTL corto). Se invalida al cambiar plan/billing/overrides. ----
const cache = new Map<string, { ent: Entitlements; expiresAtMs: number }>();
const TTL_MS = 30_000;
export function invalidateEntitlements(tenantId: string): void {
  cache.delete(tenantId);
}

export async function resolveEntitlements(tenantId: string): Promise<Entitlements> {
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAtMs > now) return hit.ent;

  const tenant = (await db().doc(paths.tenant(tenantId)).get()).data() as Partial<Tenant> | undefined;
  const planId = tenant?.planId ?? 'free';
  const plan = (await getPlan(planId)) ?? (await getPlan('free'));
  if (!plan) throw new Error('No se pudo resolver el plan base (free).');
  const status = (tenant?.subscription?.status ?? 'none') as SubscriptionStatus;
  const isDemo = tenant?.isDemo === true;

  const ent: Entitlements = {
    tenantId,
    planId,
    tier: plan.tier,
    subscriptionStatus: status,
    isDemo,
    limits: effectiveLimits(plan.limits, tenant?.limitOverrides),
    features: plan.features,
    posture: billingPosture(status, isDemo),
  };
  cache.set(tenantId, { ent, expiresAtMs: now + TTL_MS });
  return ent;
}

// ---- Registro de métricas ----
type MonthlyMetric = 'messages' | 'orders' | 'adSyncs' | 'aiTokens' | 'jobs';
type CountMetric = 'products' | 'users';
export type QuotaMetric = 'messages' | 'orders' | 'adSyncs' | 'aiTokens' | 'products' | 'users';

const MONTHLY_FIELD: Record<MonthlyMetric, keyof TenantUsage> = {
  messages: 'messagesThisMonth',
  orders: 'ordersThisMonth',
  adSyncs: 'adSyncsThisMonth',
  aiTokens: 'aiTokensThisMonth',
  jobs: 'jobsThisMonth',
};
const QUOTA_LIMIT: Record<QuotaMetric, keyof PlanLimits> = {
  messages: 'maxWhatsappMessagesPerMonth',
  orders: 'maxOrdersPerMonth',
  adSyncs: 'maxAdSyncsPerMonth',
  aiTokens: 'maxAiTokensPerMonth',
  products: 'maxProducts',
  users: 'maxUsers',
};
const COUNT_FN: Record<CountMetric, (tenantId: string) => Promise<number>> = {
  products: async (t) => (await db().collection(paths.products(t)).count().get()).data().count,
  users: async (t) => (await db().collection(paths.users()).where('tenantId', '==', t).count().get()).data().count,
};
const isCountMetric = (m: QuotaMetric): m is CountMetric => m === 'products' || m === 'users';

export interface QuotaResult {
  allowed: boolean;
  reason: 'ok' | 'quota_exceeded' | 'suspended';
  used: number;
  limit: number;
  unlimited: boolean;
  metric: QuotaMetric;
}

/** ¿La empresa puede sumar `delta` de `metric` sin pasar el límite del plan? (lazy-reset). */
export async function checkQuota(tenantId: string, metric: QuotaMetric, delta = 1): Promise<QuotaResult> {
  await maybeResetUsage(tenantId);
  const ent = await resolveEntitlements(tenantId);
  if (!ent.posture.operational) return { allowed: false, reason: 'suspended', used: 0, limit: 0, unlimited: false, metric };
  const limit = ent.limits[QUOTA_LIMIT[metric]];
  let used: number;
  if (isCountMetric(metric)) {
    used = await COUNT_FN[metric](tenantId);
  } else {
    const usage = (await db().doc(paths.tenant(tenantId)).get()).data()?.usage as TenantUsage | undefined;
    used = (usage?.[MONTHLY_FIELD[metric as MonthlyMetric]] as number | undefined) ?? 0;
  }
  const d = decideQuota(used, limit, delta);
  return { allowed: d.allowed, reason: d.allowed ? 'ok' : 'quota_exceeded', used: d.used, limit: d.limit, unlimited: d.unlimited, metric };
}

async function auditBlock(tenantId: string, actorUid: string | null | undefined, summary: string, metadata: Record<string, unknown>): Promise<void> {
  await recordAudit({ tenantId, action: 'entitlement.blocked', actorUid: actorUid ?? null, targetType: 'entitlement', summary, metadata });
}

/** Lanza HttpsError si se pasa la cuota (para callables). Audita el bloqueo. */
export async function assertWithinLimit(tenantId: string, metric: QuotaMetric, opts: { delta?: number; actorUid?: string | null } = {}): Promise<void> {
  const r = await checkQuota(tenantId, metric, opts.delta ?? 1);
  if (r.allowed) return;
  await auditBlock(tenantId, opts.actorUid, `Bloqueado por ${r.reason} (${metric}): ${r.used}/${r.limit}`, { metric, reason: r.reason, used: r.used, limit: r.limit });
  if (r.reason === 'suspended') throw new HttpsError('failed-precondition', 'La empresa está suspendida por billing.');
  throw new HttpsError('resource-exhausted', `Alcanzaste el límite de tu plan (${metric}: ${r.limit}). Actualizá tu plan para continuar.`);
}

/** Lanza HttpsError si la feature no está en el plan o el billing premium está suspendido. */
export async function assertFeatureEnabled(tenantId: string, feature: keyof PlanFeatures, opts: { actorUid?: string | null } = {}): Promise<void> {
  const ent = await resolveEntitlements(tenantId);
  if (!isFeatureEnabled(ent.features, feature)) {
    await auditBlock(tenantId, opts.actorUid, `Feature no incluida en el plan: ${feature}`, { feature, reason: 'feature_not_in_plan' });
    throw new HttpsError('failed-precondition', `Tu plan no incluye esta función (${feature}). Actualizá tu plan.`);
  }
  if (!ent.posture.premiumAllowed) {
    await auditBlock(tenantId, opts.actorUid, `Feature premium suspendida por billing (${ent.posture.reason}): ${feature}`, { feature, reason: 'billing_premium_suspended', billing: ent.posture.reason });
    throw new HttpsError('failed-precondition', 'Tu suscripción tiene un pago pendiente. Regularizá el pago para usar las funciones premium.');
  }
}

/** Gate del canal WhatsApp: el plan debe permitir al menos un número (multi-número: fase posterior). */
export async function assertWhatsappNumbersEntitled(tenantId: string, opts: { actorUid?: string | null } = {}): Promise<void> {
  const ent = await resolveEntitlements(tenantId);
  if (!ent.posture.operational) throw new HttpsError('failed-precondition', 'La empresa está suspendida por billing.');
  if (ent.limits.maxWhatsappNumbers < 1) {
    await auditBlock(tenantId, opts.actorUid, 'El plan no incluye números de WhatsApp', { metric: 'whatsappNumbers', limit: ent.limits.maxWhatsappNumbers });
    throw new HttpsError('failed-precondition', 'Tu plan no incluye conectar un número de WhatsApp. Actualizá tu plan.');
  }
}

/** Incrementa un contador de uso mensual (lazy-reset previo). */
export async function meterUsage(tenantId: string, metric: MonthlyMetric, by = 1): Promise<void> {
  await maybeResetUsage(tenantId);
  await db().doc(paths.tenant(tenantId)).set(
    { usage: { [MONTHLY_FIELD[metric]]: FieldValue.increment(by) }, updatedAt: Timestamp.now() },
    { merge: true },
  );
}

/** Mete tokens + costo estimado de IA (scaffold; el conteo real lo alimenta el motor IA). */
export async function meterAiUsage(tenantId: string, tokens: number, costUsd: number): Promise<void> {
  await maybeResetUsage(tenantId);
  await db().doc(paths.tenant(tenantId)).set(
    { usage: { aiTokensThisMonth: FieldValue.increment(tokens), aiCostUsdThisMonth: FieldValue.increment(costUsd) }, updatedAt: Timestamp.now() },
    { merge: true },
  );
}
