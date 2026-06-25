/**
 * entitlements/decide.ts — Decisiones PURAS de entitlements (Fase 5A)
 * ==================================================================
 * Sin E/S: combinan límites del plan + overrides + features + estado de suscripción.
 * Tres dimensiones ortogonales (rol / plan / billing) — acá vive SOLO plan + billing.
 * Testeable al 100%.
 */
import type { PlanLimits, PlanFeatures, SubscriptionStatus } from '@vpw/shared';

/** Valor para "ilimitado" (evita comparaciones con Infinity en Firestore). */
export const UNLIMITED = 1_000_000_000;

export function isUnlimited(limit: number): boolean {
  return limit >= UNLIMITED;
}

/** Límite efectivo: el override del tenant si existe, si no el del plan. */
export function effectiveLimit(planLimit: number, override?: number): number {
  return typeof override === 'number' ? override : planLimit;
}

/** Mezcla los límites del plan con los overrides del tenant (Enterprise/deals). */
export function effectiveLimits(planLimits: PlanLimits, overrides?: Partial<PlanLimits>): PlanLimits {
  const out = { ...planLimits };
  if (overrides) {
    for (const k of Object.keys(out) as Array<keyof PlanLimits>) {
      if (typeof overrides[k] === 'number') out[k] = overrides[k] as number;
    }
  }
  return out;
}

/** Mezcla las features del plan con los overrides del tenant (demos/Enterprise/deals). */
export function effectiveFeatures(planFeatures: PlanFeatures, overrides?: Partial<PlanFeatures>): PlanFeatures {
  const out = { ...planFeatures };
  if (overrides) {
    for (const k of Object.keys(out) as Array<keyof PlanFeatures>) {
      if (typeof overrides[k] === 'boolean') out[k] = overrides[k] as boolean;
    }
  }
  return out;
}

export function isFeatureEnabled(features: PlanFeatures, key: keyof PlanFeatures): boolean {
  return features[key] === true;
}

export type QuotaReason = 'ok' | 'quota_exceeded';

export interface QuotaDecision {
  allowed: boolean;
  reason: QuotaReason;
  used: number;
  limit: number;
  unlimited: boolean;
}

/** ¿Cabe `used + delta` dentro del límite? (ilimitado siempre cabe). */
export function decideQuota(used: number, limit: number, delta = 1): QuotaDecision {
  const unlimited = isUnlimited(limit);
  const allowed = unlimited || used + delta <= limit;
  return { allowed, reason: allowed ? 'ok' : 'quota_exceeded', used, limit, unlimited };
}

export interface BillingPosture {
  /** Puede operar (lectura + acciones básicas). Datos siempre preservados (no se suspende la cuenta). */
  operational: boolean;
  /** Puede ejecutar acciones premium/costosas (automatizaciones, ads, IA). */
  premiumAllowed: boolean;
  reason: string;
}

/** Ventana de gracia de past_due (Fase 5B): 7 días desde `pastDueSince`. */
export const GRACE_MS = 7 * 86_400_000;

/**
 * Postura de billing según el estado de la suscripción.
 * - active/trialing/none/demo → opera + premium.
 * - past_due CON gracia (5B: nowMs + pastDueSinceMs): premium mientras now < pastDueSince + 7d;
 *   pasada la gracia → premium bloqueado. Sin esos datos (5A) → premium bloqueado (conservador).
 * - canceled/incomplete → premium suspendido, datos preservados (la cuenta NO se suspende).
 */
export function billingPosture(
  status: SubscriptionStatus | undefined,
  isDemo: boolean,
  opts?: { nowMs?: number; pastDueSinceMs?: number | null },
): BillingPosture {
  if (isDemo) return { operational: true, premiumAllowed: true, reason: 'demo' };
  switch (status) {
    case 'active':
    case 'trialing':
    case 'none':
    case undefined:
      return { operational: true, premiumAllowed: true, reason: status ?? 'none' };
    case 'past_due': {
      if (opts && opts.nowMs != null && opts.pastDueSinceMs != null) {
        const inGrace = opts.nowMs < opts.pastDueSinceMs + GRACE_MS;
        return { operational: true, premiumAllowed: inGrace, reason: inGrace ? 'past_due_grace' : 'past_due_expired' };
      }
      return { operational: true, premiumAllowed: false, reason: 'past_due' };
    }
    case 'incomplete':
      return { operational: true, premiumAllowed: false, reason: 'incomplete' };
    case 'canceled':
      return { operational: true, premiumAllowed: false, reason: 'canceled' };
    default:
      return { operational: true, premiumAllowed: true, reason: 'unknown' };
  }
}
