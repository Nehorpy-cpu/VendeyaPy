/**
 * meta/attachmentIngest.ts — Ingesta de adjuntos de conversación (ADR-0016 / ARCHITECTURE §4.12)
 * ==============================================================================================
 * El adjunto genérico existe ANTES que cualquier clasificación: acá se GUARDA el archivo y se
 * deja visible en el chat, sin ninguna interpretación de negocio. Qué significa el archivo lo
 * decide después el gate (costura `attachmentGate`), y el pago siempre lo decide una persona.
 *
 * Garantías que este módulo tiene que sostener:
 *  1. IDEMPOTENCIA. El `attachmentId` es determinístico sobre (tenant, canal, providerMessageId,
 *     providerMediaId) y el documento se escribe con `create()`: un reintento del webhook falla
 *     en vez de duplicar el adjunto, la burbuja del chat y —sobre todo— la descarga de bytes.
 *  2. NADA SE PIERDE EN SILENCIO. Un rechazo o una descarga fallida quedan como estado terminal
 *     del adjunto + `lastError` SANEADO: visibles en el panel y recuperables para el negocio
 *     (se le pide al cliente que reenvíe). Antes, una imagen sin pedido pendiente jamás se
 *     descargaba y un PDF desaparecía sin dejar rastro.
 *  3. CERO PII. Ni teléfonos, ni mediaIds, ni rutas, ni URLs firmadas en los logs. El
 *     `attachmentId` es un hash opaco, así que sí se puede loguear.
 *  4. NADA DE VERTICAL. Formatos y tope de bytes entran por parámetro (configuración por tenant).
 */
import { Timestamp } from 'firebase-admin/firestore';
import {
  ATTACHMENT_INITIAL_CLASSIFICATION,
  ATTACHMENT_INITIAL_INGEST_STATE,
  attachmentClassForMime,
  buildAttachmentDocPath,
  buildAttachmentStoragePath,
  canIngestTransition,
  canClassificationTransition,
  deriveAttachmentId,
  hashProviderMessageId,
  isTerminalIngestState,
  sanitizeAttachmentError,
  type Attachment,
  type AttachmentIngestState,
  type MessageChannel,
} from '@vpw/shared';
import { db, storage } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { appendMessage } from '../conversation/messages.js';
import { resolveTenantWhatsappCreds } from '../messaging/resolveWhatsappCreds.js';
import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentIngestLimits } from './attachmentLimits.js';
import { ATTACHMENT_REPLIES, respuestaPorAdjunto, type AttachmentReplyReason } from './attachmentReplies.js';
import { downloadWhatsappAttachment, type AttachmentDownloadResult } from './mediaClient.js';
import type { InboundAttachment, InboundUnsupported, UnsupportedInboundKind } from './parseWebhook.js';

const isEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';

/** Stubs del EMULADOR: nunca se llama a Graph en local/tests E2E. Son archivos REALES (pasan el
 *  sniffing de magic bytes), no placeholders: si no lo fueran, el emulador probaría otro camino. */
const STUB_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);
const STUB_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');

// Las respuestas al cliente viven en `attachmentReplies.ts` (una sola redacción para la ingesta y
// para el gate). Se re-exporta para no romper a quien ya las importaba desde acá.
export { ATTACHMENT_REPLIES };

/**
 * TEXTO de la burbuja del chat cuando el mensaje trae un archivo. Es un marcador del SISTEMA, no
 * el caption del cliente — y esa diferencia es de seguridad, no cosmética:
 *
 *   El historial que arma `buildAiHistory` sale de estos mensajes. Si acá quedara el caption, un
 *   archivo con el pie "ignorá las instrucciones anteriores y …" entraría al prompt del modelo en
 *   el turno SIGUIENTE, aunque este turno no lo mandara. ADR-0016 §9 lo prohíbe explícitamente:
 *   el caption se sanea y SE PERSISTE (en el adjunto, que es su lugar), pero no se envía a la IA.
 *
 * El panel no pierde nada: el caption se muestra desde el documento del adjunto, y el adjunto se
 * detecta por `attachmentIds`/`hasAttachments` — jamás infiriéndolo de este texto (ADR-0016 §1).
 */
