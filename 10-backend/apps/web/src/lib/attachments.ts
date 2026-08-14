/**
 * Capa de acceso a adjuntos de conversación en el panel (ADR-0016 · ARCHITECTURE.md §4.12).
 *
 * POR QUÉ existe este archivo separado de `conversations.ts`: el adjunto tiene identidad y ciclo
 * de vida PROPIOS (vive en `tenants/{t}/attachments`, no dentro del mensaje). El mensaje solo
 * guarda punteros. Mezclarlo con la lectura del chat volvería a atar dos cosas que el ADR separa
 * a propósito.
 *
 * DOS REGLAS QUE ESTE ARCHIVO HACE CUMPLIR EN LA UI:
 *  1. El panel JAMÁS infiere un adjunto desde el texto del mensaje. Antes se miraba el prefijo
 *     "📷 Imagen recibida", que cualquier cliente podía escribir a mano para fabricar una tarjeta
 *     de comprobante. Acá el único origen de verdad es `attachmentIds` del mensaje.
 *  2. Los bytes NO salen de Storage directo: salen de un callable que firma una URL de vida corta
 *     que nunca se persiste. Por eso no hay ni una sola función que arme una ruta de Storage, y
 *     `storage.path` nunca se devuelve hacia los componentes: la lectura PROYECTA el documento a
 *     `PanelAttachment` (ver `toPanelAttachment`) y el resto del panel no conoce otra forma.
 *
 * Nada de acá menciona un vertical: los formatos, la ventana del gate y la retención son
 * configuración por tenant del lado del servidor.
 */

import { collection, getDocs, query, where, limit as fbLimit } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { Attachment, AttachmentClassification, Order, OrderStatus } from '@vpw/shared';
import { canClassificationTransition, isAttachmentStored } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';
import { admiteComprobante, isPaidStatus } from './orders';
import type { Role } from './auth-context';

const attachmentsCol = (tenantId: string) =>
  collection(firebaseDb(), 'tenants', tenantId, 'attachments');

/**
 * Nombres de los callables de adjuntos, en UN solo lugar. El panel no puede importar nada de
 * `apps/functions`, así que si el backend renombra un callable se toca una línea acá y no siete
 * componentes.
 */
export const ATTACHMENT_CALLABLES = {
  viewUrl: 'attachmentGetViewUrl',
  markReceipt: 'attachmentMarkAsReceipt',
  unmarkReceipt: 'attachmentUnmarkReceipt',
} as const;

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/**
 * La ÚNICA forma de un adjunto que el panel conoce: lo que la UI realmente necesita para pintar
 * la tarjeta, el visor, la ficha de auditoría y las acciones humanas.
 *
 * POR QUÉ es una proyección y no el documento entero: `storage.path` es la ruta real del archivo
 * de un cliente en el bucket. Devolver el doc completo la metía en el estado de React, en los
 * props de cada burbuja y a un `JSON.stringify` de distancia del DOM o de un reporte de errores —
 * y el panel no la usa para nada, porque los bytes salen SIEMPRE por el callable que firma. Lo
 * mismo vale para `checksum`, `providerMessageId` y `retentionUntil`: datos internos del servidor.
 */
export type PanelAttachment = Pick<
  Attachment,
  | 'attachmentId'
  | 'customerId'
  | 'class'
  | 'ingestState'
  | 'caption'
  | 'filename'
  | 'bytes'
  | 'orderCandidateId'
  | 'lastError'
> & {
  classification: Attachment['classification'] | null;
  /** Solo el MIME VERIFICADO: el declarado por el proveedor no tiene autoridad y no se muestra. */
  mime: { verified: string | null };
  createdAt: Attachment['createdAt'] | null;
  /** ADR-0019: desenlace SANEADO del análisis visual (estado + nombre si hubo match único). */
  vision?: { state: string; productName?: string | null } | null;
};

/**
 * Proyección defensiva del documento crudo de Firestore. Construye un objeto NUEVO campo por
 * campo: nada que no esté en esta lista sobrevive al pasaje. Un doc sin `attachmentId` no es un
 * adjunto renderizable y se descarta (la burbuja lo muestra como faltante, no como tarjeta rota).
 */
