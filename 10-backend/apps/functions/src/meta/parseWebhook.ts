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

export type InboundPlatform = 'whatsapp' | 'instagram' | 'messenger';

export interface MetaAdReferral {
  adId: string | null; // WA: referral.source_id · IG/Messenger: referral.ad_id
  campaignId: string | null; // Meta NO lo manda en el webhook (se resuelve aparte — ver docs).
  sourceUrl: string | null; // WA: referral.source_url
}

/** Imagen entrante (ORDER-1B: comprobantes de pago). Solo WhatsApp por ahora. */
export interface InboundImage {
  mediaId: string; // id del media en Graph (para descargarlo con el token del tenant)
  mimeType: string | null;
  caption: string | null;
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
  /** Presente SOLO en mensajes de imagen (text queda con el caption o ''). */
  image?: InboundImage;
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
      return null; // audio/video/sticker/document/location/etc → ignorado (image se maneja aparte, ORDER-1B)
  }
}

/** ORDER-1B: mensajes `image` (comprobantes). Sin mediaId no sirve → null (ignorado). */
function waImage(msg: Any): InboundImage | null {
  if (msg?.type !== 'image') return null;
  const mediaId = str(msg?.image?.id);
  if (!mediaId) return null;
  return { mediaId, mimeType: str(msg?.image?.mime_type), caption: str(msg?.image?.caption) };
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
        const image = waImage(msg);
        const location = waLocation(msg);
        const from = str(msg?.from);
        if (from === null || (text === null && image === null && location === null)) {
          ignored++;
          continue;
        }
        out.push({
          platform: 'whatsapp',
          externalId,
          from,
          text: text ?? image?.caption ?? '',
          messageId: str(msg?.id) ?? '',
          timestamp: toNum(msg?.timestamp),
          adReferral: waReferral(msg?.referral),
          ...(image ? { image } : {}),
          ...(location ? { location } : {}),
          // PRIVACIDAD (COVERAGE-1B): las coordenadas exactas viajan SOLO en `location` (validadas);
          // el crudo de un mensaje de ubicación se redacta para no duplicar PII en el inbox.
          rawMessage: location ? { type: 'location', redacted: true } : msg,
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
