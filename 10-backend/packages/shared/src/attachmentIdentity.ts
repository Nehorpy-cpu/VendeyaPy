/**
 * WHATSAPP-MEDIA-SAFE-FOUNDATION-1 (ADR-0016 §6) — Identidad opaca del adjunto y ruta de Storage.
 * ===============================================================================================
 * Funciones PURAS. Determinismo + opacidad son requisitos de seguridad, no comodidades:
 *
 *  - DETERMINISMO: el mismo `(tenantId, channel, providerMessageId, providerMediaId)` produce
 *    siempre el mismo `attachmentId`. Como el documento se escribe con `create()`, un reintento
 *    del webhook de Meta FALLA en vez de duplicar el adjunto (y en vez de bajar los bytes dos
 *    veces). El `customerId` NO entra en la fórmula: es el teléfono, y un id derivado de él sería
 *    un identificador de la persona disfrazado.
 *
 *  - OPACIDAD: el id es un hash truncado. Nunca contiene el mediaId crudo, ni el teléfono, ni el
 *    nombre original del archivo. La ruta de Storage se construye a partir del id ⇒ tampoco los
 *    contiene la ruta, que es lo que termina en logs de infraestructura y en URLs firmadas.
 *
 *  - PARTICIÓN POR PREFIJO DE HASH (no por fecha): `partition` son los 2 primeros caracteres hex
 *    del id ⇒ 256 buckets uniformes. Se eligió sobre `YYYY-MM` porque la ruta queda función PURA
 *    del id: un reintento vuelve a calcular exactamente la misma ruta sin depender del reloj ni
 *    del huso horario. Con partición temporal, dos intentos separados por un cambio de mes
 *    escribirían en rutas distintas y dejarían bytes huérfanos. Bonus: no expone metadata
 *    temporal de la actividad del cliente en la ruta. La retención se resuelve por
 *    `retentionUntil` en Firestore, que es donde vive la política, no por el nombre de la carpeta.
 */

import { sha256Hex } from './sha256.js';
import type { MessageChannel } from './enums.js';

/** Prefijo del id de adjunto. NO se agrega a `ID_PREFIX`: ese helper genera ids ALEATORIOS y
 *  éste es determinístico — mezclarlos invitaría a llamar `newId()` y romper la idempotencia. */
export const ATTACHMENT_ID_PREFIX = 'att';
/** 24 hex = 96 bits de hash truncado: sobra para que dos adjuntos distintos no colisionen. */
export const ATTACHMENT_ID_HEX_LENGTH = 24;
export const ATTACHMENT_ID_RE = /^att_[0-9a-f]{24}$/;

/** Prefijo del id de mensaje del proveedor ya hasheado (lo que se persiste en vez del wamid). */
export const PROVIDER_MESSAGE_ID_PREFIX = 'pmid';
export const PROVIDER_MESSAGE_ID_HEX_LENGTH = 24;
export const PROVIDER_MESSAGE_ID_RE = /^pmid_[0-9a-f]{24}$/;

/** 2 caracteres hex ⇒ 256 buckets. */
export const ATTACHMENT_PARTITION_LENGTH = 2;

/** Segmento de la colección/carpeta. Constante para que nadie lo escriba a mano. */
export const ATTACHMENTS_SEGMENT = 'attachments';

/**
 * Un tenantId aceptable como SEGMENTO de ruta: sin `/`, sin `.`, sin espacios. Es más laxo que
 * `isValidId(id, 'tnt')` a propósito (hay tenants de test y de dev), pero cierra la puerta al
 * path traversal, que es lo que importa acá.
 */
const TENANT_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Versión del esquema de derivación. Si algún día cambia la fórmula, cambia el dominio y los
 *  ids viejos siguen siendo válidos y estables (nunca se recalculan sobre datos existentes). */
const DERIVATION_DOMAIN = 'vpw.attachment.v1';
const PROVIDER_MESSAGE_DOMAIN = 'vpw.attachment.pmid.v1';

export interface AttachmentIdentityInput {
  tenantId: string;
  channel: MessageChannel;
  /** Id del mensaje en el proveedor (wamid). Entra CRUDO al hash y no se persiste crudo. */
  providerMessageId: string;
  /** Id del media en el proveedor. Ídem: entra al hash, nunca al documento ni a los logs. */
  providerMediaId: string;
}

function requireSegmentValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`attachmentIdentity: ${field} inválido`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new Error(`attachmentIdentity: ${field} inválido`);
  }
  // El mensaje de error NUNCA incluye el valor: estos campos son identificadores del proveedor
  // y el error termina en logs.
  return trimmed;
}

/**
 * Codificación INYECTIVA con longitud por delante: sin ella, `('ab','c')` y `('a','bc')`
 * producirían el mismo preimagen y por lo tanto el mismo id.
 */
