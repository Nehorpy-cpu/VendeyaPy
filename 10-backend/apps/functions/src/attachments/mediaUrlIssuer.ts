/**
 * attachments/mediaUrlIssuer.ts — Emisor ÚNICO de URLs temporales de archivos (ADR-0016 §6/§7)
 * =============================================================================================
 * Generaliza el patrón de `orders/comprobanteView.ts` a las DOS familias de path que existen:
 *
 *   1. adjuntos nuevos      →  tenants/{t}/attachments/{partition}/{attachmentId}
 *   2. comprobantes legacy  →  tenants/{t}/orders/{orderId}/comprobantes/{archivo}
 *
 * Compatibilidad aditiva (ADR-0016 §7): la familia legacy se valida con las MISMAS funciones que
 * ya usa el visor de comprobantes —importadas, no copiadas—. Dos copias de una whitelist de path
 * derivan, y una whitelist derivada es un agujero.
 *
 * Reglas que este módulo hace cumplir, en este orden:
 *
 *  · EL PATH NUNCA VIENE DEL CLIENTE. El callable recibe un `attachmentId` o un `orderId`; la
 *    ruta se RESUELVE contra el registro del tenant. Aceptar un path sería delegarle al navegador
 *    la decisión de qué archivo se firma.
 *  · REVERIFICACIÓN DE PERTENENCIA. Aunque el documento se leyó bajo `tenants/{claims.tenantId}`,
 *    el path guardado se vuelve a validar contra ESE tenant (forma completa, no `startsWith`) y
 *    además se exige el prefijo `tenants/{claims.tenantId}/` como última línea. Un documento
 *    adulterado no puede apuntar a otro tenant, ni a otra carpeta, ni escaparse con `..`.
 *  · CONTENT-TYPE VERIFICADO. Solo se firma con el MIME que salió de los magic bytes
 *    (`mime.verified`), jamás con el declarado por Graph ni con la extensión del nombre original.
 *  · EL PDF SE DESCARGA, NO SE RENDERIZA. `Content-Disposition: attachment` para documentos: un
 *    PDF servido inline se abre en el visor del navegador con el origen del bucket. Las imágenes
 *    sí van inline porque el panel las muestra —y la whitelist de MIME garantiza que un
 *    `image/svg+xml` (o un HTML) nunca llega hasta acá.
 *  · TTL CORTO Y NO PERSISTIDO. La URL firmada no se guarda, no se loguea y no vuelve en ningún
 *    error; solo viaja en la respuesta del callable. Y NADA de la emisión se escribe en el objeto:
 *    un `firebaseStorageDownloadTokens` grabado en la metadata sería una credencial sin
 *    vencimiento sobre el archivo de un cliente — ver `buildEmulatorDownloadUrl` para la única
 *    diferencia con producción, acotada al emulador y explícita.
 */

import { getStorage } from 'firebase-admin/storage';
import {
  buildAttachmentDocPath,
  isAllowedAttachmentMime,
  isAttachmentId,
  isAttachmentStoragePath,
  normalizeMimeType,
  sanitizeAttachmentFilename,
  type AttachmentIngestState,
} from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { comprobantePathValido, esComprobanteImagen } from '../orders/comprobanteView.js';

/**
 * Techo DURO del enlace. El vendedor abre el archivo y listo: una URL firmada que sobreviva a la
 * pestaña es una credencial portable que ya no controlamos.
 */
export const ATTACHMENT_VIEW_URL_MAX_TTL_MS = 10 * 60 * 1000;
export const ATTACHMENT_VIEW_URL_TTL_MS = ATTACHMENT_VIEW_URL_MAX_TTL_MS;

/** Familia de path que resolvió la emisión (va a la auditoría; nunca sale el path). */
export type AttachmentViewFamily = 'attachment' | 'legacy_comprobante';

/** Pedido del panel. NO existe una variante que acepte un path: es intencional. */
export type AttachmentViewRequest =
  | { kind: 'attachment'; attachmentId: string }
  | { kind: 'legacy_comprobante'; orderId: string };