export function toPanelAttachment(raw: unknown): PanelAttachment | null {
  const d = raw as Partial<Attachment> | null | undefined;
  if (!d || typeof d.attachmentId !== 'string' || d.attachmentId.length === 0) return null;
  const c = d.classification;
  return {
    attachmentId: d.attachmentId,
    customerId: typeof d.customerId === 'string' ? d.customerId : '',
    class: d.class ?? 'unknown',
    ingestState: d.ingestState ?? 'received',
    classification: c
      ? {
          value: c.value,
          source: c.source,
          confidence: typeof c.confidence === 'number' ? c.confidence : 0,
          by: typeof c.by === 'string' ? c.by : null,
          at: c.at ?? null,
        }
      : null,
    caption: typeof d.caption === 'string' ? d.caption : '',
    filename: typeof d.filename === 'string' ? d.filename : null,
    mime: { verified: typeof d.mime?.verified === 'string' ? d.mime.verified : null },
    bytes: typeof d.bytes === 'number' ? d.bytes : null,
    orderCandidateId: typeof d.orderCandidateId === 'string' ? d.orderCandidateId : null,
    createdAt: d.createdAt ?? null,
    lastError: typeof d.lastError === 'string' ? d.lastError : null,
    vision:
      d.vision && typeof d.vision === 'object' && typeof (d.vision as { state?: unknown }).state === 'string'
        ? {
            state: (d.vision as { state: string }).state,
            productName: typeof (d.vision as { productName?: unknown }).productName === 'string' ? (d.vision as { productName: string }).productName : null,
          }
        : null,
  };
}

/**
 * Adjuntos de UNA conversación. Solo `where` por `customerId` (sin `orderBy` ⇒ sin índice
 * compuesto): el orden real lo da el historial de mensajes, que ya viene ordenado.
 * Las reglas de Firestore son la autoridad: si el rol no puede leerlos, la query falla y la UI
 * muestra el estado de error con reintento, nunca una tarjeta a medias.
 *
 * La proyección ocurre ACÁ, en el borde: el documento crudo no sale de esta función.
 */
export async function listConversationAttachments(
  tenantId: string,
  customerId: string,
  max = 300,
): Promise<PanelAttachment[]> {
  const snap = await getDocs(
    query(attachmentsCol(tenantId), where('customerId', '==', customerId), fbLimit(max)),
  );
  return snap.docs
    .map((d) => toPanelAttachment(d.data()))
    .filter((a): a is PanelAttachment => a !== null);
}

/** Índice por `attachmentId` para que cada burbuja resuelva sus punteros en O(1). */
export function indexAttachments(list: readonly PanelAttachment[]): Map<string, PanelAttachment> {
  const map = new Map<string, PanelAttachment>();
  for (const a of list) if (a?.attachmentId) map.set(a.attachmentId, a);
  return map;
}

// ---------------------------------------------------------------------------
// Acciones (siempre por callable; nunca write directo — las rules lo cierran igual)
// ---------------------------------------------------------------------------

export interface AttachmentViewUrl {
  url: string;
  expiresAt: number;
}

/**
 * Enlace TEMPORAL para ver un adjunto. Es de solo lectura: reintentarlo no muta nada, por eso el
 * botón "Reintentar" de la UI puede llamarlo sin confirmación.
 */
export async function getAttachmentViewUrl(
  tenantId: string,
  attachmentId: string,
): Promise<AttachmentViewUrl> {
  const call = httpsCallable<
    { tenantId: string; attachmentId: string },
    { ok: boolean; url: string; expiresAt: number }
  >(firebaseFunctions(), ATTACHMENT_CALLABLES.viewUrl);
  const r = (await call({ tenantId, attachmentId })).data;
  return { url: r.url, expiresAt: r.expiresAt };
}

/**
 * Acción HUMANA: vincular el adjunto a un pedido como comprobante. El `orderId` va SIEMPRE
 * explícito —incluso cuando hay un solo pedido admisible— para que la decisión quede registrada
 * sobre un pedido elegido y no sobre uno adivinado por la UI.
 * NO confirma el pago: eso sigue siendo el callable de pedidos.
 */
export async function markAttachmentAsReceipt(
  tenantId: string,
  attachmentId: string,
  orderId: string,
): Promise<{ ok: boolean; status?: OrderStatus; alreadyMarked?: boolean }> {
  const call = httpsCallable<
    { tenantId: string; attachmentId: string; orderId: string },
    { ok: boolean; status?: OrderStatus; alreadyMarked?: boolean }
  >(firebaseFunctions(), ATTACHMENT_CALLABLES.markReceipt);
  return (await call({ tenantId, attachmentId, orderId })).data;
}

