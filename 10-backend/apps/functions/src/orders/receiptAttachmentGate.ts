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
import type { AttachmentClassification, Order, Session } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { genericMediaGate, setAttachmentGate, type AttachmentGate } from '../meta/attachmentGate.js';
import {
  esperaComprobanteDeclarada,
  evaluateReceiptGate,
  type ReceiptGateConfig,
  type ReceiptGateDenyReason,
  type ReceiptGateOrderFacts,
} from './receiptGate.js';
import {
  getReceiptGateConfig,
  linkReceiptCandidate,
  readOrderReceiptAttachments,
  toReceiptAttachmentFacts,
  type ReceiptCandidateResult,
} from './receiptStore.js';

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
  nowMs: () => number;
}

/**
 * Clasificaciones que representan una decisión YA TOMADA sobre el archivo (por el sistema o por
 * una persona). Enrutarlas al gate genérico las DEGRADARÍA —la máquina de estados permite
 * `payment_receipt_candidate → generic_media` por `system`—, y el resultado sería un pedido que
 * sigue listando el adjunto como candidato mientras el adjunto dice que es un medio normal: dos
 * documentos contándose historias distintas, y un archivo que vuelve a ser purgable.
 *
 * ADR-0016 §10 lo prohíbe explícitamente para el apagado del nivel B («no puede ocultar ni borrar
 * nada que ya exista»), pero la regla vale para CUALQUIER motivo de rechazo: el gate automático
 * propone, nunca revoca.
 */
function esDecisionYaTomada(classification: AttachmentClassification): boolean {
  return classification === 'payment_receipt_candidate' || classification === 'payment_receipt_linked';
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
  nowMs: () => Date.now(),
};

export function crearReceiptAttachmentGate(
  deps: ReceiptAttachmentGateDeps = defaultReceiptAttachmentGateDeps,
): AttachmentGate {
  return async (input) => {
    const { tenantId, customerId, attachment } = input;
    const clasificacionActual = attachment.classification?.value ?? 'unclassified';

    /**
     * Degradar SOLO si no hay una decisión previa. Con una ya tomada se devuelve tal cual está:
     * nada se pisa, nada se oculta y el pedido no queda incoherente con el adjunto.
     *
     * El `motivo` viaja hacia arriba para que el acuse al cliente sea el correcto: el webhook
     * elige el texto con él (`respuestaPorAdjunto`). Sin motivo cae al genérico, que invita a
     * escribir *pagar* para vincular el archivo — cierto en el caso normal y FALSO con el nivel B
     * apagado, donde ninguna vinculación es posible. Una decisión ya tomada no lo lleva: ahí no
     * hay nada nuevo que contarle al cliente.
     */
    const dejarComoMedioNormal = async (motivo?: ReceiptGateDenyReason) => {
      if (esDecisionYaTomada(clasificacionActual)) {
        return {
          reply: '',
          classification: clasificacionActual,
          orderCandidateId: attachment.orderCandidateId ?? null,
        };
      }
      const degradado = await deps.markGenericMedia(input);
      return motivo ? { ...degradado, reason: motivo } : degradado;
    };

    // El NIVEL B se consulta PRIMERO (ADR-0016 §10). Además de ser la respuesta correcta, evita el
    // costo: con el gate apagado —el estado por defecto de todo tenant— leer sesión, pedido
    // apuntado y la colección entera de pedidos del cliente es trabajo que nadie va a usar.
    const config = await deps.getConfig(tenantId);
    // `!== true` y no `!config.enabled`: el criterio de encendido es UNO SOLO en todo el rollout
    // (ADR-0016 §10). Un truthy acá no encendería nada —el evaluador y la relectura transaccional
    // vuelven a exigir el booleano exacto— pero sí dejaría pasar de largo a un `enabled: 1`, que
    // gastaría la lectura de sesión y de todos los pedidos del cliente para nada.
    if (config.enabled !== true) {
      logger.info('receiptGate: nivel B apagado para el tenant, el adjunto queda como medio normal', {
        tenantId,
        attachmentId: attachment.attachmentId,
      });
      return dejarComoMedioNormal('receipt_gate_disabled');
    }

    const session = await deps.getSession(tenantId, customerId);
    const pendingOrderId = session?.context?.pendingOrderId ?? null;
    // El puntero de la sesión se resuelve pero NO se cree: el gate valida su `customerId`.
    const pendingOrder = pendingOrderId ? await deps.getOrder(tenantId, pendingOrderId) : null;
    const customerOrders = await deps.listCustomerOrders(tenantId, customerId);

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
      return dejarComoMedioNormal();
    }

    // Idempotencia: ya estaba propuesto ⇒ no se re-escribe ni se repite el mensaje al cliente.
    if (decision.alreadyLinked) {
      return { reply: '', classification: 'payment_receipt_candidate', orderCandidateId: decision.orderId };
    }

    /**
     * La transacción confirma JUNTOS el candidato y la campana del panel (ADR-0016 §11). Si no
     * commitea —por el flag apagado, por estado fresco o porque Firestore falló— NO se promete
     * revisión: no quedó ni el vínculo ni el aviso, así que prometerla dejaría al cliente
     * esperando a alguien que nunca fue notificado.
     */
    let link: ReceiptCandidateResult;
    try {
      link = await deps.link(tenantId, { attachmentId: attachment.attachmentId, orderId: decision.orderId, config });
    } catch (e) {
      // Sin el mensaje crudo del error: puede arrastrar ids del proveedor o rutas.
      logger.warn('receiptGate: la transacción del vínculo candidato falló, no se promete revisión', {
        tenantId,
        attachmentId: attachment.attachmentId,
        error: e instanceof Error ? e.name : 'desconocido',
      });
      // NO se degrada: es el ÚNICO caso en que no se sabe qué quedó escrito. Un `runTransaction`
      // puede lanzar con el commit YA aplicado (UNAVAILABLE/DEADLINE sobre el RPC de commit), y
      // `dejarComoMedioNormal` decide sobre la clasificación que se leyó ANTES de la transacción:
      // pisaría con `generic_media` un adjunto que quedó de candidato, dejando al pedido listándolo
      // y al adjunto negándolo —dos documentos contándose historias distintas, y un archivo que
      // vuelve a ser purgable—. Dejarlo como está es seguro: la ingesta ya lo guardó, y el cliente
      // igual recibe el acuse neutral que arma el webhook.
      return {
        reply: '',
        classification: clasificacionActual,
        orderCandidateId: attachment.orderCandidateId ?? null,
      };
    }
    if (!link.ok) {
      // El pedido cambió entre la evaluación y la transacción (se pagó, se canceló) o el nivel B
      // se apagó en el medio. Degradar es siempre seguro: nunca fabrica evidencia de pago.
      logger.info('receiptGate: el vínculo candidato no se aplicó (estado fresco)', {
        tenantId,
        attachmentId: attachment.attachmentId,
        reason: link.reason,
      });
      return dejarComoMedioNormal();
    }

    logger.info('receiptGate: adjunto propuesto como comprobante (sugerencia, el pedido no se movió)', {
      tenantId,
      attachmentId: attachment.attachmentId,
      orderId: decision.orderId,
    });

    // Recién acá la promesa es cierta: el vínculo Y la campana están commiteados.
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
