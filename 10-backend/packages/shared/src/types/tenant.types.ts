/**
 * Tenant — un negocio cliente de la plataforma.
 * Ver ARCHITECTURE.md §4.2.
 */

import type { TenantStatus, Country, Currency, SubscriptionStatus } from '../enums.js';
import type { Timestamp } from './common.types.js';

/** Suscripción de plataforma del tenant (billing del SaaS) — Fase 4. */
export interface TenantSubscription {
  status: SubscriptionStatus;
  planId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Timestamp | null;
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
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: Timestamp | null;
}
