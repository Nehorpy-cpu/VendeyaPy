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
 *
 * COEXISTENCE (ADR-0017 §12) — el ruteo es por `change.field`. Hasta este programa ese campo no se
 * leía NUNCA: el parser buscaba `value.messages` en cualquier cambio, así que los tres eventos que
 * hacen posible Coexistence (`smb_message_echoes`, `history`, `smb_app_state_sync`) devolvían cero
 * y se descartaban sin dejar rastro. Rutear por el campo declarado y no por la forma del payload es
 * deliberado: si se mirara la forma, un `messages` con un `message_echoes` colado adentro —o al
 * revés— podría hacer que un evento se procese como el tipo equivocado.
 *
 * Referencias oficiales de los campos de Coexistence, consultadas el 2026-08-03:
 *  - https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes
 *  - https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/history
 *  - https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_app_state_sync
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

// ---------------------------------------------------------------------------
// COEXISTENCE — formas normalizadas de los campos nuevos (ADR-0017 §12)
// ---------------------------------------------------------------------------

/** Clasificación de un echo. `other` es el cajón honesto: existe para no fingir que se entendió. */
export const ECHO_TYPES = ['text', 'media', 'revoke', 'edit', 'other'] as const;
export type EchoType = (typeof ECHO_TYPES)[number];

/** Tipos de media que puede traer un echo. No se descargan acá: solo se registra cuál era. */
const ECHO_MEDIA_TYPES = ['image', 'document', 'video', 'audio', 'sticker'] as const;

/**
 * ECHO — lo que el VENDEDOR mandó desde la app de WhatsApp Business.
 *
 * LA REGLA DURA, y la razón por la que este tipo no se parece a `NormalizedInbound`: en un echo
 * `from` es el número del NEGOCIO y `to` el del cliente (referencia oficial de `smb_message_echoes`,
 * consultada 2026-08-03). `process.ts:249` deriva `customerId = payload.from`; si el `from` de un
 * echo llegara ahí, el sistema abriría una conversación de la perfumería CONSIGO MISMA y el bot se
 * respondería a sí mismo, sobre el número real y consumiendo cuota.
 *
 * Por eso el `from` NO tiene campo en esta forma —ni con otro nombre, ni dentro de un crudo sin
 * redactar—. La identidad del cliente sale de `to`; el canal, de `metadata.phone_number_id`.
 */
export interface NormalizedEcho {
  platform: 'whatsapp';
  /** `metadata.phone_number_id`: el CANAL por el que salió (el número del negocio, como id opaco). */
  externalId: string;
  /** wa_id del CLIENTE, derivado de `to`. Lo único que identifica con quién habló el vendedor. */
  customerWaId: string;
  /** wamid del echo. Base de la idempotencia (ver `echoIdempotencyKey`). */
  messageId: string;
  timestamp: number | null;
  echoType: EchoType;
  /** Texto SANEADO que mandó el vendedor ('' si el echo no es de texto). */
  text: string;
  /** Tipo de media declarado (`image`, `document`, …) o null. No se descarga nada. */
  mediaKind: string | null;
  /** `revoke`/`edit`: wamid del mensaje original al que se refieren. */
  originalMessageId: string | null;
  /** Siempre false: un echo es un hecho humano, jamás dispara automatización. */
  automationEligible: false;
}

/** Un mensaje del historial importado, recortado a lo mínimo que sirve para reconstruir el chat. */
export interface NormalizedHistoryMessage {
  id: string;
  /**
   * `in` = lo mandó el cliente · `out` = lo mandó el negocio. Se DERIVA comparando `from` con el id
   * del hilo (que es el wa_id del cliente) para no tener que transportar el número del negocio.
   */
  direction: 'in' | 'out' | 'unknown';
  type: string;
  /** Texto SANEADO y acotado; '' para todo lo que no sea texto. */
  text: string;
  timestamp: number | null;
  /** `history_context.status` saneado (DELIVERED/READ/…), o null si Meta no lo manda. */
  status: string | null;
}

export interface NormalizedHistoryThread {
  /** `threads[].id` — el wa_id del CLIENTE de ese hilo. */
  customerWaId: string;
  messages: NormalizedHistoryMessage[];
}

/**
 * HISTORY — un chunk del historial (hasta 180 días). Es un ARCHIVO, no una bandeja de entrada:
 * nace `automationEligible: false` y su destino es una colección propia y cerrada al cliente.
 */
