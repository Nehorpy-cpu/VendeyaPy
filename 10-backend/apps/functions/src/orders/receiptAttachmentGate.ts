/**
 * orders/receiptAttachmentGate.ts — El gate REAL enchufado a la ingesta (ADR-0016 §4)
 * ====================================================================================
 * `meta/attachmentGate.ts` deja una costura: la ingesta guarda el archivo y después pregunta
 * "¿esto significa algo?". Quien sabe responder es el lado de PEDIDOS —contexto de pago, cliente,
 * ventana, ambigüedad—, así que la implementación vive acá y el webhook nunca importa `orders/`.
 *
 * Qué hace, en orden: arma los hechos → corre las reglas PURAS de `receiptGate.ts` → si (y solo
 * si) pasan todas, persiste el vínculo CANDIDATO de forma transaccional. Si alguna falla, el
 * archivo queda como MEDIO NORMAL: se conserva, se ve en el chat y el pedido no se toca.
 *
 * Lo que este gate NO hace, por contrato:
 *   · no mueve el estado del pedido (ni a `PENDING_VERIFICATION` ni mucho menos a `PAID`);
 *   · no confirma pagos ni deriva a un humano por su cuenta;
 *   · no manda el archivo ni el caption a ningún modelo de IA (ADR-0016 §9).
 * Proponer un candidato es una SUGERENCIA visible; vincularlo de verdad es la callable
 * `attachmentMarkAsReceipt`, que exige una persona autorizada.
 */
import type { Order, Session } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { genericMediaGate, setAttachmentGate, type AttachmentGate } from '../meta/attachmentGate.js';
import {
  esperaComprobanteDeclarada,
  evaluateReceiptGate,
  type ReceiptGateConfig,
  type ReceiptGateOrderFacts,
} from './receiptGate.js';
import {
  getReceiptGateConfig,
  linkReceiptCandidate,
  readOrderReceiptAttachments,
  toReceiptAttachmentFacts,
  type ReceiptCandidateResult,
} from './receiptStore.js';
import {
  notifyReceiptCandidate,
  type ReceiptCandidateNotificationInput,
} from './receiptCandidateNotification.js';

/**
 * Mensaje al cliente cuando el archivo QUEDA PROPUESTO como comprobante. Deliberadamente no
 * afirma que el pago está confirmado ni que el pedido cambió: todavía no pasó ninguna de las dos.
 */
export const MENSAJE_COMPROBANTE_PROPUESTO =
  'Recibí tu comprobante 🙌 Queda cargado en tu pedido y un vendedor lo revisa para confirmarlo. ' +
  'Te avisamos por acá.';

export interface ReceiptAttachmentGateDeps {
  getSession: (tenantId: string, customerId: string) => Promise<Session | null>;
  getOrder: (tenantId: string, orderId: string) => Promise<Order | null>;
  listCustomerOrders: (tenantId: string, customerId: string) => Promise<Order[]>;
  getConfig: (tenantId: string) => Promise<ReceiptGateConfig>;
  link: (
    tenantId: string,
    input: { attachmentId: string; orderId: string; config?: ReceiptGateConfig },
  ) => Promise<ReceiptCandidateResult>;
  /** Degradar a medio normal. Se delega al gate por defecto: una sola implementación. */
  markGenericMedia: AttachmentGate;
  /**
   * Señal operativa del candidato (campana del panel). Es lo que sostiene la promesa que el
   * mensaje al cliente hace en su nombre: «un vendedor lo revisa». Best-effort e idempotente.
   */
  notifyCandidate: (input: ReceiptCandidateNotificationInput) => Promise<boolean>;
  nowMs: () => number;
}

export const defaultReceiptAttachmentGateDeps: ReceiptAttachmentGateDeps = {
  getSession: async (t, c) => ((await db().doc(paths.session(t, c)).get()).data() as Session | undefined) ?? null,
  getOrder: async (t, o) => ((await db().doc(paths.order(t, o)).get()).data() as Order | undefined) ?? null,
  listCustomerOrders: async (t, c) => {
    // Solo igualdad por customerId (índice automático); el filtro de estado va en memoria — un
    // cliente tiene pocas órdenes y así no exigimos un índice compuesto.
    const snap = await db().collection(paths.orders(t)).where('customerId', '==', c).get();
    return snap.docs.map((d) => d.data() as Order);
  },
  getConfig: getReceiptGateConfig,
  link: (tenantId, input) => linkReceiptCandidate(tenantId, input),
  markGenericMedia: genericMediaGate,
  notifyCandidate: (input) => notifyReceiptCandidate(input),
  nowMs: () => Date.now(),
};

