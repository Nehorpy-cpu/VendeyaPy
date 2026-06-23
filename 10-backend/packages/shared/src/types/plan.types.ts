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
  limits: PlanLimits;
  features: PlanFeatures;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