export interface NormalizedHistoryChunk {
  platform: 'whatsapp';
  externalId: string;
  /** `history[].metadata.*`. Defensivo: si Meta manda basura o no los manda, quedan en null. */
  phase: number | null;
  chunkOrder: number | null;
  progress: number | null;
  /** Conteos HONESTOS: cuentan lo que TRAJO el chunk, aunque el doc guarde menos (ver `truncated`). */
  threadCount: number;
  messageCount: number;
  threads: NormalizedHistoryThread[];
  /** true si se recortó por los topes. Nunca se pierde algo en silencio. */
  truncated: boolean;
  automationEligible: false;
}

/**
 * APP STATE — la agenda del vendedor. Incluye personas que nunca le escribieron, así que
 * `createsCustomer` es `false` por construcción (ADR-0017 §4): fabricar `Customer`s desde acá
 * llenaría el panel de conversaciones falsas con gente sin relación comercial.
 */
export interface NormalizedAppStateChange {
  platform: 'whatsapp';
  externalId: string;
  /** `state_sync[].type` (hoy Meta solo documenta `contact`). */
  entryType: string;
  /** `add`/`remove`. Cualquier otra cosa es `unknown`: no se asume `add`. */
  action: 'add' | 'remove' | 'unknown';
  contactWaId: string;
  fullName: string;
  firstName: string;
  timestamp: number | null;
  createsCustomer: false;
}

/**
 * CAMPO DESCONOCIDO — auditoría de FORMA, no de contenido. Meta agrega campos sin avisar; un
 * despliegue viejo tiene que poder decir "llegó algo que no entiendo" sin quedarse con el payload
 * (que puede traer tokens, teléfonos o mensajes completos) y sin ejecutar nada.
 */
export interface NormalizedUnknownField {
  platform: 'whatsapp';
  externalId: string;
  /** `change.field` SANEADO y acotado. */
  field: string;
  /** Nombres de las claves de primer nivel de `value`. Sin valores. */
  valueKeys: string[];
  /** Largo de `value[field]` si fuera un arreglo: pista de volumen, sin datos. */
  itemCount: number | null;
}

