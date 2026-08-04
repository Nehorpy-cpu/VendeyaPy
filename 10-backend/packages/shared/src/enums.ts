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

export const PLAN_TIER = ['FREE', 'STARTER', 'GROWTH', 'PRO', 'ENTERPRISE'] as const;
export type PlanTier = (typeof PLAN_TIER)[number];

// Estado de la suscripción de plataforma del tenant (billing del SaaS) — Fase 4.
export const SUBSCRIPTION_STATUS = [
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[number];

// Proveedor de billing de la SUSCRIPCIÓN del SaaS (Fase 5B). 'manual' = legacy sin proveedor externo;
// 'manual_whatsapp' = activación manual CONFIRMADA por el PLATFORM_ADMIN (billing manual por WhatsApp, MB).
export const PLATFORM_PAYMENT_PROVIDER = ['manual', 'stripe', 'paypal', 'bancard', 'manual_whatsapp'] as const;
export type PaymentProvider = (typeof PLATFORM_PAYMENT_PROVIDER)[number];

// Billing manual por WhatsApp (MB): estado de la solicitud de activación de plan.
export const MANUAL_ACTIVATION_STATUS = ['pending', 'approved', 'cancelled'] as const;
export type ManualActivationStatus = (typeof MANUAL_ACTIVATION_STATUS)[number];

// Billing manual por WhatsApp (MB): método de pago acordado fuera de la plataforma.
export const MANUAL_PAYMENT_METHOD = ['transferencia', 'deposito', 'giro'] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHOD)[number];

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

// Origen de la conexión Meta/WhatsApp. 'embedded_signup' = flujo OAuth de Meta;
// 'manual_admin' = carga manual por un PLATFORM_ADMIN (WM-1); 'demo' = simulada (local).
export const META_CONNECTION_SOURCE = ['embedded_signup', 'manual_admin', 'demo'] as const;
export type MetaConnectionSource = (typeof META_CONNECTION_SOURCE)[number];

// Onboarding manual de WhatsApp (WM-2): estado de la solicitud de activación asistida.
// El owner la crea ('pending'); el admin la 'completed' al cargar la conexión manual (WM-1) o la
// 'cancelled'. Vive en tenants/{tenantId}/whatsappActivationRequests/{requestId}.
export const WHATSAPP_ACTIVATION_STATUS = ['pending', 'completed', 'cancelled'] as const;
export type WhatsappActivationStatus = (typeof WHATSAPP_ACTIVATION_STATUS)[number];

// Canal de un mensaje/conversación (omnicanal, D2).
export const MESSAGE_CHANNEL = ['whatsapp', 'instagram', 'messenger'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNEL)[number];

// Modo de envío de WhatsApp por tenant (Fase 4A). 'live' = envío real por la conexión
// del tenant; 'mock' (default) = no se envía nada a Meta. Vive en config/channels.
export const WHATSAPP_SEND_MODE = ['mock', 'live'] as const;
export type WhatsappSendMode = (typeof WHATSAPP_SEND_MODE)[number];

// Estado de un evento en la bandeja de webhooks (D2).
export const WEBHOOK_STATUS = ['received', 'processing', 'processed', 'failed', 'ignored'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUS)[number];

// Tipo de evento de webhook YA ROUTEADO por `change.field` (Coexistence, ADR-0017 §12).
// Hasta este programa, `change.field` no se leía nunca y todo evento que no fuera `messages` se
// descartaba sin dejar rastro. Los valores NO son intercambiables:
//   · 'message'   — un inbound del cliente. Es el único que puede terminar automatizado.
//   · 'echo'      — lo que el VENDEDOR mandó desde la app de WhatsApp Business (outbound humano).
//   · 'history'   — hasta 180 días de conversaciones importadas. Archivo, no bandeja de entrada.
//   · 'app_state' — la agenda del vendedor. Contactos, NO clientes.
//   · 'unknown'   — un `field` que este despliegue no conoce. Es el valor MÁS RESTRICTIVO y por eso
//                   también es a donde cae un `kind` persistido con un valor que no está en esta
//                   lista: ante un dato que no se entiende, no se automatiza.
export const WEBHOOK_EVENT_KIND = ['message', 'echo', 'history', 'app_state', 'unknown'] as const;
export type WebhookEventKind = (typeof WEBHOOK_EVENT_KIND)[number];

