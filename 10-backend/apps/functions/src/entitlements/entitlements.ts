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
import { billingPosture, decideQuota, effectiveLimits, effectiveFeatures, isFeatureEnabled, type BillingPosture } from './decide.js';
import { maybeResetUsage } from './usageReset.js';

export interface Entitlements {
  tenantId: string;
  /** Último plan seleccionado (UX/renovación). Alias histórico: `planId`. */
  selectedPlanId: string;
  planId: string; // = selectedPlanId (compat)
  /** Plan EFECTIVO: 'free' cuando el billing no permite premium (canceled/past_due vencido). */
  effectivePlanId: string;
  /** El billing degradó a free por falta de pago (selected != free y premium no permitido). */
  premiumSuspended: boolean;
  /** Prueba gratis vencida (TRIAL-ENFORCEMENT-1A): planId 'free' + `trial.endsAt < now` + no demo.
   *  Derivado por fecha (no se persiste). Bloquea acciones de uso; el owner igual puede pedir activación. */
  trialExpired: boolean;
  tier: PlanTier;
  subscriptionStatus: SubscriptionStatus;
  isDemo: boolean;
  limits: PlanLimits; // efectivos (plan efectivo + overrides si premium)
  features: PlanFeatures; // del plan efectivo
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
  const selectedPlanId = tenant?.planId ?? 'free';
  const status = (tenant?.subscription?.status ?? 'none') as SubscriptionStatus;
  const isDemo = tenant?.isDemo === true;
  const pastDueSinceMs = tenant?.subscription?.pastDueSince ? tenant.subscription.pastDueSince.toMillis() : null;
  const posture = billingPosture(status, isDemo, { nowMs: now, pastDueSinceMs });

  // Plan efectivo: si el billing no permite premium (y no es free ni demo) → free.
  // (El tenant.planId se conserva como "último plan seleccionado" para UX/renovación.)
  const premiumSuspended = !posture.premiumAllowed && selectedPlanId !== 'free' && !isDemo;
  const effectivePlanId = premiumSuspended ? 'free' : selectedPlanId;
  const effPlan = (await getPlan(effectivePlanId)) ?? (await getPlan('free'));
  if (!effPlan) throw new Error('No se pudo resolver el plan base (free).');

  // TRIAL-ENFORCEMENT-1A: prueba vencida = el tenant está en `free`, tiene `trial.endsAt` y ya pasó, y no
  // es demo. DERIVADO por fecha (no hay status persistido). Un tenant pago tiene planId != 'free' (al activar,
  // el plan cambia) → trialExpired false. Tenants legacy sin `trial` → false (no se bloquean en esta fase).
  const trialEndsMs = tenant?.trial?.endsAt ? tenant.trial.endsAt.toMillis() : null;
  const trialExpired = selectedPlanId === 'free' && !isDemo && trialEndsMs != null && trialEndsMs < now;

  const ent: Entitlements = {
    tenantId,
    selectedPlanId,
    planId: selectedPlanId,
    effectivePlanId,
    premiumSuspended,
    trialExpired,
    tier: effPlan.tier,
    subscriptionStatus: status,
    isDemo,
    // Overrides (deals Enterprise / demos) solo aplican con premium habilitado.
    limits: effectiveLimits(effPlan.limits, premiumSuspended ? undefined : tenant?.limitOverrides),
    features: effectiveFeatures(effPlan.features, premiumSuspended ? undefined : tenant?.featureOverrides),
    posture,
  };
  cache.set(tenantId, { ent, expiresAtMs: now + TTL_MS });
  return ent;
}

// ---- Registro de métricas ----
type MonthlyMetric = 'messages' | 'orders' | 'adSyncs' | 'aiTokens' | 'jobs';
// PLAN-LIMITS-2: `whatsappNumbers` se suma al modelo como count-metric (conteo de números WA conectados).
// Queda CABLEADO pero SIN caller todavía: el gate de bloqueo (assertWithinLimit en el connect) es PLAN-LIMITS-3.
type CountMetric = 'products' | 'users' | 'deliveryPersons' | 'whatsappNumbers';
export type QuotaMetric = 'messages' | 'orders' | 'adSyncs' | 'aiTokens' | 'products' | 'users' | 'deliveryPersons' | 'whatsappNumbers';

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
  deliveryPersons: 'maxDeliveryPersons',
  whatsappNumbers: 'maxWhatsappNumbers',
};
const COUNT_FN: Record<CountMetric, (tenantId: string) => Promise<number>> = {
  products: async (t) => (await db().collection(paths.products(t)).count().get()).data().count,
  users: async (t) => (await db().collection(paths.users()).where('tenantId', '==', t).count().get()).data().count,
  // Cuota de repartidores: cuenta SOLO los activos (isActive==true) → los desactivados liberan cupo.
  deliveryPersons: async (t) => (await db().collection(paths.deliveryPersons(t)).where('isActive', '==', true).count().get()).data().count,
  // Números de WhatsApp conectados (assets de Meta). Single-where (sin índice compuesto). El gate = L3.
  whatsappNumbers: async (t) => (await db().collection(paths.metaAssets(t)).where('assetType', '==', 'whatsapp_phone_number').count().get()).data().count,
};
const isCountMetric = (m: QuotaMetric): m is CountMetric => m === 'products' || m === 'users' || m === 'deliveryPersons' || m === 'whatsappNumbers';

