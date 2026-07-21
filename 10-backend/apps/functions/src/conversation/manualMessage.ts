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
import { getWhatsAppClient, type WhatsAppClient } from '../messaging/whatsappClient.js';

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
  getGateContext: (tenantId: string, customerId: string) => Promise<ManualGateContext>;
  getClient: (tenantId: string, phoneNumberId: string | null) => Promise<WhatsAppClient>;
  append: (tenantId: string, customerId: string, input: AppendMessageInput) => Promise<Message>;
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
  getGateContext: async (t, c) => {
    const snap = await db().doc(paths.session(t, c)).get();
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
  getClient: (t, pnid) => getWhatsAppClient(t, undefined, pnid),
  append: appendMessage,
};

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

  const customer = await deps.getCustomer(input.tenantId, input.customerId);
  if (!customer) throw new HttpsError('not-found', 'Esa conversación no existe.');

  const conv = (customer as { conversation?: { humanTakeover?: boolean; receivedVia?: string | null } }).conversation;
  // Sesión (fuente de verdad) con fallback al resumen del customer (conversaciones sin sesión).
  const gate = await deps.getGateContext(input.tenantId, input.customerId);
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
  if (gateActivo && blocksManualShippingSend(text, gate.shippingQuote!)) {
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
  const res = await client.sendText(to, text, { tenantId: input.tenantId, channel: 'whatsapp' });
  if (!res.ok) {
    // SHIPPING-CHAT-3B-HARDEN: rejected ≠ unknown. Un RECHAZO CONFIRMADO (4xx de Meta) admite
    // reintento; un resultado DESCONOCIDO (timeout/5xx/2xx sin wamid) NO — el mensaje PUDO haber
    // salido y un reintento ciego lo duplicaría al cliente. En ninguno se persiste el mensaje
    // (el historial no miente) ni se loguea texto/teléfono/PNID completos.
    if (res.outcome === 'rejected') {
      logger.warn('Mensaje manual: WhatsApp rechazó el envío (confirmado)', {
        tenantId: input.tenantId,
        customerId: maskPhone(input.customerId),
        outcome: res.outcome,
        providerCode: res.providerCode,
      });
      throw new HttpsError('unavailable', 'WhatsApp no aceptó el mensaje. Probá de nuevo en un momento.', {
        kind: 'whatsapp_send_rejected',
      });
    }
    logger.warn('Mensaje manual: resultado de envío desconocido', {
      tenantId: input.tenantId,
      customerId: maskPhone(input.customerId),
      outcome: res.outcome,
    });
    throw new HttpsError('unavailable', 'No pudimos confirmar si el mensaje salió. Revisá el chat de WhatsApp antes de reenviarlo.', {
      kind: 'whatsapp_send_unknown',
    });
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
