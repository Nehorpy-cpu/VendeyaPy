/**
 * Punto de entrada de Cloud Functions de VentaporWhatsapp.
 *
 * Cada función exportada se despliega como una function independiente.
 * El naming sigue {dominio}{Accion} en camelCase — ver ARCHITECTURE.md §3.3.
 *
 * Las funciones se agrupan por dominio en src/functions/ y se re-exportan
 * desde acá para que firebase-functions las detecte.
 */

import { initializeApp } from 'firebase-admin/app';

// Inicializar Firebase Admin una sola vez por instancia
initializeApp();

// ===== Webhooks externos =====
// export { whatsappWebhook } from './functions/whatsapp/whatsappWebhook.js';
// export { paymentBancardWebhook } from './functions/payments/paymentBancardWebhook.js';
// export { paymentStripeWebhook } from './functions/payments/paymentStripeWebhook.js';

// ===== API HTTP (panel admin) =====
// export { tenantCreate } from './functions/tenants/tenantCreate.js';
// export { tenantUpdate } from './functions/tenants/tenantUpdate.js';
// export { userProvision } from './functions/users/userProvision.js';
// export { productCreate } from './functions/products/productCreate.js';

// ===== Triggers (Firestore / Pub/Sub) =====
// export { onOrderCreated } from './functions/orders/onOrderCreated.js';
// export { onPaymentApproved } from './functions/payments/onPaymentApproved.js';

// ===== Endpoints internos (n8n → Functions) =====
// export { internalAssignDelivery } from './functions/internal/internalAssignDelivery.js';
// export { internalSendWhatsapp } from './functions/internal/internalSendWhatsapp.js';

// Health check (export estático — el emulador de Functions no soporta top-level await)
export { healthCheck } from './functions/healthCheck.js';

// Bot conversacional — endpoint de prueba (F4). El webhook real de WhatsApp (F1) usará el mismo motor.
export { devMessage } from './functions/conversation/devMessage.js';

// Confirmación de pago — endpoint de prueba (F6.2). El webhook real de la pasarela lo reemplaza.
export { devConfirmPayment } from './functions/payments/devConfirmPayment.js';

// Recepción de comprobante — endpoint de prueba (F6b.2). El webhook de WhatsApp (F1) lo reemplaza.
export { devSubmitComprobante } from './functions/payments/devSubmitComprobante.js';

// Webhook REAL de Stripe (Fase 3): verifica firma + idempotente + confirma la orden.
export { stripeWebhook } from './functions/payments/stripeWebhook.js';

// SaaS multiempresa (Fase 4): alta de empresa + gestión de usuarios + billing de plataforma.
export { provisionTenant } from './functions/tenants/provisionTenant.js';
export { inviteUser, setUserRole, setUserActive } from './functions/users/userManagement.js';

// Registro self-service + onboarding (Fase registro, R-1): el visitante crea su empresa y queda
// TENANT_OWNER (email verificado, anti multi-tenant, rol hardcodeado) + marca de onboarding completo.
export { registerTenantOwner } from './functions/tenants/registerTenantOwner.js';
export { completeOnboarding } from './functions/tenants/onboardingCallables.js';
export { platformBillingWebhook } from './functions/billing/platformBillingWebhook.js';

// Billing multi-proveedor (Fase 5B-ii): PayPal Subscriptions (webhook + callables owner/admin).
export { paypalBillingWebhook } from './functions/billing/paypalBillingWebhook.js';
export { createPayPalSubscriptionSession, syncPayPalSubscription } from './functions/billing/paypalCallables.js';

// Billing manual por WhatsApp (MB-2): solicitud (owner/admin) + activación (admin) + cancelación.
export { requestManualPlanActivation, manualBillingActivate, manualBillingCancelRequest } from './functions/billing/manualActivationCallables.js';

// Notificaciones internas del free trial (TRIAL-NOTIFICATIONS-1): admin job, sin envíos externos.
export { generateTrialNotifications } from './functions/trial/generateTrialNotifications.js';
// Scheduler diario (TN-3) que dispara el mismo core (09:00 America/Asuncion). Solo notificaciones internas.
export { trialNotificationsDaily } from './functions/scheduled/trialNotifications.js';

