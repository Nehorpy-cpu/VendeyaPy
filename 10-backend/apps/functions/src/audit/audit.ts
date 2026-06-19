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
  'tenant.suspended',
  'tenant.reactivated',
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
  'payment.confirmed',
  'chat.takeover',
  'chat.released',
  'meta.connected',
  'meta.disconnected',
  'entitlement.blocked',
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