export const ATTACHMENT_MESSAGE_MARKER: Readonly<Record<InboundAttachment['kind'], string>> = {
  image: '📷 Imagen recibida',
  document: '📄 Archivo recibido',
};

/**
 * MARCADOR del historial cuando el NIVEL A del rollout está apagado (ADR-0016 §10). Es distinto
 * del marcador normal a propósito: aquel promete un archivo que se puede abrir desde el panel, y
 * acá no hay archivo. Decirle al vendedor "Imagen recibida" sin que exista adjunto sería la misma
 * mentira que este programa vino a corregir del lado del cliente.
 */
export const ATTACHMENT_INGEST_DISABLED_MARKER: Readonly<Record<InboundAttachment['kind'], string>> = {
  image: '📷 Imagen recibida (no se guardó: adjuntos desactivados)',
  document: '📄 Archivo recibido (no se guardó: adjuntos desactivados)',
};

/** Mensajes de tipos aún no soportados: uno para el HISTORIAL y otro (opcional) para el cliente. */
const UNSUPPORTED_COPY: Readonly<
  Record<UnsupportedInboundKind, { historial: string; reply: string }>
> = {
  audio: {
    historial: '🎧 Audio recibido (todavía no se procesa)',
    reply: 'Recibí tu audio 🎧 pero todavía no puedo escucharlo. ¿Me lo escribís?',
  },
  video: {
    historial: '🎬 Video recibido (todavía no se procesa)',
    reply: 'Recibí tu video 🎬 pero todavía no puedo verlo. ¿Me contás por escrito?',
  },
  // Un sticker no pide respuesta: queda registrado en el chat y listo (responderle sería ruido).
  sticker: { historial: '🩵 Sticker recibido', reply: '' },
};

export interface IngestAttachmentInput {
  tenantId: string;
  /** Solo dígitos (mismo id que usa el motor). ES el teléfono ⇒ jamás va a logs ni a rutas. */
  customerId: string;
  channel: MessageChannel;
  /** wamid CRUDO del proveedor: se hashea acá y nunca se persiste ni se loguea crudo. */
  providerMessageId: string;
  attachment: InboundAttachment;
  receivedByPhoneNumberId?: string | null;
  now?: Timestamp;
  /** Límites del TENANT (ADR-0016 §8). Ausentes ⇒ los defaults del código. */
  limits?: AttachmentIngestLimits;
}

export interface IngestAttachmentResult {
  attachmentId: string;
  /** Id (determinístico) del mensaje del historial que quedó apuntando al adjunto. */
  messageId: string;
  ingestState: AttachmentIngestState;
  /** true = el adjunto ya existía Y ya estaba en un estado terminal: no se bajó nada de nuevo. */
  duplicate: boolean;
  /** Texto a responderle al cliente ('' = no hay nada que decir por este camino). */
  reply: string;
  /**
   * Motivo por el que la ingesta no terminó en `stored`. El caller lo usa para elegir la
   * redacción — así ninguna recepción queda muda (ADR-0016 §4).
   */
  reason: AttachmentReplyReason | null;
  attachment: Attachment | null;
}

export interface AttachmentIngestDeps {
  download: (
    tenantId: string,
    attachment: InboundAttachment,
    limits: AttachmentIngestLimits,
  ) => Promise<AttachmentDownloadResult>;
  saveBytes: (path: string, buffer: Buffer, contentType: string) => Promise<void>;
}

