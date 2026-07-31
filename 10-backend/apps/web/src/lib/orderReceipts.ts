/**
 * Comprobantes de UN pedido, vistos desde el panel de Pedidos (ADR-0016 §3, §5 y §7 · Área C).
 *
 * POR QUÉ vive separado de `lib/attachments.ts`: aquel archivo responde "qué archivos mandó ESTA
 * conversación" (lectura por `customerId`). Acá la pregunta es otra: "qué archivos declara ESTE
 * pedido como comprobante vinculado o como candidato". Son dos caminos de lectura distintos sobre
 * la misma colección; mezclarlos obligaría a traerse la conversación entera para pintar una
 * tarjeta del pedido.
 *
 * TOLERANCIA A DOS FORMAS (deliberada, no defensiva porque sí). El vínculo adjunto↔pedido se
 * puede haber escrito en dos superficies distintas y el panel tiene que mostrar el comprobante en
 * las dos:
 *   1. SUPERFICIE NUEVA — `order.receiptAttachments.{linkedIds,candidateIds,statusDrivenBy}`,
 *      que es lo que escribe `orders/receiptStore.ts`. Es la forma preferida y la que da la
 *      distinción candidato/vinculado. Se lee con la proyección COMPARTIDA
 *      (`readOrderReceiptAttachments` de `@vpw/shared`), la misma que usa el store del backend:
 *      una segunda copia de esa lectura terminaría divergiendo en producción.
 *   2. SUPERFICIE VIEJA (`order.payment`) — el mismo objeto colgado de `payment`, o un único
 *      `payment.comprobanteAttachmentId`. Se lee igual para que la decisión final del contrato de
 *      escritura no obligue a tocar la UI.
 *   3. LEGACY PURO — `payment.comprobanteUrl` (una RUTA, no un attachmentId). No tiene adjunto que
 *      leer: lo abre el visor de pedido de siempre (`comprobanteEstado` + `ComprobanteViewer`).
 *      Este archivo NO lo toca; solo se asegura de no pisarlo.
 *
 * LO QUE ESTE ARCHIVO NO HACE NUNCA: devolver `storage.path` ni una URL firmada. La proyección
 * `toPanelAttachment` es el borde y todo sale por ahí; los bytes salen solo por el callable que
 * firma. Tampoco propaga el mensaje crudo de un error de Firestore, que suele traer la ruta
 * completa del documento adentro.
 */

import { doc, getDoc } from 'firebase/firestore';
import { isAttachmentId, readOrderReceiptAttachments } from '@vpw/shared';
import { firebaseDb } from './firebase';
import { toPanelAttachment, type PanelAttachment } from './attachments';

/**
 * Cuántos adjuntos se leen por pedido. El vínculo es multi-adjunto (un segundo envío ACUMULA),
 * pero un pedido con decenas de comprobantes es un caso patológico: se corta acá para no disparar
 * N lecturas sin techo desde el navegador.
 */
export const MAX_ORDER_ATTACHMENTS = 24;

export interface OrderReceiptRefs {
  /** Vinculados por una persona autorizada (ADR-0016 §5). Son comprobante. */
  linkedIds: string[];
  /** Sugerencias del gate que NADIE confirmó. No son comprobante y no movieron el pedido. */
  candidateIds: string[];
  /** Cuál de los vinculados sostiene el `PENDING_VERIFICATION` vigente (si el dato existe). */
  statusDrivenBy: string | null;
  /** Todos los ids a leer, sin repetir: vinculados primero (el que mueve el estado, primero). */
  allIds: string[];
}

const VACIO: OrderReceiptRefs = { linkedIds: [], candidateIds: [], statusDrivenBy: null, allIds: [] };

const comoObjeto = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

/**
 * Ids que se aceptan como referencia. La validación es de SEGURIDAD, no cosmética: con este id se
 * arma la ruta del documento, y un valor como `../orders/otro` construiría una lectura fuera de la
 * colección de adjuntos. Se usa el validador COMPARTIDO (`isAttachmentId`) para no tener una
 * segunda definición de qué es un id válido conviviendo con la del backend.
 */
function idsValidos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) if (isAttachmentId(v) && !out.includes(v as string)) out.push(v as string);
  return out;
}

function idValido(raw: unknown): string | null {
  return isAttachmentId(raw) ? (raw as string) : null;
}

/**
 * Lee UNA superficie con la forma `{ candidateIds, linkedIds, statusDrivenBy }`.
 *
 * La proyección la hace `readOrderReceiptAttachments` de `@vpw/shared`: es la MISMA que usa el
 * store transaccional del backend, y tener acá una segunda copia sería garantizar que un día
 * diverjan (una deduplica, la otra no; una tolera un `linkedIds` que no es lista, la otra explota).
 * Se la envuelve en `{ receiptAttachments }` para poder pasarle también la superficie alternativa
 * colgada de `payment` sin escribir un segundo parser.
 *
 * Lo ÚNICO que se agrega encima es la validación de formato del id, que es un requisito del panel
 * y no del store: acá el id se convierte en una ruta de documento.
 */
function leerSuperficie(raw: unknown): { linked: string[]; candidates: string[]; drivenBy: string | null } {
  const r = readOrderReceiptAttachments({ receiptAttachments: raw });
  return {
    linked: idsValidos(r.linkedIds),
    candidates: idsValidos(r.candidateIds),
    drivenBy: idValido(r.statusDrivenBy),
  };
}

