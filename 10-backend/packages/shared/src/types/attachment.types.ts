/**
 * Adjuntos de conversación — ADR-0016 / ARCHITECTURE.md §4.12.
 * Colección: `tenants/{tenantId}/attachments/{attachmentId}` (raíz del tenant, NO subcolección
 * del mensaje).
 *
 * POR QUÉ vive en la raíz del tenant: permite consulta tenant-scoped (panel, purga, auditoría)
 * sin `collectionGroup`, admite N adjuntos por mensaje y por pedido, y separa el ciclo de vida
 * MUTABLE del adjunto del historial de chat, que se lee como inmutable.
 *
 * REGLA CENTRAL: el adjunto genérico existe ANTES que cualquier clasificación. Guardar el
 * archivo no es una decisión de negocio; interpretarlo sí. Por eso hay DOS ejes ortogonales
 * (`ingestState` y `classification`) y ninguno puede reemplazar al otro.
 *
 * Nada de este contrato menciona un vertical: formatos, ventana temporal y retención son
 * configuración por tenant, no ramas en el código.
 */

import type { MessageChannel } from '../enums.js';
import type { Timestamp } from './common.types.js';
import type { MessageDirection, MessageAuthor } from './message.types.js';

/**
 * Clase TÉCNICA del archivo — nunca de negocio. Se deriva del MIME VERIFICADO por magic bytes,
 * jamás del MIME declarado por Graph ni de la extensión del nombre original.
 */
export const ATTACHMENT_CLASS = ['image', 'document', 'unknown'] as const;
export type AttachmentClass = (typeof ATTACHMENT_CLASS)[number];

/**
 * EJE 1 — Ingesta (hecho técnico). `stored`, `rejected` y `download_failed` son TERMINALES.
 * Un rechazo nunca bloquea la conversación: se responde al cliente y queda rastro en el chat.
 */
export const ATTACHMENT_INGEST_STATE = [
  'received',
  'downloading',
  'verifying',
  'stored',
  'rejected',
  'download_failed',
] as const;
export type AttachmentIngestState = (typeof ATTACHMENT_INGEST_STATE)[number];

/**
 * EJE 2 — Clasificación (significado). `payment_receipt_candidate` es una SUGERENCIA visible:
 * no es comprobante y no mueve el pedido. `payment_receipt_linked` solo lo produce una persona
 * autorizada (ADR-0016 §5) y ni siquiera eso confirma el pago.
 */
export const ATTACHMENT_CLASSIFICATION = [
  'unclassified',
  'generic_media',
  'payment_receipt_candidate',
  'payment_receipt_linked',
  'rejected',
] as const;
export type AttachmentClassification = (typeof ATTACHMENT_CLASSIFICATION)[number];

/** Quién produjo la clasificación: `rule` = gate determinístico del servidor; `human` = staff. */
export const ATTACHMENT_CLASSIFICATION_SOURCE = ['rule', 'human'] as const;
export type AttachmentClassificationSource = (typeof ATTACHMENT_CLASSIFICATION_SOURCE)[number];

/**
 * Quién dispara una transición. `system` = servidor (webhook, job, gate determinístico);
 * `human` = acción autenticada de staff. La autorización FINA por rol
 * (`TENANT_OWNER` | `TENANT_MANAGER` | `SELLER` para vincular un comprobante) es del callable:
 * acá solo se decide si la transición admite una mano humana o no.
 */
export const ATTACHMENT_ACTOR = ['system', 'human'] as const;
export type AttachmentActor = (typeof ATTACHMENT_ACTOR)[number];

/** Estado inicial de cada eje al crear el documento. */
export const ATTACHMENT_INITIAL_INGEST_STATE: AttachmentIngestState = 'received';
export const ATTACHMENT_INITIAL_CLASSIFICATION: AttachmentClassification = 'unclassified';

/**
 * MIME declarado vs verificado. El declarado por Graph **no se cree**: se conserva solo como
 * evidencia de lo que dijo el proveedor. El único MIME con autoridad es `verified`, sacado de
 * los magic bytes del archivo ya descargado.
 */
export interface AttachmentMimeInfo {
  /** Lo que declaró el proveedor, normalizado. Sin autoridad. */
  declared: string | null;
  /** Verificado por magic bytes. `null` mientras no se haya verificado. */
  verified: string | null;
}

/** Referencia de Storage. `path` es una RUTA, JAMÁS una URL firmada (las firmadas no se persisten). */
export interface AttachmentStorageRef {
  path: string | null;
}

/** Clasificación con su procedencia. El historial de clasificación no se borra (auditoría aparte). */
export interface AttachmentClassificationInfo {
  value: AttachmentClassification;
  source: AttachmentClassificationSource;
  /** 0..1. Una regla determinística que se cumple entera vale 1; `human` siempre vale 1. */
  confidence: number;
  /** uid del staff cuando `source === 'human'`; `null` cuando la produjo una regla. */
  by: string | null;
  at: Timestamp | null;
}

/**
 * Documento del adjunto. Todo campo de texto libre que venga del cliente o del proveedor entra
 * SANEADO (ver `attachmentSanitize.ts`): el panel renderiza esto tal cual.
 */
export interface Attachment {
  /**
   * Determinístico sobre `(tenantId, channel, providerMessageId, providerMediaId)` y OPACO:
   * nunca el mediaId crudo, nunca el teléfono, nunca el nombre original. Se escribe con
   * `create()` ⇒ un reintento del webhook falla en vez de duplicar.
   */
  attachmentId: string;
  tenantId: string;
  /** OJO: en este modelo el `customerId` ES el teléfono ⇒ jamás va a logs ni a paths. */
  customerId: string;
  /** Conversación a la que pertenece (hoy 1:1 con el cliente; explícito para omnicanal). */
  conversationId: string;
  messageId: string;
  /** Id del mensaje en el proveedor, HASHEADO y tenant-scoped. Nunca el wamid crudo. */
  providerMessageId: string;
  channel: MessageChannel;
  class: AttachmentClass;
  direction: MessageDirection;
  author: MessageAuthor;
  ingestState: AttachmentIngestState;
  classification: AttachmentClassificationInfo;
  /** Caption saneado. ADR-0016 §9: se persiste pero NO se envía a la IA. */
  caption: string;
  /** Nombre original saneado (documentos). Decorativo: el tipo real sale de `mime.verified`. */
  filename: string | null;
  mime: AttachmentMimeInfo;
  /** Tamaño REAL medido durante el stream, no el declarado. `null` hasta medirlo. */
  bytes: number | null;
  /** Checksum del contenido almacenado (lo calcula el servidor sobre el stream). */
  checksum: string | null;
  storage: AttachmentStorageRef;
  /** Pedido PROPUESTO por el gate. No implica vínculo oficial ni cambia el estado del pedido. */
  orderCandidateId: string | null;
  /** Retención configurable por tenant; la purga viene APAGADA por defecto. */
  retentionUntil: Timestamp | null;
  purgedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Último error SANEADO (sin URLs, sin teléfonos), para que un fallo sea visible y recuperable. */
  lastError: string | null;
}
