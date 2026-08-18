/**
 * conversation/manualMessage.ts — Mensaje HUMANO del vendedor por WhatsApp (HUMAN-HANDOFF-1)
 * ==========================================================================================
 * El hueco que cierra: al llegar un comprobante el bot se pausa (humanTakeover) pero el
 * vendedor no tenía forma de responder desde el panel POR EL MISMO número de WhatsApp.
 *
 * Diseño:
 *  - SELLER solo puede escribir con el chat en atención humana (humanTakeover=true) — es su
 *    cola de trabajo. MANAGER/OWNER/PLATFORM_ADMIN pueden escribir siempre (override manual,
 *    p.ej. una aclaración urgente) — enviar NUNCA cambia el estado del bot.
 *  - El envío sale por el MISMO número que recibió la conversación (receivedVia → cliente
 *    multi-número de F3/MULTI-NUMBER); live/mock lo decide getWhatsAppClient (config del
 *    tenant): en mock el mensaje se persiste y se loguea, sin tocar Meta.
 *  - Primero se envía, después se persiste: si Meta rechaza en live, el vendedor ve el error
 *    y el historial no queda mintiendo. El texto persiste como author 'seller' con la
 *    metadata del emisor (uid/nombre) y el wamid de Meta si existe.
 *  - Acá NUNCA se llama a la IA: es un mensaje humano, punto.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import type { Customer, Message, CoverageStatus, CoverageActivation, ShippingQuotePolicy, CoverageRequest } from '@vpw/shared';
import { coverageActivationOf, shippingQuotePolicyOf, blocksManualShippingSend, maskPhone } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { appendMessage, type AppendMessageInput } from './messages.js';
import { getWhatsAppClient, type SendResult, type WhatsAppClient } from '../messaging/whatsappClient.js';
import { canalDePlataformaNoWhatsapp, resolverCanalDePnid } from './canal.js';

/** Tope de la Cloud API para texto (Meta rechaza >4096; validamos antes de gastar el request). */
export const MANUAL_MESSAGE_MAX_CHARS = 4096;

export interface ManualMessageInput {
  tenantId: string;
  customerId: string;
  text: string;
}

export interface ManualMessageSender {
  uid: string;
  role: string;
  name?: string;
}

export interface ManualMessageResult {
  ok: true;
  /** true = modo mock: quedó en el historial pero NO salió a WhatsApp. */
  viaMock: boolean;
  /** wamid de Meta si el envío fue live y Meta lo devolvió. */
  waMessageId: string | null;
}

/** Roles que pueden escribir SIN handoff activo (override manual). */
const OVERRIDE_ROLES = new Set(['TENANT_MANAGER', 'TENANT_OWNER', 'PLATFORM_ADMIN']);

/**
 * SHIPPING-CHAT-3B — Contexto del GATE del mensaje manual (inyectable y testeable).
 * Costo de lecturas HONESTO del default: la sesión ya se leía para el takeover (el pointer de
 * cobertura sale de la MISMA lectura — 0 extra); `config/checkout` es 1 lectura extra SOLO con
 * pointer en estado de cobertura activa; con pointer `coverage_approved` y política != off se
 * suma 1 lectura del request para saber si la reanudación terminó. Chats sin cobertura: 0 extra.
 */
export interface ManualGateContext {
  /** humanTakeover desde la SESIÓN (fuente de verdad); null = sin sesión (decide el resumen). */
  humanTakeover: boolean | null;
  /** Puntero de cobertura de la sesión (sin PII). */
  coveragePointer: { requestId: string; status: CoverageStatus } | null;
  /** Activación validada (solo si se leyó config — pointer activo). */
  activation: CoverageActivation | null;
  /** Política de cotización (mismo snapshot de config que `activation`). */
  shippingQuote: ShippingQuotePolicy | null;
  /** true = la reanudación del request aprobado terminó (solo se resuelve cuando hace falta). */
  resumeDone: boolean | null;
}

