/**
 * meta/attachmentLimits.ts — Límites de ingesta CONFIGURABLES POR TENANT (ADR-0016 §8)
 * =====================================================================================
 * El ADR es taxativo: «Los formatos admitidos, la ventana temporal del gate y la retención son
 * configuración por tenant, **no ramas en el código**». La descarga endurecida (`mediaClient`) y
 * la ingesta ya aceptaban esos límites POR PARÁMETRO, pero el webhook nunca se los pasaba: en
 * producción todos los tenants corrían con el default y la promesa del contrato era papel.
 *
 * Se lee el MISMO documento tenant-scoped que ya usa la retención de adjuntos
 * (`tenants/{t}/config/attachments`), en el campo hermano `ingest`. Un solo doc de config para
 * todo lo que gobierna adjuntos: quien lo abre ve la política completa.
 *
 * FAIL-CLOSED en los dos sentidos, que es lo que hace seguro dejar esto en manos del tenant:
 *  · el tope de bytes se acota entre un piso razonable y el TECHO DURO del código — una config
 *    corrupta no puede habilitar descargas de 2 GB ni bloquear todo con `maxBytes: 1`;
 *  · los formatos se INTERSECAN con la whitelist compartida — un tenant puede RESTRINGIR (solo
 *    PDF, por ejemplo) pero jamás habilitar un tipo que el sniffing de magic bytes no sabe
 *    verificar. Una lista que queda vacía cae al default en vez de negar todo en silencio.
 *
 * Mismo criterio que `normalizeReceiptGateConfig` del lado de pedidos, sin importarlo: `meta/` no
 * depende de `orders/` (costura del gate).
 */
import { ATTACHMENT_ALLOWED_MIME_TYPES, type AttachmentAllowedMime } from '@vpw/shared';
import { db } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
// El nombre del doc de config vive del lado de retención, que fue quien lo definió. Importarlo
// (en vez de repetir el string) garantiza que las dos políticas sigan mirando el MISMO documento.
import { ATTACHMENT_CONFIG_DOC } from '../attachments/retention.js';
import { MAX_MEDIA_BYTES } from './mediaClient.js';

export interface AttachmentIngestLimits {
  /** Tope de bytes REAL de la descarga (se corta el stream apenas se supera). */
  maxBytes: number;
  /** Formatos habilitados para ESTE tenant. Siempre subconjunto de la whitelist compartida. */
  allowedMimeTypes: readonly AttachmentAllowedMime[];
}

/** Piso duro: por debajo de 64 KB no entra ni una foto de WhatsApp comprimida. */
export const ATTACHMENT_MIN_MAX_BYTES = 64 * 1024;
/** Techo duro: el mismo del código. Un tenant puede bajar el tope, jamás subirlo. */
export const ATTACHMENT_MAX_MAX_BYTES = MAX_MEDIA_BYTES;

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentIngestLimits = {
  maxBytes: MAX_MEDIA_BYTES,
  allowedMimeTypes: ATTACHMENT_ALLOWED_MIME_TYPES,
};

export const attachmentConfigPath = (tenantId: string): string =>
  `tenants/${tenantId}/config/${ATTACHMENT_CONFIG_DOC}`;

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max);

/** Normaliza la config CRUDA del tenant. Pura ⇒ testeable sin Firestore. */
export function parseAttachmentIngestLimits(raw: unknown): AttachmentIngestLimits {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_ATTACHMENT_LIMITS;
  const cfg = raw as { maxBytes?: unknown; allowedMimeTypes?: unknown };

  const bytes = cfg.maxBytes;
  const maxBytes =
    typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0
      ? clamp(Math.round(bytes), ATTACHMENT_MIN_MAX_BYTES, ATTACHMENT_MAX_MAX_BYTES)
      : DEFAULT_ATTACHMENT_LIMITS.maxBytes;

  const pedidos = cfg.allowedMimeTypes;
  const permitidos = Array.isArray(pedidos)
    ? ATTACHMENT_ALLOWED_MIME_TYPES.filter((m) => (pedidos as unknown[]).includes(m))
    : ATTACHMENT_ALLOWED_MIME_TYPES;

  return {
    maxBytes,
    allowedMimeTypes: permitidos.length > 0 ? permitidos : ATTACHMENT_ALLOWED_MIME_TYPES,
  };
}

/**
 * Límites efectivos del tenant. Si la lectura falla, se sigue con los DEFAULTS (que son los más
 * restrictivos del código): un Firestore intermitente no puede convertirse en "no recibo más
 * archivos de nadie" — el archivo del cliente se pierde y ese es justo el bug que este programa
 * vino a matar.
 */
export async function getAttachmentIngestLimits(tenantId: string): Promise<AttachmentIngestLimits> {
  try {
    const snap = await db().doc(attachmentConfigPath(tenantId)).get();
    if (!snap.exists) return DEFAULT_ATTACHMENT_LIMITS;
    return parseAttachmentIngestLimits((snap.data() as { ingest?: unknown } | undefined)?.ingest);
  } catch (e) {
    logger.warn('attachment: no se pudo leer la config de ingesta del tenant, se usan defaults', {
      tenantId,
      error: e instanceof Error ? e.name : 'desconocido',
    });
    return DEFAULT_ATTACHMENT_LIMITS;
  }
}
