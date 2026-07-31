/**
 * orders/receiptGate.ts — Reglas DETERMINÍSTICAS del comprobante (ADR-0016 §4 y §5)
 * ==================================================================================
 * PURO: sin E/S, sin reloj propio (el `nowMs` entra por parámetro), sin logging. La I/O
 * transaccional vive en `orders/receiptStore.ts` y la autorización por rol en el callable.
 *
 * POR QUÉ existe este módulo: hasta hoy alcanzaba con que llegara una imagen para que un pedido
 * se moviera solo a PENDING_VERIFICATION, disparara handoff y sacara al bot del chat — una foto
 * de producto congelaba el pedido. El criterio era "es una imagen". Acá el criterio pasa a ser un
 * CONJUNTO de condiciones que se cumplen TODAS o el adjunto queda `generic_media`:
 *
 *   1. contexto EXPLÍCITO de espera de comprobante, DECLARADO por el servidor en la sesión
 *      (nunca inferido del contenido del archivo ni del caption);
 *   2. exactamente UN pedido admisible **del mismo `customerId`** — el `pendingOrderId` de la
 *      sesión se valida contra quien envía, que es justamente lo que no se hacía;
 *   3. estado del pedido admisible y NO pagado;
 *   4. dentro de una ventana temporal configurable POR TENANT;
 *   5. el archivo está `stored` (los bytes existen de verdad);
 *   6. el MIME VERIFICADO (magic bytes, jamás el declarado) y el tamaño están permitidos;
 *   7. cero ambigüedad entre pedidos;
 *   8. idempotencia por `(tenantId, attachmentId)` y por `(orderId, attachmentId)`.
 *
 * Nada de esto mira el vertical del negocio: la ventana, los formatos y el tamaño son
 * configuración por tenant, no ramas en el código.
 *
 * REGLA INVIOLABLE: ninguna función de acá puede producir `PAID`. El gate propone una
 * SUGERENCIA (`payment_receipt_candidate`); marcar es humano y llega hasta
 * `PENDING_VERIFICATION`; confirmar el pago sigue siendo el callable existente de ORDER-1.
 */
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  checkClassificationTransition,
  isAttachmentStored,
  type AttachmentClassification,
  type AttachmentIngestState,
  type OrderStatus,
  type Session,
} from '@vpw/shared';
import { UNPAID_STATUSES, isPaidStatus, isTerminal } from './lifecycle.js';

// ---------------------------------------------------------------------------
// Configuración por tenant (defaults conservadores)
// ---------------------------------------------------------------------------

/** La sesión vive 24 h: más allá de eso no hay contexto de pago que sostenga una sugerencia. */
export const RECEIPT_GATE_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Piso y techo duros: una config corrupta no puede abrir la ventana para siempre. */
export const RECEIPT_GATE_MIN_WINDOW_MS = 5 * 60 * 1000;
export const RECEIPT_GATE_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Tamaño máximo del archivo que puede proponerse como comprobante. */
export const RECEIPT_GATE_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const RECEIPT_GATE_MAX_ALLOWED_BYTES = 25 * 1024 * 1024;
/**
 * Tolerancia de reloj hacia el FUTURO. El `createdAt` del pedido lo pone el servidor y el
 * `nowMs` puede venir de otra instancia: un desfasaje de segundos no puede invalidar un
 * comprobante legítimo. Hacia el pasado no hay tolerancia: para eso está la ventana.
 */
export const RECEIPT_GATE_CLOCK_SKEW_MS = 60 * 1000;

export interface ReceiptGateConfig {
  /** Cuánto tiempo después de nacer el pedido un archivo todavía puede proponerse. */
  windowMs: number;
  maxBytes: number;
  /** Siempre un subconjunto de la whitelist de `@vpw/shared` (nunca la amplía). */
  allowedMimeTypes: readonly string[];
}