export interface ManualMessageDeps {
  getCustomer: (tenantId: string, customerId: string) => Promise<Customer | null>;
  /**
   * Contexto del gate (OBLIGATORIO — jamás opcional: un dep ausente sería fail-open).
   * humanTakeover desde la SESIÓN (fuente de verdad): el resumen del customer puede quedar
   * desfasado (submitComprobante solo actualiza la sesión) — validar contra el resumen
   * bloqueaba al vendedor justo después del comprobante (caso central de HUMAN-HANDOFF-1).
   */
  getGateContext: (tenantId: string, customerId: string, sessionKey: string) => Promise<ManualGateContext>;
  /**
   * ADR-0017 §2: el CANAL de esta conversación. Se le pregunta a la autoridad a partir del mismo
   * `receivedVia` que ya elige por qué número SALE el mensaje, para que el gate y el envío no
   * puedan terminar mirando conversaciones distintas.
   */
  resolverCanal: (tenantId: string, receivedVia: string | null) => Promise<string>;
  getClient: (tenantId: string, phoneNumberId: string | null) => Promise<WhatsAppClient>;
  append: (tenantId: string, customerId: string, input: AppendMessageInput) => Promise<Message>;
  /**
   * ADR-0021 §3: limpiar `archived/archivedAt/archivedBy` cuando un envío manual AUTORIZADO sale
   * sobre una conversación archivada (misma semántica que el desarchivado por entrante de
   * messages.ts). OPCIONAL a propósito: su ausencia solo omite el desarchivado —jamás abre ni
   * cierra el envío—, así los tests existentes (fixtures sin flags) no cambian de comportamiento.
   */
  desarchivarConversacion?: (tenantId: string, customerId: string) => Promise<void>;
}

/** Estados del puntero con cobertura ACTIVA para el gate (approved requiere mirar el resume). */
const GATE_POINTER_STATUSES: ReadonlySet<CoverageStatus> = new Set<CoverageStatus>([
  'awaiting_location',
  'pending_coverage_review',
  'coverage_approved',
]);

export const defaultManualMessageDeps: ManualMessageDeps = {
  getCustomer: async (t, c) => {
    const snap = await db().doc(paths.customer(t, c)).get();
    return snap.exists ? (snap.data() as Customer) : null;
  },
  getGateContext: async (t, c, sessionKey) => {
    const snap = await db().doc(paths.session(t, c, sessionKey)).get();
    if (!snap.exists) return { humanTakeover: null, coveragePointer: null, activation: null, shippingQuote: null, resumeDone: null };
    const ctx = (snap.data() as { context?: { humanTakeover?: boolean; coverage?: { requestId?: string; status?: CoverageStatus } | null } }).context;
    const humanTakeover = ctx?.humanTakeover === true;
    const ptr = ctx?.coverage && typeof ctx.coverage.requestId === 'string' && typeof ctx.coverage.status === 'string'
      ? { requestId: ctx.coverage.requestId, status: ctx.coverage.status }
      : null;
    if (!ptr || !GATE_POINTER_STATUSES.has(ptr.status)) {
      return { humanTakeover, coveragePointer: ptr, activation: null, shippingQuote: null, resumeDone: null };
    }
    // Pointer activo ⇒ 1 lectura de config (activación + política del MISMO snapshot).
    // Fail-closed DELIBERADO: si esta lectura falla transitoriamente, el error se propaga y el
    // mensaje manual falla — jamás se envía "a ciegas" sin conocer la política con cobertura activa.
    const cfg = (await db().doc(`tenants/${t}/config/checkout`).get()).data() as { coverage?: unknown } | undefined;
    const activation = coverageActivationOf(cfg?.coverage);
    const shippingQuote = shippingQuotePolicyOf(cfg?.coverage);
    let resumeDone: boolean | null = null;
    if (ptr.status === 'coverage_approved' && activation.enabled && shippingQuote.status !== 'off') {
      // Solo acá hace falta saber si la reanudación terminó (1 lectura del request). Un fallo
      // de lectura se trata como NO terminada (conservador: el gate aplica).
      try {
        const req = (await db().doc(`tenants/${t}/coverageRequests/${ptr.requestId}`).get()).data() as CoverageRequest | undefined;
        resumeDone = req?.resume?.status === 'done';
      } catch {
        resumeDone = false;
      }
    }
    return { humanTakeover, coveragePointer: ptr, activation, shippingQuote, resumeDone };
  },
  // ADR-0017 §1: el ÚNICO origen humano del sistema. Se declara acá y no se deduce del PNID: es
  // lo que le permite al vendedor seguir contestando por el panel de un número en `shadow` (donde
  // atiende a mano) sin que ese mismo permiso se lo lleve puesto un job automático.
  getClient: (t, pnid) => getWhatsAppClient(t, undefined, pnid, 'humano'),
  resolverCanal: resolverCanalDePnid,
  append: appendMessage,
  // Merge de hoja: solo la terna de archivado — nunca toca softDeleted ni el resto del resumen.
  desarchivarConversacion: async (t, c) => {
    await db()
      .doc(paths.customer(t, c))
      .set({ conversation: { archived: false, archivedAt: null, archivedBy: null } }, { merge: true });
  },
};

