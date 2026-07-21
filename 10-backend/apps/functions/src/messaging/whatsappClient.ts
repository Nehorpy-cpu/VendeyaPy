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
 *     conexión Meta del tenant resuelve creds; en cualquier otro caso, Mock con motivo.
 * El token NUNCA se loguea ni se escribe en Firestore. Ver Fase 4A.
 */
import axios from 'axios';
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from '../lib/logger.js';
import { db } from '../lib/firebase.js';
import { maskPhone } from '@vpw/shared';
import type { MessageChannel, WhatsappSendMode } from '@vpw/shared';
import { getChannelConfig } from './channelConfig.js';
import { resolveTenantWhatsappCreds, resolveTenantWhatsappCredsFor, type WhatsappCredsResult } from './resolveWhatsappCreds.js';

/**
 * SHIPPING-CHAT-3B — Resultado DISCRIMINADO del envío (imposible de construir inconsistente).
 *  - 'accepted': la Cloud API ACEPTÓ el mensaje y devolvió un wamid (NO significa entregado
 *    al teléfono — solo aceptado por la API). 2xx SIN wamid ⇒ 'unknown'.
 *  - 'mock': no salió a Meta (emulador / modo mock / no-conectado); id determinístico.
 *  - 'rejected': rechazo CONFIRMADO (HTTP 4xx de Graph); `providerCode` numérico saneado o null.
 *  - 'unknown': 5xx, timeout, reset, sin respuesta o excepción ambigua — el mensaje PUDO salir.
 * Nada de regex sobre strings ni payload crudo de Meta en el resultado o los logs.
 */
export type SendResult =
  | { ok: true; outcome: 'accepted'; id: string; viaMock: false }
  | { ok: true; outcome: 'mock'; id: string; viaMock: true }
  | { ok: false; outcome: 'rejected'; providerCode: number | null }
  | { ok: false; outcome: 'unknown' };

/**
 * SHIPPING-CHAT-3B — Metadata NO sensible del transporte (jamás el token). La futura saga de
 * cotización (3C) la usa para distinguir: live con credenciales del PROPIO tenant (único caso
 * que podrá aprobar una cotización financiera en producción) · global fallback (live pero con
 * credenciales ajenas al tenant ⇒ NO apto para dinero) · mock (modo/credenciales no resueltas).
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
 */
export type LocationRequestResult =
  | { ok: true; id?: string; viaMock?: boolean }
  | { ok: false; reason: 'unsupported_channel' | 'send_error' };

export interface WhatsAppClient {
  /** SHIPPING-CHAT-3B: metadata no sensible del transporte (ver WhatsappTransportInfo). */
  readonly transportInfo: WhatsappTransportInfo;
  sendText(to: string, text: string, ctx?: SendContext): Promise<SendResult>;
  /** COVERAGE-1B: interactive `location_request_message` (botón nativo "Enviar ubicación"). */
  sendLocationRequest(to: string, bodyText: string, ctx?: SendContext): Promise<LocationRequestResult>;
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

/** SHIPPING-CHAT-3B — 2xx de la Cloud API SOLO es 'accepted' con wamid string no vacío. */
export function sendResultFromCloudResponse(id: unknown): SendResult {
  if (typeof id === 'string' && id.length > 0) return { ok: true, outcome: 'accepted', id, viaMock: false };
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
    // Traza de aislamiento SOLO en emulador (tests). Nunca en producción, nunca el token.
    if (isEmulator() && ctx?.tenantId) {
      try {
        await db().doc(`tenants/${ctx.tenantId}/_debug/lastWhatsappSend`).set({
          to,
          channel: ctx.channel ?? null,
          phoneNumberId: this.resolution?.phoneNumberId ?? null,
          mode: this.resolution?.mode ?? null,
          tokenPresent: !!this.resolution?.tokenPresent,
          reason: this.resolution?.reason ?? null,
          viaMock: true,
          at: Timestamp.now(),
        });
      } catch {
        /* la traza de debug nunca debe romper el envío */
      }
    }
    // COVERAGE-1D: id determinístico por (to, texto) — el outbox de mensajería lo persiste como
    // providerMessageId y una re-ejecución con el mismo contenido produce el mismo id (testeable).
    return { ok: true, outcome: 'mock', viaMock: true, id: `mock-${simpleHash(`${to}|${text}`)}` };
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
      to: `…${to.slice(-4)}`,
      chars: bodyText.length,
      mode: this.resolution?.mode,
      reason: this.resolution?.reason,
    });
    if (isEmulator() && ctx?.tenantId) {
      try {
        await db().doc(`tenants/${ctx.tenantId}/_debug/lastWhatsappSend`).set({
          to,
          kind: 'location_request',
          channel: ctx.channel ?? null,
          phoneNumberId: this.resolution?.phoneNumberId ?? null,
          mode: this.resolution?.mode ?? null,
          viaMock: true,
          at: Timestamp.now(),
        });
      } catch {
        /* la traza de debug nunca debe romper el envío */
      }
    }
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
      logger.error('WhatsApp Cloud API: error al enviar location request', e, { tenantId: ctx?.tenantId, to: `…${to.slice(-4)}` });
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

/** Dependencias inyectables (para tests sin Firestore). */
export interface WhatsappClientDeps {
  getMode: (tenantId?: string) => Promise<WhatsappSendMode>;
  resolveCreds: (tenantId?: string, phoneNumberId?: string | null) => Promise<WhatsappCredsResult>;
}

const defaultDeps: WhatsappClientDeps = {
  getMode: async (t) => (t ? (await getChannelConfig(t)).whatsappSendMode : 'mock'),
  // MULTI-NUMBER-1: con pnid se resuelve ESE número (responder por donde entró); si ese
  // número ya no está activo (desactivado con mensajes en vuelo), fallback al principal.
  resolveCreds: async (t, pnid) => {
    if (t && pnid) {
      const specific = await resolveTenantWhatsappCredsFor(t, pnid);
      if (specific.ok) return specific;
      logger.warn('WhatsApp: número receptor no resoluble; fallback al principal', { tenantId: t, phoneNumberId: pnid, reason: specific.reason });
    }
    return resolveTenantWhatsappCreds(t);
  },
};

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
): Promise<WhatsAppClient> {
  const mode = await deps.getMode(tenantId);

  // Emulador: nunca llamamos a Graph. Resolvemos creds igual para testear aislamiento
  // (Mock inspeccionable con el phone_number_id resuelto — clave para multi-número).
  if (isEmulator()) {
    const creds = await deps.resolveCreds(tenantId, phoneNumberId);
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
  if (creds.ok && tenantId) return cloudClientFor(tenantId, creds);

  // Fallback global (DEPRECATED): solo si está habilitado explícitamente y hay env globales.
  // SHIPPING-CHAT-3B: marcado 'global_fallback' en transportInfo — es live pero con credenciales
  // AJENAS al tenant: la futura saga de cotización (3C) lo tratará como channel_unavailable.
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

/*
 * ============================== REGLAS NORMATIVAS PARA SHIPPING-CHAT-3C ==============================
 * (diseño 3A-HARDEN aprobado — registradas acá porque la saga consumirá este módulo):
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
