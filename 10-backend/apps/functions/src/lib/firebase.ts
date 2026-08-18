/**
 * Helpers de acceso a Firebase Admin SDK.
 */

import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getAuth, Auth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';

let _db: Firestore | null = null;
let _auth: Auth | null = null;

export function db(): Firestore {
  if (!_db) _db = getFirestore();
  return _db;
}

export function auth(): Auth {
  if (!_auth) _auth = getAuth();
  return _auth;
}

export function storage() {
  return getStorage();
}

/**
 * Helpers de paths Firestore para evitar typos.
 * Ver ARCHITECTURE.md §4.1.
 */
export const paths = {
  plans: () => 'plans',
  plan: (planId: string) => `plans/${planId}`,
  // Globales para Meta (D2): bandeja de webhooks + índice de ids externos.
  metaWebhookInbox: () => 'metaWebhookInbox',
  metaWebhookEvent: (eventId: string) => `metaWebhookInbox/${eventId}`,
  metaExternalIndex: () => 'metaExternalIndex',
  metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  // Idempotencia de webhooks de pago + secretos cifrados (globales, Admin SDK only).
  stripeWebhookEvents: () => 'stripeWebhookEvents',
  stripeWebhookEvent: (id: string) => `stripeWebhookEvents/${id}`,
  secrets: () => 'secrets',
  secret: (name: string) => `secrets/${name}`,
  platformBillingEvents: () => 'platformBillingEvents',
  platformBillingEvent: (id: string) => `platformBillingEvents/${id}`,
  users: () => 'users',
  user: (userId: string) => `users/${userId}`,
  tenants: () => 'tenants',
  tenant: (tenantId: string) => `tenants/${tenantId}`,
  products: (tenantId: string) => `tenants/${tenantId}/products`,
  product: (tenantId: string, productId: string) =>
    `tenants/${tenantId}/products/${productId}`,
  productFinancials: (tenantId: string) => `tenants/${tenantId}/productFinancials`,
  productFinancial: (tenantId: string, productId: string) =>
    `tenants/${tenantId}/productFinancials/${productId}`,
  categories: (tenantId: string) => `tenants/${tenantId}/categories`,
  category: (tenantId: string, categoryId: string) =>
    `tenants/${tenantId}/categories/${categoryId}`,
  customers: (tenantId: string) => `tenants/${tenantId}/customers`,
  customer: (tenantId: string, customerId: string) =>
    `tenants/${tenantId}/customers/${customerId}`,
  /**
   * ADR-0017 §2 — la conversación es POR CANAL, no por cliente. El `sessionKey` deriva del número
   * que RECIBIÓ el mensaje; sin él, el mismo cliente escribiéndole a dos números compartiría
   * carrito, `humanTakeover` y pedido pendiente entre ambos.
   *
   * EL PARÁMETRO ES OBLIGATORIO A PROPÓSITO. Mientras tuvo default (`'active'`), omitirlo era
   * indistinguible de elegir el canal heredado: el compilador no podía enumerar qué callsites
   * seguían pendientes de migrar y la auditoría tenía que contarlos a mano. Ahora cada llamador
   * NOMBRA su canal, y el que legítimamente habla del número heredado lo dice escribiendo
   * `LEGACY_SESSION_KEY` — que es una decisión visible en el diff, no una omisión.
   *
   * Las conversaciones que existen hoy viven en `active` y NO se migran.
   */
  session: (tenantId: string, customerId: string, sessionKey: string) =>
    `tenants/${tenantId}/customers/${customerId}/sessions/${sessionKey}`,
  messages: (tenantId: string, customerId: string) =>
    `tenants/${tenantId}/customers/${customerId}/messages`,
  message: (tenantId: string, customerId: string, messageId: string) =>
    `tenants/${tenantId}/customers/${customerId}/messages/${messageId}`,
  orders: (tenantId: string) => `tenants/${tenantId}/orders`,
  order: (tenantId: string, orderId: string) =>
    `tenants/${tenantId}/orders/${orderId}`,
  orderFinancials: (tenantId: string) => `tenants/${tenantId}/orderFinancials`,
  orderFinancial: (tenantId: string, orderId: string) =>
    `tenants/${tenantId}/orderFinancials/${orderId}`,
  statsPublic: (tenantId: string) => `tenants/${tenantId}/stats/public`,
  statsPrivate: (tenantId: string) => `tenants/${tenantId}/stats/private`,
  statsDaily: (tenantId: string) => `tenants/${tenantId}/statsDaily`,
  statsDailyDoc: (tenantId: string, date: string) => `tenants/${tenantId}/statsDaily/${date}`,
  platformStats: () => `platformStats/current`,
  promotions: (tenantId: string) => `tenants/${tenantId}/promotions`,
  promotion: (tenantId: string, id: string) => `tenants/${tenantId}/promotions/${id}`,
  insights: (tenantId: string) => `tenants/${tenantId}/insights`,
  insight: (tenantId: string, id: string) => `tenants/${tenantId}/insights/${id}`,
  followUpTasks: (tenantId: string) => `tenants/${tenantId}/followUpTasks`,
  followUpTask: (tenantId: string, id: string) => `tenants/${tenantId}/followUpTasks/${id}`,
  notifications: (tenantId: string) => `tenants/${tenantId}/notifications`,
  notification: (tenantId: string, id: string) => `tenants/${tenantId}/notifications/${id}`,
  agentAudits: (tenantId: string) => `tenants/${tenantId}/agentAudits`,
  agentAudit: (tenantId: string, id: string) => `tenants/${tenantId}/agentAudits/${id}`,
  winningReplies: (tenantId: string) => `tenants/${tenantId}/winningReplies`,
  winningReply: (tenantId: string, id: string) => `tenants/${tenantId}/winningReplies/${id}`,
  metaConnections: (tenantId: string) => `tenants/${tenantId}/metaConnections`,
  metaConnection: (tenantId: string, id: string) => `tenants/${tenantId}/metaConnections/${id}`,
  metaAssets: (tenantId: string) => `tenants/${tenantId}/metaAssets`,
  metaAsset: (tenantId: string, id: string) => `tenants/${tenantId}/metaAssets/${id}`,
  metaCampaigns: (tenantId: string) => `tenants/${tenantId}/metaCampaigns`,
  metaCampaign: (tenantId: string, id: string) => `tenants/${tenantId}/metaCampaigns/${id}`,
  metaAdsets: (tenantId: string) => `tenants/${tenantId}/metaAdsets`,
  metaAdset: (tenantId: string, id: string) => `tenants/${tenantId}/metaAdsets/${id}`,
  metaAds: (tenantId: string) => `tenants/${tenantId}/metaAds`,
  metaAd: (tenantId: string, id: string) => `tenants/${tenantId}/metaAds/${id}`,
  metaAdInsightsDaily: (tenantId: string) => `tenants/${tenantId}/metaAdInsightsDaily`,
  metaAdInsightDaily: (tenantId: string, id: string) => `tenants/${tenantId}/metaAdInsightsDaily/${id}`,
  metaCatalogSyncLogs: (tenantId: string) => `tenants/${tenantId}/metaCatalogSyncLogs`,
  metaCatalogSyncLog: (tenantId: string, id: string) => `tenants/${tenantId}/metaCatalogSyncLogs/${id}`,
  metaCatalogSyncRuns: (tenantId: string) => `tenants/${tenantId}/metaCatalogSyncRuns`,
  metaCatalogSyncRun: (tenantId: string, runId: string) => `tenants/${tenantId}/metaCatalogSyncRuns/${runId}`,
  /** Outbox de escrituras hacia el Meta Catalog (META-CATALOG-OUTBOX-1). Aislado por tenant. */
  metaCatalogOutboxJobs: (tenantId: string) => `tenants/${tenantId}/metaCatalogOutboxJobs`,
  metaCatalogOutboxJob: (tenantId: string, jobId: string) => `tenants/${tenantId}/metaCatalogOutboxJobs/${jobId}`,
  /**
   * Puntero por INTENCIÓN: deduplica el trabajo ACTIVO sin tocar la historia. Los jobs son
   * inmutables (uno por ciclo); esto es lo único que se reescribe.
   */
  metaCatalogOutboxIntent: (tenantId: string, intentKey: string) => `tenants/${tenantId}/metaCatalogOutboxIntents/${intentKey}`,
  /** Lock de unicidad del retailer_id dentro del tenant (reconciliación con Meta). */
  metaRetailerLock: (tenantId: string, key: string) => `tenants/${tenantId}/metaRetailerLocks/${key}`,
  /** Runs de importación paginada del catálogo (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1). */
  metaCatalogImportRuns: (tenantId: string) => `tenants/${tenantId}/metaCatalogImportRuns`,
  metaCatalogImportRun: (tenantId: string, runId: string) => `tenants/${tenantId}/metaCatalogImportRuns/${runId}`,
  /** Puntero del run ACTIVO por tenant (claim transaccional, patrón intent del outbox). */
  metaCatalogImportState: (tenantId: string) => `tenants/${tenantId}/metaCatalogImportState/current`,
  /** Corridas de mantenimiento: backfill de locks + quality (HARDEN-1, ADR-0014 §4c). */
  metaCatalogMaintenanceRuns: (tenantId: string) => `tenants/${tenantId}/metaCatalogMaintenanceRuns`,
  metaCatalogMaintenanceRun: (tenantId: string, runId: string) => `tenants/${tenantId}/metaCatalogMaintenanceRuns/${runId}`,
  /**
   * Detección de FUENTES EXTERNAS del catálogo (ADR-0015 §4). Guarda SOLO metadata saneada
   * (identificador, nombre saneado, host sin query, horario, columnas): jamás la URL firmada,
   * su query string, el token ni el archivo crudo. El id del check deriva de la huella.
   */
  metaCatalogSourceChecks: (tenantId: string) => `tenants/${tenantId}/metaCatalogSourceChecks`,
  metaCatalogSourceCheck: (tenantId: string, checkId: string) => `tenants/${tenantId}/metaCatalogSourceChecks/${checkId}`,
  /**
   * Corridas de RECONCILIACIÓN periódica del estado actual (ADR-0015 §6): barrido paginado
   * del catálogo remoto (solo GET) que actualiza `metaSyncState` de los productos mapeados.
   */
  metaCatalogVerificationRuns: (tenantId: string) => `tenants/${tenantId}/metaCatalogVerificationRuns`,
  metaCatalogVerificationRun: (tenantId: string, runId: string) => `tenants/${tenantId}/metaCatalogVerificationRuns/${runId}`,
  /**
   * Corridas de MIGRACIÓN de la propiedad por campos (ADR-0015 §9): preview/apply que declara
   * el modelo, reconoce la fuente externa y siembra el estado actual de los productos.
   */
  metaCatalogOwnershipRuns: (tenantId: string) => `tenants/${tenantId}/metaCatalogOwnershipRuns`,
  metaCatalogOwnershipRun: (tenantId: string, runId: string) => `tenants/${tenantId}/metaCatalogOwnershipRuns/${runId}`,
  /**
   * Runs de TRANSICIÓN de autoridad de catálogo (ADR-0022 §3): preview→apply owner-facing que
   * declara `catalogSync.relationship` (y la propiedad si cambia el modelo). Admin-SDK-only;
   * jamás contiene tokens, URLs firmadas ni PII — solo el plan saneado y su evidencia.
   */
  metaCatalogAuthorityRuns: (tenantId: string) => `tenants/${tenantId}/metaCatalogAuthorityRuns`,
  metaCatalogAuthorityRun: (tenantId: string, runId: string) => `tenants/${tenantId}/metaCatalogAuthorityRuns/${runId}`,
  trackingSources: (tenantId: string) => `tenants/${tenantId}/trackingSources`,
  trackingSource: (tenantId: string, id: string) => `tenants/${tenantId}/trackingSources/${id}`,
  businessEvents: (tenantId: string) => `tenants/${tenantId}/businessEvents`,
  businessEvent: (tenantId: string, id: string) => `tenants/${tenantId}/businessEvents/${id}`,
  metaConversionEvents: (tenantId: string) => `tenants/${tenantId}/metaConversionEvents`,
  metaConversionEvent: (tenantId: string, id: string) => `tenants/${tenantId}/metaConversionEvents/${id}`,
  orderItem: (tenantId: string, orderId: string, itemId: string) =>
    `tenants/${tenantId}/orders/${orderId}/items/${itemId}`,
  deliveries: (tenantId: string) => `tenants/${tenantId}/deliveries`,
  delivery: (tenantId: string, deliveryId: string) =>
    `tenants/${tenantId}/deliveries/${deliveryId}`,
  deliveryEvent: (tenantId: string, deliveryId: string, eventId: string) =>
    `tenants/${tenantId}/deliveries/${deliveryId}/events/${eventId}`,
  deliveryPersons: (tenantId: string) => `tenants/${tenantId}/deliveryPersons`,
  deliveryPerson: (tenantId: string, driverId: string) =>
    `tenants/${tenantId}/deliveryPersons/${driverId}`,
  payments: (tenantId: string) => `tenants/${tenantId}/payments`,
  payment: (tenantId: string, paymentId: string) =>
    `tenants/${tenantId}/payments/${paymentId}`,
  invoices: (tenantId: string) => `tenants/${tenantId}/invoices`,
  invoice: (tenantId: string, invoiceId: string) =>
    `tenants/${tenantId}/invoices/${invoiceId}`,
  subscriptions: (tenantId: string) => `tenants/${tenantId}/subscriptions`,
  subscription: (tenantId: string, subscriptionId: string) =>
    `tenants/${tenantId}/subscriptions/${subscriptionId}`,
  webhookEvents: (tenantId: string) => `tenants/${tenantId}/webhookEvents`,
  webhookEvent: (tenantId: string, eventId: string) =>
    `tenants/${tenantId}/webhookEvents/${eventId}`,
} as const;