/**
 * ADR-0021 §5 — GUARD COMPARTIDO DEL ENVÍO MANUAL (un solo camino de routing)
 * ===========================================================================
 * Texto y media salen por EXACTAMENTE la misma secuencia: cliente existe → dispatcher por canal
 * fail-closed → sessionKey por `receivedVia` → takeover/override → gate de cotización → cliente
 * de WhatsApp por el PNID de la conversación con origen 'humano'. Antes esta secuencia vivía
 * dentro de `sendManualMessage`; se extrae para que el envío de adjuntos no pueda tener una
 * versión propia (dos guards divergen, y el laxo es el que filtra).
 *
 * `textoParaGate` es el texto VISIBLE que va a salir hacia el cliente: el cuerpo del mensaje en
 * texto, el CAPTION en un adjunto. El gate de cotización lo evalúa igual en ambos — si no, el
 * caption sería la puerta trasera exacta que el gate existe para cerrar.
 */
export type EnvioManualGuardDeps = Pick<
  ManualMessageDeps,
  'getCustomer' | 'getGateContext' | 'resolverCanal' | 'getClient' | 'desarchivarConversacion'
>;

export interface EnvioManualGuardInput {
  tenantId: string;
  customerId: string;
  /** Texto visible que saldría (mensaje o caption). Puede ser '' (adjunto sin caption). */
  textoParaGate: string;
}

export interface EnvioManualResuelto {
  customer: Customer;
  /** PNID que RECIBIÓ la conversación (null = principal / conversación legacy). */
  phoneNumberId: string | null;
  /** Destino del envío (whatsappPhone || customerId). */
  to: string;
  client: WhatsAppClient;
}