/** Proyección del documento del adjunto que necesita el emisor. */
export interface AttachmentViewRecord {
  /** El tenant que declara el PROPIO documento. Se compara contra el de los claims. */
  tenantId: string;
  storagePath: string | null;
  ingestState: AttachmentIngestState;
  /** Solo `mime.verified`. El declarado por Graph no tiene autoridad. */
  verifiedMime: string | null;
  filename: string | null;
  /** `purgedAt !== null`: los bytes ya no existen (retención). */
  purged: boolean;
}

export type AttachmentViewErrorCode =
  | 'invalid-argument'
  | 'permission-denied'
  | 'failed-precondition'
  | 'not-found'
  | 'internal';

export interface AttachmentPresentation {
  contentType: string;
  disposition: 'inline' | 'attachment';
  filename: string;
}

export interface SignedUrlRequest extends AttachmentPresentation {
  path: string;
  expiresAtMs: number;
}

/** Rechazo con código traducible a `HttpsError`. Nunca lleva el path ni la URL. */
export interface AttachmentViewDenial {
  ok: false;
  code: AttachmentViewErrorCode;
  message: string;
}

export type AttachmentViewResult =
  | {
      ok: true;
      url: string;
      expiresAtMs: number;
      family: AttachmentViewFamily;
      contentType: string;
      disposition: 'inline' | 'attachment';
    }
  | AttachmentViewDenial;

export interface AttachmentViewIssuerDeps {
  loadAttachment(tenantId: string, attachmentId: string): Promise<AttachmentViewRecord | null>;
  /** Referencia cruda guardada en el pedido (`payment.comprobanteUrl`), tal cual. */
  loadLegacyComprobanteRef(tenantId: string, orderId: string): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;
  signUrl(request: SignedUrlRequest): Promise<string>;
}

/** Ids de pedido aceptables como SEGMENTO de ruta (mismo criterio que el visor legacy). */
const ORDER_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;

/** Extensión obligatoria por MIME verificado: el nombre del cliente NUNCA define el tipo. */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** Inverso, SOLO para la familia legacy (esos archivos no tienen `mime.verified` guardado). */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** Tipo neutro para lo que no se pudo verificar: el navegador no lo interpreta, lo baja. */
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

const NAME_UNSAFE_RE = /[^A-Za-z0-9._-]+/g;
const DOWNLOAD_NAME_MAX = 80;

/**
 * Nombre con el que el navegador guarda el archivo. Dos endurecimientos sobre el saneo genérico:
 *  · se reduce a ASCII seguro (`[A-Za-z0-9._-]`) porque termina dentro de un header HTTP;
 *  · la EXTENSIÓN la impone el MIME verificado, no el cliente — así un `factura.exe` con
 *    contenido PDF se guarda como `factura.pdf` y no como ejecutable.
 */
export function buildDownloadFilename(
  preferredName: string | null,
  fallbackId: string,
  contentType: string,
): string {
  const extension = EXTENSION_BY_MIME[contentType] ?? 'bin';
  const sanitized = sanitizeAttachmentFilename(preferredName) ?? '';
  let base = sanitized
    .replace(/\.[A-Za-z0-9]{1,10}$/, '')
    .replace(NAME_UNSAFE_RE, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  if (base.length === 0) base = fallbackId.replace(NAME_UNSAFE_RE, '_');
  if (base.length === 0) base = 'adjunto';
  if (base.length > DOWNLOAD_NAME_MAX) base = base.slice(0, DOWNLOAD_NAME_MAX).replace(/[._]+$/, '');
  return `${base}.${extension}`;
}

/**
 * Cómo se sirve el archivo. La regla de oro: si no se pudo verificar el tipo, se baja como binario
 * neutro; nunca se le da al navegador una excusa para interpretarlo.
 */
export function presentationForMime(
  mime: string | null,
  preferredName: string | null,
  fallbackId: string,
): AttachmentPresentation {
  const normalized = normalizeMimeType(mime);
  const contentType = normalized && isAllowedAttachmentMime(normalized) ? normalized : FALLBACK_CONTENT_TYPE;
  const disposition = contentType.startsWith('image/') ? 'inline' : 'attachment';
  return { contentType, disposition, filename: buildDownloadFilename(preferredName, fallbackId, contentType) };
}

/**
 * MIME de un comprobante legacy a partir de su extensión (no hay `mime.verified` para ellos).
 * La extensión se exige `[a-z0-9]{1,10}` ANTES de indexar el mapa: sin ese filtro, un archivo
 * llamado `x.constructor` devolvería la función heredada del prototipo en vez de `undefined`.
 */
function legacyContentType(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,10}$/.test(extension)) return null;
  return MIME_BY_EXTENSION[extension] ?? null;
}