// Tracking propio sin Meta (P11): tipo de fuente de una venta atribuida a una promo propia.
export const TRACKING_TYPE = ['coupon', 'qr', 'link'] as const;
export type TrackingType = (typeof TRACKING_TYPE)[number];

// Capa de eventos internos del negocio + Conversions API de Meta (D6).
export const BUSINESS_EVENT_NAME = ['ViewContent', 'Lead', 'Contact', 'AddToCart', 'InitiateCheckout', 'Purchase'] as const;
export type BusinessEventName = (typeof BUSINESS_EVENT_NAME)[number];

export const EVENT_SOURCE = ['store', 'whatsapp', 'instagram', 'messenger', 'manual', 'bot'] as const;
export type EventSource = (typeof EVENT_SOURCE)[number];

export const CONVERSION_SEND_STATUS = ['pending', 'sent', 'failed', 'skipped'] as const;
export type ConversionSendStatus = (typeof CONVERSION_SEND_STATUS)[number];

// Tipo de atribución de una venta a una campaña (D5).
export const ATTRIBUTION_TYPE = ['direct_meta', 'utm_match', 'coupon_match', 'manual', 'unknown'] as const;
export type AttributionType = (typeof ATTRIBUTION_TYPE)[number];

// Estado de sincronización de un producto con el Meta Catalog (D4).
// META-CATALOG-OUTBOX-1 sumó los estados de COLA: `queued` (hay un job esperando),
// `processing` (el worker lo reclamó o Meta ya aceptó el lote y falta confirmar) y
// `needs_review` (requiere una decisión humana). `synced` sigue significando CONFIRMADO
// contra Meta — jamás "lo mandamos".
export const META_SYNC_STATUS = ['not_synced', 'pending', 'queued', 'processing', 'synced', 'needs_review', 'failed', 'disabled'] as const;
export type MetaSyncStatus = (typeof META_SYNC_STATUS)[number];

// ---------------------------------------------------------------------------
// Estado ACTUAL de un producto contra el catálogo remoto (ADR-0015 §5)
// ---------------------------------------------------------------------------
// `metaSyncStatus` (arriba) es el eje HISTÓRICO: lo que pasó con nuestros jobs de escritura,
// y un job `succeeded` es evidencia inmutable. Este es el eje ACTUAL: qué muestra Meta HOY,
// y CADUCA. Confundirlos fue el bug de origen — `synced` afirmaba el pasado y nada lo volvía
// a mirar, así que un artículo revertido por el feed externo seguía en verde.
//
// `stale` NO está acá a propósito: se DERIVA en lectura (metaVerifiedAt más viejo que el TTL)
// y jamás se persiste. Si un job de verificación falla, el estado guardado envejece solo y
// deja de afirmar — persistir `stale` dependería de que ese mismo job funcione.
export const META_SYNC_STATE = ['verified', 'drifted', 'drifted_external', 'remote_missing', 'unverifiable'] as const;
/** Estado PERSISTIDO (siempre producto de una lectura remota real). */
export type MetaSyncState = (typeof META_SYNC_STATE)[number];
/** Estado EFECTIVO en lectura = el persistido + `stale` derivado por TTL. Nunca se guarda. */
export type MetaSyncStateEffective = MetaSyncState | 'stale';

/** Quién gobierna el campo que divergió (ADR-0015 §1). `unknown` ⇒ nadie lo declaró. */
export const META_DRIFT_OWNER = ['vendeyapy', 'external', 'unknown'] as const;
export type MetaDriftOwner = (typeof META_DRIFT_OWNER)[number];

/**
 * Severidad de la deriva. `commercial` = precio/moneda/disponibilidad/stock: el bot no puede
 * afirmarlos ni cerrar la venta (ADR-0015 §8). `cosmetic` = nombre/descripción/marca/imagen/
 * URL/categoría: advertencia administrativa, NO corta la conversación.
 */
export const META_DRIFT_SEVERITY = ['commercial', 'cosmetic'] as const;
export type MetaDriftSeverity = (typeof META_DRIFT_SEVERITY)[number];

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