// Entitlements / límites / usage (Fase 5A): alta de producto con cuota (gate preparado para
// que el panel migre del write directo en 5C) + reinicio mensual proactivo del uso.
export { productUpsert } from './functions/products/productUpsert.js';
export { resetUsageMonthly } from './functions/scheduled/resetUsage.js';

// Scheduler diario (GROWTH-JOBS-SCHEDULER-1, 04:00 America/Asuncion) que refresca los jobs de growth
// SEGUROS (rule-based, sin IA) para tenants ACTIVE: computeTracking/generateWinningReplies/
// generateFollowups/generateAudits. Mismo core que el callable runTenantJob.
export { refreshGrowthJobsDaily } from './functions/scheduled/refreshGrowthJobs.js';

// Catálogo por callables (Fase 5C-B): baja por soft-archive + categorías. No cierra rules aún.
export { productDelete } from './functions/products/productDelete.js';
export { categoryUpsert, categoryDelete } from './functions/products/categoryCallables.js';

// Growth tools por callables (Fase 5C-C1): promociones + tracking propio (soft-delete, manager+).
export { promotionUpsert, promotionDelete } from './functions/growth/promotionCallables.js';
export { trackingSourceUpsert, trackingSourceDelete } from './functions/growth/trackingCallables.js';

// Growth tools (Fase 5C-C2): repartidores (cuota maxDeliveryPersons) + respuestas ganadoras
// (solo manual) + casos del simulador. Manager+. No cierra rules aún.
export { deliveryPersonUpsert, deliveryPersonDelete } from './functions/growth/deliveryCallables.js';
export { winningReplyUpsert, winningReplyDelete } from './functions/growth/winningReplyCallables.js';
export { agentTestCaseUpsert, agentTestCaseDelete, agentTestCaseRun } from './functions/growth/agentTestCaseCallables.js';

// Migración de escrituras críticas a callables (Fase 5C-A): config sensible del tenant
// (checkout/agente/canales) con gate owner/admin + validación + auditoría. No cierra rules aún.
export { checkoutConfigUpdate, agentConfigUpdate, channelConfigUpdate } from './functions/config/configCallables.js';

// Ciclo de vida de pedidos (ORDER-1): rules cierra el update directo; TODA mutación de orders
// va por estas callables auditadas que hacen cumplir la máquina de estados (orders/lifecycle.ts).
export { orderUpdate, orderCancel, orderUpdateStatus, adminOrderCorrect, orderGetComprobanteViewUrl } from './functions/orders/orderCallables.js';

// Observabilidad (Fase 5): bitácora de auditoría de cambios de catálogo.
export { onProductWriteAudit } from './functions/products/onProductWriteAudit.js';

// Capa de acciones del panel (Hardening F2): callables autenticados (rol+tenant) que
// reemplazan el uso de dev* desde el frontend. Los dev* quedan para emulador/staging.
export { runTenantJob, simulateAgentMessage } from './functions/panel/panelActions.js';

// Liberar chat (vendedor devuelve la conversación al bot) — endpoint de prueba (F6b).
export { devReleaseChat } from './functions/conversation/devReleaseChat.js';

// Tomar chat (vendedor pausa el bot) — endpoint de prueba (P5).
export { devTakeoverChat } from './functions/conversation/devTakeoverChat.js';

// Handoff desde el panel (callables con auth): tomar / devolver conversación (P5).
export { chatTakeover, chatRelease } from './functions/conversation/chatHandoff.js';

// Respuesta HUMANA del vendedor por WhatsApp desde el panel (HUMAN-HANDOFF-1).
export { conversationSendManualMessage } from './functions/conversation/manualMessage.js';

// Agregados para dashboards baratos (P7): trigger por pedido + recálculo manual.
export { onOrderWriteStats } from './functions/stats/onOrderWriteStats.js';
export { devRecomputeStats } from './functions/stats/devRecomputeStats.js';

// Sugerencias de promoción por reglas (P8): generación manual/job.
export { devGenerateSuggestions } from './functions/promotions/devGenerateSuggestions.js';

// Score y segmentación de clientes por reglas (P12): recálculo manual/job.
export { devRecomputeScores } from './functions/customers/devRecomputeScores.js';

