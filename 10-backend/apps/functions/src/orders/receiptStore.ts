/**
 * orders/receiptStore.ts — Persistencia TRANSACCIONAL del vínculo adjunto ↔ pedido (ADR-0016)
 * ============================================================================================
 * Acá vive la E/S de las reglas puras de `orders/receiptGate.ts`. Tres operaciones:
 *
 *   - `linkReceiptCandidate`  (system) — el gate propuso: se marca el adjunto como
 *     `payment_receipt_candidate` y se ACUMULA en el pedido. **No toca el estado del pedido.**
 *   - `markAttachmentAsReceipt` (human) — una persona autorizada vincula: el pedido pasa a
 *     `PENDING_VERIFICATION`. **Nunca a `PAID`** (confirmar el pago sigue siendo ORDER-1).
 *   - `unmarkAttachmentReceipt` (human) — se quita el significado y el adjunto queda
 *     `generic_media`; el pedido vuelve a `PENDING_PAYMENT` solo si NO queda ningún otro
 *     comprobante vinculado que sostenga el estado.
 *
 * TODO pasa por una transacción y RE-LEE dentro de ella: entre que el gate decidió y que se
 * escribe pueden haber pasado un pago confirmado, una cancelación o el desmarcado de otro
 * vendedor. Las reglas puras se vuelven a evaluar con el estado FRESCO, así una carrera termina
 * en un rechazo explícito y no en una escritura sobre datos viejos.
 *
 * El vínculo es MULTI-ADJUNTO a propósito (`candidateIds` / `linkedIds` son listas): un segundo
 * envío ACUMULA, no reemplaza. Antes, una segunda imagen quedaba huérfana.
 *
 * Estos campos viven en el documento del pedido bajo `receiptAttachments`, que es la superficie
 * que el panel de PEDIDOS lee para saber que hay un comprobante: sin eso, un archivo marcado en
 * Conversaciones existía pero era invisible justo donde se trabaja el pedido. El campo es
 * OPCIONAL en el tipo `Order` (los pedidos anteriores al ADR no lo tienen y siguen renderizando)
 * y solo lleva ids OPACOS — nunca una ruta de Storage, nunca una URL: los bytes salen únicamente
 * por `attachmentGetViewUrl`.
 */
import { Timestamp } from 'firebase-admin/firestore';
import {
  buildAttachmentDocPath,
  readOrderReceiptAttachments,
  type Attachment,
  type AttachmentClassification,
  type Order,
  type OrderReceiptAttachments,
  type OrderStatus,
} from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
// La ingesta es la que declara QUÉ archivos admite el tenant; el gate no puede tener su propia
// versión de esa verdad (ver `mergeReceiptGateWithIngest`).
import { getAttachmentIngestLimits } from '../meta/attachmentLimits.js';
import {
  DEFAULT_RECEIPT_GATE_CONFIG,
  decideMarkAsReceipt,
  decideUnmarkReceipt,
  evaluateReceiptFile,
  mergeReceiptGateWithIngest,
  normalizeReceiptGateConfig,
  receiptGateEnabledFromRaw,
  type ReceiptGateAttachmentFacts,
  type ReceiptGateConfig,
  type ReceiptGateDenyReason,
  type ReceiptMarkDenyReason,
  type ReceiptMarkOrderFacts,
} from './receiptGate.js';
import { buildReceiptCandidateNotification, receiptCandidateNotificationId } from './receiptCandidateNotification.js';
import { UNPAID_STATUSES, isPaidStatus } from './lifecycle.js';

/** Doc de configuración por tenant. Ausente ⇒ defaults (nunca un vertical hardcodeado). */
export const receiptGateConfigPath = (tenantId: string): string => `tenants/${tenantId}/config/receiptGate`;

