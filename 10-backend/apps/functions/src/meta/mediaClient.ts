/**
 * meta/mediaClient.ts — Descarga ENDURECIDA de media de WhatsApp Cloud API (ADR-0016)
 * ====================================================================================
 * Dos pasos contra Graph: (1) GET /{mediaId} → metadata {url, mime_type, file_size};
 * (2) GET url → binario. Ambos con el access token DEL TENANT (resuelto por el caller
 * vía resolveTenantWhatsappCreds; nunca se persiste ni se loguea).
 *
 * QUÉ CAMBIÓ Y POR QUÉ (auditoría WHATSAPP-MEDIA-1A):
 *  - TIMEOUT explícito en las dos llamadas. Sin él, un Graph colgado retenía la función hasta el
 *    timeout de la plataforma y el mensaje del cliente quedaba en el limbo.
 *  - REINTENTOS ACOTADOS y SOLO de lecturas (GET idempotente): 5xx/429/red/timeout, máximo 2.
 *    Nada de reintentar escrituras: acá no hay ninguna.
 *  - LÍMITE DE BYTES DURANTE EL STREAM. Antes se materializaba `arrayBuffer()` COMPLETO y recién
 *    después se medía: un archivo de 2 GB ya estaba en memoria cuando se lo rechazaba. Ahora se
 *    corta y se aborta la conexión apenas se pasa del máximo.
 *  - SNIFFING de magic bytes contra el MIME declarado. El MIME que declara Graph NO se cree: un
 *    HTML/SVG declarado `image/jpeg` serviría script desde nuestro bucket con la sesión del
 *    vendedor abierta. Discrepancia ⇒ rechazo, y NADA llega a Storage.
 *  - CHECKSUM sha256 del contenido, calculado sobre el stream (sin segunda pasada).
 *
 * El `contentType` que se persiste es SIEMPRE el VERIFICADO, nunca el declarado.
 * NUNCA loguear el token, el mediaId ni la URL firmada de Meta (lookaside.fbsbx.com lleva firma).
 */
import { createHash } from 'node:crypto';
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_SNIFF_MIN_BYTES,
  declaredMimeMatchesVerified,
  normalizeMimeType,
  sanitizeAttachmentError,
  sniffAttachmentMime,
  type AttachmentAllowedMime,
} from '@vpw/shared';
import { logger } from '../lib/logger.js';

const GRAPH_VERSION = 'v19.0';
/** Tope por defecto. Es configuración por tenant (ADR-0016 §8): se pasa por parámetro. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MB
/** La metadata es un JSON chico: si tarda más que esto, algo está mal. */
export const MEDIA_METADATA_TIMEOUT_MS = 10_000;
/** Cubre TODO el stream del contenido, no solo el handshake. */
export const MEDIA_CONTENT_TIMEOUT_MS = 30_000;
/** Reintentos EXTRA (además del intento inicial). Solo lecturas. */
export const MEDIA_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;

/**
 * PEOR CASO del presupuesto de una descarga completa (metadata + contenido, con sus reintentos y
 * su backoff). Vive acá —al lado de las constantes que lo determinan— porque de él depende el
 * `timeoutSeconds` de la función que ingesta adjuntos: si el presupuesto creciera por encima del
 * timeout, la función moriría a mitad de descarga y el adjunto quedaría colgado. El test que
 * relaciona ambos números es la única forma de que ese acoplamiento no se rompa en silencio.
 */
export function worstCaseDownloadBudgetMs(
  retries: number = MEDIA_MAX_RETRIES,
  retryDelayMs: number = RETRY_BASE_DELAY_MS,
): number {
  const intentos = retries + 1;
  // El backoff es lineal (`retryDelayMs * (n+1)`) y se paga una vez por cada reintento, en las
  // DOS llamadas (metadata y contenido).
  let backoff = 0;
  for (let n = 0; n < retries; n += 1) backoff += retryDelayMs * (n + 1);
  return intentos * (MEDIA_METADATA_TIMEOUT_MS + MEDIA_CONTENT_TIMEOUT_MS) + 2 * backoff;
}

/** Motivos de rechazo. Códigos cerrados: seguros de loguear y de persistir en `lastError`. */
export type MediaRejectReason =
  | 'unsupported_type' // el formato (declarado o REAL) no está en la whitelist
  | 'too_large' // superó el tope, declarado o medido durante el stream
  | 'mime_mismatch' // los magic bytes contradicen lo que declaró el proveedor
  | 'fetch_failed'; // red, timeout, 4xx/5xx de Graph, o respuesta sin cuerpo

