/**
 * conversation/sendAttachment.ts — Envío manual de imagen/archivo por WhatsApp (ADR-0021 §5)
 * ===========================================================================================
 * El vendedor manda un archivo desde el panel POR EL MISMO número que recibió la conversación.
 * Reglas que este módulo sostiene:
 *
 *  1. UN SOLO CAMINO DE ROUTING: el guard compartido de `manualMessage.ts` (`resolverEnvioManual`)
 *     decide canal, takeover, gate de cotización y PNID — texto y media no pueden divergir.
 *  2. VALIDACIÓN FAIL-CLOSED ANTES DE CUALQUIER EFECTO: tope de base64 ANTES de decodificar,
 *     allowlist estricta (jpeg/png/webp para imagen, pdf para documento) y MAGIC BYTES contra el
 *     MIME declarado (sniffing de ADR-0016). SVG/HTML/EXE/ZIP caen solos: no tienen firma admitida.
 *  3. IDEMPOTENCIA por `operationId` del cliente: reserva transaccional `create()` en
 *     `tenants/{t}/outboundOps/{operationId}` ANTES de tocar Meta. Reintento del mismo op ⇒
 *     resultado previo (si terminó ok) o rebote honesto (si sigue en vuelo / quedó ambiguo).
 *  4. EL ADJUNTO SALIENTE ES UN ADJUNTO ADR-0016: ruta de Storage opaca, doc en
 *     `tenants/{t}/attachments`, MIME verificado, caption EN EL DOC (jamás como texto del
 *     mensaje ⇒ jamás llega a la IA), `direction:'out'` + `origin:'panel'` — y NUNCA puede
 *     clasificarse como comprobante (nace `generic_media`; guard adicional en receiptGate).
 *  5. DESENLACES HONESTOS (semántica de texto): accepted/mock ⇒ burbuja author 'seller' con
 *     punteros; blocked/rejected ⇒ SIN burbuja + compensación (reserva liberada) + error
 *     accionable; unknown ⇒ SIN burbuja, la reserva queda en 'unknown' y el MISMO op no se
 *     reintenta a ciegas (duplicaría al cliente).
 *  6. Acá NUNCA se llama a la IA: es un envío humano.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import {
  ATTACHMENT_SNIFF_MIN_BYTES,
  attachmentClassForMime,
  buildAttachmentDocPath,
  buildAttachmentStoragePath,
  declaredMimeMatchesVerified,
  deriveAttachmentId,
  hashProviderMessageId,
  maskPhone,
  normalizeMimeType,
  sanitizeAttachmentCaption,
  sanitizeAttachmentError,
  sanitizeAttachmentFilename,
  sniffAttachmentMime,
  type Attachment,
  type AttachmentAllowedMime,
  type Message,
} from '@vpw/shared';
import { db, storage } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { appendMessage, type AppendMessageInput } from './messages.js';
import {
  defaultManualMessageDeps,
  errorDeEnvioManualNoOk,
  resolverEnvioManual,
  type EnvioManualGuardDeps,
  type ManualMessageSender,
} from './manualMessage.js';
import {
  resolveTenantWhatsappCreds,
  resolveTenantWhatsappCredsFor,
} from '../messaging/resolveWhatsappCreds.js';
import { uploadWhatsappMedia, type WhatsappMediaUploadResult } from '../meta/mediaClient.js';

/** Prefijo de los logs del guard/errores compartidos (distingue este camino del texto). */
const CONTEXTO_LOG = 'Adjunto manual';

/** Límites del ADR-0021 §5 (tope HTTP del callable con base64). */
export const SEND_ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const SEND_ATTACHMENT_DOCUMENT_MAX_BYTES = 7 * 1024 * 1024;

/**
 * Tope EXACTO del string base64 para `maxBytes` reales: 4 caracteres por cada 3 bytes, con
 * padding. Se compara ANTES de decodificar: decodificar para descubrir que era gigante es
 * exactamente el costo que este chequeo evita. (Un string dentro del tope puede decodificar a
 * maxBytes+2 por el redondeo del padding ⇒ el tamaño REAL se re-verifica después de decodificar.)
 */
export const maxBase64LengthForBytes = (maxBytes: number): number => 4 * Math.ceil(maxBytes / 3);

/** Forma cerrada del operationId del cliente (id de segmento seguro: sin `/`, sin `..`). */
export const OUTBOUND_OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/;

