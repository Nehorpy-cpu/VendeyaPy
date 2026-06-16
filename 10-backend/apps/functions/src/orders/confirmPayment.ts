/**
 * orders/confirmPayment.ts — Confirma el pago de una orden (F6.2)
 * ===============================================================
 * Marca la orden como PAID, vacía el carrito de la sesión y cierra el checkout.
 * Idempotente: si la orden ya estaba PAID, no falla ni duplica.
 *
 * En producción esto lo dispara el WEBHOOK de la pasarela (Bancard/Stripe) tras
 * validar su firma — eso se integra cuando haya credenciales. Por ahora lo llama
 * un endpoint de prueba (devConfirmPayment).
 */

import { Timestamp } from 'firebase-admin/firestore';
import { newPaymentId } from '@vpw/shared';
import type { Order } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

export interface ConfirmPaymentResult {
  ok: boolean;
  message: string; // texto para el cliente (lo enviaría WhatsApp en producción)
  status?: Order['status'];
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

  // Idempotencia: si ya está pagada, devolver OK sin re-procesar.
  if (order.status === 'PAID') {
    return { ok: true, message: 'El pago de esta orden ya estaba confirmado.', status: 'PAID' };
  }
  if (order.status !== 'PENDING_PAYMENT' && order.status !== 'PENDING_VERIFICATION') {
    return { ok: false, message: `La orden está en estado ${order.status}; no se puede confirmar.`, status: order.status };
  }

  const now = Timestamp.now();
  await ref.update({
    status: 'PAID',
    'payment.paidAt': now,
    'payment.paymentId': newPaymentId(),
    updatedAt: now,
  });

  // Vaciar carrito y cerrar el checkout en la sesión del cliente.
  await db()
    .doc(paths.session(tenantId, order.customerId))
    .update({
      cart: { items: [], subtotal: 0 },
      state: 'CHECKOUT_DONE',
      'context.pendingOrderId': null,
      updatedAt: now,
      // NO se toca humanTakeover: el vendedor sigue en control hasta que libera el chat
      // explícitamente (ver releaseToBot). Así no interrumpe el cierre de la venta.
    });

  logger.info('Pago confirmado', { tenantId, customerId: order.customerId, orderId });
  return {
    ok: true,
    message:
      `🎉 ¡Pago confirmado! Tu pedido *${orderId}* ya está en preparación.\n` +
      '¡Gracias por tu compra! 💖 Cualquier cosa, escribime.',
    status: 'PAID',
  };
}
