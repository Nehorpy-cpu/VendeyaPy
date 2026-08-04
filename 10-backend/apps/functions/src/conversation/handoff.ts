/**
 * conversation/handoff.ts — Tomar / devolver el chat (F6b · P5)
 * ============================================================
 * El vendedor "toma" el chat para atender en persona (el bot se calla) y lo
 * "libera" cuando termina (recién ahí el bot vuelve a responder, no al confirmar
 * el pago). Ver decisión 2026-06-16. Estos eventos quedan en el historial como
 * mensajes 'system' para que se vean en la conversación.
 */

import { Timestamp, type Transaction } from 'firebase-admin/firestore';
import type { Session, SessionState, HandoffNotificationType } from '@vpw/shared';
import { LEGACY_SESSION_KEY } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { appendMessage, markConversationRead } from './messages.js';

export interface HandoffResult {
  ok: boolean;
  message: string;
}

/** Mantengo el alias por compatibilidad con código existente. */
export type ReleaseResult = HandoffResult;

/**
 * HANDOFF-2 / AI-FALLBACK-HONESTO-1: razón estructurada de todo takeover (auditable en la sesión).
 * ADR-0015 §8 suma `catalog_drift`: el precio/disponibilidad/stock público de un producto lo
 * gobierna una fuente externa que hoy publica otra cosa — el bot no puede confirmarlo solo.
 */
