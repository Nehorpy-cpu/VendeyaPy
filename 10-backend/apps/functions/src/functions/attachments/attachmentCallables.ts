/**
 * functions/attachments/attachmentCallables.ts — El pago SIEMPRE es humano (ADR-0016 §5)
 * ======================================================================================
 * Dos callables tenant-scoped sobre `tenants/{t}/attachments/{attachmentId}`:
 *
 *   - `attachmentMarkAsReceipt`  — una persona autorizada declara que ESE archivo es el
 *     comprobante de ESE pedido: valida tenant, valida que el pedido sea del MISMO cliente que
 *     mandó el archivo, valida estado admisible y que NO esté pagado, vincula, pasa el pedido a
 *     `PENDING_VERIFICATION` y audita. **NO confirma el pago**: eso sigue siendo
 *     `orderUpdateStatus` → `confirmPayment` (ORDER-1), con su propia decisión y auditoría.
 *   - `attachmentUnmarkReceipt` — deshace la marca. Solo si el pedido NO está pagado y si fue
 *     ESTA clasificación la que produjo el estado. El archivo se PRESERVA como `generic_media`.
 *
 * Autorización: `TENANT_OWNER`, `TENANT_MANAGER` y `SELLER` de SU empresa (roles reales del
 * sistema). `TENANT_VIEWER` no —es solo lectura— y `PLATFORM_ADMIN` tampoco: el soporte de
 * plataforma no decide qué es un comprobante de un negocio ajeno (mismo criterio que la revisión
 * de cobertura). El `tenantId` SIEMPRE sale de los claims; el que manda el frontend solo puede
 * coincidir.
 *
 * Higiene de datos: nunca se loguea el teléfono (el `customerId` ES el teléfono), ni rutas de
 * Storage, ni URLs firmadas. El `attachmentId` sí: es opaco por construcción.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { isAttachmentId } from '@vpw/shared';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../audit/audit.js';
import {
  markAttachmentAsReceipt,
  unmarkAttachmentReceipt,
  type ReceiptStoreDenyReason,
} from '../../orders/receiptStore.js';

const REGION = 'us-central1';

/** Roles que pueden decidir sobre un comprobante (ADR-0016 §5). */
const RECEIPT_ROLES = ['TENANT_OWNER', 'TENANT_MANAGER', 'SELLER'] as const;
type ReceiptRole = (typeof RECEIPT_ROLES)[number];

interface ReceiptActor {
  uid: string;
  role: ReceiptRole;
  tenantId: string;
}

/**
 * Gate de rol + tenant. PURO respecto de Firestore ⇒ unit-testeable.
 * Cross-tenant imposible por construcción: el tenant sale de los claims.
 */