/**
 * Config EFECTIVA del gate: la del tenant, ya compuesta con los límites de INGESTA (ADR-0016 §8).
 * Las dos lecturas van juntas porque gobiernan la MISMA decisión — ver
 * `mergeReceiptGateWithIngest` en `receiptGate.ts` para el porqué de la intersección.
 *
 * Si la lectura falla, se devuelve la config APAGADA (ADR-0016 §10, fail-closed). Al revés que la
 * ingesta —donde caer a defaults preserva el archivo del cliente— acá un Firestore intermitente
 * que "abriera" el gate propondría comprobantes en un tenant que nunca lo encendió. Y sin este
 * try/catch la excepción subía hasta la ingesta y dejaba el adjunto `unclassified`, que es un
 * estado que la purga sí considera purgable: un error de red terminaba borrando el archivo.
 */
export async function getReceiptGateConfig(tenantId: string): Promise<ReceiptGateConfig> {
  try {
    // Las dos lecturas van juntas: la del gate y la de la ingesta gobiernan la MISMA decisión.
    const [snap, ingest] = await Promise.all([
      db().doc(receiptGateConfigPath(tenantId)).get(),
      getAttachmentIngestLimits(tenantId),
    ]);
    const gate = snap.exists ? normalizeReceiptGateConfig(snap.data()) : DEFAULT_RECEIPT_GATE_CONFIG;
    return mergeReceiptGateWithIngest(gate, ingest);
  } catch (e) {
    logger.warn('receiptGate: no se pudo leer la config del tenant, el nivel B queda APAGADO', {
      tenantId,
      error: e instanceof Error ? e.name : 'desconocido',
    });
    return DEFAULT_RECEIPT_GATE_CONFIG;
  }
}

// ---------------------------------------------------------------------------
// Metadata del pedido
// ---------------------------------------------------------------------------

// La forma y la lectura defensiva viven en `@vpw/shared`: las comparte el panel de Pedidos, que
// es donde el vendedor ve el comprobante. Se re-exportan para no romper a quien ya las importaba
// desde acá — y para que siga habiendo UNA sola definición.
export { readOrderReceiptAttachments };
export type { OrderReceiptAttachments };

const toMillis = (value: unknown): number => {
  const ts = value as { toMillis?: () => number } | null | undefined;
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : 0;
};

/** Igual que `toMillis` pero distingue "no hay fecha" de "época cero" (lo necesita `purgedAt`). */
const toMillisOrNull = (value: unknown): number | null => {
  const ts = value as { toMillis?: () => number } | null | undefined;
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : null;
};

/** Hechos del pedido para las reglas puras (recorte del documento, sin datos de más). */
export function toReceiptOrderFacts(order: Order): ReceiptMarkOrderFacts {
  const receipts = readOrderReceiptAttachments(order);
  return {
    orderId: order.id,
    customerId: order.customerId,
    status: order.status,
    createdAtMs: toMillis(order.createdAt),
    linkedAttachmentIds: [...receipts.candidateIds, ...receipts.linkedIds],
    // Solo los VINCULADOS por una persona: son los que sostienen el `PENDING_VERIFICATION`.
    linkedReceiptIds: receipts.linkedIds,
    statusDrivenBy: receipts.statusDrivenBy,
  };
}

/** Hechos del adjunto para las reglas puras. */
export function toReceiptAttachmentFacts(attachment: Attachment): ReceiptGateAttachmentFacts {
  return {
    attachmentId: attachment.attachmentId,
    tenantId: attachment.tenantId,
    customerId: attachment.customerId,
    ingestState: attachment.ingestState,
    classification: attachment.classification?.value ?? 'unclassified',
    orderCandidateId: attachment.orderCandidateId ?? null,
    mimeVerified: attachment.mime?.verified ?? null,
    bytes: attachment.bytes ?? null,
    purgedAtMs: toMillisOrNull(attachment.purgedAt),
  };
}

// ---------------------------------------------------------------------------
// Transacción inyectable (test sin Firestore)
// ---------------------------------------------------------------------------