export interface AttachmentDownloadOk {
  ok: true;
  buffer: Buffer;
  /** Tamaño REAL medido durante el stream (nunca el declarado). */
  bytes: number;
  /** ÚNICO MIME con autoridad: sale de los magic bytes. Es el que se persiste como contentType. */
  verifiedMime: AttachmentAllowedMime;
  /** Lo que dijo el proveedor, normalizado. Evidencia, sin autoridad. */
  declaredMime: string | null;
  /** sha256 hex del contenido, calculado sobre el stream. */
  checksum: string;
}

export interface AttachmentDownloadFailure {
  ok: false;
  reason: MediaRejectReason;
  /** Detalle SANEADO (sin URLs, sin dígitos largos) para `lastError`. Puede ser ''. */
  detail: string;
}

export type AttachmentDownloadResult = AttachmentDownloadOk | AttachmentDownloadFailure;

/** Firma mínima de `fetch` que usamos. Inyectable: los tests no tocan la red. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AttachmentDownloadOptions {
  mediaId: string;
  accessToken: string;
  /** Tope de bytes (configuración por tenant). Default `MAX_MEDIA_BYTES`. */
  maxBytes?: number;
  /** Whitelist efectiva. Default: todos los formatos admitidos por el contrato. */
  allowedMimes?: readonly AttachmentAllowedMime[];
  metadataTimeoutMs?: number;
  contentTimeoutMs?: number;
  /** Reintentos EXTRA de lectura. Default `MEDIA_MAX_RETRIES`. */
  retries?: number;
  /** Backoff base. Los tests lo ponen en 0 para no dormir. */
  retryDelayMs?: number;
  fetchImpl?: FetchLike;
}

const fail = (reason: MediaRejectReason, detail = ''): AttachmentDownloadFailure => ({
  ok: false,
  reason,
  detail: sanitizeAttachmentError(detail),
});

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** ¿El status amerita reintentar? Solo fallas del servidor y throttling: un 4xx no se arregla solo. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

interface ReadAttempt {
  ok: boolean;
  res?: Response;
  status: number | null;
  /** Timer del abort: lo cancela el LLAMADOR cuando terminó de consumir el cuerpo. */
  clearTimeoutFn: () => void;
  error?: unknown;
}

/**
 * GET con timeout duro y reintentos acotados. El timer NO se cancela al recibir los headers:
 * sigue corriendo hasta que el caller diga que terminó de leer el cuerpo (`clearTimeoutFn`),
 * así el timeout cubre también un stream que gotea para siempre.
 */
async function fetchRead(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retries: number,
  retryDelayMs: number,
  fetchImpl: FetchLike,
): Promise<ReadAttempt> {
  let last: ReadAttempt = { ok: false, status: null, clearTimeoutFn: () => {} };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const clearTimeoutFn = () => clearTimeout(timer);
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      if (res.ok) return { ok: true, res, status: res.status, clearTimeoutFn };
      clearTimeoutFn();
      // Cuerpo de error descartado explícitamente: sin esto el socket queda ocupado hasta el GC.
      try {
        await (res.body as ReadableStream<Uint8Array> | null)?.cancel?.();
      } catch {
        /* ya estaba cerrado */
      }
      last = { ok: false, status: res.status, clearTimeoutFn: () => {} };
      if (!isRetryableStatus(res.status)) return last;
    } catch (e) {
      clearTimeoutFn();
      // Timeout (abort) y errores de red entran acá: ambos son reintentables.
      last = { ok: false, status: null, clearTimeoutFn: () => {}, error: e };
    }
    if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
  }
  return last;
}

interface VerifiedBody {
  buffer: Buffer;
  bytes: number;
  checksum: string;
  verifiedMime: AttachmentAllowedMime;
}

/**
 * Lee el cuerpo EN STREAMING aplicando, en este orden: tope de bytes, sniffing de magic bytes y
 * cotejo contra el MIME declarado. Aborta la conexión en cuanto una de las tres falla — por eso
 * un archivo rechazado nunca se materializa entero ni llega a Storage.
 */
