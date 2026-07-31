/**
 * orders/receiptCandidateNotification.ts — La promesa al cliente tiene que existir del otro lado
 * ===============================================================================================
 * (ADR-0016 §3 y §11) Cuando el gate propone un comprobante, al cliente se le responde «queda
 * cargado en tu pedido y un vendedor lo revisa para confirmarlo». Esa frase compromete a una
 * PERSONA. Sin ninguna señal en el panel, la sugerencia quedaba esperando a que alguien abriera la
 * conversación correcta por casualidad: el archivo existía, el vínculo existía, y nadie se
 * enteraba.
 *
 * Se reusa la campana que el panel YA tiene (`tenants/{t}/notifications`), con el mismo patrón de
 * idempotencia que `conversation/handoff.ts`: id determinístico, así un reintento del webhook no
 * puede duplicar el aviso. No se inventa una colección nueva ni un mecanismo paralelo.
 *
 * ESTE MÓDULO ES PURO A PROPÓSITO: solo arma el id y el documento. Quien lo ESCRIBE es la misma
 * transacción que crea el vínculo candidato (`orders/receiptStore.ts`), porque la promesa y la
 * señal son un solo hecho (ADR-0016 §11). Antes había acá un escritor best-effort que corría
 * después del commit: si fallaba, el candidato quedaba escrito, el mensaje salía igual y el
 * cliente esperaba a alguien que nunca fue notificado. Un aviso perdido que promete una persona es
 * peor que no prometer nada.
 *
 * LO QUE ESTE AVISO NO HACE, por contrato:
 *  · no mueve el pedido ni confirma un pago — sigue siendo una SUGERENCIA;
 *  · no hace handoff: el bot NO queda en pausa (eso es exactamente lo que el ADR vino a matar) y
 *    por eso el texto jamás dice que el asistente dejó de responder.
 *
 * HIGIENE: nunca el teléfono completo (solo los últimos 4 dígitos, como el aviso de handoff),
 * nunca el mediaId del proveedor, nunca una ruta de Storage ni una URL firmada. El `attachmentId`
 * sí: es opaco por construcción y es lo que hace idempotente al aviso.
 */
import { Timestamp } from 'firebase-admin/firestore';

/**
 * Tipo del aviso. Va como string y NO se suma todavía a `HandoffNotificationType` de `@vpw/shared`
 * a propósito: el panel mapea severidad con un `Record` EXHAUSTIVO sobre esa unión, así que
 * agregarlo sin tocar el panel rompería su compilación —y el panel es de otro frente—. Mientras
 * tanto el aviso se ve igual: la campana ordena con `SEVERITY[type] ?? 0` y el CTA lo resuelve la
 * CATEGORÍA (`handoff` → /conversations?c=…), que sí es conocida. Promoverlo a la unión compartida
 * es un cambio coordinado de dos líneas (ver el contrato del panel en el handoff del programa).
 */
export const RECEIPT_CANDIDATE_NOTIFICATION_TYPE = 'handoff_receipt_candidate';

/** Categoría EXISTENTE: es un aviso que necesita a una persona en Conversaciones. */
export const RECEIPT_CANDIDATE_NOTIFICATION_CATEGORY = 'handoff';

export interface ReceiptCandidateNotificationInput {
  tenantId: string;
  /** ES el teléfono ⇒ del cuerpo del aviso solo salen los últimos 4 dígitos. */
  customerId: string;
  orderId: string;
  attachmentId: string;
}

/** Id determinístico: un adjunto propuesto = un aviso, para siempre. */
export function receiptCandidateNotificationId(attachmentId: string): string {
  // El `attachmentId` ya tiene forma cerrada (`att_<24 hex>`), pero el saneo es barato y evita que
  // un id inesperado arme un path con `/` o `..`.
  return `receipt-candidate-${attachmentId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(-120)}`;
}

/**
 * Documento del aviso. PURO ⇒ testeable sin Firestore, y así el texto que ve el vendedor se puede
 * asertar (que no prometa un pago confirmado, que no diga que el bot se pausó).
 */
export function buildReceiptCandidateNotification(
  input: ReceiptCandidateNotificationInput,
  now: Timestamp,
): { id: string; data: Record<string, unknown> } {
  const id = receiptCandidateNotificationId(input.attachmentId);
  const cliente = `…${input.customerId.slice(-4)}`;
  return {
    id,
    data: {
      id,
      tenantId: input.tenantId,
      category: RECEIPT_CANDIDATE_NOTIFICATION_CATEGORY,
      type: RECEIPT_CANDIDATE_NOTIFICATION_TYPE,
      title: '🧾 Un comprobante quedó cargado y espera revisión',
      body:
        `El cliente ${cliente} envió un archivo que quedó cargado en su pedido como comprobante ` +
        'SUGERIDO. Todavía no lo confirmó nadie y el pedido no cambió de estado: revisalo desde ' +
        'Conversaciones y marcalo como comprobante si corresponde.',
      dedupeKey: id,
      // Lo usa el CTA de la campana para abrir LA conversación de ese cliente.
      customerId: input.customerId,
      read: false,
      readAt: null,
      createdAt: now,
    },
  };
}