export interface ReceiptTx {
  getAttachment(attachmentId: string): Promise<Attachment | null>;
  getOrder(orderId: string): Promise<Order | null>;
  /**
   * Relectura FRESCA del NIVEL B dentro de la transacción (ADR-0016 §10). La config del gate se
   * lee mucho antes —el evaluador la necesita para ventana y formatos— y entre esa lectura y el
   * commit alguien puede apagar el flag. Una lectura vieja no puede ganarle a un apagado ya
   * commiteado: lo que todavía no se escribió, no se escribe.
   */
  isReceiptGateEnabled(): Promise<boolean>;
  /**
   * ¿Ya existe la campana con este id determinístico? Es una LECTURA, así que va antes de
   * cualquier escritura (Firestore lo exige) y da la idempotencia sin que un reintento aborte la
   * transacción entera por colisión de `create`.
   */
  hasNotification(notificationId: string): Promise<boolean>;
  updateAttachment(attachmentId: string, patch: Record<string, unknown>): void;
  updateOrder(orderId: string, patch: Record<string, unknown>): void;
  /** `create` (no `set`): si dos corridas empatan, la perdedora reintenta y ve el aviso ya escrito. */
  createNotification(notificationId: string, data: Record<string, unknown>): void;
}

export interface ReceiptStoreDeps {
  runTransaction<T>(tenantId: string, fn: (tx: ReceiptTx) => Promise<T>): Promise<T>;
  now: () => Timestamp;
}

export const defaultReceiptStoreDeps: ReceiptStoreDeps = {
  runTransaction: (tenantId, fn) =>
    db().runTransaction((t) =>
      fn({
        async getAttachment(attachmentId) {
          const snap = await t.get(db().doc(buildAttachmentDocPath(tenantId, attachmentId)));
          return snap.exists ? (snap.data() as Attachment) : null;
        },
        async getOrder(orderId) {
          const snap = await t.get(db().doc(paths.order(tenantId, orderId)));
          return snap.exists ? (snap.data() as Order) : null;
        },
        async isReceiptGateEnabled() {
          const snap = await t.get(db().doc(receiptGateConfigPath(tenantId)));
          // Doc ausente ⇒ APAGADO, y el mismo lector estricto que usa la config previa.
          return snap.exists ? receiptGateEnabledFromRaw(snap.data()) : false;
        },
        async hasNotification(notificationId) {
          return (await t.get(db().doc(paths.notification(tenantId, notificationId)))).exists;
        },
        updateAttachment(attachmentId, patch) {
          t.update(db().doc(buildAttachmentDocPath(tenantId, attachmentId)), patch);
        },
        updateOrder(orderId, patch) {
          t.update(db().doc(paths.order(tenantId, orderId)), patch);
        },
        createNotification(notificationId, data) {
          t.create(db().doc(paths.notification(tenantId, notificationId)), data);
        },
      }),
    ),
  now: () => Timestamp.now(),
};

// ---------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------

export type ReceiptStoreDenyReason =
  | ReceiptMarkDenyReason
  | ReceiptGateDenyReason
  | 'attachment_not_found'
  | 'order_not_found';

export type ReceiptCandidateResult =
  | { ok: true; orderId: string; alreadyLinked: boolean }
  | { ok: false; reason: ReceiptStoreDenyReason };

export type ReceiptMarkResult =
  | { ok: true; alreadyMarked: boolean; status: OrderStatus }
  | { ok: false; reason: ReceiptStoreDenyReason };

export type ReceiptUnmarkResult =
  | { ok: true; status: OrderStatus; reverted: boolean }
  | { ok: false; reason: ReceiptStoreDenyReason };

const classificationPatch = (
  value: AttachmentClassification,
  source: 'rule' | 'human',
  by: string | null,
  now: Timestamp,
): Record<string, unknown> => ({
  'classification.value': value,
  'classification.source': source,
  'classification.confidence': 1,
  'classification.by': by,
  'classification.at': now,
});

// ---------------------------------------------------------------------------
// 1) Vínculo CANDIDATO (system) — acumula y NO cambia el estado del pedido
// ---------------------------------------------------------------------------

