/**
 * orders/comprobanteImage.ts — Comprobante de pago por imagen de WhatsApp (ORDER-1B)
 * ===================================================================================
 * El cliente manda la FOTO de la transferencia → se asocia a su pedido pendiente:
 *   1. Resolver la orden: session.pendingOrderId → si no, la ÚNICA PENDING_PAYMENT del
 *      cliente. 0 pendientes o >1 (ambigüedad) → se PREGUNTA, nunca se adjunta a ciegas.
 *   2. Descargar el media de Graph con el token del tenant (límites tipo/tamaño). En
 *      EMULADOR nunca se llama a Graph: se usa un JPEG stub determinístico.
 *   3. Guardar en Storage: tenants/{t}/orders/{orderId}/comprobantes/{messageId}.{ext}
 *      (path sin datos personales; lectura solo staff por storage.rules; el doc de la
 *      orden guarda el PATH, nunca URLs firmadas).
 *   4. submitComprobante → PENDING_VERIFICATION + handoff + humanTakeover (el vendedor
 *      confirma DESPUÉS por callable ORDER-1). NUNCA se marca PAID automáticamente.
 *   5. Audit `order.comprobante_received` (metadata técnica, sin URLs ni PII extra).
 *
 * Si la descarga falla (token vencido, Graph caído), la orden IGUAL pasa a verificación
 * con el mediaId como referencia: el cliente ya avisó que pagó; el vendedor resuelve.
 * Mock/live NO afectan la recepción: solo la RESPUESTA sale por el cliente mock/real.
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { Order, Session } from '@vpw/shared';
import { db, paths, storage } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { appendMessage } from '../conversation/messages.js';
import { resolveTenantWhatsappCreds } from '../messaging/resolveWhatsappCreds.js';
import { downloadWhatsappMedia, extensionForMime, type MediaDownloadResult } from '../meta/mediaClient.js';
import { submitComprobante } from './submitComprobante.js';
import { recordAudit } from '../audit/audit.js';
import { UNPAID_STATUSES } from './lifecycle.js';

const isEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';

/** JPEG 1x1 válido para el stub del emulador (nunca se llama a Graph en tests). */
const STUB_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

export interface ComprobanteImageInput {
  tenantId: string;
  customerId: string; // solo dígitos (mismo id que usa el engine)
  from: string; // wa_id para responder
  messageId: string;
  image: { mediaId: string; mimeType?: string | null; caption?: string | null };
}

export interface ComprobanteImageResult {
  reply: string;
  attachedOrderId: string | null;
}

export interface ComprobanteDeps {
  getSession: (tenantId: string, customerId: string) => Promise<Session | null>;
  getOrder: (tenantId: string, orderId: string) => Promise<Order | null>;
  listCustomerOrders: (tenantId: string, customerId: string) => Promise<Order[]>;
  download: (tenantId: string, mediaId: string) => Promise<MediaDownloadResult>;
  saveImage: (path: string, buffer: Buffer, contentType: string) => Promise<void>;
  submit: typeof submitComprobante;
}

const defaultDeps: ComprobanteDeps = {
  getSession: async (t, c) => ((await db().doc(paths.session(t, c)).get()).data() as Session | undefined) ?? null,
  getOrder: async (t, o) => ((await db().doc(paths.order(t, o)).get()).data() as Order | undefined) ?? null,
  listCustomerOrders: async (t, c) => {
    // Solo igualdad por customerId (índice automático); el filtro de estado va en memoria
    // — un cliente tiene pocas órdenes y así no exigimos índice compuesto.
    const snap = await db().collection(paths.orders(t)).where('customerId', '==', c).get();
    return snap.docs.map((d) => d.data() as Order);
  },
  download: async (tenantId, mediaId) => {
    if (isEmulator()) return { ok: true, buffer: STUB_JPEG, mimeType: 'image/jpeg', bytes: STUB_JPEG.length };
    const creds = await resolveTenantWhatsappCreds(tenantId);
    if (!creds.ok) {
      logger.warn('comprobante: sin credenciales para descargar media', { tenantId, reason: creds.reason });
      return { ok: false, reason: 'fetch_failed' };
    }
    return downloadWhatsappMedia(mediaId, creds.accessToken);
  },
  saveImage: async (path, buffer, contentType) => {
    await storage().bucket().file(path).save(buffer, { contentType, resumable: false });
  },
  submit: submitComprobante,
};

const sanitizeId = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

/** Elige la orden destino. Pura sobre los datos ya cargados (unit-testeable vía deps). */
export function pickTargetOrder(pendingFromSession: Order | null, customerOrders: Order[]):
  | { kind: 'target'; order: Order }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number } {
  if (pendingFromSession && UNPAID_STATUSES.includes(pendingFromSession.status)) {
    return { kind: 'target', order: pendingFromSession };
  }
  const pendientes = customerOrders
    .filter((o) => o.status === 'PENDING_PAYMENT')
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
  if (pendientes.length === 0) return { kind: 'none' };
  if (pendientes.length > 1) return { kind: 'ambiguous', count: pendientes.length };
  return { kind: 'target', order: pendientes[0]! };
}

