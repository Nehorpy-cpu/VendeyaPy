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
 *
 * CONTRATO OFICIAL VERIFICADO EL 2026-08-04 (ADR-0017 §5 y §6 · ARCHITECTURE §12.1). Cuatro hechos
 * que este parser no contemplaba, y que cuestan material irrecuperable:
 *
 *  1. Los IDs de los ADJUNTOS del historial llegan con `field: "history"` pero en `value.messages[]`,
 *     NO en `value.history[]`. Se descartaban en silencio, y esos IDs viven 14 días y no se pueden
 *     volver a pedir. Salen por lista PROPIA (`historyMedia`): meterlos en `messages` los mandaría a
 *     `metaWebhookInbox`, que ES el disparador del motor.
 *  2. «El negocio no compartió» llega como `history[0].errors[0].code = 2593109` y ese payload NO
 *     trae el envelope `object`/`entry`/`changes`. Sin leerlo, el coordinador espera hasta quemar la
 *     ventana de 24 h — y pasada, hay que desconectar el número real y rehacer todo el onboarding.
 *  3. `account_update` avisa que Meta desconectó el número (inactividad ~14 d / ~30 d). Sin
 *     consumirlo, un número en `live` automatiza contra una conexión muerta.
 *  4. El error `131060` es ESPERADO tras el onboarding. Se expone CLASIFICADO para no llenar la
 *     auditoría de ruido y, sobre todo, para no esconder los errores que sí son fallas.
 */

import { sanitizeAttachmentCaption, sanitizeAttachmentFilename, sanitizeAttachmentError, normalizeMimeType } from '@vpw/shared';
import type { MessageDeliveryError } from '@vpw/shared';

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
   * ADR-0021 §2: `value.contacts[].profile.name` asociado a ESTE mensaje por `wa_id`. Es el
   * nombre de perfil que el CLIENTE eligió en WhatsApp — dato del proveedor, saneado y acotado,
   * jamás dato CRM confirmado (`Customer.name`). Ausente si Meta no mandó el contacto.
   */
  profileName?: string;
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
 * Código con el que Meta dice «el negocio eligió NO compartir el historial». Es un DESENLACE, no
 * un silencio: sin leerlo el coordinador espera hasta que se vence la ventana de 24 h, y pasada
 * esa ventana la única salida es desconectar el número real y rehacer el Embedded Signup entero.
 */
export const HISTORY_NOT_SHARED_CODE = 2593109;

/**
 * Códigos ESPERADOS tras el onboarding de Coexistence (ADR-0017 §6). `131060` aparece en el
 * webhook de mensajes no soportados —primer mensaje de un usuario, o un companion no soportado— y
 * tratarlo como falla llenaría la auditoría de ruido justo cuando hay que ver las fallas reales.
 *
 * Congelado y con nombre propio para que la clasificación se lea en un solo lugar: si esto fuera
 * un `if (code === 131060)` en el webhook, el día que Meta sume otro código esperado nadie sabría
 * dónde tocar.
 */
export const COEXISTENCE_EXPECTED_ERROR_CODES: readonly number[] = Object.freeze([131060]);

/** Un error del payload de Meta, recortado a lo que se puede loguear sin exponer nada. */
export interface NormalizedWebhookError {
  code: number | null;
  /** `title` SANEADO y acotado. El `message`/`details` NO se transportan: pueden traer contenido. */
  title: string | null;
  /** true ⇒ es uno de los códigos que el contrato declara normales. No es una falla. */
  expected: boolean;
}

/**
 * ADJUNTO del historial (`field: "history"` con `value.messages[]`). SOLO se transportan los IDs y
 * la metadata: el archivo se baja después, con el token de esa conexión, y el mediaId vive 14 días.
 *
 * No reusa `InboundAttachment` a propósito: aquel tipo describe algo que un cliente mandó AHORA y
 * que el motor puede consumir. Éste es archivo — nace `automationEligible: false` y su destino es
 * la colección cerrada, nunca `metaWebhookInbox`.
 */
