/**
 * messaging/whatsappClient.ts — Envío de WhatsApp POR TENANT (Fase 4A)
 * ===================================================================
 * El bot calcula la respuesta (engine) y la ENTREGA por este cliente. Adapters
 * intercambiables (ADR-0003):
 *   - MockWhatsAppClient: emulador / demo / no-conectado — sólo loguea, NO llama a Meta.
 *   - CloudAPIClient: producción — POST a WhatsApp Cloud API (graph.facebook.com).
 *
 * Selección (getWhatsAppClient → por tenant):
 *   - Emulador → SIEMPRE Mock (nunca llama a Graph), pero resuelve credenciales para
 *     poder testear aislamiento por tenant (Mock inspeccionable con el phone_number_id).
 *   - Real → CloudAPIClient SOLO si whatsappSendMode==='live' (config/channels) Y la
 *     conexión Meta del tenant resuelve creds Y el canal RESUELTO tiene permiso de automatización
 *     (ADR-0017 §1 — ver `decideOutboundChannel`); en cualquier otro caso, Mock con motivo.
 * El token NUNCA se loguea ni se escribe en Firestore. Ver Fase 4A.
 */
import axios from 'axios';
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from '../lib/logger.js';
import { db } from '../lib/firebase.js';
import { maskPhone, permiteAutomatizacion } from '@vpw/shared';
import type { MessageChannel, WhatsappSendMode, WhatsappAutomationMode } from '@vpw/shared';
import { getChannelConfig } from './channelConfig.js';
import { resolveAutomationMode } from '../meta/automationMode.js';
import {
  resolveTenantWhatsappCreds,
  resolveTenantWhatsappCredsFor,
  type WhatsappCredsResult,
  type WhatsappCredsReason,
} from './resolveWhatsappCreds.js';

/**
 * SHIPPING-CHAT-3B — Resultado DISCRIMINADO del envío (imposible de construir inconsistente).
 *  - 'accepted': la Cloud API ACEPTÓ el mensaje y devolvió un wamid (NO significa entregado
 *    al teléfono — solo aceptado por la API). 2xx SIN wamid ⇒ 'unknown'.
 *  - 'mock': no salió a Meta (emulador / modo mock / no-conectado); id determinístico.
 *  - 'rejected': rechazo CONFIRMADO (HTTP 4xx de Graph); `providerCode` numérico saneado o null.
 *  - 'unknown': 5xx, timeout, reset, sin respuesta o excepción ambigua — el mensaje PUDO salir.
 *  - 'blocked': ADR-0017 §1 — el canal NO tiene permiso para hablar. NO se llamó a Meta: es un
 *    NO-ENVÍO confirmado, cero HTTP en vuelo. Se separa de 'mock' porque son cosas opuestas: un
 *    mock es un envío simulado que el historial registra COMO TAL (el tenant eligió no enviar),
 *    y un bloqueo es un mensaje que el negocio quiso mandar y el sistema impidió. Devolverlo con
 *    `ok:true` dejaba la burbuja en el chat y le contestaba éxito al vendedor mientras el cliente
 *    no recibía nada: un silencio que miente es peor que un error.
 * Nada de regex sobre strings ni payload crudo de Meta en el resultado o los logs.
 */
export type SendResult =
  | { ok: true; outcome: 'accepted'; id: string; viaMock: false }
  | { ok: true; outcome: 'mock'; id: string; viaMock: true }
  | { ok: false; outcome: 'rejected'; providerCode: number | null }
  | { ok: false; outcome: 'blocked'; reason: MotivoCanalBloqueado }
  | { ok: false; outcome: 'unknown' };

/**
 * SHIPPING-CHAT-3B — Metadata NO sensible del transporte (jamás el token). La saga de
 * cotización (3C, `coverageQuote.ts`) la usa para distinguir: live con credenciales del PROPIO
 * tenant (único caso que aprueba una cotización financiera en producción) · global fallback (live
 * pero con credenciales ajenas al tenant ⇒ NO apto para dinero) · mock (modo/credenciales no resueltas).
 */
export type WhatsappTransportInfo =
  | { transport: 'live'; credentials: 'tenant' | 'global_fallback' }
  | { transport: 'mock'; mode: WhatsappSendMode | null; reason: string | null; tokenPresent: boolean };

export interface SendContext {
  tenantId?: string;
  channel?: MessageChannel;
}

/**
 * COVERAGE-1B: resultado TIPADO del pedido de ubicación nativa (nada de strings mágicos).
 * `unsupported_channel` ⇒ el llamador manda el texto plano (fallback textual, UNA sola vez).
 * `channel_blocked` (ADR-0017 §1) ⇒ el canal no tiene permiso: el fallback textual TAMPOCO va a
 * salir, y por eso el motivo es propio — que el log diga "falló el botón" cuando lo que pasa es
 * que el número está mudo manda a buscar el problema al lugar equivocado.
 */
export type LocationRequestResult =
  | { ok: true; id?: string; viaMock?: boolean }
  | { ok: false; reason: 'unsupported_channel' | 'send_error' | 'channel_blocked' };

/**
 * ADR-0021 §5 — media SALIENTE por id de media ya subido a Meta (`POST /{pnid}/media`, ver
 * `meta/mediaClient.ts#uploadWhatsappMedia`). El caption llega SANEADO por el caller (contrato
 * ADR-0016) y el filename es el saneado decorativo del documento: acá no se valida contenido,
 * solo se entrega — la validación de bytes/MIME es responsabilidad del camino de adjuntos.
 */