export const DEFAULT_RECEIPT_GATE_CONFIG: ReceiptGateConfig = {
  windowMs: RECEIPT_GATE_DEFAULT_WINDOW_MS,
  maxBytes: RECEIPT_GATE_DEFAULT_MAX_BYTES,
  allowedMimeTypes: ATTACHMENT_ALLOWED_MIME_TYPES,
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
 * Normaliza la config cruda del tenant. FAIL-CLOSED: cualquier valor ausente, no numérico o
 * fuera de rango cae al default, y los MIME se INTERSECAN con la whitelist compartida — un
 * tenant puede restringir formatos, jamás habilitar uno que el sniffing no sabe verificar.
 */
export function normalizeReceiptGateConfig(raw: unknown): ReceiptGateConfig {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const minutes = data['windowMinutes'];
  const windowMs =
    typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
      ? clamp(Math.round(minutes * 60 * 1000), RECEIPT_GATE_MIN_WINDOW_MS, RECEIPT_GATE_MAX_WINDOW_MS)
      : RECEIPT_GATE_DEFAULT_WINDOW_MS;

  const bytes = data['maxBytes'];
  const maxBytes =
    typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0
      ? clamp(Math.round(bytes), 1, RECEIPT_GATE_MAX_ALLOWED_BYTES)
      : RECEIPT_GATE_DEFAULT_MAX_BYTES;

  const rawMimes = data['allowedMimeTypes'];
  const allowedMimeTypes = Array.isArray(rawMimes)
    ? (ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).filter((m) => rawMimes.includes(m))
    : ATTACHMENT_ALLOWED_MIME_TYPES;

  return {
    windowMs,
    maxBytes,
    // Una lista que quedó vacía (config con formatos inventados) volvería inútil el gate sin
    // decirlo: se cae al default en vez de negar todo en silencio.
    allowedMimeTypes: allowedMimeTypes.length > 0 ? allowedMimeTypes : ATTACHMENT_ALLOWED_MIME_TYPES,
  };
}

/**
 * Límites de INGESTA del tenant, vistos desde acá. Se declara estructuralmente (y no importando
 * el tipo de `meta/attachmentLimits.ts`) para que este módulo siga sin depender de nada: es el
 * mismo criterio con el que `meta/` no depende de `orders/`.
 */
export interface ReceiptGateIngestLimits {
  maxBytes: number;
  allowedMimeTypes: readonly string[];
}

/**
 * UNA SOLA DECISIÓN, DOS DOCUMENTOS (ADR-0016 §8) — por qué el gate no manda solo sobre el archivo.
 *
 * "Qué archivos admite este tenant" se declara en la config de INGESTA
 * (`tenants/{t}/config/attachments.ingest`): es la que gobierna la descarga real y decide qué
 * bytes entran al bucket. El doc del gate (`tenants/{t}/config/receiptGate`) repetía formatos y
 * tope de bytes, así que los dos podían decir cosas distintas y el sistema se comportaba según
 * cuál mirara cada camino. El caso feo no es el simétrico sino el que AMPLÍA: un tenant baja la
 * ingesta a JPEG y el gate sigue prometiendo PDF ⇒ el gate propone un formato que jamás va a
 * llegar, y la config queda mintiendo sin que nadie lo note.
 *
 * Se resuelve por INTERSECCIÓN, la única composición que no puede ampliar permisos:
 *  · formatos → los del gate ∩ los de la ingesta;
 *  · bytes    → el MENOR de los dos topes.
 * Una restricción PROPIA del gate (por ejemplo "como comprobante, solo imágenes") se sigue
 * respetando: restringir de más es seguro, restringir de menos no. La ventana temporal sí es
 * exclusiva del gate — no tiene equivalente del lado de la ingesta.
 */
export function mergeReceiptGateWithIngest(
  gate: ReceiptGateConfig,
  ingest: ReceiptGateIngestLimits,
): ReceiptGateConfig {
  return {
    windowMs: gate.windowMs,
    maxBytes: Math.min(gate.maxBytes, ingest.maxBytes),
    // Intersección VACÍA = las dos configs se contradicen. NO se cae al default: eso habilitaría
    // formatos que la ingesta no acepta, que es justo lo que esta función existe para impedir.
    // Con la lista vacía ningún archivo se propone como comprobante y el archivo igual se guarda
    // y se ve en el chat como medio normal — fail-closed sin perder nada del cliente.
    allowedMimeTypes: gate.allowedMimeTypes.filter((m) => ingest.allowedMimeTypes.includes(m)),
  };
}

// ---------------------------------------------------------------------------
// Entradas del gate (datos ya cargados; el módulo no lee nada)
// ---------------------------------------------------------------------------

/** Hechos del adjunto que el gate necesita. Recorte deliberado del documento completo. */
export interface ReceiptGateAttachmentFacts {
  attachmentId: string;
  tenantId: string;
  /** OJO: es el teléfono del cliente ⇒ jamás se loguea ni se devuelve en mensajes. */
  customerId: string;
  ingestState: AttachmentIngestState;
  classification: AttachmentClassification;
  /** Pedido ya propuesto (idempotencia por `(tenantId, attachmentId)`). */
  orderCandidateId: string | null;
  /** MIME VERIFICADO por magic bytes. El declarado por Graph no entra acá a propósito. */
  mimeVerified: string | null;
  /** Tamaño REAL medido durante el stream. */
  bytes: number | null;
  /**
   * Cuándo se BORRARON los bytes por retención (`null` = siguen en el bucket). Va aparte de
   * `ingestState` porque la purga NO revierte el estado de ingesta: un adjunto purgado sigue
   * diciendo `stored` y solo pierde `storage.path`. Sin este dato, "el archivo está guardado"
   * sería mentira y se podría vincular como comprobante algo que ya no se puede abrir.
   */
  purgedAtMs: number | null;
}

/** Pedido candidato, ya cargado. `linkedAttachmentIds` da la idempotencia `(orderId, attachmentId)`. */
export interface ReceiptGateOrderFacts {
  orderId: string;
  customerId: string;
  status: OrderStatus;
  createdAtMs: number;
  linkedAttachmentIds: readonly string[];
}

/**
 * Contexto de espera DECLARADO por el servidor. Los dos campos los escribe el backend cuando
 * manda las instrucciones de transferencia o cuando deriva por verificación de pago: nada acá
 * se deduce de lo que mandó el cliente.
 */
export interface ReceiptGateSessionContext {
  awaitingPaymentDeclared: boolean;
  pendingOrderId: string | null;
}

/**
 * ¿La sesión DECLARA que se está esperando un comprobante? Los dos indicadores los escribe el
 * SERVIDOR: `AWAITING_PAYMENT` al mandar las instrucciones de transferencia, y el handoff por
 * `payment_verification` cuando ya hubo un comprobante (reenvío, que debe poder ACUMULAR).
 * Ninguno se deduce del archivo, del caption ni del texto del cliente — que es exactamente lo
 * que exige ADR-0016 §4 al pedir un contexto DECLARADO y no inferido.
 *
 * Vive acá (y no en el camino de comprobantes) para que el cableado del gate no arrastre al
 * arranque de todas las funciones el módulo de descarga de medios y el de handoff.
 */
export function esperaComprobanteDeclarada(session: Session | null | undefined): boolean {
  if (!session) return false;
  if (session.state === 'AWAITING_PAYMENT') return true;
  return session.context?.handoffReason === 'payment_verification';
}

export interface ReceiptGateInput {
  tenantId: string;
  customerId: string;
  nowMs: number;
  attachment: ReceiptGateAttachmentFacts;
  session: ReceiptGateSessionContext;
  /** Pedidos del cliente ya cargados (incluido el `pendingOrderId` de la sesión si existe). */
  candidateOrders: readonly ReceiptGateOrderFacts[];
  config: ReceiptGateConfig;
}

/** Código cerrado ⇒ seguro de loguear (no lleva teléfono, ni ids del proveedor, ni rutas). */
export type ReceiptGateDenyReason =
  | 'tenant_mismatch'
  | 'customer_mismatch'
  | 'classification_not_open'
  | 'no_explicit_payment_context'
  | 'no_admissible_order'
  | 'ambiguous_orders'
  | 'order_customer_mismatch'
  | 'order_not_admissible'
  | 'order_already_paid'
  | 'outside_time_window'
  | 'attachment_not_stored'
  | 'attachment_purged'
  | 'mime_not_allowed'
  | 'size_not_allowed';

export type ReceiptGateDecision =
  | {
      ok: true;
      classification: 'payment_receipt_candidate';
      orderId: string;
      /** Regla determinística que se cumple entera ⇒ 1. */
      confidence: 1;
      /** true ⇒ ya estaba propuesto: reevaluar no cambia nada (idempotencia). */
      alreadyLinked: boolean;
    }
  | { ok: false; classification: 'generic_media'; reason: ReceiptGateDenyReason };

const deny = (reason: ReceiptGateDenyReason): ReceiptGateDecision => ({
  ok: false,
  classification: 'generic_media',
  reason,
});

// ---------------------------------------------------------------------------
// Gate — parte de CONTEXTO (no necesita los bytes)
// ---------------------------------------------------------------------------

export type ReceiptContextDecision =
  | { ok: true; orderId: string }
  | { ok: false; reason: ReceiptGateDenyReason };

/** Igual que `ReceiptGateInput` pero sin los hechos del archivo (que exigen haberlo bajado). */
export interface ReceiptContextInput {
  tenantId: string;
  customerId: string;
  nowMs: number;
  session: ReceiptGateSessionContext;
  candidateOrders: readonly ReceiptGateOrderFacts[];
  config: ReceiptGateConfig;
}

/**
 * Elección del pedido + contexto + ventana. Se expone aparte porque el camino de ingesta puede
 * decidir NO descargar el archivo cuando el contexto ya lo descarta: bajar bytes que nunca van a
 * proponerse es costo y superficie de ataque al pedo.
 *
 * Sobre la ambigüedad: se evalúa SIEMPRE, y el `pendingOrderId` declarado NO exime de ella. El
 * puntero de sesión es un dato de UNA sola pieza que se pisa a sí misma —el cliente hace checkout
 * de A, después de B y el puntero queda en B— así que tratarlo como desambiguador hacía que un
 * comprobante pudiera caer en el pedido equivocado sin que nadie lo notara. ADR-0016 §4 pide
 * "exactamente un pedido admisible del mismo customerId" y "cero ambigüedad": con dos o más
 * admisibles no se propone nada y el archivo queda como medio normal, para que una persona lo
 * vincule al pedido que corresponde. El puntero sigue sirviendo para lo único que puede probar:
 * detectar que apunta a un pedido de OTRA persona (corrupción de estado).
 */
export function evaluateReceiptContext(input: ReceiptContextInput): ReceiptContextDecision {
  const { tenantId, customerId, nowMs, session, candidateOrders, config } = input;

  if (typeof tenantId !== 'string' || tenantId.length === 0) return { ok: false, reason: 'tenant_mismatch' };
  if (typeof customerId !== 'string' || customerId.length === 0) return { ok: false, reason: 'customer_mismatch' };

  // 1) Contexto EXPLÍCITO. Sin esto, una foto de producto es una foto de producto: el sistema
  //    no adivina, aunque el archivo parezca visualmente un comprobante (ADR-0016 §4).
  if (!session.awaitingPaymentDeclared) return { ok: false, reason: 'no_explicit_payment_context' };

  const ownOrders = candidateOrders.filter((o) => o.customerId === customerId);

  // 2) El puntero declarado NO se cree a ciegas: se valida contra quien envía. Un puntero que
  //    apunta a un pedido de OTRA persona es corrupción de estado, no un caso a "arreglar"
  //    cayendo a otro pedido — se rechaza y el archivo queda como medio normal.
  const declared = session.pendingOrderId
    ? (candidateOrders.find((o) => o.orderId === session.pendingOrderId) ?? null)
    : null;
  if (declared && declared.customerId !== customerId) return { ok: false, reason: 'order_customer_mismatch' };

  // 3) Estado admisible y NO pagado. `isPaidStatus` cubre toda la cadena operativa (PAID en
  //    adelante): un pedido ya pagado no admite "otro" comprobante.
  const admisible = (o: ReceiptGateOrderFacts): boolean =>
    UNPAID_STATUSES.includes(o.status) && !isPaidStatus(o.status) && !isTerminal(o.status);

  // 4) EXACTAMENTE un pedido admisible del cliente. Este chequeo NO tiene atajos: ni el puntero
  //    declarado ni ninguna otra señal puede saltearlo. Dos admisibles ⇒ ambigüedad ⇒ nada se
  //    propone (fail-closed: el archivo se conserva y una persona decide).
  const admisibles = ownOrders.filter(admisible);
  if (admisibles.length > 1) return { ok: false, reason: 'ambiguous_orders' };
  if (admisibles.length === 0) {
    if (ownOrders.some((o) => isPaidStatus(o.status))) return { ok: false, reason: 'order_already_paid' };
    if (ownOrders.length > 0) return { ok: false, reason: 'order_not_admissible' };
    return { ok: false, reason: 'no_admissible_order' };
  }
  // Único admisible: si hay puntero declarado y es admisible, ES éste por construcción (está en
  // `ownOrders` y pasó el mismo filtro), así que no hace falta preferirlo explícitamente.
  const target = admisibles[0]!;

  // 5) Ventana temporal por tenant, medida desde que NACIÓ el pedido: es el único ancla que un
  //    reintento vuelve a calcular igual (no depende de cuántas veces se reprocesó el webhook).
  const ageMs = nowMs - target.createdAtMs;
  if (!Number.isFinite(ageMs) || ageMs > config.windowMs || ageMs < -RECEIPT_GATE_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'outside_time_window' };
  }

  return { ok: true, orderId: target.orderId };
}

