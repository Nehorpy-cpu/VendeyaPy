/**
 * messaging/whatsappClient.ts — Abstracción de envío de WhatsApp (Fase 3)
 * =======================================================================
 * El bot calcula la respuesta (engine) y la ENTREGA por este cliente. Adapters
 * intercambiables (ADR-0003):
 *   - MockWhatsAppClient: emulador / demo / tests — sólo loguea, NO llama a Meta.
 *   - CloudAPIClient: producción — POST a WhatsApp Cloud API (graph.facebook.com).
 * La selección es automática (getWhatsAppClient): si hay credenciales reales y NO es
 * emulador, usa Cloud API; si no, Mock. Así el flujo demo nunca llama a Meta.
 */
import axios from 'axios';
import { logger } from '../lib/logger.js';
import type { MessageChannel } from '@vpw/shared';

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

/** Mock: no envía nada a Meta. Para emulador, demo y tests. */
export class MockWhatsAppClient implements WhatsAppClient {
  async sendText(to: string, text: string, ctx?: SendContext): Promise<SendResult> {
    logger.info('WhatsApp (mock): respuesta NO enviada a Meta', {
      tenantId: ctx?.tenantId,
      channel: ctx?.channel,
      to,
      chars: text.length,
    });
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

const isEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';

/**
 * Resuelve el cliente de WhatsApp para un tenant.
 * Hoy lee credenciales de entorno (globales). El multi-tenant real (credenciales por
 * conexión Meta vía SecretStore) se enchufa acá SIN tocar a los que llaman. Sin
 * credenciales o en emulador → Mock (la demo nunca llama a Meta).
 */
export async function getWhatsAppClient(_tenantId?: string): Promise<WhatsAppClient> {
  if (isEmulator()) return new MockWhatsAppClient();
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (phoneNumberId && accessToken) return new CloudAPIClient(phoneNumberId, accessToken);
  return new MockWhatsAppClient();
}
