/**
 * meta/parseWebhook.ts — Parser PURO del webhook real de Meta (Hardening F3)
 * =========================================================================
 * Normaliza el payload real de Meta (WhatsApp / Instagram / Messenger) a una lista
 * uniforme de mensajes que consume el inbox. SIN I/O; NO lanza ante payload malformado.
 *
 * Fuentes oficiales (developers.facebook.com):
 *  - WhatsApp messages webhook reference: object=whatsapp_business_account,
 *    entry[].changes[].value.metadata.phone_number_id, value.messages[], value.statuses[].
 *  - Messenger Platform "messages": object=page, entry[].id, entry[].messaging[].
 *  - Instagram messaging webhooks: object=instagram, entry[].messaging[].
 */

import { sanitizeAttachmentCaption, sanitizeAttachmentFilename, normalizeMimeType } from '@vpw/shared';

export type InboundPlatform = 'whatsapp' | 'instagram' | 'messenger';

export interface MetaAdReferral {
  adId: string | null; // WA: referral.source_id · IG/Messenger: referral.ad_id
  campaignId: string | null; // Meta NO lo manda en el webhook (se resuelve aparte — ver docs).
  sourceUrl: string | null; // WA: referral.source_url
}

/**
 * ADJUNTO entrante genérico (ADR-0016). Reemplaza a la vieja `InboundImage`: el parser normaliza
 * `image` Y `document` a la MISMA forma porque en este punto todavía no existe ninguna
 * interpretación de negocio — un PDF de banco y una foto de producto entran por la misma puerta.
 * (Los PDF se descartaban en silencio: defecto #3 de la auditoría.)
 *
 * `declaredMime` se llama así a propósito: es lo que DICE el proveedor y no se cree. El MIME con
 * autoridad sale de los magic bytes del archivo ya descargado (`mediaClient`).
 */
export interface InboundAttachment {
  kind: 'image' | 'document';
  /** Id del media en Graph (para descargarlo con el token del tenant). Nunca va a logs. */
  mediaId: string;
  declaredMime: string | null;
  /** Nombre original SANEADO (documentos). Decorativo: jamás se usa para construir rutas. */
  filename: string | null;
  /** Caption SANEADO. ADR-0016 §9: se persiste pero NO se envía a la IA. */
  caption: string;
  /** Hash que declara Meta. Se conserva como evidencia; el checksum real lo calcula el servidor. */
  sha256: string | null;
}

/**
 * Tipos que TODAVÍA no se soportan. No se descartan en silencio (ese era el defecto que hacía
 * creer al cliente que había avisado): dejan un mensaje estructurado visible en el chat y, cuando
 * corresponde, una respuesta que le dice al cliente qué hacer.
 */
export const UNSUPPORTED_INBOUND_KINDS = ['audio', 'video', 'sticker'] as const;
export type UnsupportedInboundKind = (typeof UNSUPPORTED_INBOUND_KINDS)[number];

export interface InboundUnsupported {
  kind: UnsupportedInboundKind;
}

/**
 * Ubicación nativa de WhatsApp (COVERAGE-1B). Payload oficial: messages[].type === 'location'
 * con location.{latitude,longitude} numéricos y name/address opcionales; context.id presente si
 * responde a un location_request_message. SENSIBLE: nunca va a logs ni a mensajes persistidos.
 */
export interface InboundLocation {
  latitude: number;
  longitude: number;
  name: string | null;
  address: string | null;
  /** wamid del location_request_message al que responde (si aplica). */
  contextMessageId: string | null;
}

export interface NormalizedInbound {
  platform: InboundPlatform;
  externalId: string; // WA: metadata.phone_number_id · IG/Messenger: entry.id → resuelve tenant
  from: string; // WA: messages[].from (wa_id) · IG/Messenger: sender.id
  text: string;
  messageId: string; // WA: messages[].id (wamid) · IG/Messenger: message.mid → idempotencia
  timestamp: number | null; // WA: segundos (string) · IG/Messenger: ms (number)
  adReferral: MetaAdReferral | null;
  /**
   * Presente SOLO en mensajes con archivo (imagen o documento). `text` queda '' AUNQUE haya
   * caption: el caption viaja en el adjunto y NO se envía a la IA (ADR-0016 §9).
   */
  attachment?: InboundAttachment;
  /** Presente SOLO en tipos aún no soportados (audio/video/sticker). `text` queda ''. */
  unsupported?: InboundUnsupported;
  /** Presente SOLO en mensajes de ubicación nativa (text queda ''). */
  location?: InboundLocation;
  rawMessage: unknown; // el objeto de ESE mensaje (debug/auditoría; sin tokens)
}

