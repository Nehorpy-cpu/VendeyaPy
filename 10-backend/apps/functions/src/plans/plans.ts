/**
 * plans/plans.ts — Planes del SaaS y sus límites (Fase 4 · ampliado en 5A)
 * =======================================================================
 * Define los planes por defecto (FREE/STARTER/GROWTH/PRO/ENTERPRISE), los siembra en
 * `plans/{id}` si faltan, y resuelve un plan + sus límites/features. `getPlan` rellena
 * con los defaults del spec los campos nuevos que falten en docs ya seedeados (5A).
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { Plan, PlanLimits, PlanFeatures, PlanTier } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { UNLIMITED } from '../entitlements/decide.js';

export { UNLIMITED };

interface PlanSpec {
  id: string;
  tier: PlanTier;
  name: string;
  description: string;
  priceUsdPerMonth: number;
  pricePygPerMonth?: number;
  limits: PlanLimits;
  features: PlanFeatures;
}

const F = (over: Partial<PlanFeatures>): PlanFeatures => ({
  bancard: false, stripe: false, localWallets: false, electronicInvoicing: false,
  marketingAutomation: false, multiChannel: false, prioritySupport: false, aiAssistant: false,
  ...over,
});

// PLAN-LIMITS-2 — matriz oficial congelada (ver docs/plan-limits.md). IDs internos SIN cambiar
// (free/starter/growth/pro/enterprise) → no rompe billing/webhooks/tenants. `name` = etiqueta COMERCIAL.
// FEATURES: solo se prenden las realmente enforceadas hoy (aiAssistant + marketingAutomation gateado en
// modo demo). Las features de pago/facturación/multicanal/priority quedan en `false` (no se venden como
// disponibles hasta que PLAN-LIMITS-3 implemente sus gates). LÍMITES sin cambios respecto a la auditoría.
export const DEFAULT_PLANS: PlanSpec[] = [
  {
    id: 'free', tier: 'FREE', name: 'Prueba gratis', description: 'Probá la plataforma con límites básicos', priceUsdPerMonth: 0, pricePygPerMonth: 0,
    limits: { maxProducts: 20, maxOrdersPerMonth: 50, maxWhatsappMessagesPerMonth: 500, maxDeliveryPersons: 2, maxUsers: 2, maxWhatsappNumbers: 1, maxAdSyncsPerMonth: 0, maxAiTokensPerMonth: 0 },
    features: F({}),
  },
  {
    id: 'starter', tier: 'STARTER', name: 'Básico', description: 'Para empezar a vender por WhatsApp con asistente IA', priceUsdPerMonth: 29, pricePygPerMonth: 150_000,
    limits: { maxProducts: 200, maxOrdersPerMonth: 500, maxWhatsappMessagesPerMonth: 5_000, maxDeliveryPersons: 10, maxUsers: 5, maxWhatsappNumbers: 1, maxAdSyncsPerMonth: 0, maxAiTokensPerMonth: 50_000 },
    features: F({ aiAssistant: true }),
  },
  {
    id: 'growth', tier: 'GROWTH', name: 'Pro', description: 'Escala tu operación: más capacidad + automatización de marketing', priceUsdPerMonth: 79, pricePygPerMonth: 350_000,
    limits: { maxProducts: 1_000, maxOrdersPerMonth: 2_000, maxWhatsappMessagesPerMonth: 20_000, maxDeliveryPersons: 50, maxUsers: 15, maxWhatsappNumbers: 3, maxAdSyncsPerMonth: 30, maxAiTokensPerMonth: 250_000 },
    features: F({ aiAssistant: true, marketingAutomation: true }),
  },
  {
    id: 'pro', tier: 'PRO', name: 'Max', description: 'Alto volumen para negocios consolidados', priceUsdPerMonth: 199, pricePygPerMonth: 650_000,
    limits: { maxProducts: 10_000, maxOrdersPerMonth: 20_000, maxWhatsappMessagesPerMonth: 100_000, maxDeliveryPersons: 200, maxUsers: 50, maxWhatsappNumbers: 10, maxAdSyncsPerMonth: 300, maxAiTokensPerMonth: 1_000_000 },
    features: F({ aiAssistant: true, marketingAutomation: true }),
  },
  {
    id: 'enterprise', tier: 'ENTERPRISE', name: 'Enterprise', description: 'A medida: límites por acuerdo (vía limitOverrides)', priceUsdPerMonth: 0, pricePygPerMonth: 0,
    limits: { maxProducts: UNLIMITED, maxOrdersPerMonth: UNLIMITED, maxWhatsappMessagesPerMonth: UNLIMITED, maxDeliveryPersons: UNLIMITED, maxUsers: UNLIMITED, maxWhatsappNumbers: UNLIMITED, maxAdSyncsPerMonth: UNLIMITED, maxAiTokensPerMonth: UNLIMITED },
    features: F({ aiAssistant: true, marketingAutomation: true }),
  },
];

/** Rellena los campos nuevos (5A) que falten en un doc de plan ya seedeado. */
export function withPlanDefaults(stored: Plan, spec: PlanSpec): Plan {
  return {
    ...spec,
    ...stored,
    limits: { ...spec.limits, ...(stored.limits ?? {}) },
    features: { ...spec.features, ...(stored.features ?? {}) },
  };
}

/** Siembra los planes por defecto si la colección está vacía (idempotente). */
export async function ensurePlansSeeded(): Promise<void> {
  const snap = await db().collection(paths.plans()).limit(1).get();
  if (!snap.empty) return;
  const now = Timestamp.now();
  const batch = db().batch();
  for (const p of DEFAULT_PLANS) {
    const plan: Plan = { ...p, isActive: true, createdAt: now, updatedAt: now };
    batch.set(db().doc(paths.plan(p.id)), plan);
  }
  await batch.commit();
}

/** Resuelve un plan por id (Firestore con backfill de defaults; fallback al spec). */
export async function getPlan(planId: string): Promise<Plan | null> {
  const spec = DEFAULT_PLANS.find((p) => p.id === planId);
  const snap = await db().doc(paths.plan(planId)).get();
  if (snap.exists) {
    const stored = snap.data() as Plan;
    return spec ? withPlanDefaults(stored, spec) : stored;
  }
  if (!spec) return null;
  const now = Timestamp.now();
  return { ...spec, isActive: true, createdAt: now, updatedAt: now };
}
