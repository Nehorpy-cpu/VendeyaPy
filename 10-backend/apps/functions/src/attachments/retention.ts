/**
 * attachments/retention.ts — Retención de los BYTES de adjuntos (ADR-0016 §D, "Consecuencias")
 * =============================================================================================
 * Guardar archivos de clientes abre una superficie nueva: bytes ajenos en nuestro bucket, sin
 * fecha de vencimiento. Este módulo es la política — PURA, sin Firestore ni Storage — que decide
 * hasta cuándo se conservan y qué NUNCA se toca.
 *
 * Tres decisiones de diseño que son de seguridad, no de comodidad:
 *
 *  1. FLAG APAGADO POR DEFECTO. `purgeEnabled` solo es `true` si el tenant lo escribió
 *     literalmente `true`. Cualquier otra cosa —campo ausente, `'true'` como string, config
 *     corrupta, doc inexistente— cae en `false`. Un borrado masivo jamás puede originarse en un
 *     dato malformado.
 *
 *  2. LA PURGA BORRA BYTES, NO HISTORIA. El documento del adjunto sobrevive: queda `purgedAt` y
 *     `storage.path = null`. Así el chat sigue mostrando que hubo un archivo y por qué ya no
 *     está, en vez de que la evidencia desaparezca sin rastro.
 *
 *  3. LO QUE ES EVIDENCIA DE PAGO NO SE BORRA NUNCA. Ni un comprobante vinculado, ni un candidato,
 *     ni nada atado a un pedido, ni un path que no sea EXACTAMENTE de la familia de adjuntos
 *     (los comprobantes legacy `tenants/{t}/orders/{o}/comprobantes/…` quedan fuera del alcance
 *     de esta purga por construcción, no por una lista de excepciones que alguien pueda editar).
 *
 * Multi-vertical: la ventana y el interruptor son configuración por tenant. Acá no hay ramas por
 * rubro ni valores atados a un negocio.
 */

import {
  isAttachmentStoragePath,
  type AttachmentClassification,
  type AttachmentIngestState,
} from '@vpw/shared';

/** Doc de config tenant-scoped que gobierna la retención. */
export const ATTACHMENT_CONFIG_DOC = 'attachments';

/** Ventana por defecto cuando el tenant no configuró nada: un año. */
export const ATTACHMENT_RETENTION_DEFAULT_DAYS = 365;
/**
 * Piso duro. Un tenant NO puede pedir "borrá todo mañana": una ventana corta convierte un error
 * de configuración (o una cuenta comprometida) en destrucción inmediata de archivos de clientes.
 */
export const ATTACHMENT_RETENTION_MIN_DAYS = 30;
/** Techo: 10 años. Más que eso es "no borrar nunca", y eso se expresa apagando la purga. */
export const ATTACHMENT_RETENTION_MAX_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AttachmentRetentionConfig {
  /** Interruptor de BORRADO. Apagado ⇒ el job no toca un solo byte (ni siquiera consulta). */
  purgeEnabled: boolean;
  /** Días desde la creación del adjunto hasta que sus bytes son elegibles para purga. */
  retentionDays: number;
}

/** Config efectiva cuando no hay nada válido que leer. Fail-closed: purga APAGADA. */
export const ATTACHMENT_RETENTION_DISABLED: AttachmentRetentionConfig = {
  purgeEnabled: false,
  retentionDays: ATTACHMENT_RETENTION_DEFAULT_DAYS,
};

/**
 * Lee `config/attachments.retention` con criterio fail-closed.
 * `purgeEnabled` exige el booleano `true` EXACTO: un `'true'` string o un `1` no habilitan nada.
 */
export function parseAttachmentRetentionConfig(raw: unknown): AttachmentRetentionConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ATTACHMENT_RETENTION_DISABLED;
  const cfg = raw as { purgeEnabled?: unknown; retentionDays?: unknown };
  const days = cfg.retentionDays;
  const retentionDays =
    typeof days === 'number' &&
    Number.isSafeInteger(days) &&
    days >= ATTACHMENT_RETENTION_MIN_DAYS &&
    days <= ATTACHMENT_RETENTION_MAX_DAYS
      ? days
      : ATTACHMENT_RETENTION_DEFAULT_DAYS;
  return { purgeEnabled: cfg.purgeEnabled === true, retentionDays };
}

/**
 * Vencimiento de retención de un adjunto creado en `createdAtMs`.
 *
 * Se calcula SIEMPRE, esté la purga encendida o apagada: `retentionUntil` es metadata (dice
 * cuándo *podría* vencer) y el interruptor es la política (dice si se borra). Persistirlo con la
 * purga apagada es justamente lo que permite encenderla después sin backfill: los adjuntos ya
 * tienen su fecha y los viejos —que no la tienen— nunca se vuelven elegibles.
 */
export function computeAttachmentRetentionUntilMs(
  config: AttachmentRetentionConfig,
  createdAtMs: number,
): number | null {
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
  return createdAtMs + config.retentionDays * DAY_MS;
}

