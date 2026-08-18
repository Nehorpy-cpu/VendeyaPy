/**
 * conversationSendAttachment — Callable del panel: imagen/archivo HUMANO por WhatsApp (ADR-0021 §5)
 * =================================================================================================
 * El vendedor manda un adjunto desde /conversations por el MISMO número Cloud API que recibió el
 * chat. Autorización real acá (claims), nunca en el frontend. El núcleo (validación fail-closed,
 * idempotencia por operationId, guard compartido con el texto, subida a Meta, persistencia) vive
 * en conversation/sendAttachment.ts. Sin IA.
 *
 * Recursos: el payload viaja en base64 (documento ≤ 7 MB reales ≈ 9,4 MB de string) — el timeout
 * cubre subida a Meta + envío con margen (los pasos internos ya tienen timeouts propios: 30 s la
 * subida, 10 s el POST del mensaje) y la memoria cubre decode + multipart sin apretar el default.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { sendConversationAttachment, type SendAttachmentKind } from '../../conversation/sendAttachment.js';
import { assertStaffAccess } from './staffAuth.js';
import { recordAudit } from '../../audit/audit.js';

interface SendAttachmentData {
  tenantId?: string;
  customerId?: string;
  operationId?: string;
  kind?: SendAttachmentKind;
  filename?: string;
  mimeType?: string;
  dataBase64?: string;
  caption?: string;
}

export const conversationSendAttachment = onCall<SendAttachmentData>(
  { region: 'us-central1', timeoutSeconds: 120, memory: '512MiB' },
  async (req) => {
    const { tenantId, customerId, operationId, kind, filename, mimeType, dataBase64, caption } = req.data ?? {};
    if (
      !tenantId ||
      !customerId ||
      typeof operationId !== 'string' ||
      (kind !== 'image' && kind !== 'document') ||
      typeof filename !== 'string' ||
      typeof mimeType !== 'string' ||
      typeof dataBase64 !== 'string'
    ) {
      throw new HttpsError(
        'invalid-argument',
        'Faltan datos del adjunto (tenantId, customerId, operationId, kind, filename, mimeType, dataBase64).',
      );
    }
    const actor = assertStaffAccess(req.auth, tenantId);

    const result = await sendConversationAttachment(
      {
        tenantId,
        customerId,
        operationId,
        kind,
        filename,
        mimeType,
        dataBase64,
        ...(typeof caption === 'string' ? { caption } : {}),
      },
      { uid: actor.uid, role: actor.role, name: actor.name },
    );

    // Audit SIN nombre de archivo ni caption (texto libre del negocio): solo ids opacos.
    // Un replay idempotente no re-audita: el hecho ya quedó registrado la primera vez.
    if (!result.duplicate) {
      await recordAudit({
        tenantId,
        action: 'conversation.attachment_sent',
        actorUid: actor.uid,
        targetType: 'customer',
        targetId: customerId,
        summary: `${actor.name ?? 'Staff'} envió ${kind === 'image' ? 'una imagen' : 'un documento'} por WhatsApp${result.viaMock ? ' (mock)' : ''}`,
        metadata: { attachmentId: result.attachmentId, kind, viaMock: result.viaMock, operationId },
      });
    }
    return result;
  },
);