export interface ParseResult {
  messages: NormalizedInbound[];
  ignored: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const toNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

// Traversal sobre JSON no confiable: `any` local, todo guardado con optional chaining.
type Any = any; // eslint: no-explicit-any está off en este paquete

function waText(msg: Any): string | null {
  switch (msg?.type) {
    case 'text':
      return str(msg?.text?.body);
    case 'interactive':
      return str(msg?.interactive?.button_reply?.title) ?? str(msg?.interactive?.list_reply?.title);
    case 'button':
      return str(msg?.button?.text); // botón de plantilla (quick reply)
    default:
      // image/document → `waAttachment`; audio/video/sticker → `waUnsupported`;
      // location → `waLocation`. El resto (reaction/system/order/…) sigue ignorado.
      return null;
  }
}

/**
 * ADR-0016: mensajes `image` y `document` → adjunto genérico. Sin mediaId no hay nada que bajar
 * ⇒ null (el mensaje se ignora, igual que antes).
 */
function waAttachment(msg: Any): InboundAttachment | null {
  const kind: InboundAttachment['kind'] | null =
    msg?.type === 'image' ? 'image' : msg?.type === 'document' ? 'document' : null;
  if (kind === null) return null;
  const media = msg?.[kind];
  const mediaId = str(media?.id);
  if (!mediaId) return null;
  // El saneo ocurre ACÁ, antes de que el payload se persista en el inbox: un caption de 1 MB o con
  // marcas bidi nunca llega a tocar Firestore. `sanitize*` es idempotente, así que la ingesta
  // puede volver a aplicarlo sin efectos raros.
  return {
    kind,
    mediaId,
    declaredMime: normalizeMimeType(media?.mime_type),
    filename: sanitizeAttachmentFilename(media?.filename),
    caption: sanitizeAttachmentCaption(media?.caption),
    sha256: str(media?.sha256),
  };
}

/** Tipos aún no soportados: se normalizan para dejar rastro, NO para procesarlos. */
function waUnsupported(msg: Any): InboundUnsupported | null {
  const type = msg?.type;
  return (UNSUPPORTED_INBOUND_KINDS as readonly string[]).includes(type)
    ? { kind: type as UnsupportedInboundKind }
    : null;
}

const LOCATION_NAME_MAX = 128;
const LOCATION_ADDRESS_MAX = 512;

/** Strings del payload de ubicación: no confiables — trim, sin caracteres de control, con tope. */
function sanitizeLocationText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // Los caracteres de control (código < 0x20 y DEL 0x7F) se reemplazan por espacio, por código
  // de carácter (sin clase regex de control chars: se corrompe fácil entre encodings).
  let sinControl = '';
  for (const ch of v) {
    const c = ch.codePointAt(0) ?? 0;
    sinControl += c < 0x20 || c === 0x7f ? ' ' : ch;
  }
  const clean = sinControl.replace(/ +/g, ' ').trim().slice(0, max);
  return clean !== '' ? clean : null;
}

/** Lat/lng del payload: Meta manda números; un string numérico también se acepta (defensivo). */
function toFiniteCoord(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * COVERAGE-1B: mensajes `location` (ubicación nativa). Falla SEGURA: payload incompleto o con
 * coordenadas fuera de rango → null (el mensaje se ignora, jamás rompe el webhook).
 */
function waLocation(msg: Any): InboundLocation | null {
  if (msg?.type !== 'location') return null;
  const latitude = toFiniteCoord(msg?.location?.latitude);
  const longitude = toFiniteCoord(msg?.location?.longitude);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return {
    latitude,
    longitude,
    name: sanitizeLocationText(msg?.location?.name, LOCATION_NAME_MAX),
    address: sanitizeLocationText(msg?.location?.address, LOCATION_ADDRESS_MAX),
    contextMessageId: str(msg?.context?.id),
  };
}

function waReferral(ref: Any): MetaAdReferral | null {
  if (!ref || typeof ref !== 'object') return null;
  return { adId: str(ref.source_id), campaignId: null, sourceUrl: str(ref.source_url) };
}

function igReferral(ref: Any): MetaAdReferral | null {
  if (!ref || typeof ref !== 'object') return null;
  return { adId: str(ref.ad_id), campaignId: null, sourceUrl: null };
}

function parseWhatsApp(entries: Any[], out: NormalizedInbound[]): number {
  let ignored = 0;
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value ?? {};
      const externalId = str(value?.metadata?.phone_number_id) ?? '';
      if (Array.isArray(value?.statuses)) ignored += value.statuses.length; // recibos de entrega
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      for (const msg of messages) {
        const text = waText(msg);
        const attachment = waAttachment(msg);
        const location = waLocation(msg);
        const unsupported = waUnsupported(msg);
        const from = str(msg?.from);
        // ADR-0016: el criterio de "mensaje útil" es texto O adjunto O ubicación O un tipo no
        // soportado (que igual deja rastro). Antes un PDF caía acá y desaparecía sin dejar nada.
        if (from === null || (text === null && !attachment && !location && !unsupported)) {
          ignored++;
          continue;
        }
        out.push({
          platform: 'whatsapp',
          externalId,
          from,
          // El caption NO se promueve a `text`: si lo hiciera, terminaría en el prompt de la IA
          // por el camino normal del motor (ADR-0016 §9 lo prohíbe explícitamente).
          text: text ?? '',
          messageId: str(msg?.id) ?? '',
          timestamp: toNum(msg?.timestamp),
          adReferral: waReferral(msg?.referral),
          ...(attachment ? { attachment } : {}),
          ...(unsupported ? { unsupported } : {}),
          ...(location ? { location } : {}),
          // PRIVACIDAD (COVERAGE-1B): las coordenadas exactas viajan SOLO en `location` (validadas);
          // el crudo de un mensaje de ubicación se redacta para no duplicar PII en el inbox.
          // ADR-0016: ídem para adjuntos — el crudo repetiría mediaId y caption en el inbox.
          rawMessage:
            location || attachment || unsupported
              ? { type: str(msg?.type) ?? 'unknown', redacted: true }
              : msg,
        });
      }
    }
  }
  return ignored;
}

