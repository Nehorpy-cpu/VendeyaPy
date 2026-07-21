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
  'meta.disconnected',
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