function joinFields(domain: string, fields: readonly string[]): string {
  return [domain, ...fields.map((f) => `${f.length}:${f}`)].join('|');
}

/**
 * Id determinístico y opaco del adjunto: `att_<24 hex>`.
 * Lanza si algún campo es inválido (nunca devuelve un id "parcial": un id mal derivado rompería
 * la idempotencia del `create()` y duplicaría descargas).
 */
export function deriveAttachmentId(input: AttachmentIdentityInput): string {
  const tenantId = requireSegmentValue(input?.tenantId, 'tenantId');
  const channel = requireSegmentValue(input?.channel, 'channel');
  const providerMessageId = requireSegmentValue(input?.providerMessageId, 'providerMessageId');
  const providerMediaId = requireSegmentValue(input?.providerMediaId, 'providerMediaId');
  const digest = sha256Hex(
    joinFields(DERIVATION_DOMAIN, [tenantId, channel, providerMessageId, providerMediaId]),
  );
  return `${ATTACHMENT_ID_PREFIX}_${digest.slice(0, ATTACHMENT_ID_HEX_LENGTH)}`;
}

export function isAttachmentId(value: unknown): boolean {
  return typeof value === 'string' && ATTACHMENT_ID_RE.test(value);
}

/**
 * Hash tenant-scoped del id de mensaje del proveedor: `pmid_<24 hex>`. Es lo ÚNICO que se
 * persiste como `providerMessageId`. Va salteado con el tenant para que el mismo wamid en dos
 * tenants no sea correlacionable.
 */
export function hashProviderMessageId(tenantId: string, providerMessageId: string): string {
  const tid = requireSegmentValue(tenantId, 'tenantId');
  const pmid = requireSegmentValue(providerMessageId, 'providerMessageId');
  const digest = sha256Hex(joinFields(PROVIDER_MESSAGE_DOMAIN, [tid, pmid]));
  return `${PROVIDER_MESSAGE_ID_PREFIX}_${digest.slice(0, PROVIDER_MESSAGE_ID_HEX_LENGTH)}`;
}

/** Bucket de Storage del adjunto: los 2 primeros hex del id. Función pura del id. */
export function attachmentStoragePartition(attachmentId: string): string {
  if (!isAttachmentId(attachmentId)) throw new Error('attachmentIdentity: attachmentId inválido');
  const start = ATTACHMENT_ID_PREFIX.length + 1;
  return attachmentId.slice(start, start + ATTACHMENT_PARTITION_LENGTH);
}

/**
 * Ruta PRIVADA de Storage: `tenants/{tenantId}/attachments/{partition}/{attachmentId}`.
 * El `tenantId` es siempre el primer segmento (aislamiento por prefijo en las reglas de Storage)
 * y el resto es opaco. El cliente no lee ni escribe acá: los bytes salen por un callable
 * autorizado que firma una URL de vida corta que JAMÁS se persiste.
 */
export function buildAttachmentStoragePath(tenantId: string, attachmentId: string): string {
  if (typeof tenantId !== 'string' || !TENANT_SEGMENT_RE.test(tenantId)) {
    throw new Error('attachmentIdentity: tenantId inválido');
  }
  const partition = attachmentStoragePartition(attachmentId);
  return `tenants/${tenantId}/${ATTACHMENTS_SEGMENT}/${partition}/${attachmentId}`;
}

/** Ruta del documento en Firestore. Constante compartida para que nadie tipee la colección. */
export function buildAttachmentDocPath(tenantId: string, attachmentId: string): string {
  if (typeof tenantId !== 'string' || !TENANT_SEGMENT_RE.test(tenantId)) {
    throw new Error('attachmentIdentity: tenantId inválido');
  }
  if (!isAttachmentId(attachmentId)) throw new Error('attachmentIdentity: attachmentId inválido');
  return `tenants/${tenantId}/${ATTACHMENTS_SEGMENT}/${attachmentId}`;
}

/**
 * ¿`path` es EXACTAMENTE una ruta de adjunto de ESTE tenant? Whitelist estricta para el emisor
 * de URLs firmadas: se valida forma completa y pertenencia, no un `startsWith` (que aceptaría
 * `tenants/{t}/attachments/../../otro`). No cubre los comprobantes legacy: esa segunda familia
 * de path la valida el emisor, que es quien conoce su forma.
 */
export function isAttachmentStoragePath(path: unknown, tenantId: string): boolean {
  if (typeof path !== 'string' || typeof tenantId !== 'string') return false;
  if (!TENANT_SEGMENT_RE.test(tenantId)) return false;
  const segments = path.split('/');
  if (segments.length !== 5) return false;
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  const [root, tid, folder, partition, id] = segments as [string, string, string, string, string];
  if (root !== 'tenants' || tid !== tenantId || folder !== ATTACHMENTS_SEGMENT) return false;
  if (!isAttachmentId(id)) return false;
  return partition === attachmentStoragePartition(id);
}