/**
 * Aplica la propuesta del gate. Re-valida con el estado FRESCO dentro de la transacción: si el
 * pedido se pagó o se canceló en el medio, no se propone nada.
 *
 * NO cambia `order.status` bajo ninguna circunstancia: ese es el corazón del ADR — la ingesta
 * jamás mueve un pedido por sí sola.
 *
 * DOS COSAS QUE ANTES ESTABAN AFUERA Y AHORA VIVEN ACÁ ADENTRO:
 *
 *  1. El FLAG del nivel B se RELEE (ADR-0016 §10). La config que trae el caller se leyó antes de
 *     evaluar; entre esa lectura y este commit alguien puede haber apagado el gate.
 *  2. La CAMPANA del panel (ADR-0016 §11). El mensaje al cliente promete que «un vendedor lo
 *     revisa»: esa promesa y la señal que la hace cierta son UN SOLO HECHO. Antes el aviso era
 *     best-effort después del commit, así que un Firestore con hipo dejaba al cliente esperando a
 *     alguien que nunca fue notificado. Ahora, o entran los tres writes (adjunto + pedido +
 *     campana) o no entra ninguno y el archivo queda como medio normal.
 */
export async function linkReceiptCandidate(
  tenantId: string,
  input: { attachmentId: string; orderId: string; config?: ReceiptGateConfig },
  deps: ReceiptStoreDeps = defaultReceiptStoreDeps,
): Promise<ReceiptCandidateResult> {
  const config = input.config ?? DEFAULT_RECEIPT_GATE_CONFIG;
  return deps.runTransaction(tenantId, async (tx) => {
    const attachment = await tx.getAttachment(input.attachmentId);
    if (!attachment) return { ok: false, reason: 'attachment_not_found' } as const;
    const order = await tx.getOrder(input.orderId);
    if (!order) return { ok: false, reason: 'order_not_found' } as const;

    const facts = toReceiptAttachmentFacts(attachment);
    if (facts.tenantId !== tenantId) return { ok: false, reason: 'tenant_mismatch' } as const;
    if (order.customerId !== facts.customerId) return { ok: false, reason: 'order_customer_mismatch' } as const;

    // Idempotencia por `(tenantId, attachmentId)` y por `(orderId, attachmentId)`. Va ANTES del
    // flag a propósito: informar un vínculo que ya existe no escribe nada, y apagar el nivel B no
    // puede borrar ni ocultar lo ya guardado (ADR-0016 §10).
    const receipts = readOrderReceiptAttachments(order);
    if (
      (facts.classification === 'payment_receipt_candidate' || facts.classification === 'payment_receipt_linked') &&
      facts.orderCandidateId === order.id &&
      receipts.candidateIds.includes(facts.attachmentId)
    ) {
      return { ok: true, orderId: order.id, alreadyLinked: true } as const;
    }

    // NIVEL B, releído FRESCO: de acá para abajo todo son escrituras NUEVAS.
    if (!(await tx.isReceiptGateEnabled())) return { ok: false, reason: 'receipt_gate_disabled' } as const;

    if (facts.classification !== 'unclassified') return { ok: false, reason: 'illegal_classification_transition' } as const;

    // Estado FRESCO: entre el gate y esta transacción el pedido pudo pagarse o cancelarse.
    if (isPaidStatus(order.status)) return { ok: false, reason: 'order_already_paid' } as const;
    if (!UNPAID_STATUSES.includes(order.status)) return { ok: false, reason: 'order_not_admissible' } as const;

    const archivo = evaluateReceiptFile(facts, config);
    if (!archivo.ok) return { ok: false, reason: archivo.reason } as const;

    // Última LECTURA antes de escribir: Firestore exige que todas vayan primero.
    const notificationId = receiptCandidateNotificationId(facts.attachmentId);
    const yaAvisado = await tx.hasNotification(notificationId);

    const now = deps.now();
    tx.updateAttachment(facts.attachmentId, {
      ...classificationPatch('payment_receipt_candidate', 'rule', null, now),
      orderCandidateId: order.id,
      updatedAt: now,
    });
    // Acumula: un segundo envío se suma a la lista, no pisa al anterior. `status` NO se toca.
    tx.updateOrder(order.id, {
      'receiptAttachments.candidateIds': [...new Set([...receipts.candidateIds, facts.attachmentId])],
      'receiptAttachments.updatedAt': now,
      updatedAt: now,
    });
    if (!yaAvisado) {
      // Id determinístico por adjunto ⇒ como MÁXIMO una campana por reintento del webhook.
      const aviso = buildReceiptCandidateNotification(
        { tenantId, customerId: facts.customerId, orderId: order.id, attachmentId: facts.attachmentId },
        now,
      );
      tx.createNotification(aviso.id, aviso.data);
    }
    return { ok: true, orderId: order.id, alreadyLinked: false } as const;
  });
}

