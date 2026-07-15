/**
 * conversation/handoff.ts — Tomar / devolver el chat (F6b · P5)
 * ============================================================
 * El vendedor "toma" el chat para atender en persona (el bot se calla) y lo
 * "libera" cuando termina (recién ahí el bot vuelve a responder, no al confirmar
 * el pago). Ver decisión 2026-06-16. Estos eventos quedan en el historial como
 * mensajes 'system' para que se vean en la conversación.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Session } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { appendMessage, markConversationRead } from './messages.js';

export interface HandoffResult {
  ok: boolean;
  message: string;
}

/** Mantengo el alias por compatibilidad con código existente. */
export type ReleaseResult = HandoffResult;

/** HANDOFF-2: razón estructurada de todo takeover (auditable en la sesión). */
export type HandoffReason = 'customer_requested' | 'payment_verification' | 'coverage_review' | 'seller_manual';

export interface ExecuteHandoffOptions {
  reason: HandoffReason;
  sellerName?: string | null;
  sellerUid?: string | null;
  /** Id determinístico del disparador (wamid entrante / orderId): idempotencia de notificación. */
  sourceId?: string | null;
  /** payment_verification: puntero de orden (comportamiento previo de submitComprobante). */
  pendingOrderId?: string | null;
  /** customer_requested puede llegar en el PRIMER mensaje (sesión aún no creada). */
  createSessionIfMissing?: boolean;
  /**
   * Panel (seller_manual): tomar un chat YA tomado lo REASIGNA al nuevo vendedor (comportamiento
   * histórico de takeoverChat). Los handoffs automáticos NO reasignan (idempotencia estricta).
   */
  reassignIfTaken?: boolean;
}
export interface ExecuteHandoffResult {
  ok: boolean;
  /** true = la conversación YA estaba en takeover (idempotente: sin nuevas escrituras/avisos). */
  already: boolean;
  /** true = estaba tomada y se REASIGNÓ al nuevo vendedor (solo con reassignIfTaken). */
  reassigned?: boolean;
}

/**
 * HANDOFF-2: transición CANÓNICA a atención humana — transaccional e idempotente.
 * La usan: el pedido del cliente (customer_requested), el comprobante (payment_verification)
 * y el panel (seller_manual). Escribe la sesión en UNA transacción (si ya está en takeover no
 * toca nada) y sincroniza el resumen del cliente para el panel. La CONFIRMACIÓN al cliente la
 * envía el caller DESPUÉS de que esto persista — nunca antes.
 */
export async function executeHandoff(
  tenantId: string,
  customerId: string,
  opts: ExecuteHandoffOptions,
): Promise<ExecuteHandoffResult> {
  const ref = db().doc(paths.session(tenantId, customerId));
  const now = Timestamp.now();
  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists && !opts.createSessionIfMissing) return { ok: false, already: false };
    const ctx = (snap.data()?.context ?? {}) as { humanTakeover?: boolean };
    if (snap.exists && ctx.humanTakeover === true) {
      if (!opts.reassignIfTaken) {
        // Review: el comprobante que llega con el chat YA tomado debe actualizar igual el
        // puntero de orden (el código previo lo escribía incondicional).
        if (opts.pendingOrderId !== undefined) {
          tx.update(ref, { 'context.pendingOrderId': opts.pendingOrderId, updatedAt: now });
        }
        return { ok: true, already: true };
      }
      tx.update(ref, {
        'context.handoffReason': opts.reason,
        'context.handoffSellerName': opts.sellerName ?? null,
        'context.handoffAt': now,
        'context.handoffSourceId': opts.sourceId ?? null,
        updatedAt: now,
      });
      return { ok: true, already: true, reassigned: true };
    }
    if (snap.exists) {
      const cambios: Record<string, unknown> = {
        'context.humanTakeover': true,
        // F3: la oferta del bot muere al entrar un humano — un "sí" dirigido al vendedor jamás
        // debe agregar el producto que el bot había ofrecido antes de la pausa.
        'context.pendingCartConfirmation': null,
        'context.handoffReason': opts.reason,
        'context.handoffSellerName': opts.sellerName ?? null,
        'context.handoffAt': now,
        'context.handoffSourceId': opts.sourceId ?? null,
        updatedAt: now,
      };
      if (opts.pendingOrderId !== undefined) cambios['context.pendingOrderId'] = opts.pendingOrderId;
      tx.update(ref, cambios);
    } else {
      const session: Session = {
        id: 'active',
        tenantId,
        customerId,
        state: 'IDLE',
        cart: { items: [], subtotal: 0 },
        context: {
          lastMessageAt: now,
          currentPage: 0,
          currentCategoryId: null,
          pendingOrderId: opts.pendingOrderId ?? null,
          pendingPaymentId: null,
          lastShownSkus: [],
          humanTakeover: true,
          pendingCartConfirmation: null,
          handoffReason: opts.reason,
          handoffSellerName: opts.sellerName ?? null,
          handoffAt: now,
          handoffSourceId: opts.sourceId ?? null,
        },
        expiresAt: Timestamp.fromMillis(now.toMillis() + 1000 * 60 * 60 * 24),
        updatedAt: now,
      };
      tx.set(ref, session);
    }
    return { ok: true, already: false };
  });
  if (!result.ok || (result.already && !result.reassigned)) return result;
  // Resumen del cliente (panel): quién atiende + composer visible (HUMAN-HANDOFF-1).
  // Best-effort (review): el takeover YA está persistido en la sesión — si este sync falla,
  // el handoff sigue vigente y recuperable (el próximo appendMessage con humanTakeover lo
  // re-sincroniza); jamás se revierte ni se corta el flujo por esto.
  try {
    await db().doc(paths.customer(tenantId, customerId)).set(
      {
        id: customerId,
        tenantId,
        assignedSellerId: opts.sellerUid ?? null,
        assignedSellerName: opts.sellerName ?? null,
        conversation: { humanTakeover: true },
        updatedAt: now,
      },
      { merge: true },
    );
  } catch {
    logger.warn('handoff: no se pudo sincronizar el resumen del cliente (takeover vigente igual)', {
      tenantId,
      customer: `…${customerId.slice(-4)}`,
    });
  }
  return result;
}