export function crearReceiptAttachmentGate(
  deps: ReceiptAttachmentGateDeps = defaultReceiptAttachmentGateDeps,
): AttachmentGate {
  return async (input) => {
    const { tenantId, customerId, attachment } = input;

    const session = await deps.getSession(tenantId, customerId);
    const pendingOrderId = session?.context?.pendingOrderId ?? null;
    // El puntero de la sesión se resuelve pero NO se cree: el gate valida su `customerId`.
    const pendingOrder = pendingOrderId ? await deps.getOrder(tenantId, pendingOrderId) : null;
    const customerOrders = await deps.listCustomerOrders(tenantId, customerId);
    const config = await deps.getConfig(tenantId);

    const porId = new Map<string, Order>();
    for (const o of [...(pendingOrder ? [pendingOrder] : []), ...customerOrders]) porId.set(o.id, o);
    const candidateOrders: ReceiptGateOrderFacts[] = [...porId.values()].map((o) => ({
      orderId: o.id,
      customerId: o.customerId,
      status: o.status,
      createdAtMs: o.createdAt?.toMillis?.() ?? 0,
      linkedAttachmentIds: (() => {
        const r = readOrderReceiptAttachments(o);
        return [...r.candidateIds, ...r.linkedIds];
      })(),
    }));

    const decision = evaluateReceiptGate({
      tenantId,
      customerId,
      nowMs: deps.nowMs(),
      attachment: toReceiptAttachmentFacts(attachment),
      session: { awaitingPaymentDeclared: esperaComprobanteDeclarada(session), pendingOrderId },
      candidateOrders,
      config,
    });

    if (!decision.ok) {
      // Sin `customerId` en el log: ES el teléfono. El motivo es un código cerrado.
      logger.info('receiptGate: el adjunto queda como medio normal', {
        tenantId,
        attachmentId: attachment.attachmentId,
        reason: decision.reason,
      });
      return deps.markGenericMedia(input);
    }

    // Idempotencia: ya estaba propuesto ⇒ no se re-escribe ni se repite el mensaje al cliente.
    if (decision.alreadyLinked) {
      return { reply: '', classification: 'payment_receipt_candidate', orderCandidateId: decision.orderId };
    }

    const link = await deps.link(tenantId, { attachmentId: attachment.attachmentId, orderId: decision.orderId, config });
    if (!link.ok) {
      // El pedido cambió entre la evaluación y la transacción (se pagó, se canceló). Degradar es
      // siempre seguro: nunca fabrica evidencia de pago.
      logger.info('receiptGate: el vínculo candidato no se aplicó (estado fresco)', {
        tenantId,
        attachmentId: attachment.attachmentId,
        reason: link.reason,
      });
      return deps.markGenericMedia(input);
    }

    logger.info('receiptGate: adjunto propuesto como comprobante (sugerencia, el pedido no se movió)', {
      tenantId,
      attachmentId: attachment.attachmentId,
      orderId: decision.orderId,
    });

    // El mensaje de abajo le PROMETE al cliente que una persona lo va a revisar. La promesa se
    // cumple acá: el aviso es lo único que hace que alguien se entere. Va junto con la respuesta
    // —no después, no en otro job— para que no exista un estado en el que ya prometimos y todavía
    // no avisamos. Es best-effort e idempotente: no puede romper la ingesta ni duplicarse.
    if (!link.alreadyLinked) {
      await deps
        .notifyCandidate({
          tenantId,
          customerId,
          orderId: decision.orderId,
          attachmentId: attachment.attachmentId,
        })
        // Cinturón: la implementación por defecto ya no lanza, pero un aviso NUNCA puede tumbar
        // el turno de conversación de un cliente que acaba de mandar su comprobante.
        .catch(() => false);
    }

    return {
      reply: link.alreadyLinked ? '' : MENSAJE_COMPROBANTE_PROPUESTO,
      classification: 'payment_receipt_candidate',
      orderCandidateId: decision.orderId,
    };
  };
}

/**
 * Cableado ÚNICO del gate real (se llama desde `index.ts`). Sin esta línea corre el gate por
 * defecto: todo adjunto queda como medio normal —seguro, pero sin sugerencias de comprobante—.
 */
export function wireReceiptAttachmentGate(): void {
  setAttachmentGate(crearReceiptAttachmentGate());
}