/** Por qué NO se purga un candidato. Se cuenta por motivo: una purga sin explicación no se audita. */
export type AttachmentPurgeSkipReason =
  | 'purge_disabled'
  | 'already_purged'
  /**
   * HALLAZGO: el documento declara un `tenantId` distinto del tenant de su PROPIA ruta. No es un
   * caso normal que haya que tolerar, es un dato imposible: o alguien sembró el doc a mano o algo
   * lo movió de colección. Se cuenta aparte para que se vea, y no se toca un solo byte.
   */
  | 'tenant_mismatch'
  | 'payment_evidence'
  | 'linked_to_order'
  | 'no_stored_bytes'
  | 'path_not_purgeable'
  | 'no_retention_deadline'
  | 'retention_not_reached'
  /** Solo del paso de sellado: el adjunto YA tenía fecha (idempotencia). */
  | 'already_stamped';

export type AttachmentPurgeDecision =
  | { readonly purge: true }
  | { readonly purge: false; readonly reason: AttachmentPurgeSkipReason };

/** Vista mínima del adjunto que necesita la decisión (sin Timestamps de Firestore: milisegundos). */
export interface AttachmentPurgeCandidate {
  attachmentId: string;
  /**
   * Tenant de la RUTA del documento (`tenants/{tenantId}/attachments/{id}`) — la ÚNICA autoridad.
   * Nunca el campo `tenantId` del propio documento: un doc que se auto-declara de otra empresa
   * elegiría contra qué tenant se valida la whitelist de path, y esa es exactamente la primitiva
   * de borrado cross-tenant que hay que negar.
   */
  tenantId: string;
  /**
   * Lo que el CAMPO del documento dice ser, sin autoridad ninguna. Existe solo para poder
   * detectar (y contar) la discrepancia contra la ruta. `null` ⇒ el doc no lo declara.
   */
  declaredTenantId: string | null;
  storagePath: string | null;
  ingestState: AttachmentIngestState;
  classification: AttachmentClassification;
  orderCandidateId: string | null;
  createdAtMs: number | null;
  retentionUntilMs: number | null;
  purgedAtMs: number | null;
}

/**
 * Clasificaciones que son EVIDENCIA DE PAGO. `payment_receipt_candidate` entra a propósito
 * aunque sea "solo una sugerencia": si el vendedor todavía no decidió, borrar el archivo le saca
 * la decisión de las manos — que es exactamente lo que ADR-0016 §5 quiere evitar.
 */
const PAYMENT_EVIDENCE_CLASSIFICATIONS: readonly AttachmentClassification[] = [
  'payment_receipt_candidate',
  'payment_receipt_linked',
];

/**
 * ¿El documento se auto-declara de otro tenant que el de su ruta?
 *
 * POR QUÉ es bloqueante y no algo a "corregir sobre la marcha": la whitelist de path se valida
 * CONTRA un tenant. Si ese tenant lo eligiera el propio documento, un doc sembrado en
 * `tenants/A/attachments/att_x` con `{tenantId:'B', storage.path:'tenants/B/attachments/…'}`
 * pasaría la whitelist y borraría un archivo del tenant B desde la corrida del tenant A. La ruta
 * es la autoridad; la discrepancia es un hallazgo y ante un hallazgo no se borra nada.
 */
const declaraOtroTenant = (candidate: AttachmentPurgeCandidate): boolean =>
  candidate.declaredTenantId !== null && candidate.declaredTenantId !== candidate.tenantId;

/**
 * ¿Se purgan los bytes de este adjunto? Todas las exclusiones se evalúan ANTES del vencimiento:
 * el motivo reportado tiene que ser el que importa ("es evidencia de pago"), no el accidental
 * ("todavía no venció").
 */