const unir = (...listas: string[][]): string[] => {
  const out: string[] = [];
  for (const l of listas) for (const id of l) if (!out.includes(id)) out.push(id);
  return out;
};

/**
 * Referencias de comprobante de un pedido, leyendo las dos superficies posibles.
 *
 * Un id que aparece en las dos listas queda SOLO como vinculado: `receiptStore` acumula el
 * attachmentId en `candidateIds` también al vincularlo, y mostrarlo dos veces —una como
 * "posible", otra como "vinculado"— le mentiría al vendedor sobre cuántos archivos hay.
 */
export function readOrderReceiptRefs(order: unknown): OrderReceiptRefs {
  const o = comoObjeto(order);
  if (!o) return VACIO;
  const payment = comoObjeto(o['payment']);

  const nueva = leerSuperficie(o['receiptAttachments']);
  const vieja = leerSuperficie(payment?.['receiptAttachments']);
  const sueltoEnPayment = idValido(payment?.['comprobanteAttachmentId']);

  const linkedIds = unir(nueva.linked, vieja.linked, sueltoEnPayment ? [sueltoEnPayment] : []);
  const candidateIds = unir(nueva.candidates, vieja.candidates).filter((id) => !linkedIds.includes(id));
  const statusDrivenBy = nueva.drivenBy ?? vieja.drivenBy;

  // El que sostiene el estado va primero: es el que el vendedor tiene que mirar antes de confirmar.
  const vinculadosOrdenados =
    statusDrivenBy && linkedIds.includes(statusDrivenBy)
      ? [statusDrivenBy, ...linkedIds.filter((id) => id !== statusDrivenBy)]
      : linkedIds;

  return {
    linkedIds,
    candidateIds,
    statusDrivenBy,
    allIds: unir(vinculadosOrdenados, candidateIds).slice(0, MAX_ORDER_ATTACHMENTS),
  };
}

export interface OrderAttachmentsResult {
  /** Adjuntos encontrados, ya PROYECTADOS (sin `storage.path`, sin checksum, sin retención). */
  items: PanelAttachment[];
  /** Ids que el pedido referencia pero que no se pudieron leer (purga, permisos, dato viejo). */
  missingIds: string[];
}

/**
 * Lee los adjuntos por id. Lectura DIRECTA por documento (no una query con `where`): el pedido ya
 * sabe qué ids quiere y traer la conversación entera para filtrar sería leer archivos de otros
 * pedidos del mismo cliente sin necesidad.
 *
 * Un id que no existe no es un error de la pantalla: se devuelve en `missingIds` y la UI lo cuenta
 * como archivo faltante, con explicación. Las reglas de Firestore siguen siendo la autoridad: si
 * el rol no puede leer adjuntos, la promesa REJECTA y la UI muestra el error con reintento.
 */
export async function listAttachmentsByIds(
  tenantId: string,
  ids: readonly string[],
): Promise<OrderAttachmentsResult> {
  const pedidos = ids.filter((id) => isAttachmentId(id)).slice(0, MAX_ORDER_ATTACHMENTS);
  if (pedidos.length === 0) return { items: [], missingIds: [] };
  const snaps = await Promise.all(
    pedidos.map((id) => getDoc(doc(firebaseDb(), 'tenants', tenantId, 'attachments', id))),
  );
  const items: PanelAttachment[] = [];
  const missingIds: string[] = [];
  snaps.forEach((snap, i) => {
    const proyectado = snap.exists() ? toPanelAttachment(snap.data()) : null;
    if (proyectado) items.push(proyectado);
    else missingIds.push(pedidos[i]!);
  });
  return { items, missingIds };
}

/**
 * Aislamiento por cliente en la UI. El backend ya rechaza vincular un adjunto de otro cliente
 * (`order_customer_mismatch`), pero el panel no puede DEPENDER de eso para no mostrarlo: si un
 * pedido quedara con una referencia cruzada (dato viejo, corrección manual), un vendedor vería el
 * archivo de otra persona creyendo que es el comprobante de este pedido. Acá se separan y la UI
 * los cuenta como inconsistencia visible, sin abrirlos.
 *
 * Un adjunto sin `customerId` (proyección de un documento incompleto) NO se asume propio.
 */
export function separarAdjuntosDelCliente(
  items: readonly PanelAttachment[],
  customerId: string,
): { propios: PanelAttachment[]; ajenos: PanelAttachment[] } {
  const propios: PanelAttachment[] = [];
  const ajenos: PanelAttachment[] = [];
  for (const a of items) (a.customerId === customerId ? propios : ajenos).push(a);
  return { propios, ajenos };
}

/**
 * Error de la lectura → mensaje accionable. NUNCA se reenvía `err.message` tal cual: los errores
 * de Firestore traen la ruta completa del documento adentro (`tenants/{t}/attachments/{id}`) y
 * escupirla en la pantalla pondría en el DOM exactamente lo que el ADR §6 saca de circulación.
 */
export function friendlyOrderAttachmentError(e: unknown): string {
  const code = (e as { code?: string } | null)?.code ?? '';
  if (code === 'permission-denied')
    return 'Tu usuario no tiene permiso para ver los archivos de este pedido. Pedíselo a un responsable del negocio.';
  if (code === 'unauthenticated') return 'Volvé a iniciar sesión para ver los comprobantes.';
  if (code === 'unavailable' || code === 'deadline-exceeded')
    return 'No pudimos conectarnos para traer los comprobantes. Revisá tu conexión y reintentá.';
  return 'No pudimos cargar los comprobantes de este pedido. Reintentá en unos segundos.';
}