/**
 * Acción HUMANA: desvincular. El archivo se conserva como medio normal (no se borra evidencia).
 * El `orderId` es obligatorio: desmarcar es siempre "de ESTE pedido", nunca en abstracto — así
 * dos pedidos que compartan cliente no se pisan entre sí.
 * El motivo NO va como texto libre: la auditoría del backend registra quién, cuándo y sobre qué.
 */
export async function unmarkAttachmentReceipt(
  tenantId: string,
  attachmentId: string,
  orderId: string,
): Promise<{ ok: boolean; status?: OrderStatus; reverted?: boolean }> {
  const call = httpsCallable<
    { tenantId: string; attachmentId: string; orderId: string },
    { ok: boolean; status?: OrderStatus; reverted?: boolean }
  >(firebaseFunctions(), ATTACHMENT_CALLABLES.unmarkReceipt);
  return (await call({ tenantId, attachmentId, orderId })).data;
}

/** Errores de los callables de adjuntos → mensajes accionables (el backend ya manda texto claro). */
export function friendlyAttachmentError(e: unknown): string {
  const err = e as { code?: string; message?: string };
  const code = err?.code ?? '';
  if (code === 'functions/unauthenticated') return 'Iniciá sesión para ver este archivo.';
  if (code === 'functions/permission-denied')
    return err.message || 'No tenés permiso para ver este archivo.';
  if (code === 'functions/not-found')
    return 'El archivo ya no está disponible. Pedile al cliente que lo reenvíe.';
  if (code === 'functions/failed-precondition')
    return err.message || 'El archivo todavía no está listo para verse.';
  return err?.message?.trim() || 'No se pudo abrir el archivo. Probá de nuevo.';
}

// ---------------------------------------------------------------------------
// Helpers PUROS de presentación (sin Firebase ⇒ testeables solos)
// ---------------------------------------------------------------------------

/** Qué le toca renderizar a la burbuja. `loading` = la ingesta todavía está en vuelo. */
export type AttachmentUiState = 'loading' | 'ready' | 'error';

export function attachmentUiState(a: PanelAttachment): AttachmentUiState {
  if (isAttachmentStored(a.ingestState)) return 'ready';
  if (a.ingestState === 'rejected' || a.ingestState === 'download_failed') return 'error';
  return 'loading';
}

/**
 * Motivo ACCIONABLE del fallo: siempre dice qué puede hacer el vendedor. `lastError` ya viene
 * saneado por el servidor (sin teléfonos, sin URLs) y se muestra como detalle secundario.
 */
export function attachmentErrorHint(a: PanelAttachment): string {
  if (a.ingestState === 'rejected')
    return 'No pudimos aceptar este archivo (formato o tamaño no permitido). Pedile al cliente que lo reenvíe como foto JPG/PNG o PDF.';
  if (a.ingestState === 'download_failed')
    return 'No pudimos descargar este archivo desde WhatsApp. Pedile al cliente que lo reenvíe.';
  return 'Este archivo todavía no está disponible.';
}

/** Etiqueta de tipo. La autoridad es el MIME VERIFICADO: el declarado por el proveedor no se cree. */
const MIME_LABEL: Record<string, string> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
  'application/pdf': 'PDF',
};

export function attachmentTypeLabel(a: PanelAttachment): string {
  const verified = a.mime?.verified;
  if (verified && MIME_LABEL[verified]) return MIME_LABEL[verified]!;
  if (verified) return verified;
  // Sin MIME verificado NO se muestra el declarado como si fuera cierto: se dice la verdad.
  return 'Tipo sin verificar';
}

/** Nombre visible. `filename` ya viene saneado; si no hay, se usa un rótulo genérico por clase. */
export function attachmentDisplayName(a: PanelAttachment): string {
  const f = a.filename?.trim();
  if (f) return f;
  if (a.class === 'image') return 'Imagen del cliente';
  if (a.class === 'document') return 'Documento del cliente';
  return 'Archivo del cliente';
}

/** Tamaño REAL medido durante el stream. `null` ⇒ se dice que no se conoce, no se inventa un 0. */
export function formatAttachmentSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return 'Tamaño desconocido';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Texto alternativo del visor y del thumbnail. El caption viene saneado por el servidor. */
export function attachmentAltText(a: PanelAttachment): string {
  const base =
    a.class === 'image' ? 'Imagen enviada por el cliente' : 'Documento enviado por el cliente';
  const cap = a.caption?.trim();
  return cap ? `${base}: ${cap}` : base;
}

export const isImageAttachment = (a: PanelAttachment): boolean => a.class === 'image';
export const isDocumentAttachment = (a: PanelAttachment): boolean => a.class === 'document';