export function decideAttachmentPurge(
  config: AttachmentRetentionConfig,
  candidate: AttachmentPurgeCandidate,
  nowMs: number,
): AttachmentPurgeDecision {
  if (!config.purgeEnabled) return { purge: false, reason: 'purge_disabled' };
  // Idempotencia: reejecutar la purga sobre lo ya purgado no vuelve a intentar nada.
  if (candidate.purgedAtMs !== null) return { purge: false, reason: 'already_purged' };
  // ANTES que cualquier otra exclusión: si el doc y su ruta no coinciden, ni siquiera se evalúa
  // el resto. El motivo reportado tiene que ser el hallazgo, no un accidental "todavía no venció".
  if (declaraOtroTenant(candidate)) return { purge: false, reason: 'tenant_mismatch' };
  if (PAYMENT_EVIDENCE_CLASSIFICATIONS.includes(candidate.classification)) {
    return { purge: false, reason: 'payment_evidence' };
  }
  // Atado a un pedido aunque la clasificación diga otra cosa: el vínculo manda.
  if (candidate.orderCandidateId) return { purge: false, reason: 'linked_to_order' };
  if (candidate.ingestState !== 'stored' || !candidate.storagePath) {
    return { purge: false, reason: 'no_stored_bytes' };
  }
  // Whitelist ESTRICTA de la familia de adjuntos. Es lo que deja fuera del alcance de esta purga
  // a los comprobantes legacy (`tenants/{t}/orders/{o}/comprobantes/…`), a los paths de otro
  // tenant y a cualquier `..`: no hay lista de excepciones, hay una forma exigida.
  if (!isAttachmentStoragePath(candidate.storagePath, candidate.tenantId)) {
    return { purge: false, reason: 'path_not_purgeable' };
  }
  // Sin fecha explícita NO se purga jamás. Esto es lo que hace innecesario cualquier backfill —y
  // lo que protege de la query: en Firestore `null` ordena ANTES que cualquier Timestamp, así
  // que un `where('retentionUntil','<=', ahora)` devuelve también los que lo tienen en `null`.
  if (candidate.retentionUntilMs === null) return { purge: false, reason: 'no_retention_deadline' };
  if (candidate.retentionUntilMs > nowMs) return { purge: false, reason: 'retention_not_reached' };
  return { purge: true };
}

export type AttachmentStampDecision =
  | { readonly stamp: true; readonly retentionUntilMs: number }
  | { readonly stamp: false; readonly reason: AttachmentPurgeSkipReason };

/**
 * ¿Se le SELLA la fecha de retención a un adjunto que todavía no la tiene?
 *
 * POR QUÉ existe este paso: la ingesta crea el adjunto con `retentionUntil: null` —no puede
 * saber la política de cada tenant sin leer su config en el camino caliente del webhook—, y la
 * purga exige una fecha explícita. Sin sellado, la retención sería un campo muerto.
 *
 * Solo se sella con la purga ENCENDIDA: mientras el tenant no la habilite, este job no escribe
 * absolutamente nada. Y NO se sella lo que es evidencia de pago ni lo atado a un pedido: si algún
 * día una exclusión de `decideAttachmentPurge` se rompiera, esos adjuntos igual no tendrían fecha
 * y seguirían siendo impurgables. Dos candados independientes sobre la misma puerta.
 */
export function decideRetentionStamp(
  config: AttachmentRetentionConfig,
  candidate: AttachmentPurgeCandidate,
  nowMs: number,
): AttachmentStampDecision {
  if (!config.purgeEnabled) return { stamp: false, reason: 'purge_disabled' };
  if (candidate.purgedAtMs !== null) return { stamp: false, reason: 'already_purged' };
  // Un doc que se auto-declara de otro tenant tampoco recibe fecha: sin fecha es impurgable, así
  // que el hallazgo queda contenido incluso si mañana alguien rompiera la exclusión de la purga.
  if (declaraOtroTenant(candidate)) return { stamp: false, reason: 'tenant_mismatch' };
  if (candidate.retentionUntilMs !== null) return { stamp: false, reason: 'already_stamped' };
  if (PAYMENT_EVIDENCE_CLASSIFICATIONS.includes(candidate.classification)) {
    return { stamp: false, reason: 'payment_evidence' };
  }
  if (candidate.orderCandidateId) return { stamp: false, reason: 'linked_to_order' };
  if (candidate.ingestState !== 'stored' || !candidate.storagePath) {
    return { stamp: false, reason: 'no_stored_bytes' };
  }
  if (!isAttachmentStoragePath(candidate.storagePath, candidate.tenantId)) {
    return { stamp: false, reason: 'path_not_purgeable' };
  }
  // Sin `createdAt` confiable no se inventa una fecha: quedaría sin sellar (⇒ impurgable) y
  // visible en los contadores, que es exactamente lo que se quiere de un dato roto.
  const retentionUntilMs = computeAttachmentRetentionUntilMs(config, candidate.createdAtMs ?? 0);
  if (retentionUntilMs === null) return { stamp: false, reason: 'no_retention_deadline' };
  // NUNCA se sella una fecha ya vencida: un adjunto viejo recibe `now` como plazo, así que la
  // purga recién lo alcanza en la corrida SIGUIENTE. Es un día de gracia deliberado entre "el
  // tenant encendió la retención" y "se borró el primer archivo".
  return { stamp: true, retentionUntilMs: Math.max(retentionUntilMs, nowMs) };
}

/** Contadores por motivo, todos en cero. Reportar un motivo ausente como `undefined` esconde bugs. */
export function emptyPurgeSkipCounters(): Record<AttachmentPurgeSkipReason, number> {
  return {
    purge_disabled: 0,
    already_purged: 0,
    tenant_mismatch: 0,
    payment_evidence: 0,
    linked_to_order: 0,
    no_stored_bytes: 0,
    path_not_purgeable: 0,
    no_retention_deadline: 0,
    retention_not_reached: 0,
    already_stamped: 0,
  };
}