export async function resolverEnvioManual(
  input: EnvioManualGuardInput,
  sender: ManualMessageSender,
  deps: EnvioManualGuardDeps,
  /** Prefijo de los logs (permite distinguir texto de adjuntos sin duplicar el guard). */
  contexto = 'Mensaje manual',
): Promise<EnvioManualResuelto> {
  const customer = await deps.getCustomer(input.tenantId, input.customerId);
  if (!customer) throw new HttpsError('not-found', 'Esa conversación no existe.');

  const conv = (customer as {
    conversation?: {
      humanTakeover?: boolean;
      receivedVia?: string | null;
      channel?: string | null;
      archived?: boolean;
      softDeleted?: boolean;
    };
  }).conversation;
  /**
   * ADR-0021 §3 — una conversación con eliminación LÓGICA no acepta envíos manuales (texto NI
   * adjuntos: este guard es el único camino). Se exige restaurar primero: escribirle a un chat
   * "eliminado" lo resucitaría en silencio y el vendedor no sabría que estaba descartado.
   */
  if (conv?.softDeleted === true) {
    throw new HttpsError(
      'failed-precondition',
      'Esta conversación está eliminada. Restaurala desde la bandeja antes de enviar mensajes.',
      { kind: 'conversation_deleted' },
    );
  }
  /**
   * DISPATCHER POR CANAL (H2 / ADR-0017 §2) — el transporte se decide ANTES que cualquier otra
   * cosa. `getWhatsAppClient` es el único sender implementado: para una conversación de
   * Instagram/Messenger no existe por dónde mandar, así que se RECHAZA fail-closed acá mismo —
   * sin burbuja persistida y sin decir «enviado». Reutilizar WhatsApp como fallback filtraba el
   * contenido del chat a un número (`whatsappPhone`/`customerId`) que puede ser de OTRA persona.
   * La decisión sale de `canalDePlataformaNoWhatsapp` — la MISMA regla que usa el panel — para
   * que el dispatcher y el resto del sistema no puedan divergir.
   */
  const canalPlataforma = canalDePlataformaNoWhatsapp(conv?.channel);
  if (canalPlataforma !== null) {
    // La plataforma no es PII (es 'instagram'/'messenger'); el teléfono va enmascarado como siempre.
    logger.warn(`${contexto}: la conversación es de otra plataforma y no hay sender implementado`, {
      tenantId: input.tenantId,
      customerId: maskPhone(input.customerId),
      channel: conv?.channel ?? null,
    });
    throw new HttpsError(
      'failed-precondition',
      'Todavía no se puede responder conversaciones de Instagram/Messenger desde el panel. El mensaje NO se envió.',
      { kind: 'channel_send_unsupported' },
    );
  }
  /**
   * ADR-0017 §2 — el gate se evalúa contra la conversación QUE EL VENDEDOR ESTÁ MIRANDO. Leyendo
   * siempre `sessions/active`, los dos errores posibles eran igual de malos: rebotarle su propio
   * mensaje («tocá Tomar conversación») sobre un chat que ya tomó, o dar por bueno el takeover del
   * otro número y saltear el gate de cotización de envío escribiéndole al cliente igual.
   *
   * Llegado acá la conversación es de WhatsApp (el dispatcher ya rechazó las otras plataformas),
   * así que el canal se resuelve con la autoridad del número receptor.
   */
  const sessionKey = await deps.resolverCanal(input.tenantId, conv?.receivedVia ?? null);
  // Sesión (fuente de verdad) con fallback al resumen del customer (conversaciones sin sesión).
  const gate = await deps.getGateContext(input.tenantId, input.customerId, sessionKey);
  const humanTakeover = gate.humanTakeover ?? conv?.humanTakeover === true;
  if (!humanTakeover && !OVERRIDE_ROLES.has(sender.role)) {
    throw new HttpsError(
      'failed-precondition',
      'El bot está atendiendo este chat. Tocá "Tomar conversación" antes de escribir.',
    );
  }

  // SHIPPING-CHAT-3B — GATE AUTORITATIVO server-side (la ayuda de UI del panel NO es autoridad):
  // con Coverage activo + cotización obligatoria (o config inválida ⇒ fail-closed) y el cliente
  // en revisión de cobertura (o aprobado con reanudación sin terminar), un texto con costo de
  // envío NO puede salir como mensaje manual común — el cliente vería un precio que jamás
  // llegaría al pedido. Aplica a TODOS los roles por igual (incl. PLATFORM_ADMIN). Corre ANTES
  // de resolver el cliente, enviar, persistir o auditar; jamás loguea el texto ni el monto.
  const ptr = gate.coveragePointer;
  const gateActivo =
    !!ptr &&
    gate.activation?.enabled === true &&
    !!gate.shippingQuote &&
    gate.shippingQuote.status !== 'off' &&
    (ptr.status === 'awaiting_location' ||
      ptr.status === 'pending_coverage_review' ||
      (ptr.status === 'coverage_approved' && gate.resumeDone !== true));
  if (gateActivo && blocksManualShippingSend(input.textoParaGate, gate.shippingQuote!)) {
    throw new HttpsError(
      'failed-precondition',
      'El mensaje contiene un costo de envío: usá "Informar costo de envío" para enviarlo y aprobar la cobertura.',
      { kind: 'shipping_quote_required' },
    );
  }

  // Enviar por el MISMO número que recibió la conversación (multi-número); sin receivedVia
  // (conversaciones viejas) el cliente resuelve el número principal del tenant.
  const phoneNumberId = conv?.receivedVia ?? null;
  const client = await deps.getClient(input.tenantId, phoneNumberId);
  const to = customer.whatsappPhone || input.customerId;

  /**
   * ADR-0021 §3 — el envío manual AUTORIZADO desarchiva (comportamiento WhatsApp, simétrico al
   * desarchivado por entrante de messages.ts). Corre al FINAL del guard a propósito: un rechazo
   * previo (canal no soportado, takeover faltante, gate de cotización) NO debe desarchivar nada.
   * Se desarchiva ANTES del transporte: si Meta después rechaza, la conversación queda visible en
   * la bandeja donde el vendedor ya está actuando — el estado honesto, no un efecto a revertir.
   */
  if (conv?.archived === true) {
    await deps.desarchivarConversacion?.(input.tenantId, input.customerId);
  }
  return { customer, phoneNumberId, to, client };
}

/**
 * Mapeo COMPARTIDO de un envío `!ok` a su HttpsError (ADR-0021 §5). Devuelve —no lanza— para
 * que el camino de adjuntos pueda COMPENSAR (liberar su reserva, marcar el adjunto) antes de
 * propagar exactamente el mismo error que el texto. Semántica intacta de SHIPPING-CHAT-3B-HARDEN:
 *  - blocked: NO-ENVÍO confirmado (cero HTTP) ⇒ failed-precondition accionable, sin burbuja.
 *  - rejected ≠ unknown: el rechazo confirmado admite reintento; el desconocido NO (el mensaje
 *    PUDO salir y un reintento ciego lo duplicaría al cliente).
 * Nunca loguea texto/teléfono/PNID completos.
 */