const deny = (code: AttachmentViewErrorCode, message: string): AttachmentViewDenial => ({
  ok: false,
  code,
  message,
});

/**
 * Resuelve el pedido del panel a una URL firmada de vida corta.
 * `tenantId` YA viene autorizado por el callable (claims); acá se reverifica la pertenencia del
 * path, que es la parte que un documento adulterado podría intentar torcer.
 */
export async function issueAttachmentViewUrl(
  tenantId: string,
  request: AttachmentViewRequest,
  deps: AttachmentViewIssuerDeps,
  nowMs = Date.now(),
): Promise<AttachmentViewResult> {
  const resolved =
    request.kind === 'attachment'
      ? await resolveAttachmentTarget(tenantId, request.attachmentId, deps)
      : await resolveLegacyTarget(tenantId, request.orderId, deps);
  if (!resolved.ok) return resolved;

  // ÚLTIMA LÍNEA, redundante a propósito: las dos familias ya validaron su forma completa, pero
  // el contrato es "nada se firma fuera de tenants/{claims.tenantId}/" y eso se afirma acá, en un
  // solo lugar, para que agregar una tercera familia no pueda saltearlo por olvido.
  if (!resolved.path.startsWith(`tenants/${tenantId}/`)) {
    return deny('permission-denied', 'El archivo no pertenece a esta empresa.');
  }
  if (!(await deps.fileExists(resolved.path))) {
    return deny('not-found', 'El archivo no se encontró en el almacenamiento.');
  }

  const expiresAtMs = nowMs + ATTACHMENT_VIEW_URL_TTL_MS;
  try {
    const url = await deps.signUrl({ path: resolved.path, expiresAtMs, ...resolved.presentation });
    return {
      ok: true,
      url,
      expiresAtMs,
      family: resolved.family,
      contentType: resolved.presentation.contentType,
      disposition: resolved.presentation.disposition,
    };
  } catch {
    // Sin detalles del error hacia el cliente: podría traer el bucket o la service account.
    return deny('internal', 'No se pudo generar el enlace seguro del archivo.');
  }
}

type ResolvedTarget =
  | { ok: true; path: string; family: AttachmentViewFamily; presentation: AttachmentPresentation }
  | AttachmentViewDenial;

async function resolveAttachmentTarget(
  tenantId: string,
  attachmentId: string,
  deps: AttachmentViewIssuerDeps,
): Promise<ResolvedTarget> {
  // Se valida la FORMA antes de tocar Firestore: un id basura no llega a construir un doc path.
  if (!isAttachmentId(attachmentId)) return deny('invalid-argument', 'Identificador de adjunto inválido.');

  const record = await deps.loadAttachment(tenantId, attachmentId);
  if (!record) return deny('not-found', 'El adjunto no existe.');
  // El doc declara su propio tenant: si no coincide con los claims, algo está mal sembrado o
  // movido. Se corta como permiso, no como "no encontrado".
  if (record.tenantId !== tenantId) {
    return deny('permission-denied', 'El adjunto no pertenece a esta empresa.');
  }
  if (record.purged) {
    return deny('not-found', 'El archivo ya no está disponible: se cumplió el plazo de retención.');
  }
  if (record.ingestState !== 'stored' || !record.storagePath) {
    return deny('failed-precondition', 'El archivo todavía no está disponible desde el panel.');
  }
  // Whitelist estricta: forma completa + pertenencia. Un `..`, una subcarpeta o el tenant de al
  // lado no matchean.
  if (!isAttachmentStoragePath(record.storagePath, tenantId)) {
    return deny('permission-denied', 'La referencia del adjunto no es válida para esta empresa.');
  }
  const verified = normalizeMimeType(record.verifiedMime);
  if (!verified || !isAllowedAttachmentMime(verified)) {
    // Sin MIME verificado no se firma NADA: es el único dato con autoridad sobre el contenido.
    return deny('failed-precondition', 'El tipo del archivo no está verificado: no se puede abrir.');
  }
  return {
    ok: true,
    path: record.storagePath,
    family: 'attachment',
    presentation: presentationForMime(verified, record.filename, attachmentId),
  };
}