export interface NormalizedHistoryMedia {
  platform: 'whatsapp';
  externalId: string;
  /** wamid del mensaje del historial al que pertenece el adjunto. Base de la idempotencia. */
  messageId: string;
  /** `messages[].type` SANEADO (`image`, `document`, `video`, `audio`, `sticker`, …). */
  kind: string;
  /** Id del media en Graph. Existe 14 días y NO se puede volver a pedir. Nunca va a logs. */
  mediaId: string;
  declaredMime: string | null;
  filename: string | null;
  sha256: string | null;
  timestamp: number | null;
  automationEligible: false;
}

/**
 * Clave de idempotencia de un adjunto del historial. Lleva la GENERACIÓN de la sincronización por
 * la misma razón que la del chunk: una segunda sincronización (que exige offboardear y rehacer el
 * Embedded Signup) traería los mismos wamids, y sin la generación se descartaría como duplicado.
 *
 * La generación 1 conserva la clave SIN sufijo: es retrocompatible con lo que ya escribió el
 * despliegue anterior, y evita duplicar documentos por un cambio de formato de clave.
 */
export function historyMediaIdempotencyKey(media: Pick<NormalizedHistoryMedia, 'externalId' | 'messageId'>, generacion: number): string {
  const sufijo = generacion > 1 ? `_g${generacion}` : '';
  return `historymedia_${media.externalId}_${media.messageId}${sufijo}`;
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
  /**
   * `history[].errors[]`. Se ignoraba entero, y ahí vive el ÚNICO aviso de que el negocio decidió
   * no compartir (`2593109`). Siempre existe la lista: quien la lee nunca chequea null.
   */
  errors: NormalizedWebhookError[];
  automationEligible: false;
}

/** ¿Este chunk es el aviso de que el negocio NO compartió el historial? */
export function esHistorialNoCompartido(chunk: Pick<NormalizedHistoryChunk, 'errors'>): boolean {
  return chunk.errors.some((e) => e.code === HISTORY_NOT_SHARED_CODE);
}

/**
 * Eventos de `account_update` que gobiernan el ciclo de desconexión (ADR-0017 §6). Vocabulario
 * CERRADO: un evento que este despliegue no conoce se normaliza como `unknown` y no se degrada a
 * ninguno de los conocidos — degradarlo sería ejecutar una acción por un valor que no se entiende.
 */
export const ACCOUNT_UPDATE_EVENTS = Object.freeze(['ACCOUNT_OFFBOARDED', 'PARTNER_REMOVED', 'ACCOUNT_RECONNECTED'] as const);
export type AccountUpdateEvent = (typeof ACCOUNT_UPDATE_EVENTS)[number] | 'unknown';

/**
 * ACCOUNT UPDATE — Meta desconecta un número en coexistencia por su cuenta (inactividad del
 * dispositivo primario ~14 d, del companion ~30 d, cambio de número, re-registro, reinstalación).
 *
 * `externalId` puede quedar VACÍO: el payload de `account_update` no siempre trae
 * `phone_number_id`. No se adivina — quien consuma esto decide qué hacer sin PNID, y la respuesta
 * correcta es no degradar a nadie (silenciar el número equivocado es peor que un evento perdido).
 */