export const defaultIngestDeps: AttachmentIngestDeps = {
  download: async (tenantId, attachment, limits) => {
    if (isEmulator()) {
      const esPdf = attachment.kind === 'document' || attachment.declaredMime === 'application/pdf';
      const buffer = esPdf ? STUB_PDF : STUB_JPEG;
      return {
        ok: true,
        buffer,
        bytes: buffer.length,
        verifiedMime: esPdf ? 'application/pdf' : 'image/jpeg',
        declaredMime: attachment.declaredMime,
        checksum: 'emulador',
      };
    }
    const creds = await resolveTenantWhatsappCreds(tenantId);
    if (!creds.ok) {
      logger.warn('attachment: sin credenciales para descargar el media', { tenantId, reason: creds.reason });
      return { ok: false, reason: 'fetch_failed', detail: `credenciales: ${creds.reason}` };
    }
    return downloadWhatsappAttachment({
      mediaId: attachment.mediaId,
      accessToken: creds.accessToken,
      maxBytes: limits.maxBytes,
      allowedMimes: limits.allowedMimeTypes,
    });
  },
  saveBytes: async (path, buffer, contentType) => {
    // `resumable:false` = una sola llamada (archivos chicos). El contentType es el VERIFICADO:
    // si acá entrara el declarado, un HTML podría servirse como HTML desde una URL firmada.
    await storage().bucket().file(path).save(buffer, { contentType, resumable: false });
  },
};

function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: number | string } | null)?.code;
  return code === 6 || code === 'already-exists' || /already.?exists/i.test(String(e));
}

/**
 * Cuánto tiempo tiene que llevar un adjunto NO TERMINAL sin moverse para que un reintento del
 * webhook lo retome. Es holgadamente mayor que el timeout de `onWebhookInbox` (180 s): si el
 * documento sigue en `received`/`downloading` pasado ese lapso, la corrida que lo creó ya está
 * muerta y nadie más va a terminarlo. El margen evita el otro riesgo —dos entregas concurrentes
 * de Meta, que llegan con segundos de diferencia, bajando el mismo archivo dos veces—.
 *
 * QUIÉN VUELVE A ENTRAR: el rescate del evento en `process.ts` (`WEBHOOK_STUCK_MS`). Sin él este
 * umbral era código muerto —`processWebhookEvent` marcaba `processing` antes de trabajar y salía
 * temprano si el estado no era `received`, así que ningún reintento llegaba hasta acá—.
 */
export const INGEST_STUCK_MS = 5 * 60 * 1000;

/**
 * Ingesta un adjunto entrante.
 *
 * CONTRATO DE FALLAS —y esto es lo que el docblock decía mal—: **una vez creado el documento del
 * adjunto, esta función no lanza**. Todo lo que explote de ahí en adelante (la burbuja del chat,
 * la descarga, Storage, un bug nuestro) termina en un ESTADO TERMINAL del adjunto + `lastError`
 * saneado, que es visible en el panel y recuperable para el negocio: se le pide al cliente que
 * reenvíe. Si en cambio subiera como excepción, el webhook marcaría el evento 'failed' y el
 * archivo volvería a perderse — el bug original.
 *
 * La ÚNICA excepción que sí sale es que falle el `create()` del ancla por algo que no sea
 * "ya existe": ahí no hay documento al que dejarle un estado terminal, así que fingir que la
 * ingesta terminó sería peor que dejar el evento en 'failed' con el mediaId intacto en el inbox
 * (lo único que permite recuperar el archivo a mano). El caller lo trata como cualquier otro
 * fallo del webhook.
 */
