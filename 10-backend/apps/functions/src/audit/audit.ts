/**
 * audit/audit.ts — Bitácora de auditoría del sistema (Fase 5)
 * ===========================================================
 * Registra acciones sensibles para trazabilidad/compliance en
 * tenants/{tenantId}/auditLogs/{id}. Best-effort: nunca rompe el flujo de negocio.
 * Lo leen manager+ (reglas Firestore); lo escribe SOLO Cloud Functions (Admin SDK).
 */
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

export const AUDIT_ACTIONS = [
  'tenant.provisioned',
  'tenant.self_provisioned',
  'tenant.suspended',
  'tenant.reactivated',
  'onboarding.completed',
  'user.invited',
  'user.role_changed',
  'user.deactivated',
  'user.activated',
  'product.created',
  'product.updated',
  'product.deleted',
  'product.archived',
  'category.created',
  'category.updated',
  'category.deleted',
  'promotion.created',
  'promotion.updated',
  'promotion.finished',
  'trackingSource.created',
  'trackingSource.updated',
  'trackingSource.deactivated',
  'deliveryPerson.created',
  'deliveryPerson.updated',
  'deliveryPerson.deactivated',
  'winningReply.created',
  'winningReply.updated',
  'winningReply.archived',
  'agentTestCase.created',
  'agentTestCase.updated',
  'agentTestCase.deleted',
  'agentTestCase.run',
  'payment.confirmed',
  'order.updated',
  'order.cancelled',
  'order.status_changed',
  'order.payment_confirmed_manual',
  'order.admin_corrected',
  'order.comprobante_received',
  // WHATSAPP-MEDIA-SAFE-FOUNDATION-1 (ADR-0016 §5): decisión HUMANA sobre un adjunto. Marcar
  // lleva el pedido a PENDING_VERIFICATION y NO confirma el pago; desmarcar preserva el archivo
  // como medio normal. Sin estas entradas no quedaría constancia de quién declaró qué es un
  // comprobante.
  'order.receipt_marked',
  'order.receipt_unmarked',
  // ADR-0016 §6: cada emisión de una URL temporal sobre un archivo de cliente (adjunto nuevo o
  // comprobante legacy). Sin la URL, sin el path: quién, sobre qué y hasta cuándo.
  'attachment.view_url_issued',
  // ADR-0016 §D: corrida de la purga de retención. Borrar bytes de clientes es irreversible, así
  // que queda constancia aunque el saldo del día sea cero.
  'attachment.retention_purged',
  'meta.number_added',
  'meta.number_deactivated',
  'billing.activation_requested',
  'billing.activation_approved',
  'billing.activation_cancelled',
  'chat.takeover',
  'coverage.approved',
  'coverage.rejected',
  'coverage.info_requested',
  'coverage.resume_cancelled',
  // SHIPPING-CHAT-3C: saga de cotización de envío.
  'coverage.quote_approved',
  'coverage.quote_unknown_resolved',
  'coverage.quote_job_cancelled',
  'chat.released',
  'conversation.manual_message_sent',
  'conversation.returned_to_bot',
  'meta.connected',
  'meta.connected_manual',
  // META-ONBOARDING-SELF-SERVICE-1 (ADR-0020, G7): el lifecycle owner-facing completo deja rastro.
  // `meta.verified` = quién verificó qué canal y con qué veredicto (razón saneada, sin tokens);
  // `meta.reconnected` = un reemplazo sobre una conexión que ESTABA activa — no es un alta.
  'meta.verified',
  'meta.reconnected',
  'meta.disconnected',
  // META-CATALOG-LIVE-1: cada corrida de sync de catálogo (dry_run o apply) con su runId.
  'meta.catalog_sync',
  // META-CATALOG-RECONCILIATION-1: reconciliación con un catálogo de Meta preexistente.
  'meta.catalog_mapping_confirmed',
  'meta.catalog_items_imported',
  'meta.catalog_sync_enabled',
  'meta.catalog_sync_disabled',
  // META-CATALOG-GENERIC-ONBOARDING-QUALITY-1: cada invocación del run de importación
  // paginada (contadores + estado + motivo de corte).
  'meta.catalog_import_run',
  // HARDEN-1 (ADR-0014 §4c): cada invocación del mantenimiento de catálogo
  // (preview/apply de backfill de locks + quality, con contadores y conflictos).
  'meta.catalog_maintenance_run',
  // META-CATALOG-OWNERSHIP-MODEL-1 (ADR-0015 §9): cada invocación de la migración de propiedad
  // por campos (preview/apply). El apply es el acto HUMANO que reconoce la fuente externa: sin
  // esta entrada no quedaría constancia de quién declaró quién gobierna el catálogo.
  'meta.catalog_ownership_migration_run',
  // ADR-0015 §6: cada invocación de la reconciliación periódica del estado actual (solo
  // lee Meta y actualiza metaSyncState/metaDrift; jamás escribe en Meta ni borra nada).
  'meta.catalog_verification_run',
  'whatsapp.activation_requested',
  'whatsapp.activation_completed',
  'whatsapp.activation_cancelled',
  'entitlement.blocked',
  'trial.notification_created',
  'checkout.updated',
  'agentConfig.updated',
  'channelConfig.updated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  tenantId: string;
  action: AuditAction;
  actorUid?: string | null;
  actorRole?: string | null;
  targetType?: string;
  targetId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

/** Registra una entrada de auditoría. Best-effort (loguea y sigue si falla). */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    const ref = db().collection(`tenants/${entry.tenantId}/auditLogs`).doc();
    await ref.set({
      id: ref.id,
      tenantId: entry.tenantId,
      action: entry.action,
      actorUid: entry.actorUid ?? null,
      actorRole: entry.actorRole ?? null,
      targetType: entry.targetType ?? '',
      targetId: entry.targetId ?? '',
      summary: entry.summary,
      metadata: entry.metadata ?? {},
      at: Timestamp.now(),
    });
  } catch (e) {
    logger.error('No se pudo registrar audit log', e, { tenantId: entry.tenantId, action: entry.action });
  }
}