export interface OutboundImageMedia {
  mediaId: string;
  caption?: string;
}

export interface OutboundDocumentMedia {
  mediaId: string;
  filename: string;
  caption?: string;
}

export interface WhatsAppClient {
  /** SHIPPING-CHAT-3B: metadata no sensible del transporte (ver WhatsappTransportInfo). */
  readonly transportInfo: WhatsappTransportInfo;
  sendText(to: string, text: string, ctx?: SendContext): Promise<SendResult>;
  /** COVERAGE-1B: interactive `location_request_message` (botón nativo "Enviar ubicación"). */
  sendLocationRequest(to: string, bodyText: string, ctx?: SendContext): Promise<LocationRequestResult>;
  /** ADR-0021 §5: imagen saliente por media id. Mismos outcomes y contexto que sendText. */
  sendImage(to: string, media: OutboundImageMedia, ctx?: SendContext): Promise<SendResult>;
  /** ADR-0021 §5: documento saliente por media id. Mismos outcomes y contexto que sendText. */
  sendDocument(to: string, media: OutboundDocumentMedia, ctx?: SendContext): Promise<SendResult>;
}

/**
 * SHIPPING-CHAT-3B — Clasificación PURA del error de la Cloud API (testeable, sin regex):
 *  - AxiosError con `response.status` 4xx ⇒ 'rejected' SIEMPRE (Graph recibió y negó);
 *    `providerCode` = `body.error.code` solo si es entero seguro, si no null. El payload
 *    crudo jamás se propaga.
 *  - Cualquier otra cosa (5xx, timeout, reset, sin respuesta, excepción rara) ⇒ 'unknown'.
 */
export function classifyCloudSendError(e: unknown): Extract<SendResult, { ok: false }> {
  if (axios.isAxiosError(e) && typeof e.response?.status === 'number' && e.response.status >= 400 && e.response.status < 500) {
    const code = (e.response.data as { error?: { code?: unknown } } | undefined)?.error?.code;
    return { ok: false, outcome: 'rejected', providerCode: typeof code === 'number' && Number.isSafeInteger(code) ? code : null };
  }
  return { ok: false, outcome: 'unknown' };
}

/**
 * SHIPPING-CHAT-3B — 2xx de la Cloud API SOLO es 'accepted' con un wamid REALMENTE válido:
 * string no vacío y no solo-whitespace. Un identificador evidentemente inválido NO se normaliza
 * en silencio: se clasifica 'unknown' (el mensaje pudo salir, pero no hay wamid confiable).
 */
export function sendResultFromCloudResponse(id: unknown): SendResult {
  if (typeof id === 'string' && id.trim().length > 0) return { ok: true, outcome: 'accepted', id, viaMock: false };
  return { ok: false, outcome: 'unknown' };
}

const GRAPH_VERSION = 'v19.0';

/** Construye el body de la Cloud API para un mensaje de texto (puro → testeable). */
export function buildCloudApiTextBody(to: string, text: string) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: text },
  };
}

/**
 * ADR-0021 §5 — Bodies de media saliente por ID de media (puros → testeables). El caption solo
 * viaja si existe: un `caption: undefined` serializado igual termina como campo basura en Graph.
 */
export function buildCloudApiImageBody(to: string, media: OutboundImageMedia) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'image',
    image: { id: media.mediaId, ...(media.caption ? { caption: media.caption } : {}) },
  };
}

export function buildCloudApiDocumentBody(to: string, media: OutboundDocumentMedia) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'document',
    document: {
      id: media.mediaId,
      filename: media.filename,
      ...(media.caption ? { caption: media.caption } : {}),
    },
  };
}

/**
 * Body oficial del location_request_message (puro → testeable). Graph ACTUAL del proyecto
 * (sin upgrade): el tipo interactivo está disponible en la Cloud API desde v16.
 */
export function buildCloudApiLocationRequestBody(to: string, bodyText: string) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    // `action: { name: 'send_location' }` es OBLIGATORIO según la doc oficial: sin él, Graph
    // rechaza el POST y el botón nativo jamás sale (review adversarial, hallazgo alto).
    interactive: { type: 'location_request_message', body: { text: bodyText }, action: { name: 'send_location' } },
  };
}

const isEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';

/** Hash simple determinístico (djb2) para ids de mock — no criptográfico, no sensible. */
function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Metadatos de resolución para el Mock inspeccionable. NUNCA incluye el token. */
export interface MockResolution {
  mode?: WhatsappSendMode;
  phoneNumberId?: string;
  tokenPresent?: boolean;
  reason?: string;
}

/** Mock: no envía nada a Meta. Para emulador, demo, no-conectado y tests. */
export class MockWhatsAppClient implements WhatsAppClient {
  constructor(public readonly resolution?: MockResolution) {}

  /**
   * Traza de aislamiento SOLO en emulador (tests). Nunca en producción, nunca el token.
   *
   * Está acá —y `protected`— porque el invariante que hace verificable a todo este módulo es
   * «no salió a Meta **y se sabe por qué**», y vale para CUALQUIER transporte que no llegue a
   * Graph, no solo para el envío simulado. Un no-envío sin traza es indistinguible de un flujo
   * que nunca intentó enviar: son dos defectos opuestos y el test no podría separarlos.
   */
  protected async escribirTraza(ctx: SendContext | undefined, datos: Record<string, unknown>): Promise<void> {
    if (!isEmulator() || !ctx?.tenantId) return;
    try {
      await db().doc(`tenants/${ctx.tenantId}/_debug/lastWhatsappSend`).set({ ...datos, at: Timestamp.now() });
    } catch {
      /* la traza de debug nunca debe romper el envío */
    }
  }