export async function ingestInboundAttachment(
  input: IngestAttachmentInput,
  deps: AttachmentIngestDeps = defaultIngestDeps,
): Promise<IngestAttachmentResult> {
  const { tenantId, customerId, channel, attachment } = input;
  const now = input.now ?? Timestamp.now();
  const limits = input.limits ?? DEFAULT_ATTACHMENT_LIMITS;

  const attachmentId = deriveAttachmentId({
    tenantId,
    channel,
    providerMessageId: input.providerMessageId,
    providerMediaId: attachment.mediaId,
  });
  // El id del mensaje del historial también es determinístico: dos adjuntos del MISMO mensaje del
  // proveedor comparten burbuja y acumulan punteros (`arrayUnion`), no la duplican.
  const messageId = hashProviderMessageId(tenantId, input.providerMessageId);
  const ref = db().doc(buildAttachmentDocPath(tenantId, attachmentId));

  const base: Attachment = {
    attachmentId,
    tenantId,
    customerId,
    conversationId: customerId, // hoy 1:1 con el cliente; explícito para omnicanal
    messageId,
    providerMessageId: messageId, // HASHEADO y tenant-scoped: nunca el wamid crudo
    channel,
    class: attachment.kind === 'document' ? 'document' : 'image', // provisorio: manda el verificado
    direction: 'in',
    author: 'customer',
    ingestState: ATTACHMENT_INITIAL_INGEST_STATE,
    classification: {
      value: ATTACHMENT_INITIAL_CLASSIFICATION,
      source: 'rule',
      confidence: 0,
      by: null,
      at: null,
    },
    caption: attachment.caption,
    filename: attachment.filename,
    mime: { declared: attachment.declaredMime, verified: null },
    bytes: null,
    checksum: null,
    storage: { path: null },
    orderCandidateId: null,
    // Retención: sin política del tenant no vence nada y la purga viene APAGADA (ADR-0016).
    retentionUntil: null,
    purgedAt: null,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };

  // El documento del adjunto es el ANCLA de idempotencia: se crea ANTES que la burbuja del chat
  // para que un reintento no vuelva a bajar los bytes (que es lo caro y lo que puede duplicar).
  let estadoInicial: AttachmentIngestState = ATTACHMENT_INITIAL_INGEST_STATE;
  try {
    await ref.create(base);
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
    // La relectura NO puede tumbar la función: el documento ya existe ⇒ estamos en un reintento y
    // lanzar acá rompería el contrato de fallas de arriba. Sin poder leerlo, se lo trata como
    // duplicado NO atascado, que es la opción que nunca vuelve a bajar los bytes.
    const existente = await ref
      .get()
      .then((s) => s.data() as Attachment | undefined)
      .catch((e2) => {
        logger.error('attachment: no se pudo releer el adjunto existente', e2, { tenantId, attachmentId });
        return undefined;
      });
    const previo = existente?.ingestState ?? ATTACHMENT_INITIAL_INGEST_STATE;
    // RETOMAR en vez de salir sin hacer nada. El `create()` es el ancla de idempotencia, pero si
    // la corrida anterior murió entre el `create()` y el estado terminal (timeout de la función,
    // instancia reciclada), el adjunto quedaba en `received`/`downloading` PARA SIEMPRE: sin
    // bytes, sin `lastError` y sin nadie que lo barra. Quien vuelve a entrar acá es el rescate del
    // evento (`WEBHOOK_STUCK_MS` en `process.ts`): sin él este camino no era alcanzable.
    const actualizadoMs = (existente?.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    const atascado =
      !!existente && !isTerminalIngestState(previo) && now.toMillis() - actualizadoMs >= INGEST_STUCK_MS;
    if (!atascado) {
      logger.info('attachment: reintento del webhook, adjunto ya existente', {
        tenantId,
        attachmentId,
        ingestState: previo,
      });
      return {
        attachmentId,
        messageId,
        ingestState: previo,
        duplicate: true,
        reply: '',
        reason: null,
        attachment: existente ?? null,
      };
    }
    logger.warn('attachment: adjunto NO terminal y sin movimiento, se retoma la ingesta', {
      tenantId,
      attachmentId,
      ingestState: previo,
    });
    estadoInicial = previo;
  }

  let estado: AttachmentIngestState = estadoInicial;
  /** Avanza el eje de INGESTA validando la transición contra la máquina compartida. */
  const avanzar = async (to: AttachmentIngestState, patch: Record<string, unknown> = {}) => {
    if (!canIngestTransition(estado, to, 'system')) {
      logger.warn('attachment: transición de ingesta ilegal, se ignora', { tenantId, attachmentId, from: estado, to });
      return;
    }
    await ref.update({ ingestState: to, updatedAt: Timestamp.now(), ...patch });
    estado = to;
  };

  const cerrarConError = async (
    to: Extract<AttachmentIngestState, 'rejected' | 'download_failed'>,
    detalle: string,
    reason: AttachmentReplyReason,
    /** Solo un rechazo REAL del archivo cierra también la clasificación (ver abajo). */
    clasificarRechazado = to === 'rejected',
  ): Promise<IngestAttachmentResult> => {
    const lastError = sanitizeAttachmentError(detalle);
    const patch: Record<string, unknown> = { lastError };
    // Un adjunto RECHAZADO no tiene archivo que significar ⇒ su clasificación también es terminal.
    // Un `download_failed` queda `unclassified` a propósito: no se descarta, queda pendiente.
    if (clasificarRechazado && canClassificationTransition('unclassified', 'rejected', 'system')) {
      patch['classification'] = { value: 'rejected', source: 'rule', confidence: 1, by: null, at: Timestamp.now() };
    }
    await avanzar(to, patch);
    logger.info('attachment: ingesta sin archivo almacenado', { tenantId, attachmentId, ingestState: estado, detalle: lastError });
    const doc = (await ref.get()).data() as Attachment | undefined;
    return {
      attachmentId,
      messageId,
      ingestState: estado,
      duplicate: false,
      reply: respuestaPorAdjunto(reason, attachment.kind),
      reason,
      attachment: doc ?? null,
    };
  };

  try {
    // En un adjunto RETOMADO el estado ya puede ser `downloading` (o más avanzado): no se
    // re-anuncia la transición, que la máquina rechazaría como `same_state` y ensuciaría los
    // logs con una advertencia que no describe ningún problema.
    if (estado === 'received') await avanzar('downloading');

    // Burbuja en el chat. El texto es un MARCADOR del sistema, nunca el caption del cliente (ver
    // `ATTACHMENT_MESSAGE_MARKER`: el caption entraría al prompt de la IA por el historial). El
    // panel tampoco infiere el adjunto desde el texto — para eso están `attachmentIds`/`hasAttachments`.
    //
    // DENTRO del try, y no antes: `appendMessage` hace DOS escrituras a Firestore y una caída
    // transitoria de cualquiera de las dos hacía subir la excepción hasta el webhook, que marcaba
    // el evento 'failed' y perdía el archivo — el bug original, por la puerta de atrás. Acá la red
    // de seguridad de abajo la convierte en un estado terminal recuperable y en una respuesta al
    // cliente, que es lo que este módulo promete.
    //
    // Y DESPUÉS de `downloading`, no antes: desde `received` la máquina no tiene arista a
    // `download_failed` (con razón: nada se intentó bajar todavía) y la red de seguridad tendría
    // que cerrar en `rejected`, etiquetando como "archivo rechazado" lo que fue un hipo NUESTRO.
    // El costo es que la burbuja aparece un update más tarde; la honestidad del estado vale más.
    await appendMessage(tenantId, customerId, {
      direction: 'in',
      author: 'customer',
      text: ATTACHMENT_MESSAGE_MARKER[attachment.kind],
      now,
      channel,
      receivedVia: input.receivedByPhoneNumberId ?? null,
      docId: messageId,
      attachmentIds: [attachmentId],
    });

    let media: AttachmentDownloadResult;
    try {
      media = await deps.download(tenantId, attachment, limits);
    } catch (e) {
      return await cerrarConError('download_failed', e instanceof Error ? e.message : 'descarga interrumpida', 'download_failed');
    }

    if (!media.ok) {
      if (media.reason === 'fetch_failed') {
        return await cerrarConError('download_failed', media.detail || 'no se pudo descargar', 'download_failed');
      }
      const reason: AttachmentReplyReason = media.reason === 'too_large' ? 'too_large' : 'unsupported_type';
      return await cerrarConError('rejected', media.detail || media.reason, reason);
    }

    // La subida ocurre TODAVÍA en `downloading`, a propósito: hasta que los bytes no están en
    // nuestro bucket no son nuestros, y desde `verifying` la máquina de estados (con razón) ya no
    // deja caer a `download_failed`. Un bucket caído es infra recuperable, NO un archivo rechazado:
    // marcarlo `rejected` cerraría la clasificación de algo que el cliente mandó bien.
    const path = buildAttachmentStoragePath(tenantId, attachmentId);
    try {
      await deps.saveBytes(path, media.buffer, media.verifiedMime);
    } catch (e) {
      return await cerrarConError('download_failed', e instanceof Error ? e.message : 'no se pudo guardar el archivo', 'download_failed');
    }

    // Bytes verificados y guardados: se asienta el MIME real (el declarado queda como evidencia).
    await avanzar('verifying', {
      'mime.verified': media.verifiedMime,
      class: attachmentClassForMime(media.verifiedMime),
      bytes: media.bytes,
      checksum: media.checksum,
    });
    await avanzar('stored', { 'storage.path': path });
    const doc = (await ref.get()).data() as Attachment | undefined;
    logger.info('attachment: almacenado', {
      tenantId,
      attachmentId,
      class: attachmentClassForMime(media.verifiedMime),
      bytes: media.bytes,
      mimeDeclaradoCoincide: media.declaredMime === media.verifiedMime,
    });
    // Sin respuesta propia: qué se le contesta al cliente por un archivo VÁLIDO es una decisión de
    // negocio del gate (ADR-0016 §4), no de la ingesta.
    return { attachmentId, messageId, ingestState: estado, duplicate: false, reply: '', reason: null, attachment: doc ?? null };
  } catch (e) {
    // RED DE SEGURIDAD. Cualquier cosa que explote acá adentro (Firestore, un bug nuestro) dejaba
    // el adjunto colgado en un estado no terminal, sin `lastError` y sin nada que lo barriera.
    // Ahora se cierra SIEMPRE en el terminal que la máquina de estados permita desde donde
    // estemos: `download_failed` mientras haya descarga en curso; ya en `verifying` esa arista no
    // existe (y con razón) y el único terminal alcanzable es `rejected` — pero SIN cerrar la
    // clasificación: el archivo no hizo nada malo, falló nuestra infraestructura.
    const destino: Extract<AttachmentIngestState, 'rejected' | 'download_failed'> | null =
      canIngestTransition(estado, 'download_failed', 'system') ? 'download_failed'
      : canIngestTransition(estado, 'rejected', 'system') ? 'rejected'
      : null;
    const detalle = e instanceof Error ? e.message : 'fallo inesperado en la ingesta';
    logger.error('attachment: fallo inesperado en la ingesta', e, { tenantId, attachmentId, ingestState: estado });
    if (!destino) {
      // Ya estaba en un terminal (p. ej. explotó la relectura final): no hay nada que arreglar.
      const doc = await ref.get().then((s) => s.data() as Attachment | undefined).catch(() => undefined);
      return { attachmentId, messageId, ingestState: estado, duplicate: false, reply: '', reason: null, attachment: doc ?? null };
    }
    try {
      return await cerrarConError(destino, detalle, 'download_failed', false);
    } catch (e2) {
      // Ni siquiera se pudo escribir el estado terminal (Firestore caído). Se responde igual al
      // cliente: quedarse mudo es exactamente lo que ADR-0016 §4 prohíbe.
      logger.error('attachment: no se pudo persistir el estado terminal', e2, { tenantId, attachmentId });
      return {
        attachmentId,
        messageId,
        ingestState: estado,
        duplicate: false,
        reply: ATTACHMENT_REPLIES.download_failed,
        reason: 'download_failed',
        attachment: null,
      };
    }
  }
}

export interface UnsupportedInboundResult {
  messageId: string;
  reply: string;
}

/**
 * NIVEL A DEL ROLLOUT APAGADO (ADR-0016 §10). El tenant todavía no encendió
 * `config/attachments.ingest.enabled`, así que NO se toca Graph, NO se escribe un byte en Storage
 * y NO se crea documento de adjunto — pero el inbound tampoco puede desaparecer: queda un mensaje
 * neutral estructurado en la conversación y el cliente recibe una respuesta honesta.
 *
 * Es deliberadamente hermana de `recordUnsupportedInbound` y no una variante de la ingesta: las
 * dos describen el mismo hecho —"llegó algo que no vamos a procesar, y se dice"— y ninguna de las
 * dos tiene efectos de negocio. Acá NO se revive el camino legacy de "toda imagen es un
 * comprobante": no se miran pedidos, no se clasifica nada y no se hace handoff.
 *
 * El `docId` es el MISMO id determinístico que usaría la ingesta real: un reintento del webhook no
 * duplica la burbuja, y si más adelante el tenant enciende el flag, la ingesta de un mensaje nuevo
 * sigue funcionando igual (el adjunto viejo no se inventa retroactivamente — sus bytes ya no
 * existen del lado de Meta).
 */
export async function recordAttachmentIngestDisabled(input: {
  tenantId: string;
  customerId: string;
  channel: MessageChannel;
  providerMessageId: string;
  attachment: InboundAttachment;
  receivedByPhoneNumberId?: string | null;
  now?: Timestamp;
}): Promise<UnsupportedInboundResult> {
  const messageId = hashProviderMessageId(input.tenantId, input.providerMessageId);
  await appendMessage(input.tenantId, input.customerId, {
    direction: 'in',
    author: 'customer',
    // El marcador es del SISTEMA, nunca el caption del cliente: el caption entraría al prompt del
    // modelo por el historial en el turno siguiente (ADR-0016 §9). Con el nivel A apagado el
    // caption no se persiste en ningún lado, porque no hay documento de adjunto donde ponerlo.
    text: ATTACHMENT_INGEST_DISABLED_MARKER[input.attachment.kind],
    now: input.now ?? Timestamp.now(),
    channel: input.channel,
    receivedVia: input.receivedByPhoneNumberId ?? null,
    docId: messageId, // idempotente: un reintento no repite la burbuja
    // SIN `attachmentIds`: el panel decide que hay adjunto por ese campo y por nada más
    // (ADR-0016 §1). Un puntero a un documento que no existe rompería el visor.
  });
  logger.info('attachment: ingesta APAGADA para el tenant, el archivo no se descarga', {
    tenantId: input.tenantId,
    kind: input.attachment.kind,
  });
  return { messageId, reply: respuestaPorAdjunto('ingest_disabled', input.attachment.kind) };
}

/**
 * Tipo todavía no soportado (audio/video/sticker): NO se descarga nada, pero el mensaje queda
 * visible en el chat y —cuando corresponde— el cliente recibe una respuesta que le dice qué
 * hacer. Antes desaparecían en silencio y el cliente creía haber avisado.
 */
export async function recordUnsupportedInbound(input: {
  tenantId: string;
  customerId: string;
  channel: MessageChannel;
  providerMessageId: string;
  unsupported: InboundUnsupported;
  receivedByPhoneNumberId?: string | null;
  now?: Timestamp;
}): Promise<UnsupportedInboundResult> {
  const copy = UNSUPPORTED_COPY[input.unsupported.kind];
  const messageId = hashProviderMessageId(input.tenantId, input.providerMessageId);
  await appendMessage(input.tenantId, input.customerId, {
    direction: 'in',
    author: 'customer',
    text: copy.historial,
    now: input.now ?? Timestamp.now(),
    channel: input.channel,
    receivedVia: input.receivedByPhoneNumberId ?? null,
    docId: messageId, // idempotente: un reintento no repite la burbuja
  });
  logger.info('attachment: tipo entrante no soportado, registrado en el chat', {
    tenantId: input.tenantId,
    kind: input.unsupported.kind,
  });
  return { messageId, reply: copy.reply };
}