async function resolveLegacyTarget(
  tenantId: string,
  orderId: string,
  deps: AttachmentViewIssuerDeps,
): Promise<ResolvedTarget> {
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) {
    return deny('invalid-argument', 'Identificador de pedido inválido.');
  }
  const ref = (await deps.loadLegacyComprobanteRef(tenantId, orderId))?.trim() ?? '';
  if (!ref) return deny('failed-precondition', 'Este pedido todavía no tiene comprobante.');
  if (!esComprobanteImagen(ref)) {
    // `media:{id}` (no se pudo bajar de Meta) o `comprobante-simulado` (dev): no hay archivo.
    return deny('failed-precondition', 'El comprobante llegó pero la imagen todavía no está disponible desde el panel.');
  }
  if (!comprobantePathValido(tenantId, orderId, ref)) {
    return deny('permission-denied', 'La referencia del comprobante no es válida para este pedido.');
  }
  // Los comprobantes legacy se guardaron ANTES del sniffing: no hay `mime.verified`. Se deduce del
  // sufijo y, si no se reconoce, cae en binario neutro con descarga forzada.
  return {
    ok: true,
    path: ref,
    family: 'legacy_comprobante',
    presentation: presentationForMime(legacyContentType(ref), null, orderId),
  };
}

// ---------------------------------------------------------------------------
// Deps reales (Firestore + Storage). Todo lo de arriba es puro respecto de la infraestructura:
// los tests ejercitan `issueAttachmentViewUrl` con deps falsas y sin inicializar Firebase.
// ---------------------------------------------------------------------------

interface AttachmentDocShape {
  tenantId?: unknown;
  ingestState?: unknown;
  storage?: { path?: unknown } | null;
  mime?: { verified?: unknown } | null;
  filename?: unknown;
  purgedAt?: unknown;
}

/** Proyección defensiva del documento: nada se asume, todo se comprueba. */
export function toAttachmentViewRecord(
  tenantId: string,
  data: AttachmentDocShape | undefined,
): AttachmentViewRecord | null {
  if (!data) return null;
  return {
    tenantId: typeof data.tenantId === 'string' ? data.tenantId : tenantId,
    storagePath: typeof data.storage?.path === 'string' ? data.storage.path : null,
    ingestState: (typeof data.ingestState === 'string' ? data.ingestState : 'received') as AttachmentIngestState,
    verifiedMime: typeof data.mime?.verified === 'string' ? data.mime.verified : null,
    filename: typeof data.filename === 'string' ? data.filename : null,
    purged: data.purgedAt !== null && data.purgedAt !== undefined,
  };
}

/**
 * Host del emulador de Storage, y `null` cuando no corresponde usarlo.
 *
 * POR QUÉ el segundo filtro: tener seteado `FIREBASE_STORAGE_EMULATOR_HOST` en un runtime de
 * producción ya sería una anomalía; que ADEMÁS cambiara la forma de emitir el enlace convertiría
 * una variable de entorno en un interruptor para degradar la firma. En producción se firma de
 * verdad o no se emite nada.
 */
export function emulatorStorageHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.FIREBASE_STORAGE_EMULATOR_HOST || env.STORAGE_EMULATOR_HOST || '';
  const host = raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!host) return null;
  if (env.FUNCTIONS_EMULATOR === 'true') return host; // suite de emuladores: es desarrollo declarado
  return env.NODE_ENV === 'production' ? null : host;
}