export function errorDeEnvioManualNoOk(
  res: Extract<SendResult, { ok: false }>,
  ctx: { tenantId: string; customerId: string; contexto?: string },
): HttpsError {
  const etiqueta = ctx.contexto ?? 'Mensaje manual';
  if (res.outcome === 'blocked') {
    logger.warn(`${etiqueta}: el canal no tiene permiso para enviar (ADR-0017)`, {
      tenantId: ctx.tenantId,
      customerId: maskPhone(ctx.customerId),
      reason: res.reason,
    });
    return new HttpsError(
      'failed-precondition',
      'Ese número todavía no tiene habilitado el envío de mensajes. El mensaje NO se envió: pedí que se active el número antes de volver a intentar.',
      { kind: 'whatsapp_channel_blocked' },
    );
  }
  if (res.outcome === 'rejected') {
    logger.warn(`${etiqueta}: WhatsApp rechazó el envío (confirmado)`, {
      tenantId: ctx.tenantId,
      customerId: maskPhone(ctx.customerId),
      outcome: res.outcome,
      providerCode: res.providerCode,
    });
    return new HttpsError('unavailable', 'WhatsApp no aceptó el mensaje. Probá de nuevo en un momento.', {
      kind: 'whatsapp_send_rejected',
    });
  }
  logger.warn(`${etiqueta}: resultado de envío desconocido`, {
    tenantId: ctx.tenantId,
    customerId: maskPhone(ctx.customerId),
    outcome: res.outcome,
  });
  return new HttpsError('unavailable', 'No pudimos confirmar si el mensaje salió. Revisá el chat de WhatsApp antes de reenviarlo.', {
    kind: 'whatsapp_send_unknown',
  });
}

export async function sendManualMessage(
  input: ManualMessageInput,
  sender: ManualMessageSender,
  deps: ManualMessageDeps = defaultManualMessageDeps,
): Promise<ManualMessageResult> {
  const text = (input.text ?? '').trim();
  if (!text) throw new HttpsError('invalid-argument', 'Escribí un mensaje antes de enviar.');
  if (text.length > MANUAL_MESSAGE_MAX_CHARS) {
    throw new HttpsError('invalid-argument', `El mensaje es demasiado largo (máx. ${MANUAL_MESSAGE_MAX_CHARS} caracteres).`);
  }

  // Guard compartido (ADR-0021 §5): canal → sessionKey → takeover/override → gate → PNID exacto.
  const { phoneNumberId, to, client } = await resolverEnvioManual(
    { tenantId: input.tenantId, customerId: input.customerId, textoParaGate: text },
    sender,
    deps,
  );

  const res = await client.sendText(to, text, { tenantId: input.tenantId, channel: 'whatsapp' });
  if (!res.ok) {
    // ADR-0017 §1 / SHIPPING-CHAT-3B-HARDEN: en ningún caso se persiste burbuja (el historial no
    // miente). El mapeo del error vive en `errorDeEnvioManualNoOk`, compartido con los adjuntos.
    throw errorDeEnvioManualNoOk(res, { tenantId: input.tenantId, customerId: input.customerId });
  }

  // Persistir DESPUÉS del envío OK (mock también persiste: el historial es la verdad del panel).
  // humanTakeover NO se toca: enviar un mensaje humano jamás cambia quién atiende.
  await deps.append(input.tenantId, input.customerId, {
    direction: 'out',
    author: 'seller',
    text,
    channel: 'whatsapp',
    receivedVia: phoneNumberId,
    senderUid: sender.uid,
    senderName: sender.name ?? null,
    waMessageId: res.id ?? null,
    viaMock: !!res.viaMock,
  });

  logger.info('Mensaje manual enviado', {
    tenantId: input.tenantId,
    customerId: maskPhone(input.customerId),
    chars: text.length,
    viaMock: !!res.viaMock,
    phoneNumberId: phoneNumberId ? maskPhone(phoneNumberId) : '(principal)',
  });
  return { ok: true, viaMock: !!res.viaMock, waMessageId: res.id ?? null };
}