export function assertReceiptActor(
  auth: CallableRequest<unknown>['auth'] | undefined | null,
  requestedTenantId?: string,
): ReceiptActor {
  if (!auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const token = (auth.token ?? {}) as { role?: string; tenantId?: string };
  const role = token.role ?? '';
  if (role === 'PLATFORM_ADMIN') {
    throw new HttpsError(
      'permission-denied',
      'El soporte de plataforma no decide qué es un comprobante: lo hace el equipo del negocio.',
    );
  }
  if (!(RECEIPT_ROLES as readonly string[]).includes(role)) {
    throw new HttpsError('permission-denied', 'Tu rol no puede marcar comprobantes.');
  }
  if (!token.tenantId) throw new HttpsError('permission-denied', 'Tu usuario no tiene una empresa asignada.');
  if (requestedTenantId !== undefined && requestedTenantId !== token.tenantId) {
    throw new HttpsError('permission-denied', 'No tenés acceso a esta empresa.');
  }
  return { uid: auth.uid, role: role as ReceiptRole, tenantId: token.tenantId };
}

/** Validación de entrada. El `attachmentId` tiene forma cerrada (`att_<24 hex>`). */
export function validarEntrada(data: { attachmentId?: unknown; orderId?: unknown } | undefined): {
  attachmentId: string;
  orderId: string;
} {
  const attachmentId = typeof data?.attachmentId === 'string' ? data.attachmentId.trim() : '';
  if (!isAttachmentId(attachmentId)) throw new HttpsError('invalid-argument', 'Adjunto inválido.');
  const orderId = typeof data?.orderId === 'string' ? data.orderId.trim() : '';
  // Se valida forma de SEGMENTO (sin `/`, sin `..`), no el prefijo: hay pedidos de dev/test que
  // no siguen el formato `ord_` y bloquearlos rompería el panel sin ganar seguridad.
  if (!orderId || orderId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(orderId) || orderId.includes('..')) {
    throw new HttpsError('invalid-argument', 'Pedido inválido.');
  }
  return { attachmentId, orderId };
}

/**
 * Mensaje para el vendedor a partir del motivo. Cerrado a propósito: el motivo es un código
 * interno y nunca se devuelve crudo (no filtra estructura ni datos de otros clientes).
 */
export function mensajeDeMotivo(reason: ReceiptStoreDenyReason): { code: 'not-found' | 'failed-precondition'; message: string } {
  switch (reason) {
    case 'receipt_gate_disabled':
      // Nivel B del rollout apagado para este tenant (ADR-0016 §10). No es un error del vendedor
      // ni algo que se arregle reintentando: hay que encenderlo. Y se aclara que desmarcar sigue
      // disponible, porque es lo primero que va a intentar quien ve este mensaje.
      return {
        code: 'failed-precondition',
        message:
          'La marcación de comprobantes no está habilitada para tu empresa. Pedile al responsable ' +
          'de la cuenta que la active. Desmarcar comprobantes sigue disponible.',
      };
    case 'attachment_not_found':
    case 'tenant_mismatch':
      return { code: 'not-found', message: 'El archivo no existe en esta empresa.' };
    case 'order_not_found':
      return { code: 'not-found', message: 'El pedido no existe.' };
    case 'order_customer_mismatch':
      return { code: 'failed-precondition', message: 'Ese pedido es de otro cliente: el archivo no puede vincularse.' };
    case 'order_already_paid':
      return { code: 'failed-precondition', message: 'El pedido ya está pagado: no se puede cambiar su comprobante.' };
    case 'order_not_admissible':
      return { code: 'failed-precondition', message: 'El estado del pedido no admite esta acción.' };
    case 'linked_to_another_order':
      return { code: 'failed-precondition', message: 'Ese archivo ya está vinculado a otro pedido.' };
    case 'attachment_not_stored':
      return { code: 'failed-precondition', message: 'El archivo todavía no está disponible: probá de nuevo en un momento.' };
    case 'attachment_purged':
      // Distinto de "todavía no está": acá los bytes se borraron por la política de retención y
      // no vuelven. Decir "probá de nuevo" mandaría al vendedor a reintentar para siempre.
      return {
        code: 'failed-precondition',
        message: 'Los archivos de este adjunto ya se borraron por la política de retención: no puede vincularse como comprobante.',
      };
    case 'not_linked':
      return { code: 'failed-precondition', message: 'Ese archivo no está marcado como comprobante de este pedido.' };
    case 'other_evidence_drives_status':
      // Honesto sobre lo ÚNICO que este motivo significa hoy: hay OTRO adjunto declarado como
      // origen del estado. El caso "no hay origen declarado" (puntero nulo del flujo legacy) ya
      // no llega acá — se desmarca sin tocar el estado del pedido.
      return {
        code: 'failed-precondition',
        message: 'Otro comprobante figura como origen del estado de este pedido: revisalo primero.',
      };
    case 'classification_terminal':
    case 'illegal_classification_transition':
      return { code: 'failed-precondition', message: 'El archivo no admite esta clasificación.' };
    default:
      return { code: 'failed-precondition', message: 'No se pudo aplicar la acción sobre este archivo.' };
  }
}

// ---------------------------------------------------------------------------

interface ReceiptInput {
  tenantId?: string;
  attachmentId?: string;
  orderId?: string;
}

/** Marca un adjunto como comprobante del pedido. Llega hasta PENDING_VERIFICATION, JAMÁS a PAID. */
export const attachmentMarkAsReceipt = onCall<ReceiptInput>({ region: REGION }, async (req) => {
  const actor = assertReceiptActor(req.auth, req.data?.tenantId);
  const { attachmentId, orderId } = validarEntrada(req.data);

  const res = await markAttachmentAsReceipt(actor.tenantId, { attachmentId, orderId, actorUid: actor.uid });
  if (!res.ok) {
    const { code, message } = mensajeDeMotivo(res.reason);
    logger.info('Comprobante: marcado rechazado', { tenantId: actor.tenantId, orderId, attachmentId, reason: res.reason });
    throw new HttpsError(code, message);
  }
  if (!res.alreadyMarked) {
    await recordAudit({
      tenantId: actor.tenantId,
      action: 'order.receipt_marked',
      actorUid: actor.uid,
      actorRole: actor.role,
      targetType: 'order',
      targetId: orderId,
      summary: `Adjunto marcado como comprobante por ${actor.role} (pedido → ${res.status})`,
      metadata: { attachmentId, status: res.status, paymentConfirmed: false },
    });
  }
  logger.info('Comprobante: adjunto marcado', { tenantId: actor.tenantId, orderId, attachmentId, status: res.status });
  return { ok: true, status: res.status, alreadyMarked: res.alreadyMarked };
});

/** Desmarca un adjunto. Preserva el archivo como medio normal y deja auditoría. */
export const attachmentUnmarkReceipt = onCall<ReceiptInput>({ region: REGION }, async (req) => {
  const actor = assertReceiptActor(req.auth, req.data?.tenantId);
  const { attachmentId, orderId } = validarEntrada(req.data);

  const res = await unmarkAttachmentReceipt(actor.tenantId, { attachmentId, orderId, actorUid: actor.uid });
  if (!res.ok) {
    const { code, message } = mensajeDeMotivo(res.reason);
    logger.info('Comprobante: desmarcado rechazado', { tenantId: actor.tenantId, orderId, attachmentId, reason: res.reason });
    throw new HttpsError(code, message);
  }
  await recordAudit({
    tenantId: actor.tenantId,
    action: 'order.receipt_unmarked',
    actorUid: actor.uid,
    actorRole: actor.role,
    targetType: 'order',
    targetId: orderId,
    summary: `Comprobante desmarcado por ${actor.role} (pedido → ${res.status})`,
    metadata: { attachmentId, status: res.status, reverted: res.reverted },
  });
  logger.info('Comprobante: adjunto desmarcado', { tenantId: actor.tenantId, orderId, attachmentId, status: res.status });
  return { ok: true, status: res.status, reverted: res.reverted };
});
