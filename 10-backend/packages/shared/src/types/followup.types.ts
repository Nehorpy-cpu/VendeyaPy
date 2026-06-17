/**
 * Tareas de seguimiento para el vendedor (P14). Generadas por reglas; el vendedor
 * las revisa y manda el mensaje sugerido A MANO (no se envía nada automático).
 * Subcolección: tenants/{t}/followUpTasks/{taskId}.
 */

import type { FollowUpType, FollowUpStatus, InsightPriority } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface FollowUpTask {
  id: string;
  tenantId: string;
  customerId: string;
  conversationId: string | null;
  /** Vendedor asignado (uid). null = sin asignar (lo ve cualquier vendedor). */
  sellerId: string | null;
  type: FollowUpType;
  title: string;
  /** Mensaje listo para copiar y enviar a mano. */
  suggestedMessage: string;
  priority: InsightPriority;
  status: FollowUpStatus;
  dueAt: Timestamp | null;
  createdAt: Timestamp;
  completedAt: Timestamp | null;
}
