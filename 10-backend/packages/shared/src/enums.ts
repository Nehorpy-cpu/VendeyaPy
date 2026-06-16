/**
 * Enumeraciones de estado del sistema.
 * Los valores son literales fijos — NO cambiar sin migración de datos.
 * Ver ARCHITECTURE.md §3.6.
 */

export const ORDER_STATUS = [
  'PENDING_PAYMENT',
  'PAID',
  'PREPARING',
  'ASSIGNED',
  'IN_TRANSIT',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

export const DELIVERY_STATUS = [
  'PENDING',
  'ASSIGNED',
  'ACCEPTED',
  'IN_TRANSIT',
  'ARRIVED',
  'DELIVERED',
  'FAILED',
  'RETURNED',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUS)[number];

export const PAYMENT_STATUS = [
  'INITIATED',
  'PROCESSING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const PAYMENT_METHOD = [
  'BANCARD',
  'STRIPE',
  'TIGO',
  'PERSONAL',
  'ZIMPLE',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[number];

export const TENANT_STATUS = [
  'ONBOARDING',
  'ACTIVE',
  'SUSPENDED',
  'DELETED',
] as const;
export type TenantStatus = (typeof TENANT_STATUS)[number];

export const USER_ROLE = [
  'PLATFORM_ADMIN',
  'TENANT_OWNER',
  'TENANT_MANAGER',
  'TENANT_VIEWER',
] as const;
export type UserRole = (typeof USER_ROLE)[number];

export const SESSION_STATE = [
  'GREETING',
  'BROWSING',
  'VIEWING_PRODUCT',
  'CART',
  'SELECTING_PAYMENT',
  'AWAITING_PAYMENT',
  'CHECKOUT_DONE',
  'IDLE',
] as const;
export type SessionState = (typeof SESSION_STATE)[number];

export const PRODUCT_STATUS = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUS)[number];

export const PERFUME_GENDER = ['Femenino', 'Masculino', 'Unisex'] as const;
export type PerfumeGender = (typeof PERFUME_GENDER)[number];

export const PRICE_RANGE = ['ACCESIBLE', 'MID', 'PREMIUM', 'LUJO'] as const;
export type PriceRange = (typeof PRICE_RANGE)[number];

export const DRIVER_STATUS = ['AVAILABLE', 'BUSY', 'OFFLINE'] as const;
export type DriverStatus = (typeof DRIVER_STATUS)[number];

export const INVOICE_STATUS = [
  'DRAFT',
  'PENDING_SUBMISSION',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];

export const CHANNEL = ['WHATSAPP', 'FACEBOOK', 'INSTAGRAM', 'TIKTOK'] as const;
export type Channel = (typeof CHANNEL)[number];

export const CURRENCY = ['PYG', 'ARS', 'USD'] as const;
export type Currency = (typeof CURRENCY)[number];

export const COUNTRY = ['PY', 'AR', 'BR', 'MX', 'CO'] as const;
export type Country = (typeof COUNTRY)[number];

export const PLAN_TIER = ['FREE', 'STARTER', 'GROWTH', 'PRO'] as const;
export type PlanTier = (typeof PLAN_TIER)[number];