export interface ParseResult {
  messages: NormalizedInbound[];
  ignored: number;
  /**
   * Los cuatro campos de Coexistence salen por listas SEPARADAS y no por `messages`. Son aditivos:
   * quien solo lee `messages`/`ignored` sigue funcionando igual que antes.
   */
  echoes: NormalizedEcho[];
  historyChunks: NormalizedHistoryChunk[];
  appStateChanges: NormalizedAppStateChange[];
  unknownFields: NormalizedUnknownField[];
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

/** Cuerpo HISTÓRICO del parser: un cambio con `field === 'messages'` (mensajes vivos + statuses). */
function waMessagesChange(value: Any, externalId: string, out: NormalizedInbound[]): number {
  let ignored = 0;
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
  return ignored;
}

// ---------------------------------------------------------------------------
// Normalizadores de Coexistence (ADR-0017 §12)
// ---------------------------------------------------------------------------

/** Nombre de contacto de la agenda: decorativo, se muestra; no se usa para nada estructural. */
const CONTACT_NAME_MAX = 128;
/** Texto de un mensaje del historial. Ver el cálculo de tamaño en `waHistoryChange`. */
const HISTORY_TEXT_MAX = 512;
/** Etiquetas cortas del historial (`type`, `history_context.status`). */
const HISTORY_LABEL_MAX = 32;
/**
 * Topes del chunk de historial. Un documento de Firestore no puede pasar 1 MiB; un chunk grande
 * de Meta sí. Recortar acá es la opción MENOS mala: la alternativa es que la escritura falle y se
 * pierda el chunk ENTERO. Con estos números el peor caso ronda 800 × 512 B ≈ 400 KB, con margen
 * de sobra. Lo que no se guarda queda declarado en `truncated` y en los conteos honestos.
 */
const HISTORY_MAX_THREADS = 200;
const HISTORY_MAX_MESSAGES = 800;
/** `change.field` desconocido: cabe en una fila de log y no es un vector de costo. */
const UNKNOWN_FIELD_MAX = 64;
const UNKNOWN_FIELD_KEYS_MAX = 20;

/** Etiqueta corta y segura a partir de texto no confiable ('' ⇒ null). */
const label = (raw: unknown, max: number): string | null => {
  const clean = sanitizeAttachmentCaption(raw).slice(0, max).trim();
  return clean !== '' ? clean : null;
};

/**
 * ECHOES (`smb_message_echoes` → `value.message_echoes`, NO `value.messages`).
 *
 * Un echo sin `to` o sin wamid se IGNORA: sin `to` no hay a quién atribuirlo (y el `from` no sirve
 * porque es el negocio), y sin wamid no hay forma de deduplicarlo — un echo repetido se persistiría
 * dos veces y el vendedor vería su propio mensaje duplicado en el panel.
 */
function waEchoesChange(value: Any, externalId: string, out: NormalizedEcho[]): number {
  let ignored = 0;
  const items = Array.isArray(value?.message_echoes) ? value.message_echoes : [];
  for (const item of items) {
    const customerWaId = str(item?.to);
    const messageId = str(item?.id);
    if (customerWaId === null || messageId === null) {
      ignored++;
      continue;
    }
    const tipo = str(item?.type);
    // `edit` trae el mensaje NUEVO adentro; de ahí sale el texto que el cliente terminó viendo.
    const editado = item?.edit?.message;
    const textoCrudo = tipo === 'edit' ? waText(editado) : waText(item);
    const mediaTipo = tipo === 'edit' ? str(editado?.type) : tipo;
    const esMedia = (ECHO_MEDIA_TYPES as readonly string[]).includes(mediaTipo ?? '');
    const echoType: EchoType =
      tipo === 'revoke' ? 'revoke'
        : tipo === 'edit' ? 'edit'
          : textoCrudo !== null ? 'text'
            : esMedia ? 'media'
              : 'other';
    out.push({
      platform: 'whatsapp',
      externalId,
      customerWaId,
      messageId,
      timestamp: toNum(item?.timestamp),
      echoType,
      // Saneado igual que un caption: es texto que el vendedor escribió a mano y termina en el
      // panel y en Firestore. El caption de un media NO se promueve a texto (ADR-0016 §9).
      text: sanitizeAttachmentCaption(textoCrudo),
      mediaKind: esMedia ? mediaTipo : null,
      originalMessageId: str(item?.revoke?.original_message_id) ?? str(item?.edit?.original_message_id),
      automationEligible: false,
    });
  }
  return ignored;
}

/**
 * Clave de idempotencia de un echo. Tiene PREFIJO PROPIO por dos razones distintas:
 *
 *  1. Frente a los mensajes vivos: un echo y un inbound son hechos distintos y no pueden compartir
 *     documento aunque compartieran wamid.
 *  2. Frente a sí mismo: un `revoke` o un `edit` pueden llegar referidos al mismo mensaje que ya
 *     produjo un echo. Sin discriminar el tipo, el borrado se tragaría como "duplicado" y el
 *     vendedor seguiría viendo en el panel el mensaje que ya borró delante del cliente.
 */
export function echoIdempotencyKey(echo: Pick<NormalizedEcho, 'echoType' | 'messageId'>): string {
  return echo.echoType === 'revoke' || echo.echoType === 'edit'
    ? `echo_${echo.echoType}_${echo.messageId}`
    : `echo_${echo.messageId}`;
}

/**
 * HISTORY (`history` → `value.history[]`, con `metadata.{phase,chunk_order,progress}` y `threads[]`).
 *
 * La dirección de cada mensaje se DERIVA comparando su `from` con el id del hilo (que es el wa_id
 * del cliente). Así el número del negocio no necesita transportarse tampoco acá: menos superficie
 * para que mañana alguien lo confunda con el `from` de un inbound.
 */
function waHistoryChange(value: Any, externalId: string, out: NormalizedHistoryChunk[]): number {
  let ignored = 0;
  const chunks = Array.isArray(value?.history) ? value.history : [];
  for (const chunk of chunks) {
    const hilosCrudos = Array.isArray(chunk?.threads) ? chunk.threads : [];
    const threads: NormalizedHistoryThread[] = [];
    let threadCount = 0;
    let messageCount = 0;
    let guardados = 0;
    let truncated = false;
    for (const hilo of hilosCrudos) {
      const customerWaId = str(hilo?.id);
      if (customerWaId === null) {
        ignored++;
        continue;
      }
      threadCount++;
      const msgsCrudos = Array.isArray(hilo?.messages) ? hilo.messages : [];
      const messages: NormalizedHistoryMessage[] = [];
      for (const msg of msgsCrudos) {
        const id = str(msg?.id);
        if (id === null) {
          ignored++;
          continue;
        }
        messageCount++; // el conteo es HONESTO aunque después no se guarde
        if (threads.length >= HISTORY_MAX_THREADS || guardados >= HISTORY_MAX_MESSAGES) {
          truncated = true;
          continue;
        }
        const from = str(msg?.from);
        messages.push({
          id,
          direction: from === null ? 'unknown' : from === customerWaId ? 'in' : 'out',
          type: label(msg?.type, HISTORY_LABEL_MAX) ?? 'unknown',
          text: sanitizeAttachmentCaption(waText(msg)).slice(0, HISTORY_TEXT_MAX),
          timestamp: toNum(msg?.timestamp),
          status: label(msg?.history_context?.status, HISTORY_LABEL_MAX),
        });
        guardados++;
      }
      if (threads.length < HISTORY_MAX_THREADS) threads.push({ customerWaId, messages });
      else truncated = true;
    }
    out.push({
      platform: 'whatsapp',
      externalId,
      phase: toNum(chunk?.metadata?.phase),
      chunkOrder: toNum(chunk?.metadata?.chunk_order),
      progress: toNum(chunk?.metadata?.progress),
      threadCount,
      messageCount,
      threads,
      truncated,
      automationEligible: false,
    });
  }
  return ignored;
}

/**
 * APP STATE (`smb_app_state_sync` → `value.state_sync[]` con `{type, contact, action, metadata}`).
 * Un contacto sin teléfono no se puede vincular a nada: se ignora.
 */
function waAppStateChange(value: Any, externalId: string, out: NormalizedAppStateChange[]): number {
  let ignored = 0;
  const items = Array.isArray(value?.state_sync) ? value.state_sync : [];
  for (const item of items) {
    const contactWaId = str(item?.contact?.phone_number);
    if (contactWaId === null) {
      ignored++;
      continue;
    }
    const accion = str(item?.action);
    out.push({
      platform: 'whatsapp',
      externalId,
      entryType: label(item?.type, HISTORY_LABEL_MAX) ?? 'unknown',
      // Fail-closed de vocabulario: si Meta agrega una acción nueva no se asume `add`. Asumirlo
      // sería dar de alta contactos por un valor que este despliegue no entiende.
      action: accion === 'add' || accion === 'remove' ? accion : 'unknown',
      contactWaId,
      fullName: sanitizeAttachmentCaption(item?.contact?.full_name).slice(0, CONTACT_NAME_MAX).trim(),
      firstName: sanitizeAttachmentCaption(item?.contact?.first_name).slice(0, CONTACT_NAME_MAX).trim(),
      timestamp: toNum(item?.metadata?.timestamp),
      createsCustomer: false,
    });
  }
  return ignored;
}

/** Campo desconocido: se registra la FORMA (nombre del campo y claves), nunca el contenido. */
function waUnknownChange(field: string, value: Any, externalId: string): NormalizedUnknownField {
  const claves =
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).sort().slice(0, UNKNOWN_FIELD_KEYS_MAX)
      : [];
  const items = value?.[field];
  return {
    platform: 'whatsapp',
    externalId,
    field: sanitizeAttachmentCaption(field).slice(0, UNKNOWN_FIELD_MAX),
    valueKeys: claves.map((k) => sanitizeAttachmentCaption(k).slice(0, UNKNOWN_FIELD_MAX)),
    itemCount: Array.isArray(items) ? items.length : null,
  };
}