async function readVerifiedBody(
  res: Response,
  opts: { maxBytes: number; declaredMime: string | null; allowed: readonly AttachmentAllowedMime[] },
): Promise<{ ok: true; body: VerifiedBody } | AttachmentDownloadFailure> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    // Sin cuerpo legible no hay forma de acotar el tamaño: se rechaza en vez de caer a
    // `arrayBuffer()`, que es justamente lo que había que dejar de hacer.
    return fail('fetch_failed', 'respuesta sin cuerpo legible');
  }
  const reader = body.getReader();
  /** Cortar la conexión: `reader.cancel()` propaga la cancelación al socket (el stream está
   *  bloqueado por el reader, así que `body.cancel()` tiraría TypeError). Se ESPERA para que el
   *  socket quede liberado antes de devolver el rechazo. */
  const abort = async () => {
    try {
      await reader.cancel();
    } catch {
      /* ya estaba cerrado */
    }
  };
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let total = 0;
  let head = Buffer.alloc(0);
  let verifiedMime: AttachmentAllowedMime | null = null;

  /** Decide el MIME real con lo que haya en `head`. `final` = ya no vienen más bytes. */
  const verifyHead = (final: boolean): AttachmentDownloadFailure | null => {
    if (verifiedMime) return null;
    if (!final && head.length < ATTACHMENT_SNIFF_MIN_BYTES) return null;
    const sniffed = sniffAttachmentMime(head);
    if (!sniffed) return fail('unsupported_type', 'el contenido real no es un formato admitido');
    if (!allowedHas(opts.allowed, sniffed)) {
      return fail('unsupported_type', 'formato real no habilitado para este adjunto');
    }
    // Un declarado ausente no contradice nada (Graph a veces no lo manda) y el que manda es el
    // verificado igual. Un declarado PRESENTE que no coincide sí es señal de mentira ⇒ rechazo.
    if (opts.declaredMime && !declaredMimeMatchesVerified(opts.declaredMime, sniffed)) {
      return fail('mime_mismatch', 'el tipo declarado no coincide con el contenido');
    }
    verifiedMime = sniffed;
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      // COPIA, no vista: un chunk que compartiera memoria con el buffer del transporte podría
      // reescribirse antes del `concat` final y corromper lo que termina en Storage.
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > opts.maxBytes) {
        await abort();
        return fail('too_large', 'el archivo supera el máximo permitido');
      }
      if (head.length < ATTACHMENT_SNIFF_MIN_BYTES) {
        head = Buffer.concat([head, chunk.subarray(0, ATTACHMENT_SNIFF_MIN_BYTES - head.length)]);
      }
      const rechazo = verifyHead(false);
      if (rechazo) {
        await abort();
        return rechazo;
      }
      hash.update(chunk);
      chunks.push(chunk);
    }
  } catch (e) {
    await abort();
    return fail('fetch_failed', e instanceof Error ? e.name : 'lectura interrumpida');
  }

  const rechazoFinal = verifyHead(true);
  if (rechazoFinal) return rechazoFinal;
  if (!verifiedMime) return fail('unsupported_type', 'archivo vacío');
  return {
    ok: true,
    body: { buffer: Buffer.concat(chunks, total), bytes: total, checksum: hash.digest('hex'), verifiedMime },
  };
}

function allowedHas(allowed: readonly AttachmentAllowedMime[], mime: AttachmentAllowedMime): boolean {
  return allowed.includes(mime);
}

/**
 * Descarga VERIFICADA de un adjunto. Nunca lanza: todo error sale como `{ok:false, reason, detail}`
 * para que la ingesta lo deje visible y recuperable en el documento del adjunto.
 */
