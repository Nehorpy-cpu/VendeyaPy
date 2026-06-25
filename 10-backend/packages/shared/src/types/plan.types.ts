/**
 * Planes del SaaS (FREE / STARTER / GROWTH / PRO).
 * Ver ARCHITECTURE.md §2.4.
 */

import type { PlanTier } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface PlanLimits {
  maxProducts: number;
  maxOrdersPerMonth: number;
  maxWhatsappMessagesPerMonth: number;
  maxDeliveryPersons: number;
  // Fase 5A — límites adicionales para vender el SaaS.
  maxUsers: number;
  maxWhatsappNumbers: number;
  maxAdSyncsPerMonth: number;
  maxAiTokensPerMonth: number;
}

export interface PlanFeatures {
  bancard: boolean;
  stripe: boolean;
  localWallets: boolean;
  electronicInvoicing: boolean;
  marketingAutomation: boolean;
  multiChannel: boolean;
  prioritySupport: boolean;
  // Fase 5A — feature flag del asistente IA (scaffold; sin cablear OpenAI todavía).
  aiAssistant: boolean;
}

export interface Plan {
  id: string;
  tier: PlanTier;
  name: string;
  description: string;
  /** Precio de referencia en USD (legacy). El precio COMERCIAL es `pricePygPerMonth` (PLAN-LIMITS-2). */
  priceUsdPerMonth: number;
  /** Precio comercial mensual en guaraníes (PLAN-LIMITS-2). Fuente de verdad para mostrar al cliente. */
  pricePygPerMonth?: number;
  /**
   * Días de prueba gratis (PLAN-LIMITS-FREE-TRIAL). Solo el plan `free` lo define (7). Determina
   * `Tenant.trial.endsAt = startedAt + trialDays·días` en `provisionTenantCore`. El vencimiento SE ENFORCEA
   * (TRIAL-ENFORCEMENT-1A): `resolveEntitlements` deriva `trialExpired` por fecha y bloquea acciones de uso.
   * Ver docs/plan-limits.md §13 (matriz) y §14 (enforcement). Los planes pagos lo dejan `undefined`.
   */
  trialDays?: number;
  limits: PlanLimits;
  features: PlanFeatures;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