/**
 * Lo ÚNICO que la rama de emulador puede hacer con el objeto: leerlo. No hay `setMetadata` en
 * este contrato a propósito — escribir `firebaseStorageDownloadTokens` crea una credencial
 * ETERNA sobre bytes de un cliente, que es lo contrario del techo de 10 minutos y del "jamás
 * persistida" de ADR-0016 §6.
 */
export interface EmulatorStorageFile {
  getMetadata(): Promise<unknown>;
}

/** Token de descarga que el objeto YA tenga. Nunca se inventa uno. */
function existingDownloadToken(raw: unknown): string | null {
  const meta = (Array.isArray(raw) ? raw[0] : raw) as { metadata?: unknown } | undefined;
  const tokens = (meta?.metadata as { firebaseStorageDownloadTokens?: unknown } | undefined)
    ?.firebaseStorageDownloadTokens;
  if (typeof tokens !== 'string') return null;
  return tokens.split(',').map((t) => t.trim()).filter(Boolean)[0] ?? null;
}

/**
 * Enlace de DESARROLLO contra el emulador. El emulador no tiene clave privada (no firma) y su
 * endpoint `?alt=media` no admite override de headers de respuesta, así que la diferencia con
 * producción se declara acá, explícita y acotada:
 *
 *  · NO se escribe metadata en el objeto. Se reutiliza el token que el objeto ya tenga; si no
 *    tiene, no se inventa: se falla y el callable responde `internal`. Un token persistido por
 *    nosotros sería una URL sin vencimiento sobre el archivo de un cliente.
 *  · NO se sirve nada que deba descargarse. Sin `Content-Disposition: attachment` un PDF se
 *    abriría INLINE con el origen del emulador; antes que romper esa regla, no se emite enlace.
 *  · El enlace resultante NO expira (limitación del emulador). Por eso esta rama solo se toma en
 *    un runtime de desarrollo (ver `emulatorStorageHost`), nunca en producción.
 */
export async function buildEmulatorDownloadUrl(
  file: EmulatorStorageFile,
  emuHost: string,
  bucketName: string,
  request: SignedUrlRequest,
): Promise<string> {
  if (request.disposition !== 'inline') {
    throw new Error('El emulador no puede forzar la descarga de un archivo: enlace no emitido.');
  }
  const token = existingDownloadToken(await file.getMetadata());
  if (!token) {
    throw new Error('El objeto no tiene token de descarga propio y el emulador no puede firmar.');
  }
  return `http://${emuHost}/v0/b/${bucketName}/o/${encodeURIComponent(request.path)}?alt=media&token=${encodeURIComponent(token)}`;
}

export const defaultAttachmentViewDeps: AttachmentViewIssuerDeps = {
  async loadAttachment(tenantId, attachmentId) {
    const snap = await db().doc(buildAttachmentDocPath(tenantId, attachmentId)).get();
    if (!snap.exists) return null;
    return toAttachmentViewRecord(tenantId, snap.data() as AttachmentDocShape);
  },
  async loadLegacyComprobanteRef(tenantId, orderId) {
    const snap = await db().doc(paths.order(tenantId, orderId)).get();
    if (!snap.exists) return null;
    const data = snap.data() as { payment?: { comprobanteUrl?: unknown } } | undefined;
    return typeof data?.payment?.comprobanteUrl === 'string' ? data.payment.comprobanteUrl : null;
  },
  async fileExists(path) {
    const [exists] = await getStorage().bucket().file(path).exists();
    return exists;
  },
  async signUrl(request) {
    const bucket = getStorage().bucket();
    const file = bucket.file(request.path);
    const emuHost = emulatorStorageHost();
    if (emuHost) return buildEmulatorDownloadUrl(file, emuHost, bucket.name, request);
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: request.expiresAtMs,
      // El Content-Type y el Content-Disposition van FIRMADOS: quedan dentro de la firma, así que
      // el navegador no puede pedir que el PDF se sirva inline cambiando la query string.
      responseType: request.contentType,
      responseDisposition: `${request.disposition}; filename="${request.filename}"`,
    });
    return url;
  },
};
