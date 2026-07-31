/**
 * orderReceiptAttachments.ts — Lectura DEFENSIVA de los comprobantes de un pedido (ADR-0016 §5)
 * ==============================================================================================
 * Vive en `@vpw/shared` —y no del lado del backend— porque la MISMA proyección la necesitan dos
 * consumidores: el store transaccional que decide sobre el pedido y el panel de Pedidos, que es
 * donde el vendedor trabaja. Dos copias de esta lectura derivan (una tolera un `linkedIds` que no
 * es lista, la otra explota; una deduplica, la otra muestra el mismo comprobante dos veces) y la
 * divergencia se descubre siempre en producción.
 *
 * Es PURA y TOLERANTE a propósito: los pedidos anteriores al ADR no tienen el campo y no son un
 * error, y un documento adulterado no puede convertirse en una tarjeta rota ni en un `throw` que
 * tumbe la pantalla de pedidos. Lo que no es un id válido, no existe.
 */
import type { OrderReceiptAttachments } from './types/order.types.js';

/** Strings no vacíos, sin duplicados y en orden de aparición. */
const uniqueStrings = (values: unknown): string[] =>
  Array.isArray(values)
    ? [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))]
    : [];

/**
 * Proyección defensiva de `order.receiptAttachments`. Acepta el pedido entero (o cualquier cosa:
 * `null`, un doc viejo, basura) y devuelve SIEMPRE la forma completa.
 *
 * OJO con la semántica, que es la parte que importa para la UI:
 *  · `linkedIds`    → una PERSONA decidió que eso es el comprobante ⇒ evidencia.
 *  · `candidateIds` → el sistema lo SUGIRIÓ ⇒ hay que revisarlo, no afirmar que hay comprobante.
 * Un id vinculado también figura en `candidateIds` (marcar acumula en las dos listas), así que
 * "sugerencia pendiente" es `candidateIds` MENOS `linkedIds`, nunca `candidateIds` a secas.
 */
export function readOrderReceiptAttachments(order: unknown): OrderReceiptAttachments {
  const raw = (order && typeof order === 'object' ? (order as Record<string, unknown>)['receiptAttachments'] : null) as
    | Record<string, unknown>
    | null
    | undefined;
  const drivenBy = raw?.['statusDrivenBy'];
  return {
    candidateIds: uniqueStrings(raw?.['candidateIds']),
    linkedIds: uniqueStrings(raw?.['linkedIds']),
    statusDrivenBy: typeof drivenBy === 'string' && drivenBy.length > 0 ? drivenBy : null,
  };
}

/**
 * Qué tiene que mostrar la tarjeta de comprobante de un pedido, sin que cada superficie invente
 * su propia regla:
 *  · `linked`    → hay comprobante vinculado por una persona;
 *  · `candidate` → hay una sugerencia del sistema SIN confirmar (jamás decir "comprobante recibido");
 *  · `none`      → no hay nada de este eje (puede haber un comprobante LEGACY en `payment`).
 */
export function receiptAttachmentsState(order: unknown): 'linked' | 'candidate' | 'none' {
  const r = readOrderReceiptAttachments(order);
  if (r.linkedIds.length > 0) return 'linked';
  return r.candidateIds.length > 0 ? 'candidate' : 'none';
}