  get transportInfo(): WhatsappTransportInfo {
    return {
      transport: 'mock',
      mode: this.resolution?.mode ?? null,
      reason: this.resolution?.reason ?? null,
      tokenPresent: !!this.resolution?.tokenPresent,
    };
  }

  async sendText(to: string, text: string, ctx?: SendContext): Promise<SendResult> {
    // Fixture SOLO-emulador (COVERAGE-1D / 3B): outcomes TIPADOS — rechazo confirmado
    // ('error' ⇒ rejected code 100) o resultado ambiguo ('timeout' ⇒ unknown), para testear
    // los estados failed/unknown del outbox sin regex sobre strings.
    if (isEmulator() && ctx?.tenantId) {
      try {
        const fx = (await db().doc(`tenants/${ctx.tenantId}/_debug/whatsappFixtures`).get()).data();
        if (fx?.failSendText === 'error') return { ok: false, outcome: 'rejected', providerCode: 100 };
        if (fx?.failSendText === 'timeout') return { ok: false, outcome: 'unknown' };
      } catch {
        /* sin fixture → camino normal */
      }
    }
    logger.info('WhatsApp (mock): respuesta NO enviada a Meta', {
      tenantId: ctx?.tenantId,
      channel: ctx?.channel,
      to: maskPhone(to),
      chars: text.length,
      mode: this.resolution?.mode,
      reason: this.resolution?.reason,
    });
    await this.escribirTraza(ctx, {
      to,
      channel: ctx?.channel ?? null,
      phoneNumberId: this.resolution?.phoneNumberId ?? null,
      mode: this.resolution?.mode ?? null,
      tokenPresent: !!this.resolution?.tokenPresent,
      reason: this.resolution?.reason ?? null,
      viaMock: true,
      blocked: false,
    });
    // COVERAGE-1D: id determinístico por (to, texto) — el outbox de mensajería lo persiste como
    // providerMessageId y una re-ejecución con el mismo contenido produce el mismo id (testeable).
    return { ok: true, outcome: 'mock', viaMock: true, id: `mock-${simpleHash(`${to}|${text}`)}` };
  }

  /**
   * ADR-0021 §5 — media en mock: no se llama a Meta (tampoco hubo subida: el caller la saltea
   * cuando el transporte no es live). Id determinístico por (to, tipo, mediaId), igual criterio
   * que sendText. El caption NO se loguea (texto del negocio hacia el cliente).
   */
  protected async mockMediaSend(
    kind: 'image' | 'document',
    to: string,
    mediaId: string,
    ctx?: SendContext,
  ): Promise<SendResult> {
    logger.info('WhatsApp (mock): media NO enviado a Meta', {
      tenantId: ctx?.tenantId,
      channel: ctx?.channel,
      kind,
      to: maskPhone(to),
      mode: this.resolution?.mode,
      reason: this.resolution?.reason,
    });
    await this.escribirTraza(ctx, {
      to,
      kind,
      channel: ctx?.channel ?? null,
      phoneNumberId: this.resolution?.phoneNumberId ?? null,
      mode: this.resolution?.mode ?? null,
      tokenPresent: !!this.resolution?.tokenPresent,
      reason: this.resolution?.reason ?? null,
      viaMock: true,
      blocked: false,
    });
    return { ok: true, outcome: 'mock', viaMock: true, id: `mock-${simpleHash(`${to}|${kind}|${mediaId}`)}` };
  }

  async sendImage(to: string, media: OutboundImageMedia, ctx?: SendContext): Promise<SendResult> {
    return this.mockMediaSend('image', to, media.mediaId, ctx);
  }

  async sendDocument(to: string, media: OutboundDocumentMedia, ctx?: SendContext): Promise<SendResult> {
    return this.mockMediaSend('document', to, media.mediaId, ctx);
  }

  /** Mock del location_request_message: no llama a Meta; traza inspeccionable en emulador. */
  async sendLocationRequest(to: string, bodyText: string, ctx?: SendContext): Promise<LocationRequestResult> {
    // Fixture SOLO-emulador para testear el fallback textual (mismo patrón que aiTestFixtures).
    if (isEmulator() && ctx?.tenantId) {
      try {
        const fx = await db().doc(`tenants/${ctx.tenantId}/_debug/whatsappFixtures`).get();
        if (fx.data()?.failLocationRequest === true) return { ok: false, reason: 'send_error' };
      } catch {
        /* sin fixture → camino normal */
      }
    }
    logger.info('WhatsApp (mock): location request NO enviado a Meta', {
      tenantId: ctx?.tenantId,
      channel: ctx?.channel,
      to: maskPhone(to),
      chars: bodyText.length,
      mode: this.resolution?.mode,
      reason: this.resolution?.reason,
    });
    await this.escribirTraza(ctx, {
      to,
      kind: 'location_request',
      channel: ctx?.channel ?? null,
      phoneNumberId: this.resolution?.phoneNumberId ?? null,
      mode: this.resolution?.mode ?? null,
      viaMock: true,
      blocked: false,
    });
    return { ok: true, viaMock: true };
  }
}