// Centro de Decisiones (P13): genera "acciones de hoy" (promos + reactivación + sin responder).
export { devGenerateInsights } from './functions/decisions/devGenerateInsights.js';

// Follow-ups inteligentes (P14): tareas de seguimiento para el vendedor.
export { devGenerateFollowups } from './functions/followups/devGenerateFollowups.js';

// Auditoría del agente (P16): hallazgos por reglas sobre el historial + catálogo.
export { devGenerateAudits } from './functions/audits/devGenerateAudits.js';

// Respuestas ganadoras (P18): mina respuestas de chats que convirtieron.
export { devGenerateWinningReplies } from './functions/replies/devGenerateWinningReplies.js';

// Integración Meta (D1): conexión en modo demo (reemplaza OAuth real cuando se habilite).
export { devMetaConnect, devMetaDisconnect } from './functions/meta/devMeta.js';

// Conexión REAL de Meta por tenant (Fase 4B): callables autenticados (owner/admin) del
// Embedded Signup — nonce + intercambio de code + discovery + preflight. No cablea frontend.
export { startMetaConnect, connectMeta, verifyMetaChannel, selectMetaPhoneNumber, metaDisconnect } from './functions/meta/metaConnect.js';
// WM-1: alta MANUAL de WhatsApp por PLATFORM_ADMIN (reusa el mismo modelo; no toca Embedded Signup).
// MULTI-NUMBER-1: números adicionales por empresa (agregar/desactivar, solo PLATFORM_ADMIN).
export { adminSetManualWhatsappConnection, adminAddWhatsappNumber, adminDeactivateWhatsappNumber } from './functions/meta/manualWhatsappCallables.js';
// WM-2: solicitud de activación asistida (owner/admin) + cancelación. Solo metadatos, sin token.
export { requestWhatsappActivation, cancelWhatsappActivationRequest } from './functions/meta/whatsappActivationCallables.js';

// Webhooks + omnicanal (D2): endpoint de Meta (GET verify + POST) + trigger + simulador.
export { metaWebhook, devSimulateInbound } from './functions/meta/webhookHttp.js';
export { onWebhookInbox } from './functions/meta/onWebhookInbox.js';

// Meta Ads (D3): sincronización (modo demo) de campañas/anuncios + snapshots diarios.
export { devSyncMetaAds } from './functions/meta/devSyncMetaAds.js';

// Catálogo → Meta (D4): sincroniza el catálogo del panel al Meta Catalog (modo demo).
export { devSyncCatalogToMeta } from './functions/meta/devSyncCatalogToMeta.js';

// Atribución (D5): anuncio → pedido → ganancia real, por campaña.
export { devComputeAttribution } from './functions/meta/devComputeAttribution.js';

// businessEvents + Conversions API (D6): eventos del negocio → envío server-side a Meta.
export { devProcessConversions } from './functions/events/devProcessConversions.js';

// Tracking propio sin Meta (P11): atribución por código/cupón → rollup por fuente.
export { devComputeTracking } from './functions/tracking/devComputeTracking.js';

// Asistente interno de crecimiento (AG-4): callable owner/admin que consulta agregados PRIVADOS del
// propio tenant vía Claude Haiku (contexto internal, read-only). No cablea frontend.
export { askInternalGrowthAssistant } from './functions/ai/internalAssistantCallable.js';

// Revisión humana de cobertura (COVERAGE-1C): aprobar / rechazar / pedir más información.
// Decisión transaccional con outbox para la reanudación (1D). Owner/manager, o SELLER asignado.
export { coverageApprove, coverageReject, coverageRequestInfo } from './functions/coverage/coverageCallables.js';

// Reanudación del checkout tras la decisión (COVERAGE-1D): consumidor idempotente del outbox
// (orden única + instrucciones por el mismo número) + mantenimiento diario (expiración + purga
// de coordenadas a 30 días + recuperación de jobs retenidos/fallidos).
export { onCoverageResumeJob } from './functions/coverage/onCoverageResumeJob.js';
export { coverageMaintenanceDaily } from './functions/scheduled/coverageMaintenance.js';
export { devRunCoverageMaintenance } from './functions/coverage/devCoverageMaintenance.js';