export interface QuotaResult {
  allowed: boolean;
  reason: 'ok' | 'quota_exceeded' | 'suspended' | 'trial_expired';
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
  // TRIAL-ENFORCEMENT-1A: prueba gratis vencida → ninguna acción de uso (órdenes/mensajes/cuotas) pasa.
  if (ent.trialExpired) return { allowed: false, reason: 'trial_expired', used: 0, limit: 0, unlimited: false, metric };
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
  if (r.reason === 'trial_expired') throw new HttpsError('failed-precondition', 'Tu prueba gratis de 7 días terminó. Activá un plan para seguir usando la plataforma.');
  throw new HttpsError('resource-exhausted', `Alcanzaste el límite de tu plan (${metric}: ${r.limit}). Actualizá tu plan para continuar.`);
}

/**
 * Lanza HttpsError si la feature no está disponible en el plan EFECTIVO. Distingue la causa:
 * billing (plan degradado por falta de pago → mensaje de pago) vs plan (feature no incluida).
 */
export async function assertFeatureEnabled(tenantId: string, feature: keyof PlanFeatures, opts: { actorUid?: string | null } = {}): Promise<void> {
  const ent = await resolveEntitlements(tenantId);
  if (isFeatureEnabled(ent.features, feature)) return;
  // TRIAL-ENFORCEMENT-1A: prueba vencida → bloquea features de uso (IA/marketing) con motivo de trial.
  if (ent.trialExpired) {
    await auditBlock(tenantId, opts.actorUid, `Prueba gratis vencida: ${feature}`, { feature, reason: 'trial_expired' });
    throw new HttpsError('failed-precondition', 'Tu prueba gratis de 7 días terminó. Activá un plan para usar esta función.');
  }
  if (ent.premiumSuspended) {
    await auditBlock(tenantId, opts.actorUid, `Feature premium suspendida por billing (${ent.posture.reason}): ${feature}`, { feature, reason: 'billing_premium_suspended', billing: ent.posture.reason });
    throw new HttpsError('failed-precondition', 'Tu suscripción tiene un pago pendiente. Regularizá el pago para usar las funciones premium.');
  }
  await auditBlock(tenantId, opts.actorUid, `Feature no incluida en el plan: ${feature}`, { feature, reason: 'feature_not_in_plan' });
  throw new HttpsError('failed-precondition', `Tu plan no incluye esta función (${feature}). Actualizá tu plan.`);
}

/**
 * Gate del canal WhatsApp (MULTI-NUMBER-1): el plan debe cubrir `needed` números en total.
 * needed=1 (default) mantiene el comportamiento del alta/reemplazo del número principal;
 * agregar un número adicional pasa needed = activos actuales + 1.
 */
export async function assertWhatsappNumbersEntitled(
  tenantId: string,
  opts: { actorUid?: string | null; needed?: number } = {},
): Promise<void> {
  const needed = Math.max(1, opts.needed ?? 1);
  const ent = await resolveEntitlements(tenantId);
  if (!ent.posture.operational) throw new HttpsError('failed-precondition', 'La empresa está suspendida por billing.');
  if (ent.limits.maxWhatsappNumbers < needed) {
    await auditBlock(tenantId, opts.actorUid, 'Límite de números de WhatsApp del plan', { metric: 'whatsappNumbers', limit: ent.limits.maxWhatsappNumbers, needed });
    throw new HttpsError(
      'failed-precondition',
      needed <= 1
        ? 'Tu plan no incluye conectar un número de WhatsApp. Actualizá tu plan.'
        : `Tu plan permite hasta ${ent.limits.maxWhatsappNumbers} número(s) de WhatsApp. Actualizá tu plan para agregar más.`,
    );
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
