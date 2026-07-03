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
import type { MessageChannel, WhatsappSendMode } from '@vpw/shared';
import { getChannelConfig } from './channelConfig.js';
import { resolveTenantWhatsappCreds, resolveTenantWhatsappCredsFor, type WhatsappCredsResult } from './resolveWhatsappCreds.js';

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
  viaMock?: boolean;
}

export interface SendContext {
  tenantId?: string;
  channel?: MessageChannel;
}

export interface WhatsAppClient {
  sendText(to: string, text: string, ctx?: SendContext): Promise<SendResult>;
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

const isEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';

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

  async sendText(to: string, text: string, ctx?: SendContext): Promise<SendResult> {
    logger.info('WhatsApp (mock): respuesta NO enviada a Meta', {
      tenantId: ctx?.tenantId,
      channel: ctx?.channel,
      to,
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
    return { ok: true, viaMock: true };
  }
}

/** Cliente real de WhatsApp Cloud API. */
export class CloudAPIClient implements WhatsAppClient {
  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
  ) {}

  async sendText(to: string, text: string, ctx?: SendContext): Promise<SendResult> {
    try {
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/messages`;
      const res = await axios.post(url, buildCloudApiTextBody(to, text), {
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        timeout: 10_000,
      });
      const id = res.data?.messages?.[0]?.id as string | undefined;
      return { ok: true, id };
    } catch (e) {
      // No exponer el token. Loguear solo el cuerpo del error de Meta (códigos: 190 token,
      // 131047 ventana 24h, 131030 destinatario no permitido, 131056/80007 rate limit).
      const error = axios.isAxiosError(e)
        ? e.response?.data
          ? JSON.stringify(e.response.data)
          : e.message
        : String(e);
      logger.error('WhatsApp Cloud API: error al enviar', e, { tenantId: ctx?.tenantId, to });
      return { ok: false, error };
    }
  }
}

// ---- Caché de clientes Cloud por tenant: TTL corto y acotado a tokenExpiresAt ----
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
  const hit = clientCache.get(tenantId);
  if (hit && hit.expiresAtMs > now) return hit.client;
  const client = new CloudAPIClient(creds.phoneNumberId, creds.accessToken);
  const expiresAtMs = Math.min(now + CACHE_TTL_MS, creds.tokenExpiresAtMs ?? Number.POSITIVE_INFINITY);
  clientCache.set(tenantId, { client, expiresAtMs });
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
  if (globalFallbackAllowed()) {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (phoneNumberId && accessToken) {
      logger.warn('WhatsApp: usando credenciales GLOBALES (ALLOW_GLOBAL_WHATSAPP_FALLBACK, deprecated)', { tenantId });
      return new CloudAPIClient(phoneNumberId, accessToken);
    }
  }
  return new MockWhatsAppClient({ mode, reason: creds.ok ? 'no_tenant' : creds.reason });
}