/**
 * HANDOFF-2: aviso a la campana del panel — IDEMPOTENTE por id determinístico
 * `handoff-{customerId}-{sourceId}`: un webhook repetido jamás duplica el aviso.
 * Sin contenido del mensaje ni teléfono completo (solo los últimos 4 dígitos).
 */
export async function notifyHandoffRequested(
  tenantId: string,
  customerId: string,
  sellerName: string | null,
  sourceId: string | null,
): Promise<boolean> {
  // Sin wamid (dev/simulador): bucket por hora — repetir en la misma hora no duplica el aviso.
  const fallback = `sin-wamid-${new Date(Timestamp.now().toMillis()).toISOString().slice(0, 13)}`;
  const safe = String(sourceId ?? fallback).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(-120);
  const id = `handoff-${customerId}-${safe}`;
  const cliente = `…${customerId.slice(-4)}`;
  try {
    await db().doc(`${paths.notifications(tenantId)}/${id}`).create({
      id,
      tenantId,
      category: 'handoff',
      type: 'handoff_customer_requested',
      title: '🙋 Un cliente pidió atención humana',
      body: sellerName
        ? `El cliente ${cliente} pidió hablar con ${sellerName}. El bot quedó en pausa: respondele desde Conversaciones.`
        : `El cliente ${cliente} pidió hablar con una persona. El bot quedó en pausa: respondele desde Conversaciones.`,
      dedupeKey: id,
      customerId,
      read: false,
      readAt: null,
      createdAt: Timestamp.now(),
    });
    return true;
  } catch (e) {
    const code = (e as { code?: number | string }).code;
    if (code === 6 || code === 'already-exists') return false; // idempotencia: ya avisado
    // El aviso jamás rompe el handoff (que ya quedó persistido y visible en el panel).
    logger.warn('handoff: no se pudo crear la notificación', { tenantId, customer: cliente });
    return false;
  }
}

/** Un vendedor toma el chat: el bot deja de responder y la conversación queda asignada a él. */
export async function takeoverChat(
  tenantId: string,
  customerId: string,
  by?: string,
  sellerUid?: string | null,
): Promise<HandoffResult> {
  const r = await executeHandoff(tenantId, customerId, {
    reason: 'seller_manual',
    sellerName: by ?? null,
    sellerUid: sellerUid ?? null,
    reassignIfTaken: true, // tomar un chat ya tomado lo reasigna (comportamiento histórico)
  });
  if (!r.ok) {
    return { ok: false, message: 'No hay conversación para ese cliente todavía.' };
  }
  await appendMessage(tenantId, customerId, {
    direction: 'out',
    author: 'system',
    text: by ? `🧑‍💼 ${by} tomó la conversación.` : '🧑‍💼 Un vendedor tomó la conversación.',
    humanTakeover: true,
  });
  // El vendedor ya está mirando: limpiar el contador de "sin leer".
  await markConversationRead(tenantId, customerId);
  logger.info('Chat tomado por un humano', { tenantId, customerId });
  return { ok: true, message: 'Tomaste la conversación. El bot queda en pausa para este cliente.' };
}

/** El vendedor libera el chat: el bot vuelve a responder al próximo mensaje. */
export async function releaseToBot(tenantId: string, customerId: string): Promise<HandoffResult> {
  const ref = db().doc(paths.session(tenantId, customerId));
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, message: 'No hay sesión para ese cliente.' };
  }
  await ref.update({
    'context.humanTakeover': false,
    'context.pendingCartConfirmation': null, // F3: el bot retoma con contexto de oferta limpio
    // HANDOFF-2: la razón/metadata del takeover se limpia al liberar (auditoría queda en historial).
    'context.handoffReason': null,
    'context.handoffSellerName': null,
    'context.handoffAt': null,
    'context.handoffSourceId': null,
    state: 'IDLE', // próximo mensaje del cliente: el bot retoma con un saludo de "vuelta"
    updatedAt: Timestamp.now(),
  });
  // HUMAN-HANDOFF-1: al devolver el chat también se libera la asignación — "quién atiende"
  // vuelve a ser el bot, no queda un vendedor colgado en la bandeja.
  await db().doc(paths.customer(tenantId, customerId)).set(
    { assignedSellerId: null, assignedSellerName: null, updatedAt: Timestamp.now() },
    { merge: true },
  );
  await appendMessage(tenantId, customerId, {
    direction: 'out',
    author: 'system',
    text: '🤖 El chat volvió al asistente.',
    humanTakeover: false,
    state: 'IDLE',
  });
  logger.info('Chat liberado al bot', { tenantId, customerId });
  return {
    ok: true,
    message: 'Chat devuelto al bot. El asistente vuelve a responder a este cliente.',
  };
}