export type HandoffReason = 'customer_requested' | 'payment_verification' | 'coverage_review' | 'seller_manual' | 'ai_unavailable' | 'catalog_drift';

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
   * ADR-0017 §2: canal de la conversación (deriva del número que RECIBIÓ el mensaje). Omitirlo
   * apunta al canal HEREDADO (`active`), que es donde viven todas las conversaciones de hoy: los
   * llamadores que todavía no la pasan siguen comportándose exactamente igual.
   *
   * Con más de un número, el takeover TIENE que ser el de esa conversación en ESE número. Si el
   * echo de un número escribiera siempre en `active`, el vendedor contestando desde el número
   * nuevo dejaría mudo al bot en el número que ya vende.
   */
  sessionKey?: string;
  /**
   * Panel (seller_manual): tomar un chat YA tomado lo REASIGNA al nuevo vendedor (comportamiento
   * histórico de takeoverChat). Los handoffs automáticos NO reasignan (idempotencia estricta).
   */
  reassignIfTaken?: boolean;
  /**
   * KILL-SWITCH-1 (cobertura): precondición evaluada DENTRO de la transacción del handoff —
   * sus lecturas (tx.get) corren ANTES de cualquier escritura, así el takeover queda serializado
   * con lo que el guard lee (p.ej. el flag). false ⇒ no se toma el chat (blocked: true).
   */
  guard?: (tx: Transaction) => Promise<boolean>;
}
export interface ExecuteHandoffResult {
  ok: boolean;
  /** true = la conversación YA estaba en takeover (idempotente: sin nuevas escrituras/avisos). */
  already: boolean;
  /** true = estaba tomada y se REASIGNÓ al nuevo vendedor (solo con reassignIfTaken). */
  reassigned?: boolean;
  /** true = el guard transaccional lo frenó: cero escrituras (KILL-SWITCH-1). */
  blocked?: boolean;
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
  const ref = db().doc(paths.session(tenantId, customerId, opts.sessionKey));
  const now = Timestamp.now();
  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    // KILL-SWITCH-1: el guard lee (tx.get) ANTES de cualquier escritura de esta transacción.
    if (opts.guard && !(await opts.guard(tx))) return { ok: false, already: false, blocked: true };
    if (!snap.exists && !opts.createSessionIfMissing) return { ok: false, already: false };
    const ctx = (snap.data()?.context ?? {}) as { humanTakeover?: boolean; handoffReason?: string | null };
    if (snap.exists && ctx.humanTakeover === true) {
      if (!opts.reassignIfTaken) {
        // Review: el comprobante que llega con el chat YA tomado debe actualizar igual el
        // puntero de orden (el código previo lo escribía incondicional).
        if (opts.pendingOrderId !== undefined) {
          tx.update(ref, { 'context.pendingOrderId': opts.pendingOrderId, updatedAt: now });
        }
        // COVERAGE-1D (review): excepción ÚNICA — un comprobante (payment_verification) ESCALA
        // un takeover coverage_review vigente: el pago en verificación manda sobre la revisión
        // de zona. Sin esto, el worker de reanudación "liberaría" (candado razón+sourceId) un
        // chat que ya contiene un pago en curso y re-mandaría instrucciones bancarias.
        if (opts.reason === 'payment_verification' && ctx.handoffReason === 'coverage_review') {
          tx.update(ref, {
            'context.handoffReason': 'payment_verification',
            'context.handoffSourceId': opts.sourceId ?? null,
            'context.handoffAt': now,
            updatedAt: now,
          });
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
        // El id del documento y el campo tienen que decir lo mismo: con más de un canal, un `id`
        // hardcodeado en `active` haría que una sesión de otro número mintiera sobre cuál es.
        id: opts.sessionKey ?? LEGACY_SESSION_KEY,
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

/** Motivos de aviso soportados por la campana (mismo id determinístico, distinto copy). */
export type HandoffNotifyMotivo = 'customer_requested' | 'ai_unavailable' | 'coverage_review' | 'catalog_drift';

/**
 * Copy por motivo. Tabla en vez de ternarios encadenados: agregar un motivo (ADR-0015 §8) no
 * puede obligar a releer una expresión de cuatro ramas para saber qué se le muestra al owner.
 * Ningún cuerpo incluye el texto del mensaje del cliente, su teléfono completo ni datos internos.
 */
const COPY_HANDOFF: Record<
  HandoffNotifyMotivo,
  { type: HandoffNotificationType; title: string; body: (cliente: string, sellerName: string | null) => string }
> = {
  coverage_review: {
    type: 'handoff_coverage_review',
    title: '📍 Un cliente espera confirmación de cobertura',
    body: (cliente) =>
      `El cliente ${cliente} compartió su ubicación para confirmar la cobertura antes de pagar. Revisala desde Conversaciones (el bot quedó en pausa).`,
  },
  ai_unavailable: {
    type: 'handoff_ai_unavailable',
    title: '🙋 Un cliente necesita atención humana',
    body: (cliente, sellerName) =>
      sellerName
        ? `El asistente no pudo completar la consulta del cliente ${cliente} y lo derivó a ${sellerName}. El bot quedó en pausa: respondele desde Conversaciones.`
        : `El asistente no pudo completar la consulta del cliente ${cliente} y no hay un vendedor disponible para derivarlo. Revisá la conversación desde Conversaciones.`,
  },
  customer_requested: {
    type: 'handoff_customer_requested',
    title: '🙋 Un cliente pidió atención humana',
    body: (cliente, sellerName) =>
      sellerName
        ? `El cliente ${cliente} pidió hablar con ${sellerName}. El bot quedó en pausa: respondele desde Conversaciones.`
        : `El cliente ${cliente} pidió hablar con una persona. El bot quedó en pausa: respondele desde Conversaciones.`,
  },
  // ADR-0015 §8: el dato público lo publica una fuente externa y hoy no coincide con el interno.
  // El aviso NO propone escribir en Meta: la corrección va en el ORIGEN que genera la publicación.
  catalog_drift: {
    type: 'handoff_catalog_drift',
    title: '🏷️ Un precio publicado no se pudo confirmar',
    body: (cliente, sellerName) =>
      `El precio o la disponibilidad publicados de un producto que consultó el cliente ${cliente} no coinciden con los datos internos, así que el bot no los afirmó ni cerró la venta${sellerName ? ` y lo derivó a ${sellerName}` : ''}. Confirmalo desde Conversaciones y corregí el dato en su origen.`,
  },
};

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
  /** Motivo del aviso (cambia tipo/título/cuerpo, misma idempotencia por sourceId). */
  motivo: HandoffNotifyMotivo = 'customer_requested',
  /** COVERAGE-1C: uid del SELLER destinatario (server-controlled) — las rules le abren la campana. */
  targetUid: string | null = null,
): Promise<boolean> {
  // Sin wamid (dev/simulador): bucket por hora — repetir en la misma hora no duplica el aviso.
  const fallback = `sin-wamid-${new Date(Timestamp.now().toMillis()).toISOString().slice(0, 13)}`;
  const safe = String(sourceId ?? fallback).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(-120);
  const id = `handoff-${customerId}-${safe}`;
  const cliente = `…${customerId.slice(-4)}`;
  const copy = COPY_HANDOFF[motivo] || COPY_HANDOFF.customer_requested;
  try {
    await db().doc(`${paths.notifications(tenantId)}/${id}`).create({
      id,
      tenantId,
      category: 'handoff',
      type: copy.type,
      title: copy.title,
      body: copy.body(cliente, sellerName),
      dedupeKey: id,
      customerId,
      ...(targetUid ? { targetUid } : {}),
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

/**
 * ADR-0017 §3: estados que SOBREVIVEN a la liberación del chat.
 *
 * Liberar reinicia una navegación abandonada (ese es el comportamiento buscado), pero un checkout
 * en curso no es navegación: el cliente ya eligió pagar y, en `AWAITING_PAYMENT`, ya recibió los
 * datos bancarios y tiene un pedido pendiente. Degradarlo a `IDLE` hace que su comprobante rebote
 * en el gate (`receiptGate`) y que el bot vuelva a ofrecerle pagar algo que ya pidió.
 *
 * Con Coexistence esto deja de ser un caso raro: cada respuesta del vendedor desde su teléfono
 * toma y libera la conversación, así que el defecto se dispararía todos los días.
 */
const ESTADOS_QUE_SOBREVIVEN_A_LIBERAR: ReadonlySet<string> = new Set(['SELECTING_PAYMENT', 'AWAITING_PAYMENT']);

/** El vendedor libera el chat: el bot vuelve a responder al próximo mensaje. */
export async function releaseToBot(tenantId: string, customerId: string): Promise<HandoffResult> {
  const ref = db().doc(paths.session(tenantId, customerId));
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, message: 'No hay sesión para ese cliente.' };
  }
  const estadoPrevio = (snap.data() as Session | undefined)?.state;
  const estadoFinal: SessionState =
    estadoPrevio && ESTADOS_QUE_SOBREVIVEN_A_LIBERAR.has(estadoPrevio) ? estadoPrevio : 'IDLE';
  await ref.update({
    'context.humanTakeover': false,
    'context.pendingCartConfirmation': null, // F3: el bot retoma con contexto de oferta limpio
    // HANDOFF-2: la razón/metadata del takeover se limpia al liberar (auditoría queda en historial).
    'context.handoffReason': null,
    'context.handoffSellerName': null,
    'context.handoffAt': null,
    'context.handoffSourceId': null,
    // Sin checkout en curso: el próximo mensaje del cliente arranca de cero (saludo de "vuelta").
    state: estadoFinal,
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
    // El historial tiene que decir el estado REAL: si acá quedara 'IDLE' con la sesión en
    // AWAITING_PAYMENT, el panel y la auditoría mostrarían dos verdades distintas.
    state: estadoFinal,
  });
  logger.info('Chat liberado al bot', { tenantId, customerId });
  return {
    ok: true,
    message: 'Chat devuelto al bot. El asistente vuelve a responder a este cliente.',
  };
}
