/**
 * orders/confirmPayment.ts — Confirma el pago de una orden (F6.2)
 * ===============================================================
 * Marca la orden como PAID, deja el rastro del pago (evento Purchase + auditoría) y cierra el
 * checkout del canal que armó el pedido. Idempotente: si la orden ya estaba PAID, no falla ni
 * duplica.
 *
 * H-05 (auditoría 2026-08-19, hallada por dos auditorías independientes): el orden de las
 * escrituras estaba invertido respecto del daño que causa perder cada una. Se marcaba `PAID`,
 * después se limpiaba la sesión con `.update()` —que **lanza NOT_FOUND si el documento no
 * existe**— y recién al final se registraban el Purchase y el audit. Cuando la sesión no estaba,
 * el pedido quedaba pagado y sin ningún rastro; y el reintento lo **sellaba**, porque el
 * cortocircuito de idempotencia veía `PAID` y devolvía «ya estaba» sin completar nada.
 *
 * Ahora:
 *  1. `PAID` primero (el dinero no se toca).
 *  2. **El rastro antes que la limpieza.** Perder la limpieza del carrito es recuperable —el
 *     motor la repara solo en el siguiente mensaje (`conversation/engine.ts`, rama
 *     `kind === 'paid'`)—; perder el audit de un pago es permanente.
 *  3. La limpieza de sesión es best-effort y su fallo se registra, no se propaga.
 *  4. El cortocircuito **completa** lo que falte en vez de sellar. Todo lo que re-ejecuta es
 *     idempotente: el Purchase por su id `purchase-{orderId}` y el audit por su id
 *     determinístico.
 *
 * En producción esto lo dispara el WEBHOOK de la pasarela (Bancard/Stripe) tras validar su firma.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { newPaymentId, parseSessionKey, LEGACY_SESSION_KEY } from '@vpw/shared';
import type { Order } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { PAID_ORDER_STATUSES } from './lifecycle.js';
import { logger } from '../lib/logger.js';
import { recordBusinessEvent } from '../events/businessEvents.js';
import { recordAudit } from '../audit/audit.js';

export interface ConfirmPaymentResult {
  ok: boolean;
  message: string; // texto para el cliente (lo enviaría WhatsApp en producción)
  status?: Order['status'];
}

/** Id determinístico del audit del pago: repetirlo no crea una entrada nueva. */
const auditIdDePago = (orderId: string): string => `payment-confirmed-${orderId}`;

/** Cliente enmascarado para los logs (H-01: un identificador puede ser PII sin parecerlo). */
const clienteEnmascarado = (customerId: string): string => `…${String(customerId).slice(-4)}`;

/**
 * El RASTRO del pago: evento de negocio + auditoría. Los dos son idempotentes por id, así que
 * llamarlo de nuevo sobre un pedido ya pagado completa lo que falte sin duplicar nada.
 *
 * El Purchase alimenta atribución y Conversions API; si falla, se registra y NO se lleva puesto
 * el audit, que es la pieza irrecuperable.
 */
async function registrarRastroDelPago(
  tenantId: string,
  orderId: string,
  order: Order,
  occurredAt: Timestamp,
  /** Reconstrucción de un rastro que faltaba: el `at` del audit va a ser el de HOY, no el del pago. */
  reconstruido = false,
): Promise<void> {
  try {
    await recordBusinessEvent(tenantId, {
      id: `purchase-${orderId}`,
      eventName: 'Purchase',
      eventSource: order.channel === 'INSTAGRAM' ? 'instagram' : order.channel === 'FACEBOOK' ? 'messenger' : 'whatsapp',
      customerId: order.customerId,
      conversationId: order.customerId,
      orderId,
      value: order.totals?.total ?? null,
      currency: order.totals?.currency ?? null,
      campaignId: order.attribution?.campaignId ?? null,
      occurredAt,
    });
  } catch (e) {
    logger.error('No se pudo registrar el evento Purchase', e, { tenantId, orderId });
  }
  await recordAudit({
    id: auditIdDePago(orderId),
    tenantId,
    action: 'payment.confirmed',
    targetType: 'order',
    targetId: orderId,
    summary: `Pago confirmado del pedido ${orderId}`,
    metadata: {
      total: order.totals?.total ?? null,
      currency: order.totals?.currency ?? null,
      // Sin esto, un audit reconstruido es indistinguible de uno escrito en el momento del pago.
      ...(reconstruido ? { reconstruido: true, paidAt: occurredAt } : {}),
    },
  });
}

/**
 * Cierra el checkout del CANAL que armó el pedido (ADR-0017 §2): vacía el carrito y apaga el
 * puntero. El canal viaja en el pedido desde que se lo crea; los tres llamadores —webhook de
 * Stripe, callable del panel, endpoint de prueba— solo conocen el `orderId`. Sin el campo, este
 * update vaciaba el carrito de la conversación equivocada.
 *
 * H-05: es la ÚNICA escritura de este flujo que puede fallar por un documento inexistente, y es
 * también la única recuperable — por eso va al final y su fallo no se propaga. Si no ocurre, el
 * cliente queda con el carrito de lo que ya pagó y el puntero al pedido pagado; el motor lo
 * limpia en el siguiente mensaje.
 */