/** Cliente real de WhatsApp Cloud API. */
export class CloudAPIClient implements WhatsAppClient {
  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
    /** SHIPPING-CHAT-3B: 'tenant' = credenciales propias; 'global_fallback' = env deprecated. */
    private readonly credentials: 'tenant' | 'global_fallback' = 'tenant',
  ) {}

  get transportInfo(): WhatsappTransportInfo {
    return { transport: 'live', credentials: this.credentials };
  }

  async sendText(to: string, text: string, ctx?: SendContext): Promise<SendResult> {
    try {
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/messages`;
      const res = await axios.post(url, buildCloudApiTextBody(to, text), {
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        timeout: 10_000,
      });
      // 2xx SOLO es accepted con wamid string no vacío; 2xx sin id ⇒ unknown (SHIPPING-CHAT-3B).
      return sendResultFromCloudResponse(res.data?.messages?.[0]?.id);
    } catch (e) {
      // Clasificación tipada, sin regex ni payload crudo (códigos Meta de referencia: 190 token,
      // 131047 ventana 24h, 131030 destinatario no permitido, 131056/80007 rate limit).
      const result = classifyCloudSendError(e);
      logger.error('WhatsApp Cloud API: error al enviar', e, {
        tenantId: ctx?.tenantId,
        to: maskPhone(to),
        outcome: result.outcome,
        providerCode: result.outcome === 'rejected' ? result.providerCode : null,
      });
      return result;
    }
  }

  /**
   * ADR-0021 §5 — POST /messages compartido por los tipos de media. Misma clasificación tipada
   * que sendText (accepted solo con wamid real; 4xx ⇒ rejected saneado; resto ⇒ unknown) y el
   * mismo criterio de logs: teléfono enmascarado, jamás payload crudo ni caption.
   */
  private async postMediaMessage(
    body: Record<string, unknown>,
    to: string,
    etiqueta: 'imagen' | 'documento',
    ctx?: SendContext,
  ): Promise<SendResult> {
    try {
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/messages`;
      const res = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        timeout: 10_000,
      });
      return sendResultFromCloudResponse(res.data?.messages?.[0]?.id);
    } catch (e) {
      const result = classifyCloudSendError(e);
      logger.error(`WhatsApp Cloud API: error al enviar ${etiqueta}`, e, {
        tenantId: ctx?.tenantId,
        to: maskPhone(to),
        outcome: result.outcome,
        providerCode: result.outcome === 'rejected' ? result.providerCode : null,
      });
      return result;
    }
  }

  async sendImage(to: string, media: OutboundImageMedia, ctx?: SendContext): Promise<SendResult> {
    return this.postMediaMessage(buildCloudApiImageBody(to, media), to, 'imagen', ctx);
  }

  async sendDocument(to: string, media: OutboundDocumentMedia, ctx?: SendContext): Promise<SendResult> {
    return this.postMediaMessage(buildCloudApiDocumentBody(to, media), to, 'documento', ctx);
  }

  /** COVERAGE-1B: interactive location_request_message por la Cloud API (Graph actual). */
  async sendLocationRequest(to: string, bodyText: string, ctx?: SendContext): Promise<LocationRequestResult> {
    try {
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/messages`;
      const res = await axios.post(url, buildCloudApiLocationRequestBody(to, bodyText), {
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        timeout: 10_000,
      });
      const id = res.data?.messages?.[0]?.id as string | undefined;
      return { ok: true, id };
    } catch (e) {
      // Sin payloads sensibles: solo el error de Meta (mismo criterio que sendText, to enmascarado).
      logger.error('WhatsApp Cloud API: error al enviar location request', e, { tenantId: ctx?.tenantId, to: maskPhone(to) });
      return { ok: false, reason: 'send_error' };
    }
  }
}

// ---- Caché de clientes Cloud: TTL corto y acotado a tokenExpiresAt ----
// SHIPPING-CHAT-3B: keyeada por tenant + phone_number_id EFECTIVO (bug preexistente: con la
// clave solo-tenant, en multi-número dos envíos por números distintos dentro del TTL podían
// reusar el cliente del OTRO número — el mensaje salía por el número equivocado).
interface CacheEntry {
  client: CloudAPIClient;
  expiresAtMs: number;
}
const clientCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 1 min: corto, para no leer Secret/Firestore por cada mensaje.

/** Limpia la caché de clientes (para tests). */
export function clearWhatsappClientCache(): void {
  clientCache.clear();
}

function cloudClientFor(tenantId: string, creds: Extract<WhatsappCredsResult, { ok: true }>): CloudAPIClient {
  const now = Date.now();
  const key = `${tenantId}:${creds.phoneNumberId}`;
  const hit = clientCache.get(key);
  if (hit && hit.expiresAtMs > now) return hit.client;
  const client = new CloudAPIClient(creds.phoneNumberId, creds.accessToken, 'tenant');
  const expiresAtMs = Math.min(now + CACHE_TTL_MS, creds.tokenExpiresAtMs ?? Number.POSITIVE_INFINITY);
  clientCache.set(key, { client, expiresAtMs });
  return client;
}

/** Fallback global DEPRECATED (bootstrap mono-tenant) detrás de flag explícito. */
const globalFallbackAllowed = () => process.env.ALLOW_GLOBAL_WHATSAPP_FALLBACK === 'true';

/**
 * ADR-0017 §1 — EL PERMISO DEL CANAL, DEL LADO DEL ENVÍO
 * ======================================================
 * El gate de ADR-0017 nació mirando el inbound. Del lado del envío quedaba un agujero con nombre
 * propio: `resolveCreds` cae al número PRINCIPAL del tenant cuando el PNID pedido no resuelve. Si
 * el principal es —o pasa a ser— el número en `inactive`/`shadow`, TODO el outbound del tenant
 * sale por el número que debe estar callado. El fallback es el punto exacto donde un error de
 * ruteo se convierte en un mensaje a un cliente real.
 *
 * LA INTENCIÓN NO SE ADIVINA — SE DECLARA. La primera versión de este gate dedujo el origen del
 * mensaje mirando la forma de la llamada: «si el llamador nombró un PNID y ese PNID resolvió, lo
 * único que puede haber llegado hasta acá es HUMANO, porque el gate del inbound corta al bot antes
 * de que exista una respuesta que enviar». La premisa era FALSA y el contraejemplo está en el
 * repo: `enviarPorOutbox` (cobertura) construye el cliente con el PNID GUARDADO en el job
 * (`receivedVia`), y quienes la disparan son el mantenimiento programado y el trigger del job —
 * cero intervención humana. Un número en `live` deja un job pendiente, el operador lo degrada a
 * `shadow`, el mantenimiento toma el job: canal «elegido», modo distinto de `inactive` ⇒ salían
 * instrucciones bancarias a un cliente real por el número que tiene que estar callado.
 *
 * Por eso el permiso depende de un `origen` EXPLÍCITO, y el default es el estricto:
 *
 *  · **`automatico`** (bot, jobs, schedulers, triggers — todo lo que decide una máquina): se exige
 *    `live` SIEMPRE, nombre o no nombre el PNID. Es el default justamente porque un llamador que
 *    no se hizo la pregunta no puede terminar con el permiso ancho.
 *
 *  · **`humano`** + **canal ELEGIDO** (el vendedor escribe desde el panel por un número concreto):
 *    alcanza con que NO esté `inactive`. Es el único caso en el que un `shadow` lleva outbound, y
 *    tiene sentido porque en `shadow` el vendedor atiende A MANO: romperlo sería dejarlo sin poder
 *    contestar por el panel del número que él mismo está atendiendo.
 *
 *  · **canal INFERIDO** (no se nombró PNID, o se nombró uno y terminó saliendo por otro): se exige
 *    `live` aunque el origen sea humano. Un mensaje que el sistema RE-RUTEÓ a un número que nadie
 *    nombró no puede salir por un canal sin permiso: ahí no hubo decisión sobre el destino.
 *
 * Fail-closed igual que el inbound: si el permiso no se puede leer, el lector devuelve `inactive` y
 * el envío no sale. Cuesta una lectura por mensaje saliente, del mismo orden que la del gate de
 * entrada, y es lo que compra que ningún número hable sin permiso.
 */
export type OrigenEnvio = 'humano' | 'automatico';

/**
 * Motivo saneado de un bloqueo: código CERRADO, seguro de loguear y de persistir.
 *
 * `channel_unavailable` es el segundo motivo por el que un mensaje NO sale sin haber tocado Meta:
 * se pidió un número concreto y ese número no resuelve credenciales. Comparte desenlace con el
 * bloqueo por permiso —cero HTTP, `ok:false`— así que comparte tipo: los consumidores que ya
 * distinguen `outcome === 'blocked'` (mensaje manual, reanudación de cobertura) hacen exactamente
 * lo correcto sin cambiar nada, que es no persistir burbuja y no reintentar a ciegas.
 */
export type MotivoCanalBloqueado = `automation_${WhatsappAutomationMode}` | 'channel_unavailable';

export type OutboundChannelDecision =
  | { allow: true }
  | { allow: false; reason: MotivoCanalBloqueado; canal: 'elegido' | 'inferido'; origen: OrigenEnvio };

/** Decisión PURA (sin E/S, sin reloj) → unit-testeable, igual que `decideWhatsappCreds`. */
export function decideOutboundChannel(args: {
  requestedPhoneNumberId: string | null | undefined;
  resolvedPhoneNumberId: string;
  mode: WhatsappAutomationMode;
  /** Ausente ⇒ `automatico`: quien no declara origen recibe la vara estricta (fail-closed). */
  origen?: OrigenEnvio;
}): OutboundChannelDecision {
  const origen = args.origen ?? 'automatico';
  const pedido = (args.requestedPhoneNumberId ?? '').trim();
  const elegido = pedido !== '' && pedido === args.resolvedPhoneNumberId;
  const permitido = origen === 'humano' && elegido ? args.mode !== 'inactive' : permiteAutomatizacion(args.mode);
  return permitido
    ? { allow: true }
    : { allow: false, reason: `automation_${args.mode}`, canal: elegido ? 'elegido' : 'inferido', origen };
}

/**
 * ADR-0017 §1 — CLIENTE DE UN CANAL SIN PERMISO. Extiende el Mock a propósito y no lo reemplaza:
 * hacia afuera tiene que seguir pareciendo lo que ES —un transporte que NO llega a Meta, con la
 * misma `resolution` inspeccionable— para que la saga de cotización lo siga rechazando por
 * `transportInfo.transport === 'mock'` sin conocer este tipo. Lo único que cambia es lo que
 * devuelve al enviar: `blocked`, nunca `ok`. La burbuja en el historial y el "listo" del panel se
 * decidían con ese booleano.
 */
export class BlockedChannelClient extends MockWhatsAppClient {
  constructor(
    resolution: MockResolution,
    private readonly motivo: MotivoCanalBloqueado,
  ) {
    super(resolution);
  }

  /**
   * UN BLOQUEO TAMBIÉN DEJA RASTRO. La primera versión de esta clase devolvía `blocked` y no
   * escribía nada, así que un no-envío por permiso o por canal inexistente quedaba EXACTAMENTE
   * igual que un flujo que ni siquiera intentó enviar: cero traza, cero log en el punto del envío.
   * Son dos defectos opuestos —«habló el número equivocado» y «no contestó nadie»— y sin este
   * registro no hay forma de distinguirlos, ni en un test ni frente a un cliente que reclama.
   *
   * `blocked: true` y `viaMock: false` son deliberados: un mock es un envío SIMULADO que el tenant
   * eligió, un bloqueo es un mensaje que el negocio quiso mandar y el sistema impidió. Que la traza
   * los mezclara volvería a contar la misma mentira que `ok:true` contaba en el resultado.
   */
  private async trazaDeBloqueo(to: string, ctx?: SendContext, kind?: string): Promise<void> {
    logger.warn('WhatsApp: mensaje NO enviado — canal bloqueado (ADR-0017)', {
      tenantId: ctx?.tenantId,
      channel: ctx?.channel,
      to: maskPhone(to),
      ...(kind ? { kind } : {}),
      mode: this.resolution?.mode,
      reason: this.resolution?.reason,
      blockedReason: this.motivo,
    });
    await this.escribirTraza(ctx, {
      to,
      ...(kind ? { kind } : {}),
      channel: ctx?.channel ?? null,
      phoneNumberId: this.resolution?.phoneNumberId ?? null,
      mode: this.resolution?.mode ?? null,
      tokenPresent: !!this.resolution?.tokenPresent,
      // El motivo DIAGNÓSTICO (por qué el canal no sirve); `blockedReason` es el motivo SANEADO
      // del bloqueo. Los dos, porque responden preguntas distintas.
      reason: this.resolution?.reason ?? null,
      blockedReason: this.motivo,
      viaMock: false,
      blocked: true,
    });
  }

  override async sendText(to: string, _text: string, ctx?: SendContext): Promise<SendResult> {
    await this.trazaDeBloqueo(to, ctx);
    return { ok: false, outcome: 'blocked', reason: this.motivo };
  }

  /** ADR-0021 §5: un canal sin permiso tampoco manda media — mismo `blocked` que sendText. */
  override async sendImage(to: string, _media: OutboundImageMedia, ctx?: SendContext): Promise<SendResult> {
    await this.trazaDeBloqueo(to, ctx, 'image');
    return { ok: false, outcome: 'blocked', reason: this.motivo };
  }

  override async sendDocument(to: string, _media: OutboundDocumentMedia, ctx?: SendContext): Promise<SendResult> {
    await this.trazaDeBloqueo(to, ctx, 'document');
    return { ok: false, outcome: 'blocked', reason: this.motivo };
  }

  override async sendLocationRequest(to: string, _bodyText: string, ctx?: SendContext): Promise<LocationRequestResult> {
    await this.trazaDeBloqueo(to, ctx, 'location_request');
    return { ok: false, reason: 'channel_blocked' };
  }
}

/** Dependencias inyectables (para tests sin Firestore). */
export interface WhatsappClientDeps {
  getMode: (tenantId?: string) => Promise<WhatsappSendMode>;
  resolveCreds: (tenantId?: string, phoneNumberId?: string | null) => Promise<WhatsappCredsResult>;
  /**
   * Permiso de automatización del canal RESUELTO (ADR-0017 §1). Opcional para no romper a quien ya
   * construye deps: si falta, se usa el lector real —que es el MISMO que usa el gate del inbound,
   * porque dos lecturas del mismo flag terminan divergiendo y la laxa es la que enciende—.
   */
  resolveAutomation?: (tenantId: string, phoneNumberId: string) => Promise<WhatsappAutomationMode>;
}

const defaultDeps: WhatsappClientDeps = {
  getMode: async (t) => (t ? (await getChannelConfig(t)).whatsappSendMode : 'mock'),
  /**
   * ADR-0017 — CUANDO SE PIDE UN NÚMERO, NO HAY SUSTITUTO.
   *
   * Esto caía al número PRINCIPAL del tenant cuando el PNID pedido no resolvía. Nació como una
   * comodidad de MULTI-NUMBER-1 («el número se desactivó con mensajes en vuelo») y con Coexistence
   * es el peor desenlace posible: un número adicional que todavía no está `active` —el estado
   * NORMAL de un número recién incorporado, y el que va a tener el número real el día del
   * onboarding— hacía que la respuesta saliera por el número que está vendiendo, a un cliente que
   * le escribió al OTRO número. El cliente ve una respuesta desde un teléfono que no conoce y el
   * vendedor no se entera de nada.
   *
   * Sin PNID pedido (conversación vieja mono-número) se sigue resolviendo el principal: ahí no hay
   * destino que traicionar.
   */
  resolveCreds: async (t, pnid) => {
    if (t && pnid) {
      const specific = await resolveTenantWhatsappCredsFor(t, pnid);
      if (specific.ok) return specific;
      logger.warn('WhatsApp: el número receptor pedido no resuelve; NO se sustituye por el principal', {
        tenantId: t,
        phoneNumberId: maskPhone(pnid),
        reason: specific.reason,
      });
      // `cause` conserva el diagnóstico que el motivo colapsa: qué hacer y por qué son dos cosas.
      return { ok: false, reason: 'channel_unavailable', cause: specific.reason };
    }
    return resolveTenantWhatsappCreds(t);
  },
  resolveAutomation: async (t, pnid) => (await resolveAutomationMode(t, pnid)).mode,
};

/**
 * Aplica el gate sobre el canal por el que el mensaje SALDRÍA de verdad (el resuelto), no sobre el
 * que se pidió: el fallback puede haber cambiado el destino sin que el llamador se entere.
 */
async function permisoDeCanal(
  tenantId: string,
  requestedPhoneNumberId: string | null | undefined,
  creds: Extract<WhatsappCredsResult, { ok: true }>,
  deps: WhatsappClientDeps,
  origen: OrigenEnvio,
): Promise<OutboundChannelDecision> {
  const leer = deps.resolveAutomation ?? defaultDeps.resolveAutomation!;
  const mode = await leer(tenantId, creds.phoneNumberId);
  const decision = decideOutboundChannel({
    requestedPhoneNumberId,
    resolvedPhoneNumberId: creds.phoneNumberId,
    mode,
    origen,
  });
  if (!decision.allow) {
    logger.warn('WhatsApp: envío BLOQUEADO por el permiso del canal (ADR-0017)', {
      tenantId,
      phoneNumberId: maskPhone(creds.phoneNumberId),
      canal: decision.canal,
      origen: decision.origen,
      reason: decision.reason,
    });
  }
  return decision;
}

/**
 * Mock de un canal SIN permiso. Deliberadamente sin `tokenPresent`: la saga de cotización acepta un
 * mock en emulador solo cuando la resolución habría sido un envío live válido, y un canal bloqueado
 * no lo es. Marcarlo `tokenPresent: true` haría que una cotización se aprobara sobre un número que
 * tiene prohibido hablar.
 */
const mockCanalBloqueado = (mode: WhatsappSendMode, decision: Extract<OutboundChannelDecision, { allow: false }>, phoneNumberId: string) =>
  new BlockedChannelClient({ mode, phoneNumberId, reason: decision.reason }, decision.reason);

/**
 * El número PEDIDO no resuelve: no hay canal para ese destino y no existe sustituto legítimo.
 * Deliberadamente SIN `phoneNumberId`: no hay número resuelto, y poner el principal ahí sería
 * volver a insinuar en los logs y en la saga el mismo sustituto que este bloqueo existe para
 * impedir. La `causa` sí viaja: es lo único que después explica si hay que reconectar, renovar el
 * token o dar de alta el número.
 */
const mockCanalNoDisponible = (mode: WhatsappSendMode, causa?: WhatsappCredsReason) =>
  new BlockedChannelClient({ mode, reason: causa ?? 'channel_unavailable' }, 'channel_unavailable');

/** ¿La resolución falló porque el número PEDIDO no está disponible (vs. cualquier otro motivo)? */
const canalPedidoNoDisponible = (creds: WhatsappCredsResult): boolean => !creds.ok && creds.reason === 'channel_unavailable';

/** Diagnóstico conservado por `resolveCreds` cuando colapsa el motivo (null si no lo hay). */
const causaDelCanal = (creds: WhatsappCredsResult): WhatsappCredsReason | undefined => (creds.ok ? undefined : creds.cause);

/**
 * Resuelve el cliente de WhatsApp para un tenant (Fase 4A). USA el tenantId de verdad.
 * Si falta tenantId / no conectado / sin asset / token ausente o vencido / sendMode !=
 * 'live' → Mock con motivo claro. En emulador SIEMPRE Mock (nunca toca Graph).
 */
export async function getWhatsAppClient(
  tenantId?: string,
  deps: WhatsappClientDeps = defaultDeps,
  /** MULTI-NUMBER-1: responder por ESTE número (el que recibió el mensaje). */
  phoneNumberId?: string | null,
  /**
   * ADR-0017 §1: QUIÉN decide este envío. Ausente ⇒ `automatico` (vara estricta): el default no
   * puede ser el permiso ancho, porque el llamador que no se hizo la pregunta es justamente el
   * que no debería recibirlo.
   */
  origen: OrigenEnvio = 'automatico',
): Promise<WhatsAppClient> {
  const mode = await deps.getMode(tenantId);

  // Emulador: nunca llamamos a Graph. Resolvemos creds igual para testear aislamiento
  // (Mock inspeccionable con el phone_number_id resuelto — clave para multi-número).
  if (isEmulator()) {
    const creds = await deps.resolveCreds(tenantId, phoneNumberId);
    /**
     * SOLO EN `live`, igual que en producción. Abajo, el camino real corta en `mode !== 'live'`
     * ANTES de resolver credenciales: un tenant en modo `mock` —demo, staging, onboarding sin Meta—
     * jamás ve un bloqueo por canal, porque no hay nada que entregar y por lo tanto no hay número
     * equivocado por el que entregarlo. Sin esta condición el emulador era MÁS estricto que
     * producción justo en el caso más común de las pruebas: una conexión sin token dejaba al bot
     * mudo y sin burbuja, un desenlace que en producción no ocurre nunca.
     *
     * Es el mismo criterio que defiende al gate de permiso de abajo, aplicado en las dos
     * direcciones: el emulador tiene que comportarse como producción, ni más laxo ni más estricto.
     */
    if (mode === 'live' && canalPedidoNoDisponible(creds)) return mockCanalNoDisponible(mode, causaDelCanal(creds));
    // El gate corre TAMBIÉN en emulador: un permiso que se comporta distinto según el entorno es
    // un permiso que nadie probó de verdad.
    if (creds.ok && tenantId) {
      const permiso = await permisoDeCanal(tenantId, phoneNumberId, creds, deps, origen);
      if (!permiso.allow) return mockCanalBloqueado(mode, permiso, creds.phoneNumberId);
    }
    if (mode === 'live') {
      return creds.ok
        ? new MockWhatsAppClient({ mode, phoneNumberId: creds.phoneNumberId, tokenPresent: true })
        : new MockWhatsAppClient({ mode, reason: creds.reason });
    }
    return creds.ok
      ? new MockWhatsAppClient({ mode, phoneNumberId: creds.phoneNumberId, tokenPresent: true, reason: 'mode_mock' })
      : new MockWhatsAppClient({ mode, reason: 'mode_mock' });
  }

  // Producción: solo se envía real si el tenant está en modo 'live'.
  if (mode !== 'live') return new MockWhatsAppClient({ mode, reason: 'mode_mock' });

  const creds = await deps.resolveCreds(tenantId, phoneNumberId);
  // Antes del fallback global: si el destino PEDIDO no está disponible, mandar por credenciales
  // ajenas al tenant es la misma sustitución silenciosa, solo que peor (otro negocio).
  if (canalPedidoNoDisponible(creds)) return mockCanalNoDisponible(mode, causaDelCanal(creds));
  if (creds.ok && tenantId) {
    // ADR-0017 §1: el permiso se verifica ANTES de la caché de clientes. Cachear el veredicto junto
    // con el cliente dejaría hasta un minuto de envíos por un canal que ya perdió el permiso.
    const permiso = await permisoDeCanal(tenantId, phoneNumberId, creds, deps, origen);
    if (!permiso.allow) return mockCanalBloqueado(mode, permiso, creds.phoneNumberId);
    return cloudClientFor(tenantId, creds);
  }

  // Fallback global (DEPRECATED): solo si está habilitado explícitamente y hay env globales.
  // SHIPPING-CHAT-3B: marcado 'global_fallback' en transportInfo — es live pero con credenciales
  // AJENAS al tenant: la saga de cotización (3C) lo trata como channel_unavailable.
  if (globalFallbackAllowed()) {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (phoneNumberId && accessToken) {
      logger.warn('WhatsApp: usando credenciales GLOBALES (ALLOW_GLOBAL_WHATSAPP_FALLBACK, deprecated)', { tenantId });
      return new CloudAPIClient(phoneNumberId, accessToken, 'global_fallback');
    }
  }
  return new MockWhatsAppClient({ mode, reason: creds.ok ? 'no_tenant' : creds.reason });
}

/**
 * SHIPPING-CHAT-3C — Resolución ESTRICTA del número: el cliente se resuelve para el pnid EXACTO,
 * SIN fallback al número principal (una cotización financiera debe salir por el MISMO número que
 * recibió la conversación; si ese número no resuelve, el caller aborta con channel_unavailable).
 * Con pnid null (conversación vieja mono-número) se resuelve el principal del tenant.
 */
export async function getWhatsAppClientExact(
  tenantId: string,
  phoneNumberId: string | null,
  /** Igual que `getWhatsAppClient`: sin declarar, la vara estricta (ADR-0017 §1). */
  origen: OrigenEnvio = 'automatico',
): Promise<WhatsAppClient> {
  const strictDeps: WhatsappClientDeps = {
    ...defaultDeps, // hereda el gate de canal de ADR-0017; solo se endurece la resolución del número
    resolveCreds: async (t, pnid) => {
      if (!t || !pnid) return resolveTenantWhatsappCreds(t);
      const specific = await resolveTenantWhatsappCredsFor(t, pnid);
      // Mismo motivo que el camino por defecto: sin canal para el destino PEDIDO, tampoco puede
      // caer al fallback global (credenciales de OTRO negocio). Y mismo diagnóstico conservado.
      return specific.ok ? specific : { ok: false, reason: 'channel_unavailable', cause: specific.reason };
    },
  };
  return getWhatsAppClient(tenantId, strictDeps, phoneNumberId, origen);
}

/*
 * ============================== REGLAS NORMATIVAS DE SHIPPING-CHAT-3C ==============================
 * (diseño 3A-HARDEN aprobado — registradas acá porque la saga consume este módulo; implementadas
 * en `functions/coverage/coverageQuote.ts`):
 *  1. La recuperación de un outbox de cotización ya 'sent' se ejecuta ANTES de resolver el
 *     transporte (no re-resolver credenciales para un mensaje que ya salió).
 *  2. HTTP aceptado SIN wamid = 'unknown' (ya implementado en sendResultFromCloudResponse).
 *  3. En producción, la cotización financiera solo acepta transportInfo
 *     {transport:'live', credentials:'tenant'}; 'global_fallback' y 'mock' ⇒ channel_unavailable
 *     (jamás aprueban). En emulador se permite mock ÚNICAMENTE con una resolución que habría
 *     sido live válida (mode 'live' + tokenPresent).
 *  4. TX-A creará el outbox de cotización en 'prepared', NUNCA en 'sending' (el claim
 *     prepared→sending ocurre inmediatamente antes de Meta).
 * =====================================================================================================
 */
