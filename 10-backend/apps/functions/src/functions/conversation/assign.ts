/**
 * conversationAssign — Callable del panel: asignar/quitar vendedor (ADR-0021 §7)
 * ===============================================================================
 * Solo TENANT_MANAGER/TENANT_OWNER/PLATFORM_ADMIN (lo verifica el núcleo). `sellerUid: null`
 * limpia la asignación. El destino se valida FAIL-CLOSED contra `users/{uid}` (staff activo del
 * MISMO tenant). Asignar NUNCA toca `humanTakeover`: asignar ≠ tomar.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { assignConversationSeller } from '../../conversation/lifecycle.js';
import { db } from '../../lib/firebase.js';
import { assertStaffAccess } from './staffAuth.js';
import { recordAudit } from '../../audit/audit.js';

interface AssignData {
  tenantId?: string;
  customerId?: string;
  sellerUid?: string | null;
}

export const conversationAssign = onCall<AssignData>({ region: 'us-central1' }, async (req) => {
  const { tenantId, customerId, sellerUid } = req.data ?? {};
  // `sellerUid` es OBLIGATORIO y explícito (string no vacío o null): un undefined accidental no
  // puede significar "quitar la asignación".
  if (!tenantId || !customerId || (sellerUid !== null && (typeof sellerUid !== 'string' || sellerUid === ''))) {
    throw new HttpsError('invalid-argument', 'Faltan tenantId, customerId o sellerUid (string o null).');
  }
  const actor = assertStaffAccess(req.auth, tenantId);

  const result = await assignConversationSeller(db(), tenantId, customerId, sellerUid, {
    uid: actor.uid,
    role: actor.role,
    name: actor.name,
  });

  if (result.changed) {
    await recordAudit({
      tenantId,
      action: sellerUid !== null ? 'conversation.assigned' : 'conversation.unassigned',
      actorUid: actor.uid,
      targetType: 'customer',
      targetId: customerId,
      summary:
        sellerUid !== null
          ? `${actor.name ?? 'Staff'} asignó la conversación a ${result.sellerName ?? sellerUid}`
          : `${actor.name ?? 'Staff'} quitó la asignación de la conversación`,
      ...(sellerUid !== null ? { metadata: { sellerUid } } : {}),
    });
  }
  return { ok: true, ...(result.sellerName !== null ? { sellerName: result.sellerName } : {}) };
});