async function limpiarCheckout(
  tenantId: string,
  order: Order,
  orderId: string,
  now: Timestamp,
  /**
   * Solo para la REPARACIÓN de un pedido ya pagado: la sesión es de vida larga por (cliente,
   * canal) y NO por pedido, así que limpiarla a ciegas pisaría el carrito que el cliente armó
   * después. Con este guard solo se limpia si la conversación sigue esperando ESE pago — el
   * mismo criterio que `checkoutReuse.ts` usa para no bloquear una compra nueva (review).
   */
  soloSiSigueEsperandoElPedido = false,
): Promise<void> {
  const sessionKey = parseSessionKey(order.sessionKey, LEGACY_SESSION_KEY);
  const ref = db().doc(paths.session(tenantId, order.customerId, sessionKey));
  if (soloSiSigueEsperandoElPedido) {
    const snap = await ref.get().catch((e: unknown) => {
      logger.warn('No se pudo leer la sesión para decidir la limpieza; se deja como está', {
        tenantId, orderId, motivo: e instanceof Error ? e.message.slice(0, 120) : 'desconocido',
      });
      return null;
    });
    const ses = snap?.data() as { context?: { pendingOrderId?: string | null } } | undefined;
    if (ses?.context?.pendingOrderId !== orderId) return; // la conversación ya siguió su camino
  }
  try {
    await ref.update({
      cart: { items: [], subtotal: 0 },
      state: 'CHECKOUT_DONE',
      'context.pendingOrderId': null,
      updatedAt: now,
      // NO se toca humanTakeover: el vendedor sigue en control hasta que libera el chat
      // explícitamente (ver releaseToBot). Así no interrumpe el cierre de la venta.
    });
  } catch (e) {
    // Antes esta excepción subía y se llevaba puesto el rastro del pago. El pago YA está
    // confirmado y auditado: lo único pendiente es cosmética de la conversación, que el motor
    // repara solo. Queda registrado con lo necesario para encontrarlo.
    const contexto = {
      tenantId,
      orderId,
      customer: clienteEnmascarado(order.customerId),
      sessionKey,
      motivo: e instanceof Error ? e.message.slice(0, 120) : 'desconocido',
    };
    const mensaje = 'Pago confirmado pero no se pudo cerrar el checkout de la sesión';
    // `warn(msg, ctx)` y `error(msg, error, ctx)` tienen firmas DISTINTAS: elegir la función y
    // llamarla igual metía el contexto en el slot del error y perdía la excepción (review).
    if ((e as { code?: number | string })?.code === 5) logger.warn(mensaje, contexto);
    else logger.error(mensaje, e, contexto);
  }
}

export async function confirmPayment(
  tenantId: string,
  orderId: string,
): Promise<ConfirmPaymentResult> {
  const ref = db().doc(paths.order(tenantId, orderId));
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, message: 'Orden no encontrada.' };
  }
  const order = snap.data() as Order;

  // Idempotencia: la orden ya está pagada. H-05: en vez de devolver «ya estaba» y SELLAR un
  // estado a medias, se completa el rastro que pueda faltar (todo idempotente por id) y se
  // reintenta la limpieza. Un pedido ya completo no genera nada nuevo.
  if (PAID_ORDER_STATUSES.includes(order.status)) {
    const paidAt = (order.payment?.paidAt as Timestamp | undefined) ?? Timestamp.now();
    await registrarRastroDelPago(tenantId, orderId, order, paidAt, true);
    await limpiarCheckout(tenantId, order, orderId, Timestamp.now(), true);
    return { ok: true, message: 'El pago de esta orden ya estaba confirmado.', status: order.status };
  }
  if (order.status !== 'PENDING_PAYMENT' && order.status !== 'PENDING_VERIFICATION') {
    return { ok: false, message: `La orden está en estado ${order.status}; no se puede confirmar.`, status: order.status };
  }

  const now = Timestamp.now();
  // El dinero primero: si esto falla, la excepción sube y NO existe ni Purchase ni audit de un
  // pago que no ocurrió.
  await ref.update({
    status: 'PAID',
    'payment.paidAt': now,
    'payment.paymentId': newPaymentId(),
    updatedAt: now,
  });

  // El rastro, antes que la limpieza: es lo único que no se puede recuperar después.
  await registrarRastroDelPago(tenantId, orderId, order, now);
  logger.info('Pago confirmado', { tenantId, customerId: order.customerId, orderId });

  await limpiarCheckout(tenantId, order, orderId, now);

  return {
    ok: true,
    message:
      `🎉 ¡Pago confirmado! Tu pedido *${orderId}* ya está en preparación.\n` +
      '¡Gracias por tu compra! 💖 Cualquier cosa, escribime.',
    status: 'PAID',
  };
}
