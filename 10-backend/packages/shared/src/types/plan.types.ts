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
}

export interface PlanFeatures {
  bancard: boolean;
  stripe: boolean;
  localWallets: boolean;
  electronicInvoicing: boolean;
  marketingAutomation: boolean;
  multiChannel: boolean;
  prioritySupport: boolean;
}

export interface Plan {
  id: string;
  tier: PlanTier;
  name: string;
  description: string;
  priceUsdPerMonth: number;
  limits: PlanLimits;
  features: PlanFeatures;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
