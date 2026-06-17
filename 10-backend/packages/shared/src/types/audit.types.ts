/**
 * Auditoría del agente (P16): hallazgos detectados por reglas sobre el historial
 * de conversaciones y el catálogo, para mejorar al bot. Sin IA.
 * Subcolección: tenants/{t}/agentAudits/{auditId}.
 */

import type { AuditIssueType, AuditStatus, InsightPriority } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface AgentAudit {
  id: string;
  tenantId: string;
  issueType: AuditIssueType;
  severity: InsightPriority;
  /** Conversación afectada (= customerId). null si es del catálogo. */
  conversationId: string | null;
  relatedEntityType: string | null; // 'conversation' | 'product'
  relatedEntityId: string | null;
  summary: string;
  recommendedFix: string;
  status: AuditStatus;
  createdAt: Timestamp;
  resolvedAt: Timestamp | null;
}
