/**
 * Enumeraciones de estado del sistema.
 * Los valores son literales fijos — NO cambiar sin migración de datos.
 * Ver ARCHITECTURE.md §3.6.
 */

export const ORDER_STATUS = [
  'PENDING_PAYMENT',
  'PENDING_VERIFICATION', // comprobante recibido, esperando verificación del vendedor
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
  'PLATFORM_ADMIN', // Super Admin (Marco) — dueño del SaaS, ve todas las empresas
  'TENANT_OWNER', // Dueño de la empresa cliente
  'TENANT_MANAGER',
  'TENANT_VIEWER',
  'SELLER', // Vendedor — solo pedidos/conversaciones/handoffs asignados (ADR-0005)
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

export const PROMOTION_TYPE = [
  'PERCENTAGE', // % de descuento
  'FIXED_AMOUNT', // monto fijo de descuento
  'BUNDLE', // combo
  'TWO_FOR_ONE', // 2x1
  'FREE_SHIPPING', // envío gratis
] as const;
export type PromotionType = (typeof PROMOTION_TYPE)[number];

export const PROMOTION_STATUS = ['DRAFT', 'ACTIVE', 'PAUSED', 'FINISHED'] as const;
export type PromotionStatus = (typeof PROMOTION_STATUS)[number];

// Recomendaciones del sistema (Growth Copilot). P8 genera las de promoción;
// P13/P14/Track D agregan las demás. Ver ADR-0006.
export const INSIGHT_TYPE = [
  'PROMO_SUGGESTION', // P8 — sugerencia de promoción
  'CUSTOMER_REACTIVATION', // P13 — reactivar cliente dormido que ya compró
  'PENDING_REPLY', // P13 — conversación esperando respuesta
  'FOLLOW_UP', // P14
  'CAMPAIGN_REVIEW', // Track D
  'AGENT_ISSUE', // P16
] as const;
export type InsightType = (typeof INSIGHT_TYPE)[number];

export const INSIGHT_STATUS = ['PENDING', 'ACCEPTED', 'DISMISSED', 'RESOLVED'] as const;
export type InsightStatus = (typeof INSIGHT_STATUS)[number];

export const INSIGHT_PRIORITY = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type InsightPriority = (typeof INSIGHT_PRIORITY)[number];

// Tareas de seguimiento para el vendedor (Growth Copilot, P14).
export const FOLLOWUP_TYPE = [
  'PAYMENT_PENDING', // pedido sin pagar
  'VERIFY_RECEIPT', // comprobante a verificar
  'ENGAGE', // preguntó y no compró
  'REPURCHASE', // compró hace tiempo, ofrecer de nuevo
  'GENERAL',
] as const;
export type FollowUpType = (typeof FOLLOWUP_TYPE)[number];

export const FOLLOWUP_STATUS = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'DISMISSED'] as const;
export type FollowUpStatus = (typeof FOLLOWUP_STATUS)[number];

// Auditoría del agente (Growth Copilot, P16). Hallazgos por reglas sobre el historial.
export const AUDIT_ISSUE_TYPE = [
  'NOT_UNDERSTOOD', // el bot cayó al mensaje de "no entendí" (fallback)
  'POSSIBLE_COMPLAINT_NO_HANDOFF', // posible reclamo sin pasar a un vendedor
  'PRODUCT_INCOMPLETE', // producto con info incompleta (sin notas IA / costo / descripción)
] as const;
export type AuditIssueType = (typeof AUDIT_ISSUE_TYPE)[number];

export const AUDIT_STATUS = ['OPEN', 'RESOLVED', 'DISMISSED'] as const;
export type AuditStatus = (typeof AUDIT_STATUS)[number];

// Simulador del agente (Growth Copilot, P17). El dueño marca el resultado de cada caso.
export const AGENTTEST_STATUS = ['UNTESTED', 'OK', 'NEEDS_WORK'] as const;
export type AgentTestStatus = (typeof AGENTTEST_STATUS)[number];

// Biblioteca de respuestas ganadoras (Growth Copilot, P18).
export const REPLY_STATUS = ['ACTIVE', 'ARCHIVED'] as const;
export type ReplyStatus = (typeof REPLY_STATUS)[number];

// Integración con Meta (Track D / D1). Estados de la conexión (ADR-0009).
export const META_CONNECTION_STATUS = [
  'not_connected',
  'connected_limited',
  'pending_review',
  'permission_missing',
  'active',
  'error',
  'expired',
  'revoked',
] as const;
export type MetaConnectionStatus = (typeof META_CONNECTION_STATUS)[number];

export const META_ASSET_TYPE = [
  'business',
  'ad_account',
  'facebook_page',
  'instagram_account',
  'whatsapp_business_account',
  'whatsapp_phone_number',
  'catalog',
  'pixel',
] as const;
export type MetaAssetType = (typeof META_ASSET_TYPE)[number];

// Segmento del cliente (Growth Copilot, P12). Calculado por reglas RFM-lite.
export const CUSTOMER_TYPE = [
  'NEW', // recién apareció, sin compras
  'HOT', // interactuó hace poco, todavía no compró
  'BUYER', // compró 1 vez
  'RECURRING', // 2+ compras
  'PREMIUM', // alto gasto acumulado
  'DORMANT', // sin interacción hace tiempo
  'LOST', // sin interacción hace mucho
] as const;
export type CustomerType = (typeof CUSTOMER_TYPE)[number];