/**
 * DESPACHADOR por `change.field` (ADR-0017 §12).
 *
 * `field` AUSENTE ⇒ `messages`. No es laxitud: es exactamente lo que este parser hacía antes de
 * existir el despachador, y los payloads en vuelo (y los fixtures viejos) tienen que seguir
 * funcionando. Un `field` PRESENTE pero desconocido, en cambio, no se degrada a `messages`: se
 * audita y no ejecuta nada.
 */
function parseWhatsApp(entries: Any[], result: ParseResult): number {
  let ignored = 0;
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value ?? {};
      const externalId = str(value?.metadata?.phone_number_id) ?? '';
      const field = str(change?.field) ?? 'messages';
      switch (field) {
        case 'messages':
          ignored += waMessagesChange(value, externalId, result.messages);
          break;
        case 'smb_message_echoes':
          ignored += waEchoesChange(value, externalId, result.echoes);
          break;
        case 'history':
          ignored += waHistoryChange(value, externalId, result.historyChunks);
          break;
        case 'smb_app_state_sync':
          ignored += waAppStateChange(value, externalId, result.appStateChanges);
          break;
        default:
          result.unknownFields.push(waUnknownChange(field, value, externalId));
          ignored++;
          break;
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

/** Resultado vacío. Las listas de Coexistence siempre existen: quien las lee nunca chequea null. */
const emptyResult = (): ParseResult => ({
  messages: [],
  ignored: 0,
  echoes: [],
  historyChunks: [],
  appStateChanges: [],
  unknownFields: [],
});

export function parseMetaWebhookPayload(payload: unknown): ParseResult {
  const root = payload as Any;
  const result = emptyResult();
  if (!root || typeof root !== 'object' || !Array.isArray(root.entry)) return result;
  switch (root.object) {
    case 'whatsapp_business_account':
      result.ignored = parseWhatsApp(root.entry, result);
      break;
    case 'instagram':
      result.ignored = parseMessaging('instagram', root.entry, result.messages);
      break;
    case 'page':
      result.ignored = parseMessaging('messenger', root.entry, result.messages);
      break;
    default:
      return emptyResult();
  }
  return result;
}
