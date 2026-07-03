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
import type { Customer, Message } from '@vpw/shared';
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

export interface ManualMessageDeps {
  getCustomer: (tenantId: string, customerId: string) => Promise<Customer | null>;
  /**
   * humanTakeover desde la SESIÓN (fuente de verdad). El resumen del customer puede quedar
   * desfasado: submitComprobante solo actualiza la sesión y el resumen recién se sincroniza
   * con el próximo appendMessage — validar contra el resumen bloqueaba al vendedor justo
   * después del comprobante (el caso central de HUMAN-HANDOFF-1).
   */
  getTakeover: (tenantId: string, customerId: string) => Promise<boolean | null>;
  getClient: (tenantId: string, phoneNumberId: string | null) => Promise<WhatsAppClient>;
  append: (tenantId: string, customerId: string, input: AppendMessageInput) => Promise<Message>;
}

export const defaultManualMessageDeps: ManualMessageDeps = {
  getCustomer: async (t, c) => {
    const snap = await db().doc(paths.customer(t, c)).get();
    return snap.exists ? (snap.data() as Customer) : null;
  },
  getTakeover: async (t, c) => {
    const snap = await db().doc(paths.session(t, c)).get();
    if (!snap.exists) return null; // sin sesión → decide el resumen del customer
    return (snap.data() as { context?: { humanTakeover?: boolean } }).context?.humanTakeover === true;
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
  const sessionTakeover = await deps.getTakeover(input.tenantId, input.customerId);
  const humanTakeover = sessionTakeover ?? conv?.humanTakeover === true;
  if (!humanTakeover && !OVERRIDE_ROLES.has(sender.role)) {
    throw new HttpsError(
      'failed-precondition',
      'El bot está atendiendo este chat. Tocá "Tomar conversación" antes de escribir.',
    );
  }

  // Enviar por el MISMO número que recibió la conversación (multi-número); sin receivedVia
  // (conversaciones viejas) el cliente resuelve el número principal del tenant.
  const phoneNumberId = conv?.receivedVia ?? null;
  const client = await deps.getClient(input.tenantId, phoneNumberId);
  const to = customer.whatsappPhone || input.customerId;
  const res = await client.sendText(to, text, { tenantId: input.tenantId, channel: 'whatsapp' });
  if (!res.ok) {
    // El detalle del rechazo ya quedó en el log del cliente (sin token). Al panel, error accionable.
    logger.warn('Mensaje manual: WhatsApp rechazó el envío', { tenantId: input.tenantId, customerId: input.customerId });
    throw new HttpsError('unavailable', 'WhatsApp no aceptó el mensaje. Probá de nuevo en un momento.');
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
    customerId: input.customerId,
    chars: text.length,
    viaMock: !!res.viaMock,
    phoneNumberId: phoneNumberId ?? '(principal)',
  });
  return { ok: true, viaMock: !!res.viaMock, waMessageId: res.id ?? null };
}