// ---------------------------------------------------------------------------
// 2) Marcar como comprobante (human) — llega hasta PENDING_VERIFICATION
// ---------------------------------------------------------------------------

/**
 * Vincular un comprobante NUEVO es parte del nivel B (ADR-0016 §10): con el flag en OFF esta
 * operación RECHAZA. El flag se relee dentro de la transacción por el mismo motivo que en el
 * candidato — un apagado ya commiteado tiene que ganarle a cualquier lectura previa.
 */
export async function markAttachmentAsReceipt(
  tenantId: string,
  input: { attachmentId: string; orderId: string; actorUid: string },
  deps: ReceiptStoreDeps = defaultReceiptStoreDeps,
): Promise<ReceiptMarkResult> {
  return deps.runTransaction(tenantId, async (tx) => {
    const attachment = await tx.getAttachment(input.attachmentId);
    if (!attachment) return { ok: false, reason: 'attachment_not_found' } as const;
    const order = await tx.getOrder(input.orderId);
    if (!order) return { ok: false, reason: 'order_not_found' } as const;
    // La relectura del flag se hace acá, con el resto de las lecturas (Firestore exige que TODAS
    // vayan antes de la primera escritura), pero se APLICA más abajo — ver el comentario del
    // corto-circuito idempotente.
    const gateHabilitado = await tx.isReceiptGateEnabled();

    const facts = toReceiptAttachmentFacts(attachment);
    const orderFacts = toReceiptOrderFacts(order);
    const decision = decideMarkAsReceipt({ tenantId, attachment: facts, order: orderFacts });
    if (!decision.ok) return { ok: false, reason: decision.reason } as const;
    // Idempotencia ANTES del flag, igual que en `linkReceiptCandidate`: informar un marcado que YA
    // existe no escribe nada, y apagar el nivel B no puede convertir en error algo que ya es un
    // hecho (ADR-0016 §10). Pasa de verdad en el rollback del paso 3: se marcó con el gate
    // encendido, se apaga el gate, y el vendedor vuelve a apretar «marcar» —doble click o reintento
    // del panel— sobre un comprobante que ya estaba vinculado. Verlo fallar diría que se rompió
    // algo cuando en realidad ya estaba hecho.
    if (decision.alreadyMarked) return { ok: true, alreadyMarked: true, status: order.status } as const;
    // De acá para abajo todo son vínculos NUEVOS: eso sí lo gobierna el nivel B.
    if (!gateHabilitado) return { ok: false, reason: 'receipt_gate_disabled' } as const;

    const now = deps.now();
    const receipts = readOrderReceiptAttachments(order);
    // El camino de clasificación se calculó paso a paso contra la máquina de estados; se persiste
    // el ESTADO FINAL (los intermedios no son un hecho: nadie estuvo en ellos).
    tx.updateAttachment(facts.attachmentId, {
      ...classificationPatch('payment_receipt_linked', 'human', input.actorUid, now),
      orderCandidateId: order.id,
      updatedAt: now,
    });

    const orderPatch: Record<string, unknown> = {
      'receiptAttachments.linkedIds': [...new Set([...receipts.linkedIds, facts.attachmentId])],
      'receiptAttachments.candidateIds': [...new Set([...receipts.candidateIds, facts.attachmentId])],
      'receiptAttachments.updatedAt': now,
      updatedAt: now,
    };
    let status = order.status;
    if (decision.moveOrderToPendingVerification) {
      // Único cambio de estado permitido acá. `PAID` es inalcanzable por este camino.
      status = 'PENDING_VERIFICATION';
      orderPatch['status'] = status;
      orderPatch['receiptAttachments.statusDrivenBy'] = facts.attachmentId;
    }
    tx.updateOrder(order.id, orderPatch);
    return { ok: true, alreadyMarked: false, status } as const;
  });
}