/** Allowlist ESTRICTA por tipo (ADR-0021 §5). Subconjuntos de la whitelist del sniffing. */
export const SEND_ATTACHMENT_IMAGE_MIMES: readonly AttachmentAllowedMime[] = ['image/jpeg', 'image/png', 'image/webp'];
export const SEND_ATTACHMENT_DOCUMENT_MIMES: readonly AttachmentAllowedMime[] = ['application/pdf'];

/** Reserva de idempotencia. Colección propia por tenant (Admin SDK only; sin rules que abrir). */
export const outboundOpPath = (tenantId: string, operationId: string): string =>
  `tenants/${tenantId}/outboundOps/${operationId}`;

export type SendAttachmentKind = 'image' | 'document';

export interface SendAttachmentInput {
  tenantId: string;
  customerId: string;
  /** Id de operación GENERADO POR EL CLIENTE: un reintento honesto reusa el mismo. */
  operationId: string;
  kind: SendAttachmentKind;
  filename: string;
  mimeType: string;
  dataBase64: string;
  caption?: string;
}

export interface SendAttachmentResult {
  ok: true;
  viaMock: boolean;
  waMessageId: string | null;
  attachmentId: string;
  /** true = este resultado es la RELECTURA de una operación ya completada (idempotencia). */
  duplicate?: boolean;
}

