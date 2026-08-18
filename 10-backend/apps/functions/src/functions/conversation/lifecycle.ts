/**
 * Callables de CICLO DE VIDA de la conversación + marcar leído (ADR-0021 §3/§7)
 * ==============================================================================
 * Archivar/desarchivar (cualquier staff), eliminación lógica/restaurar (manager+) y marcado de
 * leído por apertura. Autorización real acá (claims vía staffAuth), la matriz de roles §7 la
 * re-verifica el núcleo (`conversation/lifecycle.ts`). Auditoría SOLO de acciones efectivas: un
 * no-op idempotente (archivar lo ya archivado) no re-escribe ni re-audita.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import {
  applyConversationLifecycle,
  markConversationReadExisting,
  type ConversationLifecycleAction,
} from '../../conversation/lifecycle.js';
import { db } from '../../lib/firebase.js';
import { assertStaffAccess } from './staffAuth.js';
import { recordAudit, type AuditAction } from '../../audit/audit.js';

interface LifecycleData {
  tenantId?: string;
  customerId?: string;
}

function readArgs(req: CallableRequest<LifecycleData>): { tenantId: string; customerId: string } {
  const { tenantId, customerId } = req.data ?? {};
  if (!tenantId || !customerId) {
    throw new HttpsError('invalid-argument', 'Faltan tenantId y customerId.');
  }
  return { tenantId, customerId };
}

const ACCIONES: Record<ConversationLifecycleAction, { audit: AuditAction; resumen: string }> = {
  archive: { audit: 'conversation.archived', resumen: 'archivó la conversación' },
  unarchive: { audit: 'conversation.unarchived', resumen: 'desarchivó la conversación' },
  softDelete: { audit: 'conversation.soft_deleted', resumen: 'eliminó (lógico) la conversación' },
  restore: { audit: 'conversation.restored', resumen: 'restauró la conversación' },
};

function lifecycleCallable(action: ConversationLifecycleAction) {
  return onCall<LifecycleData>({ region: 'us-central1' }, async (req) => {
    const { tenantId, customerId } = readArgs(req);
    const actor = assertStaffAccess(req.auth, tenantId);
    const result = await applyConversationLifecycle(db(), tenantId, customerId, action, {
      uid: actor.uid,
      role: actor.role,
      name: actor.name,
    });
    if (result.changed) {
      await recordAudit({
        tenantId,
        action: ACCIONES[action].audit,
        actorUid: actor.uid,
        targetType: 'customer',
        targetId: customerId,
        summary: `${actor.name ?? 'Staff'} ${ACCIONES[action].resumen}`,
      });
    }
    return { ok: true };
  });
}

export const conversationArchive = lifecycleCallable('archive');
export const conversationUnarchive = lifecycleCallable('unarchive');
export const conversationSoftDelete = lifecycleCallable('softDelete');
export const conversationRestore = lifecycleCallable('restore');

/**
 * Marcar leído al ABRIR la conversación (resetea `unreadForSeller`). Idempotente por naturaleza
 * (escribe 0) pero SOLO sobre clientes existentes: el `set(merge)` de messages.ts es para el
 * motor — expuesto acá dejaba crear docs stub `customers/{idArbitrario}` desde el navegador.
 * SIN audit deliberadamente: es un evento de lectura de bandeja —cada apertura de chat—, no una
 * acción de negocio; auditarlo enterraría la bitácora en ruido sin valor probatorio.
 */
export const conversationMarkRead = onCall<LifecycleData>({ region: 'us-central1' }, async (req) => {
  const { tenantId, customerId } = readArgs(req);
  assertStaffAccess(req.auth, tenantId);
  return markConversationReadExisting(db(), tenantId, customerId);
});