// ---------------------------------------------------------------------------
// 3) Desmarcar (human) — preserva el adjunto como medio normal
// ---------------------------------------------------------------------------

/**
 * DESMARCAR NO MIRA EL FLAG, y es deliberado (ADR-0016 §10): «apagar una función no puede dejar
 * atrapada una decisión humana que alguien necesita revertir». Si el desmarcado dependiera del
 * nivel B, un tenant con el gate apagado —el estado por DEFECTO— quedaría con sus comprobantes
 * marcados para siempre y sin forma de corregir un error. Revocar siempre tiene que ser posible;
 * lo que el flag gobierna es CREAR vínculos nuevos, no deshacerlos.
 */
export async function unmarkAttachmentReceipt(
  tenantId: string,
  input: { attachmentId: string; orderId: string; actorUid: string },
  deps: ReceiptStoreDeps = defaultReceiptStoreDeps,
): Promise<ReceiptUnmarkResult> {
  return deps.runTransaction(tenantId, async (tx) => {
    const attachment = await tx.getAttachment(input.attachmentId);
    if (!attachment) return { ok: false, reason: 'attachment_not_found' } as const;
    const order = await tx.getOrder(input.orderId);
    if (!order) return { ok: false, reason: 'order_not_found' } as const;

    const facts = toReceiptAttachmentFacts(attachment);
    const orderFacts = toReceiptOrderFacts(order);
    const decision = decideUnmarkReceipt({ tenantId, attachment: facts, order: orderFacts });
    if (!decision.ok) return { ok: false, reason: decision.reason } as const;

    const now = deps.now();
    const receipts = readOrderReceiptAttachments(order);
    // El archivo NO se borra ni se degrada a `rejected`: queda como medio normal de la
    // conversación, con su historia intacta.
    tx.updateAttachment(facts.attachmentId, {
      ...classificationPatch('generic_media', 'human', input.actorUid, now),
      orderCandidateId: null,
      updatedAt: now,
    });

    const orderPatch: Record<string, unknown> = {
      'receiptAttachments.linkedIds': receipts.linkedIds.filter((id) => id !== facts.attachmentId),
      // También sale de `candidateIds`. Si quedara acá, el pedido seguiría listando un adjunto que
      // ya no le pertenece (`orderCandidateId: null`, clasificación `generic_media`) y que por eso
      // mismo volvió a ser PURGABLE: el panel mostraría una referencia a bytes que el job de
      // retención puede borrar. Las dos listas se mantienen coherentes o ninguna sirve.
      'receiptAttachments.candidateIds': receipts.candidateIds.filter((id) => id !== facts.attachmentId),
      // El puntero se reescribe SIEMPRE con lo que decidieron las reglas: puede quedar en null
      // (se revirtió), traspasado a otro comprobante vinculado, o igual que antes.
      'receiptAttachments.statusDrivenBy': decision.nextStatusDrivenBy,
      'receiptAttachments.updatedAt': now,
      updatedAt: now,
    };
    let status = order.status;
    if (decision.revertOrderToPendingPayment) {
      status = 'PENDING_PAYMENT';
      orderPatch['status'] = status;
    }
    tx.updateOrder(order.id, orderPatch);
    return { ok: true, status, reverted: decision.revertOrderToPendingPayment } as const;
  });
}
