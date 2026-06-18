/**
 * plans/plans.ts — Planes del SaaS y sus límites (Fase 4)
 * =======================================================
 * Define los planes por defecto (FREE/STARTER/GROWTH/PRO, ARCHITECTURE §2.4),
 * los siembra en `plans/{id}` si faltan, y permite resolver un plan + sus límites.
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { Plan, PlanLimits, PlanFeatures, PlanTier } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';

/** Valor para "ilimitado" (evita comparaciones con Infinity en Firestore). */
export const UNLIMITED = 1_000_000_000;

interface PlanSpec {
  id: string;
  tier: PlanTier;
  name: string;
  description: string;
  priceUsdPerMonth: number;
  limits: PlanLimits;
  features: PlanFeatures;
}

export const DEFAULT_PLANS: PlanSpec[] = [
  {
    id: 'free', tier: 'FREE', name: 'Free', description: 'Para empezar a vender por WhatsApp', priceUsdPerMonth: 0,
    limits: { maxProducts: 20, maxOrdersPerMonth: 50, maxWhatsappMessagesPerMonth: 500, maxDeliveryPersons: 2 },
    features: { bancard: false, stripe: false, localWallets: false, electronicInvoicing: false, marketingAutomation: false, multiChannel: false, prioritySupport: false },
  },
  {
    id: 'starter', tier: 'STARTER', name: 'Starter', description: 'Negocios en crecimiento', priceUsdPerMonth: 29,
    limits: { maxProducts: 200, maxOrdersPerMonth: 500, maxWhatsappMessagesPerMonth: 5_000, maxDeliveryPersons: 10 },
    features: { bancard: true, stripe: true, localWallets: true, electronicInvoicing: false, marketingAutomation: false, multiChannel: true, prioritySupport: false },
  },
  {
    id: 'growth', tier: 'GROWTH', name: 'Growth', description: 'Escala tu operación', priceUsdPerMonth: 79,
    limits: { maxProducts: 1_000, maxOrdersPerMonth: 2_000, maxWhatsappMessagesPerMonth: 20_000, maxDeliveryPersons: 50 },
    features: { bancard: true, stripe: true, localWallets: true, electronicInvoicing: true, marketingAutomation: true, multiChannel: true, prioritySupport: false },
  },
  {
    id: 'pro', tier: 'PRO', name: 'Pro', description: 'Sin límites + soporte prioritario', priceUsdPerMonth: 199,
    limits: { maxProducts: UNLIMITED, maxOrdersPerMonth: UNLIMITED, maxWhatsappMessagesPerMonth: UNLIMITED, maxDeliveryPersons: UNLIMITED },
    features: { bancard: true, stripe: true, localWallets: true, electronicInvoicing: true, marketingAutomation: true, multiChannel: true, prioritySupport: true },
  },
];

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

/** Resuelve un plan por id (de Firestore, con fallback al spec por defecto). */
export async function getPlan(planId: string): Promise<Plan | null> {
  const snap = await db().doc(paths.plan(planId)).get();
  if (snap.exists) return snap.data() as Plan;
  const spec = DEFAULT_PLANS.find((p) => p.id === planId);
  if (!spec) return null;
  const now = Timestamp.now();
  return { ...spec, isActive: true, createdAt: now, updatedAt: now };
}