// ---------------------------------------------------------------------------
// Gate — parte de ARCHIVO (necesita los bytes ya bajados y verificados)
// ---------------------------------------------------------------------------

export type ReceiptFileDecision = { ok: true } | { ok: false; reason: ReceiptGateDenyReason };

/**
 * ¿El archivo, tal como quedó guardado, puede sostener un comprobante? Solo mira hechos
 * técnicos: bytes guardados, no purgados, MIME VERIFICADO y tamaño real. El MIME declarado no
 * participa.
 */
export function evaluateReceiptFile(
  attachment: Pick<ReceiptGateAttachmentFacts, 'ingestState' | 'mimeVerified' | 'bytes' | 'purgedAtMs'>,
  config: ReceiptGateConfig,
): ReceiptFileDecision {
  if (!isAttachmentStored(attachment.ingestState)) return { ok: false, reason: 'attachment_not_stored' };
  // La purga borra los BYTES pero deja el documento (y su `ingestState: 'stored'`) para que el
  // chat siga mostrando que hubo un archivo. Sin este chequeo se podría proponer como comprobante
  // algo que ya nadie puede abrir: evidencia de pago que no existe.
  if (attachment.purgedAtMs !== null) return { ok: false, reason: 'attachment_purged' };
  if (!attachment.mimeVerified || !config.allowedMimeTypes.includes(attachment.mimeVerified)) {
    return { ok: false, reason: 'mime_not_allowed' };
  }
  const { bytes } = attachment;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0 || bytes > config.maxBytes) {
    return { ok: false, reason: 'size_not_allowed' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Gate completo
// ---------------------------------------------------------------------------

/**
 * Decisión completa del gate. Cualquier condición que falle ⇒ `generic_media` (jamás un error:
 * un rechazo no bloquea la conversación, el archivo se conserva y una persona puede vincularlo
 * después con el callable de marcar).
 */
export function evaluateReceiptGate(input: ReceiptGateInput): ReceiptGateDecision {
  const { tenantId, customerId, attachment, config } = input;

  // Aislamiento de tenant y de cliente ANTES que nada: un adjunto de otro tenant o de otra
  // persona no puede ni siquiera participar de la evaluación.
  if (attachment.tenantId !== tenantId) return deny('tenant_mismatch');
  if (attachment.customerId !== customerId) return deny('customer_mismatch');

  // Idempotencia por `(tenantId, attachmentId)`: si ESTE adjunto ya está propuesto, reevaluar no
  // puede cambiar la respuesta. Sin esto, un reintento del webhook horas después "des-propondría"
  // el candidato por ventana vencida, y el panel vería aparecer y desaparecer la sugerencia.
  if (attachment.classification === 'payment_receipt_candidate' && attachment.orderCandidateId) {
    return {
      ok: true,
      classification: 'payment_receipt_candidate',
      orderId: attachment.orderCandidateId,
      confidence: 1,
      alreadyLinked: true,
    };
  }
  // El gate automático solo opina sobre adjuntos SIN clasificar. Lo que ya clasificó una persona
  // (o un pase previo) no lo pisa una regla: degradar un `payment_receipt_linked` desde el
  // sistema fabricaría/destruiría evidencia sin que nadie lo haya decidido.
  if (attachment.classification !== 'unclassified') return deny('classification_not_open');

  const contexto = evaluateReceiptContext({
    tenantId,
    customerId,
    nowMs: input.nowMs,
    session: input.session,
    candidateOrders: input.candidateOrders,
    config,
  });
  if (!contexto.ok) return deny(contexto.reason);

  const archivo = evaluateReceiptFile(attachment, config);
  if (!archivo.ok) return deny(archivo.reason);

  // Idempotencia por `(orderId, attachmentId)`: el pedido ya tiene este adjunto ⇒ no se duplica.
  const target = input.candidateOrders.find((o) => o.orderId === contexto.orderId);
  const alreadyLinked = target?.linkedAttachmentIds.includes(attachment.attachmentId) ?? false;

  return {
    ok: true,
    classification: 'payment_receipt_candidate',
    orderId: contexto.orderId,
    confidence: 1,
    alreadyLinked,
  };
}

// ---------------------------------------------------------------------------
// Acción HUMANA: marcar / desmarcar (ADR-0016 §5 — el pago siempre es humano)
// ---------------------------------------------------------------------------

/** Motivos de rechazo de la acción humana. Cerrados y seguros de loguear. */
export type ReceiptMarkDenyReason =
  | 'tenant_mismatch'
  | 'attachment_not_stored'
  | 'attachment_purged'
  | 'order_customer_mismatch'
  | 'order_already_paid'
  | 'order_not_admissible'
  | 'linked_to_another_order'
  | 'classification_terminal'
  | 'illegal_classification_transition'
  | 'not_linked'
  | 'other_evidence_drives_status';

export interface ReceiptMarkOrderFacts extends ReceiptGateOrderFacts {
  /**
   * Comprobantes VINCULADOS POR UNA PERSONA que el pedido tiene hoy. Va aparte de
   * `linkedAttachmentIds` (que mezcla candidatos y vinculados para la idempotencia del gate)
   * porque el estado del pedido lo sostiene esta lista y solo esta lista.
   */
  linkedReceiptIds: readonly string[];
  /**
   * Cuál de esos vinculados figura como origen del `PENDING_VERIFICATION` vigente
   * (null = lo produjo otra cosa: flujo legacy, cambio manual). Es un PUNTERO dentro de la lista,
   * no la condición del estado: el estado se sostiene mientras quede AL MENOS UNO vinculado.
   */
  statusDrivenBy: string | null;
}

export interface ReceiptMarkInput {
  tenantId: string;
  attachment: ReceiptGateAttachmentFacts;
  order: ReceiptMarkOrderFacts;
}

export type ReceiptMarkDecision =
  | {
      ok: true;
      /** Ya estaba vinculado a ESTE pedido: la operación es un no-op idempotente. */
      alreadyMarked: boolean;
      /** Pasos de clasificación a aplicar, en orden, todos con actor `human`. */
      classificationPath: readonly AttachmentClassification[];
      /** true ⇒ el pedido pasa PENDING_PAYMENT → PENDING_VERIFICATION (jamás a PAID). */
      moveOrderToPendingVerification: boolean;
    }
  | { ok: false; reason: ReceiptMarkDenyReason };

/**
 * Camino legal hasta `payment_receipt_linked` para una mano humana. Se apoya en la máquina de
 * estados compartida: si la tabla cambia, esto falla en los tests en vez de inventar una arista.
 */
function pathToLinked(from: AttachmentClassification): readonly AttachmentClassification[] | null {
  const candidates: Record<AttachmentClassification, readonly AttachmentClassification[] | null> = {
    unclassified: ['payment_receipt_candidate', 'payment_receipt_linked'],
    generic_media: ['payment_receipt_candidate', 'payment_receipt_linked'],
    payment_receipt_candidate: ['payment_receipt_linked'],
    payment_receipt_linked: [],
    rejected: null,
  };
  const path = candidates[from];
  if (!path) return null;
  let cursor = from;
  for (const step of path) {
    if (!checkClassificationTransition(cursor, step, 'human').ok) return null;
    cursor = step;
  }
  return path;
}

/**
 * ¿Puede una persona autorizada marcar este adjunto como comprobante de este pedido?
 * La autorización por ROL ya la hizo el callable; acá se validan los hechos:
 * tenant, cliente del pedido, estado admisible, que NO esté pagado y que el archivo exista.
 *
 * Marcar llega hasta `PENDING_VERIFICATION`. NO confirma el pago: eso sigue siendo
 * `orderUpdateStatus` → `confirmPayment` (ORDER-1), con su propia auditoría.
 */
export function decideMarkAsReceipt(input: ReceiptMarkInput): ReceiptMarkDecision {
  const { tenantId, attachment, order } = input;

  if (attachment.tenantId !== tenantId) return { ok: false, reason: 'tenant_mismatch' };
  // El pedido tiene que ser DEL MISMO cliente que mandó el archivo: vincular el comprobante de
  // una persona al pedido de otra es exactamente la confusión que hay que impedir.
  if (order.customerId !== attachment.customerId) return { ok: false, reason: 'order_customer_mismatch' };
  if (isPaidStatus(order.status)) return { ok: false, reason: 'order_already_paid' };
  if (!UNPAID_STATUSES.includes(order.status)) return { ok: false, reason: 'order_not_admissible' };
  if (!isAttachmentStored(attachment.ingestState)) return { ok: false, reason: 'attachment_not_stored' };
  // Un adjunto PURGADO conserva `ingestState: 'stored'` (la purga borra bytes, no historia), así
  // que sin este chequeo se podía vincular como comprobante un archivo que ya no se puede abrir.
  if (attachment.purgedAtMs !== null) return { ok: false, reason: 'attachment_purged' };

  if (attachment.classification === 'payment_receipt_linked') {
    // Idempotente contra el MISMO pedido; contra otro, se rechaza: un archivo no puede ser el
    // comprobante oficial de dos pedidos a la vez.
    if (attachment.orderCandidateId === order.orderId) {
      return {
        ok: true,
        alreadyMarked: true,
        classificationPath: [],
        moveOrderToPendingVerification: false,
      };
    }
    return { ok: false, reason: 'linked_to_another_order' };
  }
  if (attachment.classification === 'rejected') return { ok: false, reason: 'classification_terminal' };
  if (
    attachment.classification === 'payment_receipt_candidate' &&
    attachment.orderCandidateId &&
    attachment.orderCandidateId !== order.orderId
  ) {
    return { ok: false, reason: 'linked_to_another_order' };
  }

  const path = pathToLinked(attachment.classification);
  if (!path) return { ok: false, reason: 'illegal_classification_transition' };

  return {
    ok: true,
    alreadyMarked: false,
    classificationPath: path,
    moveOrderToPendingVerification: order.status === 'PENDING_PAYMENT',
  };
}

export type ReceiptUnmarkDecision =
  | {
      ok: true;
      /** true ⇒ se revierte PENDING_VERIFICATION → PENDING_PAYMENT (nunca otro estado). */
      revertOrderToPendingPayment: boolean;
      /**
       * Puntero `statusDrivenBy` que queda después de desmarcar. Cuando el adjunto que figuraba
       * como origen se va pero quedan OTROS comprobantes vinculados, el puntero se TRASPASA a uno
       * de ellos en vez de revertir el pedido.
       */
      nextStatusDrivenBy: string | null;
    }
  | { ok: false; reason: ReceiptMarkDenyReason };

/**
 * ¿Puede desmarcarse? Solo si el pedido NO está pagado y si el `PENDING_VERIFICATION` lo sostiene
 * la lista de comprobantes vinculados de este pedido.
 *
 * POR QUÉ mira la LISTA y no un puntero único: con dos comprobantes (el cliente manda dos
 * archivos y el vendedor marca los dos), el segundo no mueve el estado —ya estaba en
 * `PENDING_VERIFICATION`— así que el puntero seguía apuntando al primero. Desmarcar el primero
 * devolvía el pedido a `PENDING_PAYMENT` **con el segundo comprobante todavía vinculado por una
 * persona**: se borraba una decisión humana sin que nadie la revocara. La regla correcta es que
 * el estado se sostiene mientras quede AL MENOS UN comprobante vinculado.
 *
 * Si el estado lo produjo algo que NO está en esa lista (flujo legacy, cambio manual), no se
 * toca: se rechaza en vez de revertir un estado ajeno.
 *
 * El adjunto se PRESERVA como `generic_media`: desmarcar quita significado, nunca borra el
 * archivo ni su historia.
 */
export function decideUnmarkReceipt(input: ReceiptMarkInput): ReceiptUnmarkDecision {
  const { tenantId, attachment, order } = input;

  if (attachment.tenantId !== tenantId) return { ok: false, reason: 'tenant_mismatch' };
  if (attachment.classification !== 'payment_receipt_linked') return { ok: false, reason: 'not_linked' };
  if (attachment.orderCandidateId !== order.orderId) return { ok: false, reason: 'linked_to_another_order' };
  if (order.customerId !== attachment.customerId) return { ok: false, reason: 'order_customer_mismatch' };
  if (isPaidStatus(order.status)) return { ok: false, reason: 'order_already_paid' };
  // CANCELLED / REFUNDED son registro permanente: no se reabren desde acá.
  if (!UNPAID_STATUSES.includes(order.status)) return { ok: false, reason: 'order_not_admissible' };
  if (!checkClassificationTransition(attachment.classification, 'generic_media', 'human').ok) {
    return { ok: false, reason: 'illegal_classification_transition' };
  }

  if (order.status === 'PENDING_VERIFICATION') {
    // Qué comprobantes vinculados SOBREVIVEN a este desmarcado.
    const restantes = order.linkedReceiptIds.filter((id) => id !== attachment.attachmentId);
    const drivenBy = order.statusDrivenBy;

    // PUNTERO NULO: el `PENDING_VERIFICATION` NO lo produjo este camino. Pasa de verdad — el
    // pedido ya venía en verificación por el flujo legacy (`submitComprobante`) o por una
    // corrección manual, así que cuando la persona vinculó el adjunto no hubo cambio de estado y
    // el puntero nunca se escribió.
    //
    // Antes esto caía en `other_evidence_drives_status` y quedaba TRABADO PARA SIEMPRE, con un
    // mensaje que mandaba a desmarcar "ese otro comprobante" que no existe: el adjunto quedaba
    // marcado como comprobante sin forma de revocarlo, mostrando evidencia de pago que nadie
    // podía sacar del pedido. Desmarcar es revocar una decisión HUMANA y tiene que poder hacerse
    // siempre; lo que se protege es OTRA cosa —no revertir un estado que este camino no produjo
    // (ADR-0016 §5)— y eso se sigue cumpliendo: el pedido queda donde está.
    if (drivenBy === null) {
      return { ok: true, revertOrderToPendingPayment: false, nextStatusDrivenBy: null };
    }

    if (drivenBy === attachment.attachmentId) {
      // Éste figuraba como origen del estado. Mientras quede otro comprobante vinculado, el
      // estado SIGUE sostenido: se traspasa el puntero en vez de revertir el pedido (si no, se
      // perdería la decisión humana que vinculó al otro).
      if (restantes.length > 0) {
        return { ok: true, revertOrderToPendingPayment: false, nextStatusDrivenBy: restantes[0]! };
      }
      return { ok: true, revertOrderToPendingPayment: true, nextStatusDrivenBy: null };
    }
    // El estado lo sostiene OTRO comprobante que sigue vinculado ⇒ sacar éste no lo cambia.
    if (restantes.includes(drivenBy)) {
      return { ok: true, revertOrderToPendingPayment: false, nextStatusDrivenBy: drivenBy };
    }
    // Queda un solo caso: el puntero NOMBRA a otro adjunto que este pedido ya no lista como
    // vinculado. Ahí sí hay un origen declarado que no controlamos desde acá, y desmarcar sin
    // entenderlo puede borrar la única referencia a la evidencia que movió el pedido.
    return { ok: false, reason: 'other_evidence_drives_status' };
  }
  // Fuera de `PENDING_VERIFICATION` el puntero no gobierna nada, pero si apuntaba a ESTE adjunto
  // se limpia: dejarlo colgado a algo que ya no está vinculado es basura que confunde después.
  return {
    ok: true,
    revertOrderToPendingPayment: false,
    nextStatusDrivenBy: order.statusDrivenBy === attachment.attachmentId ? null : order.statusDrivenBy,
  };
}