export interface NormalizedAccountUpdate {
  platform: 'whatsapp';
  /** `metadata.phone_number_id` si vino; `''` si Meta no lo mandó. */
  externalId: string;
  /** `entry[].id` — la WABA. Evidencia para diagnosticar, jamás para decidir a quién degradar. */
  wabaId: string;
  event: AccountUpdateEvent;
  /** El string CRUDO saneado, para que un evento nuevo quede registrado con su nombre real. */
  rawEvent: string;
  timestamp: number | null;
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

// ---------------------------------------------------------------------------
// ADR-0021 §1 — RECIBOS DE ENTREGA (`value.statuses`)
// ---------------------------------------------------------------------------

/**
 * Estados de entrega que declara el contrato oficial de Meta para `value.statuses[]`. Vocabulario
 * CERRADO: un estado que este despliegue no conoce se descarta contado como ignorado — degradarlo
 * a uno conocido sería avanzar ticks del panel por un valor que no se entiende.
 */
export const DELIVERY_RECEIPT_STATUSES = ['sent', 'delivered', 'read', 'failed'] as const;
export type DeliveryReceiptStatus = (typeof DELIVERY_RECEIPT_STATUSES)[number];

/**
 * RECIBO DE ENTREGA normalizado — el avance de estado de un mensaje SALIENTE nuestro, reportado
 * por el proveedor. Hasta ADR-0021 se descartaban enteros (sumaban a `ignored`) y la burbuja del
 * panel no podía mostrar ticks honestos.
 *
 * `recipientId` es el wa_id del CLIENTE al que le mandamos el mensaje: de ahí se deriva el
 * `customerId` (misma sanitización a dígitos que `process.ts`) para buscar la burbuja por wamid.
 * El `error` de un `failed` viaja SANEADO (code + title/message acotados) — el payload crudo del
 * error (`error_data`, `details`) NO se transporta: puede arrastrar contenido y termina en logs.
 */
export interface NormalizedDeliveryStatus {
  /** `statuses[].id` — wamid del mensaje SALIENTE al que refiere el recibo. */
  waMessageId: string;
  status: DeliveryReceiptStatus;
  /** `statuses[].timestamp` en segundos (reloj DEL PROVEEDOR). null si no vino o es basura. */
  timestampSeconds: number | null;
  /** `statuses[].recipient_id` — wa_id del cliente destinatario. */
  recipientId: string;
  /** `metadata.phone_number_id` — por qué número del negocio salió el mensaje ('' si no vino). */
  receivedVia: string;
  /** Solo en `failed` (si Meta lo mandó): `errors[0]` sanitizado, sin payload crudo. */
  error?: MessageDeliveryError;
}

export interface ParseResult {
  messages: NormalizedInbound[];
  ignored: number;
  /**
   * ADR-0021 §1: recibos de entrega del cambio `messages`. Lista aditiva como las de
   * Coexistence: quien solo lee `messages`/`ignored` sigue funcionando igual que antes.
   */
  deliveryStatuses: NormalizedDeliveryStatus[];
  /**
   * Los cuatro campos de Coexistence salen por listas SEPARADAS y no por `messages`. Son aditivos:
   * quien solo lee `messages`/`ignored` sigue funcionando igual que antes.
   */
  echoes: NormalizedEcho[];
  historyChunks: NormalizedHistoryChunk[];
  /** IDs de los adjuntos del historial (`field:"history"` con `value.messages[]`). Ver el tipo. */
  historyMedia: NormalizedHistoryMedia[];
  appStateChanges: NormalizedAppStateChange[];
  /** `account_update`: el ciclo de desconexión de Coexistence (ADR-0017 §6). */
  accountUpdates: NormalizedAccountUpdate[];
  /** Errores del canal `messages`, ya clasificados en esperados / no esperados. */
  messageErrors: NormalizedWebhookError[];
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

/** Largo máximo del `title` de un error. Entra en una fila de log y no arrastra contenido. */
const ERROR_TITLE_MAX = 128;

/**
 * Normaliza `errors[]` de cualquier nivel del payload. Se transportan SOLO `code` y `title`: el
 * `message`, `details` y `error_data` de Meta pueden arrastrar contenido del mensaje del cliente, y
 * esto termina en logs y en documentos de auditoría.
 */
function waErrors(raw: Any, out: NormalizedWebhookError[]): void {
  if (!Array.isArray(raw)) return;
  for (const e of raw) {
    const code = toNum(e?.code);
    out.push({
      code,
      title: label(e?.title, ERROR_TITLE_MAX),
      expected: code !== null && COEXISTENCE_EXPECTED_ERROR_CODES.includes(code),
    });
  }
}

/** ¿Es uno de los cuatro estados del contrato? Fail-closed de vocabulario (ver el const). */
const esEstadoDeEntrega = (v: string | null): v is DeliveryReceiptStatus =>
  v !== null && (DELIVERY_RECEIPT_STATUSES as readonly string[]).includes(v);

/**
 * `statuses[].errors[0]` → error SANEADO. Se transportan SOLO `code` y `title` (con fallback a
 * `message`, que algunos códigos traen en lugar del title), pasados por `sanitizeAttachmentError`:
 * corta control chars, URLs firmadas y corridas largas de dígitos (teléfonos/wamids). El
 * `error_data`/`details` crudo JAMÁS viaja — puede arrastrar contenido del mensaje.
 */
function waStatusError(s: Any): MessageDeliveryError | null {
  const e0 = Array.isArray(s?.errors) ? s.errors[0] : null;
  if (!e0 || typeof e0 !== 'object') return null;
  const code = toNum(e0?.code);
  const detail = sanitizeAttachmentError(str(e0?.title) ?? str(e0?.message) ?? '', ERROR_TITLE_MAX);
  if (code === null && detail === '') return null;
  return { ...(code !== null ? { code: String(code) } : {}), ...(detail !== '' ? { detail } : {}) };
}

/**
 * ADR-0021 §1: los RECIBOS DE ENTREGA dejan de descartarse. Sin wamid o sin `recipient_id` no hay
 * a qué aplicarlos (se descartan contados), y un estado desconocido también — nunca se degrada.
 */
function waStatuses(value: Any, externalId: string, out: NormalizedDeliveryStatus[]): number {
  let ignored = 0;
  const items = Array.isArray(value?.statuses) ? value.statuses : [];
  for (const s of items) {
    const waMessageId = str(s?.id);
    const recipientId = str(s?.recipient_id);
    const status = str(s?.status);
    if (waMessageId === null || recipientId === null || !esEstadoDeEntrega(status)) {
      ignored++;
      continue;
    }
    const error = waStatusError(s);
    out.push({
      waMessageId,
      status,
      timestampSeconds: toNum(s?.timestamp),
      recipientId,
      receivedVia: externalId,
      ...(error ? { error } : {}),
    });
  }
  return ignored;
}

/**
 * ADR-0021 §2: `value.contacts[]` → mapa wa_id → nombre de perfil SANEADO. Es dato del proveedor
 * (lo eligió el cliente en su WhatsApp): se acota y se limpia igual que cualquier texto no
 * confiable, y solo sirve para asociarlo al mensaje entrante de ESE wa_id.
 */
function waContactNames(value: Any): Map<string, string> {
  const nombres = new Map<string, string>();
  const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
  for (const c of contacts) {
    const waId = str(c?.wa_id);
    const nombre = label(c?.profile?.name, CONTACT_NAME_MAX);
    if (waId !== null && nombre !== null) nombres.set(waId, nombre);
  }
  return nombres;
}

/** Cuerpo HISTÓRICO del parser: un cambio con `field === 'messages'` (mensajes vivos + statuses). */
function waMessagesChange(
  value: Any,
  externalId: string,
  out: NormalizedInbound[],
  errores: NormalizedWebhookError[],
  recibos: NormalizedDeliveryStatus[],
): number {
  let ignored = 0;
  // ADR-0021 §1: los recibos de entrega ya NO suman a `ignored` — alimentan los ticks del panel.
  ignored += waStatuses(value, externalId, recibos);
  // Errores a nivel del CAMBIO: hasta acá eran completamente invisibles. Ahí es donde llega el
  // `131060` esperado tras el onboarding, y también cualquier falla real del canal.
  waErrors(value?.errors, errores);
  // ADR-0021 §2: el nombre de perfil del contacto, para asociarlo al mensaje por `wa_id`.
  const perfiles = waContactNames(value);
  const messages = Array.isArray(value?.messages) ? value.messages : [];
  for (const msg of messages) {
    // Errores del MENSAJE (típicamente `type: 'unsupported'`). Mismo criterio: se exponen
    // clasificados, no se esconden ni se tratan todos como falla.
    waErrors(msg?.errors, errores);
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
      // ADR-0021 §2: SOLO si el contacto matchea el `from` de ESTE mensaje. No se adivina.
      ...(perfiles.has(from) ? { profileName: perfiles.get(from)! } : {}),
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
function waHistoryChange(value: Any, externalId: string, out: NormalizedHistoryChunk[], media: NormalizedHistoryMedia[]): number {
  let ignored = 0;
  // AGUJERO DEL CONTRATO #1: los IDs de los adjuntos del historial llegan en ESTE mismo `field`
  // pero en `value.messages[]`. Se descartaban en silencio y sólo viven 14 días.
  ignored += waHistoryMedia(value, externalId, media);
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
    const errors: NormalizedWebhookError[] = [];
    // AGUJERO DEL CONTRATO #2: acá vive el `2593109` con el que Meta avisa que el negocio NO
    // compartió. Sin leerlo, el coordinador espera hasta quemar la ventana de 24 h.
    waErrors(chunk?.errors, errors);
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
      errors,
      automationEligible: false,
    });
  }
  return ignored;
}

/** Tipos de `messages[].type` que pueden traer un media id en el historial. */
const HISTORY_MEDIA_TYPES = ['image', 'document', 'video', 'audio', 'sticker'] as const;

/**
 * Los ADJUNTOS del historial: `field: "history"` con `value.messages[]`.
 *
 * Se transportan sólo los IDs y la metadata. No se reusa `waAttachment` porque aquel exige
 * `image`/`document` (los dos tipos que el motor sabe consumir) y acá se guardan TODOS los que
 * traigan media id: no hay interpretación de negocio, hay un archivo que sólo existe 14 días.
 */
function waHistoryMedia(value: Any, externalId: string, out: NormalizedHistoryMedia[]): number {
  let ignored = 0;
  const mensajes = Array.isArray(value?.messages) ? value.messages : [];
  for (const msg of mensajes) {
    const messageId = str(msg?.id);
    const tipo = str(msg?.type) ?? '';
    const media = (HISTORY_MEDIA_TYPES as readonly string[]).includes(tipo) ? msg?.[tipo] : null;
    const mediaId = str(media?.id);
    // Sin wamid no hay clave de idempotencia; sin media id no hay nada que bajar. En los dos casos
    // el ítem no sirve para nada: se cuenta como ignorado en vez de guardar un documento inútil.
    if (messageId === null || mediaId === null) {
      ignored++;
      continue;
    }
    out.push({
      platform: 'whatsapp',
      externalId,
      messageId,
      kind: label(tipo, HISTORY_LABEL_MAX) ?? 'unknown',
      mediaId,
      declaredMime: normalizeMimeType(media?.mime_type),
      filename: sanitizeAttachmentFilename(media?.filename),
      sha256: str(media?.sha256),
      timestamp: toNum(msg?.timestamp),
      automationEligible: false,
    });
  }
  return ignored;
}

/**
 * ACCOUNT UPDATE (`field: "account_update"` → `value.event`). ADR-0017 §6.
 *
 * El PNID sale ÚNICAMENTE de `metadata.phone_number_id`. Si Meta no lo manda queda vacío y quien
 * consuma esto no degrada a nadie: adivinar el número a partir del `phone_number` mostrado o de la
 * WABA podría dejar mudo al número que está vendiendo, que es el desenlace prohibido.
 */
function waAccountUpdateChange(value: Any, externalId: string, wabaId: string, out: NormalizedAccountUpdate[]): number {
  const crudo = str(value?.event) ?? '';
  const conocido = (ACCOUNT_UPDATE_EVENTS as readonly string[]).includes(crudo);
  out.push({
    platform: 'whatsapp',
    externalId,
    wabaId,
    event: conocido ? (crudo as AccountUpdateEvent) : 'unknown',
    rawEvent: label(crudo, HISTORY_LABEL_MAX) ?? '',
    timestamp: toNum(value?.timestamp),
  });
  // Un account_update no es un mensaje: no suma a `ignored` (que cuenta mensajes descartados).
  return 0;
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
          ignored += waMessagesChange(value, externalId, result.messages, result.messageErrors, result.deliveryStatuses);
          break;
        case 'smb_message_echoes':
          ignored += waEchoesChange(value, externalId, result.echoes);
          break;
        case 'history':
          ignored += waHistoryChange(value, externalId, result.historyChunks, result.historyMedia);
          break;
        case 'smb_app_state_sync':
          ignored += waAppStateChange(value, externalId, result.appStateChanges);
          break;
        case 'account_update':
          ignored += waAccountUpdateChange(value, externalId, str(entry?.id) ?? '', result.accountUpdates);
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

/**
 * ADR-0021 §1 — RECIBOS a partir del payload YA PERSISTIDO en el inbox (`payload.statuses[]`).
 *
 * Mismo criterio que `attachmentFromInboxPayload`: el documento del inbox no se cree — cada evento
 * se RE-VALIDA (wamid, recipient y estado del vocabulario cerrado; lo inválido se descarta sin
 * lanzar) y el error se re-sanea. Es puro ⇒ testeable sin E/S. No existe forma legacy: hasta
 * ADR-0021 los recibos se descartaban en el parser y nunca llegaron a persistirse.
 */
export function deliveryStatusesFromInboxPayload(payload: unknown): NormalizedDeliveryStatus[] {
  const items = (payload as Any)?.statuses;
  if (!Array.isArray(items)) return [];
  const out: NormalizedDeliveryStatus[] = [];
  for (const s of items as Any[]) {
    const waMessageId = str(s?.waMessageId);
    const recipientId = str(s?.recipientId);
    const status = str(s?.status);
    if (waMessageId === null || recipientId === null || !esEstadoDeEntrega(status)) continue;
    const code = str(s?.error?.code);
    const detail = sanitizeAttachmentError(str(s?.error?.detail) ?? '', ERROR_TITLE_MAX);
    const error: MessageDeliveryError | null =
      code !== null || detail !== ''
        ? { ...(code !== null ? { code } : {}), ...(detail !== '' ? { detail } : {}) }
        : null;
    out.push({
      waMessageId,
      status,
      timestampSeconds: toNum(s?.timestampSeconds),
      recipientId,
      receivedVia: str(s?.receivedVia) ?? '',
      ...(error ? { error } : {}),
    });
  }
  return out;
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
  deliveryStatuses: [],
  echoes: [],
  historyChunks: [],
  historyMedia: [],
  appStateChanges: [],
  accountUpdates: [],
  messageErrors: [],
  unknownFields: [],
});

/**
 * HISTORIAL SIN ENVELOPE — AGUJERO DEL CONTRATO #2.
 *
 * El payload con el que Meta avisa «el negocio no compartió» NO trae `object`/`entry`/`changes`:
 * llega como un objeto suelto con `history[]` adentro (y, según la página de la doc, a veces
 * envuelto en `value`). Sin este camino, `parseMetaWebhookPayload` cortaba en el guard del
 * `entry` y perdía el evento ENTERO — el coordinador se quedaba esperando hasta que se vencía la
 * ventana de 24 h, y ahí la única salida es desconectar el número real y rehacer el onboarding.
 *
 * Es DELIBERADAMENTE angosto: sólo reconoce un `history` que sea arreglo. Cualquier otro payload
 * sin envelope sigue devolviendo vacío, como antes.
 */
function parseHistorialSinSobre(root: Any, result: ParseResult): void {
  const cuerpo = Array.isArray(root?.history) ? root : Array.isArray(root?.value?.history) ? root.value : null;
  if (!cuerpo) return;
  const externalId = str(cuerpo?.metadata?.phone_number_id) ?? '';
  result.ignored = waHistoryChange(cuerpo, externalId, result.historyChunks, result.historyMedia);
}

export function parseMetaWebhookPayload(payload: unknown): ParseResult {
  const root = payload as Any;
  const result = emptyResult();
  if (!root || typeof root !== 'object') return result;
  if (!Array.isArray(root.entry)) {
    parseHistorialSinSobre(root, result);
    return result;
  }
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