/** Documento de la reserva de operación. */
export interface OutboundOpDoc {
  operationId: string;
  tenantId: string;
  /** Teléfono ⇒ vive en el doc (tenant-scoped) pero JAMÁS en logs. */
  customerId: string;
  kind: SendAttachmentKind;
  actorUid: string;
  attachmentId: string;
  state: 'pending' | 'done' | 'unknown';
  result: { viaMock: boolean; waMessageId: string | null; attachmentId: string } | null;
  lastError: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Doc de adjunto SALIENTE: contrato ADR-0016 + metadata del panel (aditiva, el visor la ignora). */
export type OutboundAttachmentDoc = Attachment & {
  direction: 'out';
  author: 'seller';
  origin: 'panel';
  uploadedByUid: string;
};

export interface SendAttachmentDeps {
  /** Guard compartido con el mensaje de texto (ADR-0021 §5 — un solo camino de routing). */
  guard: EnvioManualGuardDeps;
  /** `create()` de la reserva; si ya existe devuelve el doc existente (o null si es ilegible). */
  reserveOperation(
    tenantId: string,
    operationId: string,
    doc: OutboundOpDoc,
  ): Promise<{ created: boolean; existing: OutboundOpDoc | null }>;
  updateOperation(tenantId: string, operationId: string, patch: Record<string, unknown>): Promise<void>;
  /** Borra la reserva (compensación de un NO-ENVÍO confirmado: el reintento vuelve a crearla). */
  releaseOperation(tenantId: string, operationId: string): Promise<void>;
  saveBytes(path: string, buffer: Buffer, contentType: string): Promise<void>;
  /** Escribe (o re-escribe en un reintento legítimo) el doc del adjunto saliente. */
  writeAttachmentDoc(tenantId: string, attachmentId: string, doc: OutboundAttachmentDoc): Promise<void>;
  /** Deja el fallo visible en el doc del adjunto (saneado). El archivo NO se borra. */
  markAttachmentSendError(tenantId: string, attachmentId: string, lastError: string): Promise<void>;
  uploadMedia(
    tenantId: string,
    phoneNumberId: string | null,
    file: { buffer: Buffer; mimeType: AttachmentAllowedMime; filename: string },
  ): Promise<WhatsappMediaUploadResult>;
  append(tenantId: string, customerId: string, input: AppendMessageInput): Promise<Message>;
  now(): Timestamp;
}

/**
 * B1 — LEASE de una reserva `pending`. Si el runtime muere entre el `create()` y el desenlace,
 * el doc quedaba `pending` eterno y ese operationId rebotaba `operation_in_flight` para siempre
 * (el compositor reusa el mismo op en "Reintentar" ⇒ bloqueado sin salida). Una `pending` más
 * vieja que este lease se considera MUERTA y reclamable. 5 minutos: holgado sobre el timeout del
 * callable (120 s) — ninguna corrida viva puede seguir en vuelo cuando el lease vence.
 */
export const OUTBOUND_OP_LEASE_MS = 5 * 60 * 1000;

const opCreatedAtMillis = (value: unknown): number => {
  const ts = value as { toMillis?: () => number } | null | undefined;
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : 0;
};

export type ReservaDeOperacionDecision = { accion: 'crear' } | { accion: 'reclamar' } | { accion: 'rechazar' };

/**
 * Decisión PURA sobre una reserva (la comparten la transacción real y los tests — dos copias de
 * esta regla divergirían, y la laxa duplicaría envíos):
 *  - sin doc ⇒ crear;
 *  - `pending` DE LA MISMA OPERACIÓN (mismo customerId/kind) con lease vencido ⇒ reclamar
 *    (la corrida que la creó está muerta: el timeout del callable es muy inferior al lease);
 *  - todo lo demás ⇒ rechazar. Una reserva de OTRO envío no se reclama jamás (B2: el caller la
 *    rebota como `operation_mismatch`); `done`/`unknown` conservan su desenlace sin importar la edad.
 * El reclamo renueva `createdAt`, así el perdedor de una carrera ve una pending FRESCA y rebota.
 */
export function decidirReservaDeOperacion(
  existing: OutboundOpDoc | null | undefined,
  doc: OutboundOpDoc,
): ReservaDeOperacionDecision {
  if (!existing) return { accion: 'crear' };
  const mismaOperacion = existing.customerId === doc.customerId && existing.kind === doc.kind;
  const leaseVencido =
    existing.state === 'pending' &&
    opCreatedAtMillis(doc.createdAt) - opCreatedAtMillis(existing.createdAt) >= OUTBOUND_OP_LEASE_MS;
  return mismaOperacion && leaseVencido ? { accion: 'reclamar' } : { accion: 'rechazar' };
}

export const defaultSendAttachmentDeps: SendAttachmentDeps = {
  guard: defaultManualMessageDeps,
  reserveOperation: async (tenantId, operationId, doc) => {
    // TRANSACCIÓN (no `create()` pelado): el reclamo de un lease vencido es un read-modify-write
    // y dos reclamos simultáneos del mismo op tienen que colapsar en UN ganador. El perdedor
    // reintenta la tx, ve el `createdAt` renovado por el ganador y recibe `rechazar` (pending
    // fresca) ⇒ rebota `operation_in_flight` sin segundo envío.
    const ref = db().doc(outboundOpPath(tenantId, operationId));
    return db().runTransaction(async (t) => {
      const snap = await t.get(ref);
      const existing = snap.exists ? (snap.data() as OutboundOpDoc) : null;
      const decision = decidirReservaDeOperacion(existing, doc);
      if (decision.accion === 'crear') {
        t.create(ref, doc);
        return { created: true, existing: null };
      }
      if (decision.accion === 'reclamar') {
        t.update(ref, {
          actorUid: doc.actorUid,
          attachmentId: doc.attachmentId,
          state: 'pending',
          result: null,
          lastError: null,
          createdAt: doc.createdAt, // renueva el lease: cierra la puerta al segundo reclamo
          updatedAt: doc.updatedAt,
        });
        return { created: true, existing: null };
      }
      return { created: false, existing };
    });
  },
  updateOperation: async (tenantId, operationId, patch) => {
    await db().doc(outboundOpPath(tenantId, operationId)).set(patch, { merge: true });
  },
  releaseOperation: async (tenantId, operationId) => {
    await db().doc(outboundOpPath(tenantId, operationId)).delete();
  },
  saveBytes: async (path, buffer, contentType) => {
    // Mismo criterio que la ingesta: una sola llamada, contentType SIEMPRE el verificado.
    await storage().bucket().file(path).save(buffer, { contentType, resumable: false });
  },
  writeAttachmentDoc: async (tenantId, attachmentId, doc) => {
    // `set` (no `create`): la idempotencia la da la RESERVA del op. Un reintento legítimo
    // (rechazo compensado) re-escribe el mismo doc con datos frescos y limpia el lastError.
    await db().doc(buildAttachmentDocPath(tenantId, attachmentId)).set(doc);
  },
  markAttachmentSendError: async (tenantId, attachmentId, lastError) => {
    await db()
      .doc(buildAttachmentDocPath(tenantId, attachmentId))
      .set({ lastError: sanitizeAttachmentError(lastError), updatedAt: Timestamp.now() }, { merge: true });
  },
  uploadMedia: async (tenantId, phoneNumberId, file) => {
    // Misma resolución de credenciales que el transporte: el pnid EXACTO de la conversación, sin
    // sustitutos; con pnid null (conversación legacy) el principal del tenant.
    const creds = phoneNumberId
      ? await resolveTenantWhatsappCredsFor(tenantId, phoneNumberId)
      : await resolveTenantWhatsappCreds(tenantId);
    if (!creds.ok) return { ok: false, outcome: 'rejected', detail: `credenciales: ${creds.reason}` };
    return uploadWhatsappMedia({
      phoneNumberId: creds.phoneNumberId,
      accessToken: creds.accessToken,
      buffer: file.buffer,
      mimeType: file.mimeType,
      filename: file.filename,
    });
  },
  append: appendMessage,
  now: () => Timestamp.now(),
};

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

interface ArchivoValidado {
  buffer: Buffer;
  bytes: number;
  verifiedMime: AttachmentAllowedMime;
  declaredMime: string;
  filename: string;
  caption: string;
  maxBytes: number;
}

/**
 * Validación PURA y fail-closed del archivo (pasos a–c del contrato). Lanza `invalid-argument`
 * sin ningún efecto: nada se reservó, nada se guardó, nada viajó.
 */
function validarArchivoSaliente(input: SendAttachmentInput): ArchivoValidado {
  // (a) operationId con forma cerrada, ANTES que nada: es un segmento de ruta de Firestore.
  const operationId = typeof input.operationId === 'string' ? input.operationId : '';
  if (!OUTBOUND_OPERATION_ID_RE.test(operationId)) {
    throw new HttpsError('invalid-argument', 'operationId inválido.');
  }
  if (input.kind !== 'image' && input.kind !== 'document') {
    throw new HttpsError('invalid-argument', 'Tipo de adjunto inválido.');
  }
  const maxBytes = input.kind === 'image' ? SEND_ATTACHMENT_IMAGE_MAX_BYTES : SEND_ATTACHMENT_DOCUMENT_MAX_BYTES;

  const filename = sanitizeAttachmentFilename(input.filename);
  if (!filename) throw new HttpsError('invalid-argument', 'Nombre de archivo inválido.');
  const caption = sanitizeAttachmentCaption(input.caption);

  // (b) Allowlist estricta sobre lo DECLARADO (barata; el veredicto final es de los magic bytes).
  const declaredMime = normalizeMimeType(input.mimeType);
  const allowed = input.kind === 'image' ? SEND_ATTACHMENT_IMAGE_MIMES : SEND_ATTACHMENT_DOCUMENT_MIMES;
  if (!declaredMime || !allowed.some((m) => declaredMimeMatchesVerified(declaredMime, m))) {
    throw new HttpsError(
      'invalid-argument',
      input.kind === 'image'
        ? 'Formato no admitido: la imagen tiene que ser JPG, PNG o WEBP.'
        : 'Formato no admitido: el documento tiene que ser un PDF.',
    );
  }

  // (a) Tope del base64 ANTES de decodificar (4 caracteres por cada 3 bytes reales).
  const b64 = typeof input.dataBase64 === 'string' ? input.dataBase64 : '';
  if (b64.length === 0 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new HttpsError('invalid-argument', 'El contenido del archivo no es base64 válido.');
  }
  if (b64.length > maxBase64LengthForBytes(maxBytes)) {
    throw new HttpsError(
      'invalid-argument',
      `El archivo supera el máximo permitido (${Math.round(maxBytes / (1024 * 1024))} MB).`,
    );
  }

  // (c) Decodificar, medir el tamaño REAL y verificar MAGIC BYTES contra lo declarado.
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length === 0) throw new HttpsError('invalid-argument', 'El archivo está vacío.');
  if (buffer.length > maxBytes) {
    throw new HttpsError(
      'invalid-argument',
      `El archivo supera el máximo permitido (${Math.round(maxBytes / (1024 * 1024))} MB).`,
    );
  }
  const sniffed = sniffAttachmentMime(buffer.subarray(0, ATTACHMENT_SNIFF_MIN_BYTES));
  // Sin firma admitida (SVG, HTML, ejecutables, ZIP…) o firma que contradice el MIME declarado ⇒
  // rechazo sin efectos. El único MIME con autoridad es el verificado.
  if (!sniffed || !allowed.includes(sniffed) || !declaredMimeMatchesVerified(declaredMime, sniffed)) {
    throw new HttpsError('invalid-argument', 'El contenido del archivo no coincide con el formato declarado.');
  }

