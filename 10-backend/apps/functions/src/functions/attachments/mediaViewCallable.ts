/**
 * functions/attachments/mediaViewCallable.ts — Enlace temporal a un archivo (ADR-0016 §6/§7)
 * ===========================================================================================
 * `attachmentGetViewUrl` es la ÚNICA puerta por la que salen los bytes de un archivo de cliente:
 * `storage.rules` deniega la lectura directa de `tenants/{t}/attachments/**`.
 *
 * El input admite exactamente UNA de dos referencias —`attachmentId` (adjunto nuevo) u `orderId`
 * (comprobante legacy)— y JAMÁS un path: la ruta se resuelve del lado del servidor contra el
 * registro del tenant. Todo lo demás vive en `attachments/mediaUrlIssuer.ts` (whitelist de path,
 * MIME verificado, Content-Disposition) y en `attachments/viewerAuth.ts` (roles).
 *
 * Lo que NO se loguea ni se audita nunca: la URL firmada, el path, el teléfono del cliente.
 * El `attachmentId` sí: es un hash opaco por diseño y sin él la auditoría no serviría para nada.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import {
  defaultAttachmentViewDeps,
  issueAttachmentViewUrl,
  type AttachmentViewRequest,
} from '../../attachments/mediaUrlIssuer.js';
import { resolveAttachmentViewerAuth } from '../../attachments/viewerAuth.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';

export interface AttachmentViewUrlInput {
  tenantId?: string;
  attachmentId?: string;
  orderId?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Resuelve QUÉ se pide. Exigir exactamente una referencia evita el caso ambiguo en el que el
 * cliente manda las dos y el servidor elige por orden de los `if`.
 */
export function parseAttachmentViewRequest(
  input: AttachmentViewUrlInput | undefined,
): { ok: true; request: AttachmentViewRequest } | { ok: false; message: string } {
  const attachmentId = str(input?.attachmentId);
  const orderId = str(input?.orderId);
  if (attachmentId && orderId) {
    return { ok: false, message: 'Indicá un adjunto o un pedido, no ambos.' };
  }
  if (attachmentId) return { ok: true, request: { kind: 'attachment', attachmentId } };
  if (orderId) return { ok: true, request: { kind: 'legacy_comprobante', orderId } };
  return { ok: false, message: 'Falta la referencia del archivo (attachmentId u orderId).' };
}

export const attachmentGetViewUrl = onCall<AttachmentViewUrlInput>(
  { region: 'us-central1' },
  async (req: CallableRequest<AttachmentViewUrlInput>) => {
    // `req.auth` ausente ⇒ anónimo. El resolver devuelve 'unauthenticated' y acá se corta antes
    // de tocar Firestore o Storage.
    const auth = resolveAttachmentViewerAuth(
      req.auth ? (req.auth.token as { role?: string; tenantId?: string }) : null,
      req.data?.tenantId,
    );
    if (!auth.ok) throw new HttpsError(auth.code, auth.message);

    const parsed = parseAttachmentViewRequest(req.data);
    if (!parsed.ok) throw new HttpsError('invalid-argument', parsed.message);

    const result = await issueAttachmentViewUrl(auth.tenantId, parsed.request, defaultAttachmentViewDeps);
    if (!result.ok) {
      logger.warn('Adjunto: emisión de enlace denegada', {
        tenantId: auth.tenantId,
        role: auth.role,
        kind: parsed.request.kind,
        code: result.code,
      });
      throw new HttpsError(result.code, result.message);
    }

    const targetId =
      parsed.request.kind === 'attachment' ? parsed.request.attachmentId : parsed.request.orderId;
    // Cada emisión deja rastro: quién, sobre qué y con qué vencimiento. Sin URL y sin path.
    await recordAudit({
      tenantId: auth.tenantId,
      action: 'attachment.view_url_issued',
      actorUid: req.auth?.uid ?? null,
      actorRole: auth.role,
      targetType: parsed.request.kind === 'attachment' ? 'attachment' : 'order',
      targetId,
      summary: `Enlace temporal emitido (${result.family})`,
      metadata: {
        family: result.family,
        contentType: result.contentType,
        disposition: result.disposition,
        expiresAtMs: result.expiresAtMs,
      },
    });
    logger.info('Adjunto: enlace temporal emitido', {
      tenantId: auth.tenantId,
      role: auth.role,
      family: result.family,
      expiresAtMs: result.expiresAtMs,
    });

    return {
      ok: true,
      url: result.url,
      expiresAt: result.expiresAtMs,
      contentType: result.contentType,
      disposition: result.disposition,
    };
  },
);