function parseMessaging(platform: InboundPlatform, entries: Any[], out: NormalizedInbound[]): number {
  let ignored = 0;
  for (const entry of entries) {
    const externalId = str(entry?.id) ?? '';
    const events = Array.isArray(entry?.messaging) ? entry.messaging : [];
    for (const ev of events) {
      const msg = ev?.message;
      const text = str(msg?.text);
      const from = str(ev?.sender?.id);
      if (!msg || msg?.is_echo || msg?.is_deleted || text === null || from === null) {
        ignored++;
        continue;
      }
      out.push({
        platform,
        externalId,
        from,
        text,
        messageId: str(msg?.mid) ?? '',
        timestamp: toNum(ev?.timestamp),
        adReferral: igReferral(ev?.referral),
        rawMessage: ev,
      });
    }
  }
  return ignored;
}

/**
 * Adjunto a partir del payload YA PERSISTIDO en el inbox (`metaWebhookInbox`).
 *
 * Acepta DOS formas a propósito: la nueva (`payload.attachment`) y la LEGACY (`payload.image`,
 * ORDER-1B). Los eventos que quedaron en vuelo cuando se despliega este cambio tienen la vieja
 * y perderlos sería exactamente el bug que este programa arregla. Es puro ⇒ testeable sin E/S.
 */
export function attachmentFromInboxPayload(payload: unknown): InboundAttachment | null {
  const p = payload as Any;
  const nuevo = p?.attachment;
  const mediaIdNuevo = str(nuevo?.mediaId);
  if (mediaIdNuevo) {
    const kind: InboundAttachment['kind'] = nuevo?.kind === 'document' ? 'document' : 'image';
    return {
      kind,
      mediaId: mediaIdNuevo,
      declaredMime: normalizeMimeType(nuevo?.declaredMime),
      filename: sanitizeAttachmentFilename(nuevo?.filename),
      caption: sanitizeAttachmentCaption(nuevo?.caption),
      sha256: str(nuevo?.sha256),
    };
  }
  const legacyMediaId = str(p?.image?.mediaId);
  if (!legacyMediaId) return null;
  return {
    kind: 'image',
    mediaId: legacyMediaId,
    declaredMime: normalizeMimeType(p?.image?.mimeType),
    filename: null,
    caption: sanitizeAttachmentCaption(p?.image?.caption),
    sha256: null,
  };
}

/** Tipo no soportado a partir del payload del inbox (no existe forma legacy: antes se perdían). */
export function unsupportedFromInboxPayload(payload: unknown): InboundUnsupported | null {
  const kind = (payload as Any)?.unsupported?.kind;
  return (UNSUPPORTED_INBOUND_KINDS as readonly string[]).includes(kind)
    ? { kind: kind as UnsupportedInboundKind }
    : null;
}

export function parseMetaWebhookPayload(payload: unknown): ParseResult {
  const root = payload as Any;
  const messages: NormalizedInbound[] = [];
  if (!root || typeof root !== 'object' || !Array.isArray(root.entry)) {
    return { messages, ignored: 0 };
  }
  let ignored = 0;
  switch (root.object) {
    case 'whatsapp_business_account':
      ignored = parseWhatsApp(root.entry, messages);
      break;
    case 'instagram':
      ignored = parseMessaging('instagram', root.entry, messages);
      break;
    case 'page':
      ignored = parseMessaging('messenger', root.entry, messages);
      break;
    default:
      return { messages, ignored: 0 };
  }
  return { messages, ignored };
}