  return { buffer, bytes: buffer.length, verifiedMime: sniffed, declaredMime, filename, caption, maxBytes };
}

/** Doc del adjunto saliente, compatible con el visor del panel (`toPanelAttachment`). */
function buildOutboundAttachmentDoc(args: {
  input: SendAttachmentInput;
  archivo: ArchivoValidado;
  attachmentId: string;
  messageId: string;
  storagePath: string;
  senderUid: string;
  now: Timestamp;
}): OutboundAttachmentDoc {
  const { input, archivo, now } = args;
  return {
    attachmentId: args.attachmentId,
    tenantId: input.tenantId,
    customerId: input.customerId,
    conversationId: input.customerId,
    messageId: args.messageId,
    providerMessageId: args.messageId, // hasheado y tenant-scoped, igual que la ingesta
    channel: 'whatsapp',
    class: attachmentClassForMime(archivo.verifiedMime),
    direction: 'out',
    author: 'seller',
    origin: 'panel',
    uploadedByUid: args.senderUid,
    // Los bytes YA están en Storage cuando este doc se escribe: 'stored' es un hecho, no un deseo.
    ingestState: 'stored',
    /**
     * JAMÁS comprobante ni candidato (ADR-0021 §5): nace `generic_media` clasificado por regla.
     * El gate automático solo opina sobre `unclassified` y `decideMarkAsReceipt` rechaza
     * `direction:'out'` — doble cerrojo.
     */
    classification: { value: 'generic_media', source: 'rule', confidence: 1, by: null, at: now },
    // El caption vive ACÁ (contrato ADR-0016 §9), no como texto del mensaje ⇒ no llega a la IA.
    caption: archivo.caption,
    filename: archivo.filename,
    mime: { declared: archivo.declaredMime, verified: archivo.verifiedMime },
    bytes: archivo.bytes,
    checksum: createHash('sha256').update(archivo.buffer).digest('hex'),
    storage: { path: args.storagePath },
    orderCandidateId: null,
    retentionUntil: null,
    purgedAt: null,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
}

/** Compensación de un NO-ENVÍO confirmado: fallo visible en el adjunto + reserva liberada. */
async function compensarNoEnvio(
  deps: SendAttachmentDeps,
  tenantId: string,
  operationId: string,
  attachmentId: string,
  motivo: string,
): Promise<void> {
  // Best-effort en orden: primero el rastro honesto, después liberar el op (si liberar falla, el
  // op queda 'pending' y el MISMO id rebota — molesto pero jamás duplica un envío).
  try {
    await deps.markAttachmentSendError(tenantId, attachmentId, motivo);
  } catch (e) {
    logger.error('Adjunto manual: no se pudo marcar el error en el adjunto', e, { tenantId, attachmentId });
  }
  try {
    await deps.releaseOperation(tenantId, operationId);
  } catch (e) {
    logger.error('Adjunto manual: no se pudo liberar la reserva de la operación', e, { tenantId, attachmentId });
  }
}

export async function sendConversationAttachment(
  input: SendAttachmentInput,
  sender: ManualMessageSender,
  deps: SendAttachmentDeps = defaultSendAttachmentDeps,
): Promise<SendAttachmentResult> {
  // (a)–(c) Validación pura, sin efectos.
  const archivo = validarArchivoSaliente(input);

  // (d) Guard compartido: canal fail-closed → sessionKey → takeover/override → gate de
  // cotización (sobre el CAPTION: es el texto visible de este envío) → cliente por PNID exacto.
  const envio = await resolverEnvioManual(
    { tenantId: input.tenantId, customerId: input.customerId, textoParaGate: archivo.caption },
    sender,
    deps.guard,
    CONTEXTO_LOG,
  );

  // Identidad determinística y OPACA por operación (dominio `panel:` — jamás colisiona con los
  // wamids reales de la ingesta). Mismo esquema ADR-0016: el visor y el emisor de URLs firmadas
  // funcionan sin tocar el frontend.
  const attachmentId = deriveAttachmentId({
    tenantId: input.tenantId,
    channel: 'whatsapp',
    providerMessageId: `panel:${input.operationId}`,
    providerMediaId: `panel:${input.operationId}`,
  });
  const messageId = hashProviderMessageId(input.tenantId, `panel:${input.operationId}`);

  // (e) IDEMPOTENCIA: la reserva se crea ANTES de tocar Storage o Meta.
  const now = deps.now();
  const reserva = await deps.reserveOperation(input.tenantId, input.operationId, {
    operationId: input.operationId,
    tenantId: input.tenantId,
    customerId: input.customerId,
    kind: input.kind,
    actorUid: sender.uid,
    attachmentId,
    state: 'pending',
    result: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  if (!reserva.created) {
    const previo = reserva.existing;
    // B2 — COHERENCIA: el operationId nombra UN envío concreto. Si la reserva existente describe
    // OTRO (cliente o tipo distintos), devolver su resultado sería un `duplicate:true` mentiroso
    // — y reclamarla, un envío ajeno. Se rebota como uso inválido del id, sin efectos.
    if (previo && (previo.customerId !== input.customerId || previo.kind !== input.kind)) {
      logger.warn('Adjunto manual: operationId reusado para OTRO envío', {
        tenantId: input.tenantId,
        customerId: maskPhone(input.customerId),
        kind: input.kind,
        kindPrevio: previo.kind,
      });
      throw new HttpsError(
        'invalid-argument',
        'Ese operationId pertenece a otro envío: generá una operación nueva para este archivo.',
        { kind: 'operation_mismatch' },
      );
    }
    if (previo?.state === 'done' && previo.result) {
      logger.info('Adjunto manual: operación repetida, se devuelve el resultado previo', {
        tenantId: input.tenantId,
        attachmentId: previo.result.attachmentId,
        viaMock: previo.result.viaMock,
      });
      return {
        ok: true,
        viaMock: previo.result.viaMock,
        waMessageId: previo.result.waMessageId,
        attachmentId: previo.result.attachmentId,
        duplicate: true,
      };
    }
    if (previo?.state === 'unknown') {
      // El envío anterior quedó AMBIGUO: pudo haber llegado. Reintentar el mismo op a ciegas
      // duplicaría el archivo al cliente; un reenvío deliberado es una operación NUEVA.
      throw new HttpsError(
        'failed-precondition',
        'No pudimos confirmar si este archivo salió. Revisá el chat de WhatsApp; si no llegó, adjuntalo de nuevo.',
        { kind: 'operation_unknown_outcome' },
      );
    }
    throw new HttpsError('failed-precondition', 'Ese envío ya está en curso. Esperá a que termine antes de reintentar.', {
      kind: 'operation_in_flight',
    });
  }

  // (f) Bytes a Storage (esquema opaco ADR-0016) y doc del adjunto renderizable por el panel.
  const storagePath = buildAttachmentStoragePath(input.tenantId, attachmentId);
  try {
    await deps.saveBytes(storagePath, archivo.buffer, archivo.verifiedMime);
    await deps.writeAttachmentDoc(
      input.tenantId,
      attachmentId,
      buildOutboundAttachmentDoc({ input, archivo, attachmentId, messageId, storagePath, senderUid: sender.uid, now }),
    );
  } catch (e) {
    // Nada viajó a Meta: liberar la reserva deja el reintento seguro.
    logger.error('Adjunto manual: no se pudo guardar el archivo/documento', e, { tenantId: input.tenantId, attachmentId });
    try {
      await deps.releaseOperation(input.tenantId, input.operationId);
    } catch (e2) {
      logger.error('Adjunto manual: no se pudo liberar la reserva tras el fallo de guardado', e2, {
        tenantId: input.tenantId,
        attachmentId,
      });
    }
    throw new HttpsError('unavailable', 'No se pudo guardar el archivo. El mensaje NO se envió: probá de nuevo en un momento.', {
      kind: 'attachment_store_failed',
    });
  }

  // (g) Transporte. Mock/bloqueado ⇒ NO se sube nada a Meta (cero red); el propio cliente decide
  // el desenlace (viaMock o blocked) con la misma semántica que el texto retenido.
  const esLive = envio.client.transportInfo.transport === 'live';
  let mediaId = `mock:${attachmentId}`;
  if (esLive) {
    const subida = await deps.uploadMedia(input.tenantId, envio.phoneNumberId, {
      buffer: archivo.buffer,
      mimeType: archivo.verifiedMime,
      filename: archivo.filename,
    });
    if (!subida.ok) {
      // Una subida fallida (aún ambigua) JAMÁS llegó al cliente: el mensaje es un POST separado
      // que nunca se hizo. Compensación completa ⇒ reintento seguro del MISMO operationId.
      logger.warn('Adjunto manual: la subida del media a Meta falló', {
        tenantId: input.tenantId,
        customerId: maskPhone(input.customerId),
        outcome: subida.outcome,
        detail: subida.detail,
      });
      await compensarNoEnvio(deps, input.tenantId, input.operationId, attachmentId, `subida a Meta fallida: ${subida.detail}`);
      throw new HttpsError(
        'unavailable',
        'No pudimos subir el archivo a WhatsApp. El mensaje NO se envió: probá de nuevo en un momento.',
        { kind: 'whatsapp_media_upload_failed' },
      );
    }
    mediaId = subida.mediaId;
  }

  const ctx = { tenantId: input.tenantId, channel: 'whatsapp' as const };
  const res =
    input.kind === 'image'
      ? await envio.client.sendImage(envio.to, { mediaId, ...(archivo.caption ? { caption: archivo.caption } : {}) }, ctx)
      : await envio.client.sendDocument(
          envio.to,
          { mediaId, filename: archivo.filename, ...(archivo.caption ? { caption: archivo.caption } : {}) },
          ctx,
        );

  if (!res.ok) {
    if (res.outcome === 'unknown') {
      // (h) Misma filosofía que el texto: el archivo PUDO salir. La reserva queda en 'unknown'
      // para que el MISMO op no se reintente a ciegas; el adjunto conserva el rastro del fallo.
      try {
        await deps.markAttachmentSendError(input.tenantId, attachmentId, 'resultado de envío desconocido');
        await deps.updateOperation(input.tenantId, input.operationId, {
          state: 'unknown',
          lastError: 'whatsapp_send_unknown',
          updatedAt: deps.now(),
        });
      } catch (e) {
        logger.error('Adjunto manual: no se pudo registrar el desenlace desconocido', e, {
          tenantId: input.tenantId,
          attachmentId,
        });
      }
      throw errorDeEnvioManualNoOk(res, { tenantId: input.tenantId, customerId: input.customerId, contexto: CONTEXTO_LOG });
    }
    // blocked / rejected: NO-ENVÍO confirmado ⇒ compensación completa, sin burbuja, reintento seguro.
    const motivo =
      res.outcome === 'blocked'
        ? `canal bloqueado: ${res.reason}`
        : `WhatsApp rechazó el envío (código ${res.providerCode ?? 'desconocido'})`;
    await compensarNoEnvio(deps, input.tenantId, input.operationId, attachmentId, motivo);
    throw errorDeEnvioManualNoOk(res, { tenantId: input.tenantId, customerId: input.customerId, contexto: CONTEXTO_LOG });
  }

  // (h) Burbuja DESPUÉS del envío OK (mock también persiste). El texto va VACÍO: el caption vive
  // en el doc del adjunto y no puede entrar al historial que alimenta a la IA (ADR-0016 §9).
  // docId determinístico ⇒ si esta corrida se repitiera, la burbuja no se duplica (create()).
  await deps.append(input.tenantId, input.customerId, {
    direction: 'out',
    author: 'seller',
    text: '',
    channel: 'whatsapp',
    receivedVia: envio.phoneNumberId,
    senderUid: sender.uid,
    senderName: sender.name ?? null,
    waMessageId: res.id ?? null,
    viaMock: !!res.viaMock,
    origin: 'panel',
    docId: messageId,
    attachmentIds: [attachmentId],
  });

  const result: SendAttachmentResult = {
    ok: true,
    viaMock: !!res.viaMock,
    waMessageId: res.id ?? null,
    attachmentId,
  };
  await deps.updateOperation(input.tenantId, input.operationId, {
    state: 'done',
    result: { viaMock: result.viaMock, waMessageId: result.waMessageId, attachmentId },
    lastError: null,
    updatedAt: deps.now(),
  });

  logger.info('Adjunto manual enviado', {
    tenantId: input.tenantId,
    customerId: maskPhone(input.customerId),
    kind: input.kind,
    bytes: archivo.bytes,
    mime: archivo.verifiedMime,
    viaMock: result.viaMock,
    attachmentId,
    phoneNumberId: envio.phoneNumberId ? maskPhone(envio.phoneNumberId) : '(principal)',
  });
  return result;
}
