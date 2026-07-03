/**
 * orders/submitComprobante.ts — Recibe el comprobante y deriva al vendedor (F6b.2)
 * ================================================================================
 * El cliente envía el comprobante de la transferencia. Esto:
 *  1. Marca la orden PENDING_VERIFICATION y guarda la ref del comprobante.
 *  2. Activa humanTakeover en la sesión → el bot deja de responder ese chat.
 *  3. Crea un registro de handoff y asigna un vendedor (la cola del vendedor).
 *  4. (Producción) notifica al vendedor por WhatsApp; en dev solo se loguea.
 *
 * La FOTO real del comprobante llega por el webhook de WhatsApp (F1). Mientras tanto
 * el endpoint de prueba pasa una ref simulada.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Order } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { getCheckoutConfig, pickSeller } from './checkoutConfig.js';

export interface ComprobanteResult {
  ok: boolean;
  message: string; // texto para el cliente
  sellerName?: string;
}

export async function submitComprobante(
  tenantId: string,
  orderId: string,
  comprobanteUrl?: string,
): Promise<ComprobanteResult> {
  const ref = db().doc(paths.order(tenantId, orderId));
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, message: 'No encontré tu pedido. ¿Podés reenviar el comprobante?' };
  }
  const order = snap.data() as Order;

  // Idempotencia
  if (order.status === 'PENDING_VERIFICATION') {
    return { ok: true, message: 'Ya recibí tu comprobante 🙌 Un vendedor lo está revisando.' };
  }
  if (order.status !== 'PENDING_PAYMENT') {
    return { ok: false, message: `Tu pedido está en estado ${order.status}.` };
  }

  const now = Timestamp.now();

  // 1. Orden → PENDING_VERIFICATION + ref del comprobante
  await ref.update({
    status: 'PENDING_VERIFICATION',
    'payment.comprobanteUrl': comprobanteUrl ?? 'comprobante-simulado',
    updatedAt: now,
  });

  // 2. Asignar vendedor
  const config = await getCheckoutConfig(tenantId);
  const seller = pickSeller(config);

  // 3. Registro de handoff (cola del vendedor). 1 handoff por orden.
  await db()
    .doc(`tenants/${tenantId}/handoffs/${orderId}`)
    .set({
      orderId,
      customerId: order.customerId,
      total: order.totals.total,
      sellerName: seller?.name ?? null,
      sellerWhatsapp: seller?.whatsapp ?? null,
      comprobanteUrl: comprobanteUrl ?? 'comprobante-simulado',
      status: 'PENDING', // el vendedor confirma o rechaza
      createdAt: now,
    });

  // 4. Sesión → atención humana (el bot deja de responder). La oferta de carrito pendiente
  //    muere acá (F3): el flujo pasó a verificación de pago, un "sí" al vendedor no agrega nada.
  await db()
    .doc(paths.session(tenantId, order.customerId))
    .update({
      'context.humanTakeover': true,
      'context.pendingOrderId': orderId,
      'context.pendingCartConfirmation': null,
      updatedAt: now,
    });
  // HUMAN-HANDOFF-1: sincronizar TAMBIÉN el resumen del customer — el panel calcula "quién
  // atiende" y el composer desde conversation.humanTakeover; si queda desfasado, el vendedor
  // no ve el composer justo en el caso central (comprobante recién recibido).
  await db()
    .doc(paths.customer(tenantId, order.customerId))
    .set({ conversation: { humanTakeover: true }, updatedAt: now }, { merge: true });

  // 5. Notificar al vendedor (producción: WhatsApp; dev: log)
  logger.info('Handoff a vendedor', {
    tenantId,
    orderId,
    customerId: order.customerId,
    seller: seller?.name ?? 'sin-vendedor',
  });
  // TODO (F1): enviar mensaje al vendedor por WhatsApp con el resumen + comprobante.

  return {
    ok: true,
    message:
      `📸 ¡Recibí tu comprobante! Te estoy pasando con ${seller?.name ?? 'un vendedor'} ` +
      'para confirmar tu pedido. En un ratito te escribe por acá 🙌',
    sellerName: seller?.name,
  };
}