export async function processComprobanteImage(
  input: ComprobanteImageInput,
  deps: ComprobanteDeps = defaultDeps,
): Promise<ComprobanteImageResult> {
  const { tenantId, customerId, messageId, image } = input;
  const now = Timestamp.now();

  // Registrar la imagen entrante en la conversación (el panel la ve como evento).
  await appendMessage(tenantId, customerId, {
    direction: 'in',
    author: 'customer',
    text: image.caption?.trim() ? `📷 Comprobante: ${image.caption.trim()}` : '📷 Imagen recibida (posible comprobante)',
    now,
    channel: 'whatsapp',
  });

  // La respuesta se persiste acá (como hace handleMessage con las del bot); el caller la ENVÍA.
  const responder = async (reply: string, attachedOrderId: string | null): Promise<ComprobanteImageResult> => {
    await appendMessage(tenantId, customerId, { direction: 'out', author: 'bot', text: reply, channel: 'whatsapp' });
    return { reply, attachedOrderId };
  };

  // 1) Resolver la orden destino (sin adjuntar a ciegas).
  const session = await deps.getSession(tenantId, customerId);
  const pendingOrderId = session?.context?.pendingOrderId ?? null;
  const pendingFromSession = pendingOrderId ? await deps.getOrder(tenantId, pendingOrderId) : null;
  const picked = pickTargetOrder(pendingFromSession, await deps.listCustomerOrders(tenantId, customerId));

  if (picked.kind === 'none') {
    return responder(
      'Recibí tu imagen 🙂 pero no encuentro un pedido pendiente tuyo. Si querés comprar, ' +
        'escribí *catálogo* y armamos tu pedido; si ya pagaste algo, un asesor te contacta enseguida.',
      null,
    );
  }
  if (picked.kind === 'ambiguous') {
    logger.info('comprobante: cliente con múltiples pedidos pendientes, se pide aclaración', { tenantId, customerId, count: picked.count });
    return responder(
      'Recibí tu comprobante 🙌 pero tenés más de un pedido pendiente y no quiero confundirlos. ' +
        'Un asesor lo asigna enseguida — si podés, respondé con el total que pagaste.',
      null,
    );
  }
  const order = picked.order;

  // 2) Descargar el media (stub en emulador; límites tipo/tamaño en prod).
  const media = await deps.download(tenantId, image.mediaId);
  if (!media.ok && (media.reason === 'unsupported_type' || media.reason === 'too_large')) {
    return responder(
      media.reason === 'too_large'
        ? 'La imagen es demasiado pesada 😅 ¿Podés mandarla de nuevo en menor calidad?'
        : 'Ese formato no lo puedo leer 😅 ¿Podés mandar el comprobante como foto (JPG/PNG)?',
      null,
    );
  }

  // 3) Guardar en Storage (si la descarga falló, seguimos igual con el mediaId de referencia).
  let comprobanteRef = `media:${sanitizeId(image.mediaId)}`; // fallback: referencia al media de Meta
  let bytes = 0;
  let contentType = image.mimeType ?? 'image/jpeg';
  if (media.ok) {
    contentType = media.mimeType;
    bytes = media.bytes;
    const ext = extensionForMime(media.mimeType) ?? 'jpg';
    const path = `tenants/${tenantId}/orders/${order.id}/comprobantes/${sanitizeId(messageId)}.${ext}`;
    try {
      await deps.saveImage(path, media.buffer, media.mimeType);
      comprobanteRef = path;
    } catch (e) {
      logger.error('comprobante: no se pudo guardar en Storage (se sigue con referencia al media)', e, { tenantId, orderId: order.id });
    }
  }

  // 4) Orden → PENDING_VERIFICATION + handoff + humanTakeover. NUNCA PAID automático.
  const submitted = await deps.submit(tenantId, order.id, comprobanteRef);

  // 5) Audit técnico (sin URLs firmadas, sin PII extra).
  await recordAudit({
    tenantId,
    action: 'order.comprobante_received',
    targetType: 'order',
    targetId: order.id,
    summary: `Comprobante por imagen de WhatsApp (${media.ok ? 'guardado en Storage' : 'descarga pendiente'})`,
    metadata: { messageId: sanitizeId(messageId).slice(0, 60), contentType, bytes, stored: media.ok },
  });
  logger.info('Comprobante de imagen procesado', { tenantId, orderId: order.id, stored: media.ok, bytes });

  return responder(submitted.message, order.id);
}