export async function downloadWhatsappAttachment(
  opts: AttachmentDownloadOptions,
): Promise<AttachmentDownloadResult> {
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : MAX_MEDIA_BYTES;
  const allowed = opts.allowedMimes ?? ATTACHMENT_ALLOWED_MIME_TYPES;
  const retries = Number.isSafeInteger(opts.retries) && (opts.retries as number) >= 0 ? (opts.retries as number) : MEDIA_MAX_RETRIES;
  const retryDelayMs = Number.isSafeInteger(opts.retryDelayMs) && (opts.retryDelayMs as number) >= 0 ? (opts.retryDelayMs as number) : RETRY_BASE_DELAY_MS;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const auth = { Authorization: `Bearer ${opts.accessToken}` };

  // 1) Metadata del media (mime + tamaño + URL efímera firmada).
  const metaAttempt = await fetchRead(
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(opts.mediaId)}`,
    { method: 'GET', headers: auth },
    opts.metadataTimeoutMs ?? MEDIA_METADATA_TIMEOUT_MS,
    retries,
    retryDelayMs,
    doFetch,
  );
  if (!metaAttempt.ok || !metaAttempt.res) {
    metaAttempt.clearTimeoutFn();
    logger.warn('mediaClient: metadata del media falló', { status: metaAttempt.status });
    return fail('fetch_failed', `metadata status ${metaAttempt.status ?? 'sin respuesta'}`);
  }

  // El timer sigue vivo mientras se lee el JSON: el timeout cubre el cuerpo, no solo los headers.
  let meta: { url?: string; mime_type?: string; file_size?: number };
  try {
    meta = (await metaAttempt.res.json()) as { url?: string; mime_type?: string; file_size?: number };
  } catch {
    return fail('fetch_failed', 'metadata ilegible');
  } finally {
    metaAttempt.clearTimeoutFn();
  }

  const declaredMime = normalizeMimeType(meta.mime_type);
  // Descarte TEMPRANO (`received → rejected` del contrato): si lo declarado ya está fuera de la
  // whitelist o del tope, no hay ningún motivo para gastar la descarga. Un declarado que MIENTE
  // hacia adentro de la whitelist se cae después, en el sniffing.
  // El cotejo va por `declaredMimeMatchesVerified` y no por igualdad: así los alias que manda
  // Graph (`image/jpg`) se resuelven con la MISMA tabla que usa la verificación, sin duplicarla.
  if (declaredMime && !allowed.some((permitido) => declaredMimeMatchesVerified(declaredMime, permitido))) {
    logger.info('mediaClient: tipo declarado no admitido', { declaredMime });
    return fail('unsupported_type', 'tipo declarado no admitido');
  }
  const declaredSize = typeof meta.file_size === 'number' && Number.isFinite(meta.file_size) ? meta.file_size : 0;
  if (declaredSize > maxBytes) {
    logger.info('mediaClient: media declarado demasiado grande', { declaredSize, maxBytes });
    return fail('too_large', 'tamaño declarado sobre el máximo');
  }
  if (!meta.url) return fail('fetch_failed', 'metadata sin url');

  // 2) Contenido. La URL es firmada/efímera: NO se loguea ni se persiste jamás.
  const binAttempt = await fetchRead(
    meta.url,
    { method: 'GET', headers: auth },
    opts.contentTimeoutMs ?? MEDIA_CONTENT_TIMEOUT_MS,
    retries,
    retryDelayMs,
    doFetch,
  );
  if (!binAttempt.ok || !binAttempt.res) {
    binAttempt.clearTimeoutFn();
    logger.warn('mediaClient: descarga del contenido falló', { status: binAttempt.status });
    return fail('fetch_failed', `contenido status ${binAttempt.status ?? 'sin respuesta'}`);
  }
  const res = binAttempt.res;

  // Content-Length es una PISTA (mentible), pero si ya dice que se pasa, cortamos sin leer nada
  // — cancelando el cuerpo para no dejar el socket colgado.
  const declaredLength = Number(res.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    binAttempt.clearTimeoutFn();
    try {
      await (res.body as ReadableStream<Uint8Array> | null)?.cancel?.();
    } catch {
      /* el stream ya podía estar cerrado */
    }
    return fail('too_large', 'content-length sobre el máximo');
  }

  const leido = await readVerifiedBody(res, { maxBytes, declaredMime, allowed });
  binAttempt.clearTimeoutFn();
  if (!leido.ok) return leido;

  return {
    ok: true,
    buffer: leido.body.buffer,
    bytes: leido.body.bytes,
    verifiedMime: leido.body.verifiedMime,
    declaredMime,
    checksum: leido.body.checksum,
  };
}

// AQUÍ VIVÍAN `downloadWhatsappMedia`, `MediaDownloadResult` y `extensionForMime`, el wrapper
// LEGACY del camino de comprobantes. Ese camino murió con `orders/comprobanteImage.ts`: hoy TODO
// archivo entrante baja por `downloadWhatsappAttachment` y se guarda como adjunto (ADR-0016 §1),
// con rutas sin extensión. Se eliminan en vez de dejarlos "por si acaso": un wrapper sin consumidor
// es una segunda puerta de descarga que nadie mantiene y que se salta los límites por tenant.

// ---------------------------------------------------------------------------
// Subida de media a Meta (ADR-0021 §5 — envío manual de imagen/archivo)
// ---------------------------------------------------------------------------

/** Cubre el POST multipart completo (headers + cuerpo). Mismo orden de magnitud que la descarga. */
export const MEDIA_UPLOAD_TIMEOUT_MS = 30_000;

export interface WhatsappMediaUploadOptions {
  phoneNumberId: string;
  /** Token del TENANT (resuelto por el caller). NUNCA se loguea ni viaja en errores. */
  accessToken: string;
  buffer: Buffer;
  /** MIME que el caller YA verificó por magic bytes. Acá se re-verifica igual (fail-closed). */
  mimeType: string;
  /** Nombre decorativo del multipart (ya saneado por el caller). */
  filename?: string | null;
  /** Tope de bytes. Default `MAX_MEDIA_BYTES`. */
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/**
 * Resultado del upload, alineado con la semántica de envío (SHIPPING-CHAT-3B):
 *  - 'rejected' = NO llegó nada a Meta o Meta lo negó con 4xx — reintento SEGURO.
 *  - 'unknown'  = 5xx/timeout/red/respuesta ilegible. A diferencia de un MENSAJE, una subida
 *    ambigua tampoco alcanzó al cliente (el envío es un segundo POST separado), así que el
 *    caller puede compensar y reintentar sin riesgo de duplicar mensajes.
 */
export type WhatsappMediaUploadResult =
  | { ok: true; mediaId: string }
  | { ok: false; outcome: 'rejected' | 'unknown'; detail: string };

const uploadFail = (outcome: 'rejected' | 'unknown', detail: string): WhatsappMediaUploadResult => ({
  ok: false,
  outcome,
  detail: sanitizeAttachmentError(detail),
});

/**
 * POST `/{pnid}/media` multipart (FormData/Blob NATIVOS de Node 20 — cero dependencias nuevas).
 *
 * Reglas:
 *  - MIME re-verificado por magic bytes ANTES de tocar la red: aunque el caller ya validó, esta
 *    función es una puerta de salida de bytes hacia Meta y no confía en su caller (fail-closed).
 *  - SIN reintentos: es una ESCRITURA (mismo criterio que la descarga solo reintenta lecturas).
 *    Reintentar la subida es decisión del caller, que tiene la reserva de idempotencia.
 *  - Timeout duro con AbortController (cubre headers + cuerpo).
 *  - Errores SANEADOS: jamás el token, jamás la URL, jamás payload crudo de Graph. En una
 *    excepción se conserva solo `e.name` (el message puede citar la URL con el token).
 */
export async function uploadWhatsappMedia(
  opts: WhatsappMediaUploadOptions,
): Promise<WhatsappMediaUploadResult> {
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : MAX_MEDIA_BYTES;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as FetchLike);

  if (!Buffer.isBuffer(opts.buffer) || opts.buffer.length === 0) {
    return uploadFail('rejected', 'archivo vacío');
  }
  if (opts.buffer.length > maxBytes) {
    return uploadFail('rejected', 'el archivo supera el máximo permitido');
  }
  const declared = normalizeMimeType(opts.mimeType);
  const sniffed = sniffAttachmentMime(opts.buffer.subarray(0, ATTACHMENT_SNIFF_MIN_BYTES));
  if (!sniffed || !declared || !declaredMimeMatchesVerified(declared, sniffed)) {
    return uploadFail('rejected', 'el tipo declarado no coincide con el contenido');
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', sniffed);
  // El filename del multipart es decorativo (ya saneado por el caller); nunca arma rutas.
  form.append('file', new Blob([new Uint8Array(opts.buffer)], { type: sniffed }), opts.filename || 'archivo');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? MEDIA_UPLOAD_TIMEOUT_MS);
  try {
    const res = await doFetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(opts.phoneNumberId)}/media`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.accessToken}` },
        body: form,
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      // Cuerpo de error descartado explícitamente (mismo criterio que fetchRead).
      try {
        await (res.body as ReadableStream<Uint8Array> | null)?.cancel?.();
      } catch {
        /* ya estaba cerrado */
      }
      const esRechazo = res.status >= 400 && res.status < 500;
      logger.warn('mediaClient: la subida del media falló', { status: res.status, outcome: esRechazo ? 'rejected' : 'unknown' });
      return uploadFail(esRechazo ? 'rejected' : 'unknown', `subida status ${res.status}`);
    }
    let json: { id?: unknown };
    try {
      json = (await res.json()) as { id?: unknown };
    } catch {
      return uploadFail('unknown', 'respuesta de subida ilegible');
    }
    const id = json.id;
    if (typeof id === 'string' && id.trim().length > 0) return { ok: true, mediaId: id };
    // 2xx sin id: NO se inventa un media id (mismo criterio que sendResultFromCloudResponse).
    return uploadFail('unknown', 'respuesta de subida sin id de media');
  } catch (e) {
    // Timeout (abort) y errores de red. Solo `e.name`: el message podría citar la URL con token.
    logger.warn('mediaClient: la subida del media se interrumpió', {
      error: e instanceof Error ? e.name : 'desconocido',
    });
    return uploadFail('unknown', e instanceof Error ? e.name : 'subida interrumpida');
  } finally {
    clearTimeout(timer);
  }
}
