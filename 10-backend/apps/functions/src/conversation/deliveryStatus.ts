/**
 * conversation/deliveryStatus.ts — Aplicación de recibos de entrega (ADR-0021 §1)
 * ================================================================================
 * Avanza el `deliveryStatus` de una burbuja SALIENTE con lo que reporta el proveedor
 * (`value.statuses` del webhook). DETERMINÍSTICO: cero IA, cero cuota — solo una consulta por
 * wamid y una transacción sobre el documento del mensaje.
 *
 * Las reglas duras, en orden:
 *  1. MONOTONÍA (rango `pending=0 < sent=1 < delivered=2 < read=3`): un evento con rango ≤ al
 *     vigente es un no-op. Los recibos repetidos o tardíos jamás retroceden el estado, y por eso
 *     mismo la operación es idempotente ante el mismo evento re-entregado.
 *  2. `failed` solo aplica si el rango vigente es < `delivered` (lo que el cliente ya recibió o
 *     leyó no "des-sucede"), y una vez aplicado es TERMINAL: ningún recibo posterior lo revive.
 *  3. La identidad del cliente se deriva de `recipient_id` con la MISMA sanitización a dígitos
 *     que usa `process.ts` para `customerId`: los dos caminos tienen que hablar del mismo doc.
 *  4. La correlación es por `where('waMessageId','==', wamid)` sobre la subcolección del cliente
 *     (índice single-field automático — sin índices nuevos). Un wamid sin burbuja es un evento
 *     HUÉRFANO legítimo (mensaje viaMock que nunca salió a Meta, o histórico anterior al campo):
 *     no-op contado y logueado suave, jamás una falla.
 *  5. Los timestamps escritos (`deliveryAt.<estado>`) son DEL PROVEEDOR (`timestampSeconds`);
 *     si no vino, el estado avanza igual pero el timestamp no se inventa.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { DELIVERY_STATUS_RANK } from '@vpw/shared';
import { paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import type { NormalizedDeliveryStatus } from '../meta/parseWebhook.js';

/** Desenlace CERRADO de aplicar un recibo (seguro de loguear; sin wamids ni teléfonos). */
export type MotivoRecibo =
  | 'aplicado'
  /** El evento no trae wamid o el recipient no tiene dígitos: no hay a qué aplicarlo. */
  | 'sin_datos'
  /** Ningún mensaje del cliente tiene ese wamid (viaMock / histórico): no-op legítimo. */
  | 'huerfano'
  /** El doc que matchea el wamid no es un saliente: un recibo jamás toca entrantes. */
  | 'no_saliente'
  /** Rango ≤ al vigente (recibo repetido o tardío): la monotonía manda. */
  | 'sin_progreso'
  /** El mensaje ya está en `failed`, que es terminal. */
  | 'terminal';

export interface ResultadoRecibo {
  aplicado: boolean;
  motivo: MotivoRecibo;
}

const noOp = (motivo: MotivoRecibo): ResultadoRecibo => ({ aplicado: false, motivo });

/** ¿El valor persistido es un estado con rango conocido? (los históricos no tienen el campo). */
const conRango = (v: unknown): v is keyof typeof DELIVERY_STATUS_RANK =>
  typeof v === 'string' && v in DELIVERY_STATUS_RANK;

/**
 * Aplica UN recibo de entrega sobre la burbuja saliente que le corresponde. `db` viaja como
 * parámetro (y no se resuelve acá) para que el módulo sea trivialmente testeable sin emulador.
 */
export async function aplicarReciboDeEntrega(
  db: Firestore,
  tenantId: string,
  evento: NormalizedDeliveryStatus,
): Promise<ResultadoRecibo> {
  // MISMA regla de identidad que `process.ts`: el cliente es el `recipient_id` a solo dígitos.
  const customerId = evento.recipientId.replace(/[^0-9]/g, '');
  if (customerId === '' || evento.waMessageId === '') return noOp('sin_datos');

  const q = await db
    .collection(paths.messages(tenantId, customerId))
    .where('waMessageId', '==', evento.waMessageId)
    .limit(1)
    .get();
  if (q.empty) {
    // Evento huérfano LEGÍTIMO (viaMock o histórico). Suave a propósito: no es una falla.
    logger.info('Recibo de entrega sin burbuja que lo reciba (viaMock o histórico): no-op', {
      tenantId,
      status: evento.status,
    });
    return noOp('huerfano');
  }
  const ref = q.docs[0]!.ref;

  // TRANSACCIÓN: releer y decidir en un solo acto. Dos recibos del mismo lote (p. ej. delivered y
  // read llegan juntos) no pueden decidir los dos contra la misma lectura vieja.
  return db.runTransaction<ResultadoRecibo>(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return noOp('huerfano'); // borrado entre la consulta y la transacción
    const data = snap.data() as { direction?: unknown; deliveryStatus?: unknown } | undefined;
    // DEFENSIVO: los entrantes no tienen estado de entrega. Un recibo jamás los toca.
    if (data?.direction !== 'out') return noOp('no_saliente');

    const vigente = data?.deliveryStatus;
    if (vigente === 'failed') return noOp('terminal');
    // Ausente o valor fuera de vocabulario ⇒ `pending` (los mensajes históricos no tienen campo).
    const rangoActual = DELIVERY_STATUS_RANK[conRango(vigente) ? vigente : 'pending'];

    if (evento.status === 'failed') {
      // `failed` solo si el mensaje aún no alcanzó `delivered`: read/delivered nunca retroceden.
      if (rangoActual >= DELIVERY_STATUS_RANK.delivered) return noOp('sin_progreso');
    } else if (DELIVERY_STATUS_RANK[evento.status] <= rangoActual) {
      return noOp('sin_progreso');
    }

    const update: Record<string, unknown> = { deliveryStatus: evento.status };
    if (evento.timestampSeconds !== null) {
      // Reloj DEL PROVEEDOR. Merge de hoja (clave con punto): cada estado conserva el suyo.
      update[`deliveryAt.${evento.status}`] = Timestamp.fromMillis(evento.timestampSeconds * 1000);
    }
    if (evento.status === 'failed') {
      // El error ya viene SANEADO del parser (sin payload crudo). Sin error ⇒ null explícito.
      update['deliveryError'] = evento.error ?? null;
    }
    tx.update(ref, update);
    return { aplicado: true, motivo: 'aplicado' };
  });
}
