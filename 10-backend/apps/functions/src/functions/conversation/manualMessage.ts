/**
 * conversationSendManualMessage — Callable del panel: respuesta HUMANA por WhatsApp (HUMAN-HANDOFF-1)
 * ===================================================================================================
 * El vendedor responde al cliente desde /conversations usando el MISMO número Cloud API que
 * recibió el chat. Autorización real acá (claims), nunca en el frontend. El núcleo (validación,
 * envío por número correcto, persistencia) vive en conversation/manualMessage.ts. Sin IA.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { sendManualMessage, MANUAL_MESSAGE_MAX_CHARS } from '../../conversation/manualMessage.js';
import { assertStaffAccess } from './staffAuth.js';
import { recordAudit } from '../../audit/audit.js';

interface ManualMessageData {
  tenantId?: string;
  customerId?: string;
  text?: string;
}

export const conversationSendManualMessage = onCall<ManualMessageData>(
  { region: 'us-central1' },
  async (req) => {
    const { tenantId, customerId, text } = req.data ?? {};
    if (!tenantId || !customerId || typeof text !== 'string') {
      throw new HttpsError('invalid-argument', 'Faltan tenantId, customerId o text.');
    }
    const actor = assertStaffAccess(req.auth, tenantId);

    const result = await sendManualMessage(
      { tenantId, customerId, text },
      { uid: actor.uid, role: actor.role, name: actor.name },
    );

    // Audit sin el texto completo (PII del cliente/negocio): solo un preview corto.
    const preview = text.trim().replace(/\s+/g, ' ').slice(0, 60);
    await recordAudit({
      tenantId,
      action: 'conversation.manual_message_sent',
      actorUid: actor.uid,
      targetType: 'customer',
      targetId: customerId,
      summary: `${actor.name ?? 'Staff'} respondió por WhatsApp${result.viaMock ? ' (mock)' : ''}: "${preview}${text.trim().length > 60 ? '…' : ''}"`,
    });
    return result;
  },
);

export { MANUAL_MESSAGE_MAX_CHARS };
