/**
 * Tenant — un negocio cliente de la plataforma.
 * Ver ARCHITECTURE.md §4.2.
 */

import type { TenantStatus, Country, Currency, SubscriptionStatus, PaymentProvider } from '../enums.js';
import type { Timestamp } from './common.types.js';
import type { PlanLimits } from './plan.types.js';

/** Suscripción de plataforma del tenant (billing del SaaS) — Fase 4 · 5B. */
export interface TenantSubscription {
  status: SubscriptionStatus;
  planId: string;
  /** Proveedor que cobra la suscripción (Fase 5B-ii). Legacy sin campo: ver resolvePaymentProvider. */
  paymentProvider?: PaymentProvider;
  // Referencias GENÉRICas del proveedor (Fase 5B-ii). Para Stripe se mantienen además los legacy.
  externalCustomerId?: string | null;
  externalSubscriptionId?: string | null;
  externalPlanRef?: string | null; // priceId (Stripe) | plan_id (PayPal)
  providerMetadata?: Record<string, unknown>;
  // Legacy específicos de Stripe (Fase 4/5B-i). Se conservan para datos Stripe.
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Timestamp | null;
  /** Desde cuándo está en past_due (para la ventana de gracia de 7 días) — Fase 5B. */
  pastDueSince?: Timestamp | null;
  updatedAt: Timestamp;
}

export interface TenantContact {
  ownerName: string;
  email: string;
  phone: string;
  country: Country;
}

export interface TenantWhatsappConfig {
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string; // Encriptado en reposo
  verifyToken: string;
  phoneNumber: string;
}

export interface BancardConfig {
  enabled: boolean;
  publicKey: string;
  privateKey: string; // Encriptado en reposo
  environment: 'staging' | 'production';
}

export interface StripeConfig {
  enabled: boolean;
  publishableKey: string;
  secretKey: string; // Encriptado en reposo
  webhookSecret: string; // Encriptado en reposo
}

export interface WalletConfig {
  enabled: boolean;
  apiKey: string; // Encriptado en reposo
  merchantId: string;
}

export interface TenantPaymentsConfig {
  bancard: BancardConfig;
  stripe: StripeConfig;
  tigo: WalletConfig;
  personal: WalletConfig;
  zimple: WalletConfig;
}

export interface TenantFiscalConfig {
  ruc: string;
  dv: string;
  razonSocial: string;
  nombreFantasia: string;
  direccion: string;
  departamento: string;
  ciudad: string;
  telefono: string;
  email: string;
  timbrado: string;
  timbradoFechaInicio: string; // ISO date
  establecimiento: string;
  puntoExpedicion: string;
  ambiente: 'testing' | 'production';
  actividadCodigo: string;
  actividadDescripcion: string;
}

export interface TenantBranding {
  businessName: string;
  welcomeMessage: string;
  currency: Currency;
  timezone: string;
  locale: string;
}

export interface TenantLimits {
  maxProducts: number;
  maxOrdersPerMonth: number;
  maxWhatsappMessagesPerMonth: number;
  maxDeliveryPersons: number;
}

export interface TenantUsage {
  ordersThisMonth: number;
  messagesThisMonth: number;
  currentPeriodStart: Timestamp;
  // Fase 5A — contadores mensuales adicionales (se reinician con el período).
  jobsThisMonth?: number;
  adSyncsThisMonth?: number;
  aiTokensThisMonth?: number;
  aiCostUsdThisMonth?: number;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  planId: string;
  contact: TenantContact;
  whatsapp: TenantWhatsappConfig;
  payments: TenantPaymentsConfig;
  fiscal: TenantFiscalConfig;
  branding: TenantBranding;
  limits: TenantLimits;
  usage: TenantUsage;
  /** Rubro del negocio (perfumeria, indumentaria, ...) — para plantillas y saludo. */
  industry?: string;
  /** Suscripción de plataforma (billing del SaaS) — Fase 4. */
  subscription?: TenantSubscription;
  /** Estado del onboarding inicial (Fase registro). Solo Admin SDK lo escribe (completeOnboarding). */
  onboarding?: { completed: boolean; completedAt: Timestamp | null };
  /** Overrides de límites por tenant (Enterprise/deals a medida) — Fase 5A. Solo Admin SDK. */
  limitOverrides?: Partial<PlanLimits>;
  /** Cuenta demo / no facturable (no se suspende por billing) — Fase 5A. Solo Admin SDK. */
  isDemo?: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: Timestamp | null;
}