export const isReceiptCandidate = (a: PanelAttachment): boolean =>
  a.classification?.value === 'payment_receipt_candidate';
export const isLinkedReceipt = (a: PanelAttachment): boolean =>
  a.classification?.value === 'payment_receipt_linked';

export const CLASSIFICATION_LABEL: Record<AttachmentClassification, string> = {
  unclassified: 'Sin clasificar',
  generic_media: 'Archivo del cliente',
  payment_receipt_candidate: 'Posible comprobante',
  payment_receipt_linked: 'Comprobante vinculado',
  rejected: 'Archivo rechazado',
};

export function classificationLabel(v: AttachmentClassification | undefined): string {
  return (v && CLASSIFICATION_LABEL[v]) || CLASSIFICATION_LABEL.unclassified;
}

/**
 * Roles que pueden decidir que un archivo es un comprobante (ADR-0016 §5). El backend es la
 * autoridad; acá solo se decide qué acción MOSTRAR para no ofrecer un botón que va a fallar.
 * `TENANT_VIEWER` y `PLATFORM_ADMIN` quedan fuera a propósito: el ADR nombra exactamente tres.
 */
const ROLES_QUE_CLASIFICAN: readonly Role[] = ['TENANT_OWNER', 'TENANT_MANAGER', 'SELLER'];

export function puedeClasificarComprobantes(role: Role | null | undefined): boolean {
  return !!role && ROLES_QUE_CLASIFICAN.includes(role);
}

/**
 * ¿Se puede ofrecer "Marcar como comprobante"? Se consulta la MÁQUINA DE ESTADOS compartida en
 * vez de comparar strings a mano: si el ADR cambia una arista, esta UI cambia con él.
 * Contempla el camino en dos pasos (`generic_media → candidate → linked`) que la máquina admite
 * para una mano humana; el callable resuelve el salto de forma transaccional.
 */
export function puedeMarcarComprobante(a: PanelAttachment, role: Role | null | undefined): boolean {
  if (!puedeClasificarComprobantes(role)) return false;
  if (!isAttachmentStored(a.ingestState)) return false; // sin bytes guardados no hay comprobante
  const from = a.classification?.value;
  if (!from) return false;
  if (canClassificationTransition(from, 'payment_receipt_linked', 'human')) return true;
  return (
    canClassificationTransition(from, 'payment_receipt_candidate', 'human') &&
    canClassificationTransition('payment_receipt_candidate', 'payment_receipt_linked', 'human')
  );
}

/**
 * ¿Se puede ofrecer "Desmarcar"? Solo sobre un comprobante YA vinculado, con el pedido a la vista
 * y todavía en la espera que produjo esa vinculación. Si el pedido ya está pagado (o no se puede
 * leer), la UI no ofrece la acción: desmarcar no puede borrar evidencia de un pago confirmado.
 */
export function puedeDesmarcarComprobante(
  a: PanelAttachment,
  order: Order | null | undefined,
  role: Role | null | undefined,
): boolean {
  if (!puedeClasificarComprobantes(role)) return false;
  if (!isLinkedReceipt(a)) return false;
  if (!canClassificationTransition('payment_receipt_linked', 'generic_media', 'human')) return false;
  if (!order) return false;
  if (isPaidStatus(order.status)) return false;
  return order.status === 'PENDING_VERIFICATION';
}

/**
 * Pedidos a los que se puede vincular un comprobante: del MISMO cliente y en un estado que lo
 * admita. Si devuelve más de uno hay ambigüedad y la UI está obligada a pedir una elección
 * explícita — el sistema no adivina cuál pedido pagó el cliente.
 */
export function pedidosElegiblesParaComprobante(
  orders: readonly Order[],
  customerId: string,
): Order[] {
  return orders.filter((o) => o.customerId === customerId && admiteComprobante(o.status));
}

/** Fecha corta para la línea de auditoría (Timestamp de Firestore o `null`). */
export function fechaCorta(ts: unknown): string {
  try {
    const d = (ts as { toDate?: () => Date } | null)?.toDate?.();
    return d ? d.toLocaleString('es-PY', { dateStyle: 'short', timeStyle: 'short' }) : '';
  } catch {
    return '';
  }
}

/** Quién clasificó, en texto: `rule` = el gate automático; `human` = una persona identificada. */
export function autorClasificacion(a: PanelAttachment): string {
  const c = a.classification;
  if (!c) return 'Sin clasificar';
  if (c.source === 'human') return c.by ? `una persona (${c.by})` : 'una persona del equipo';
  return 'una regla automática del sistema';
}
