/**
 * devMessage — Endpoint HTTP de PRUEBA para el bot (F4)
 * =====================================================
 * Simula un mensaje entrante sin necesidad de WhatsApp/Meta.
 *   POST { from: "+595981...", text: "hola", tenantId?: "perfumeria" }
 *   → { ok, reply, state }
 *
 * Cuando se conecte WhatsApp real (F1), el webhook llamará al mismo motor
 * (conversation/engine) y entregará la respuesta vía WhatsAppClient.
 * Este endpoint es solo para desarrollo/pruebas locales.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { handleMessage } from '../../conversation/engine.js';
import { logger } from '../../lib/logger.js';

export const devMessage = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Usá POST' });
      return;
    }
    const body = (req.body ?? {}) as { from?: string; text?: string; tenantId?: string };
    const tenantId = body.tenantId ?? 'perfumeria'; // default dev: tenant perfumería
    if (!body.from || !body.text) {
      res.status(400).json({ ok: false, error: 'Faltan campos: from, text' });
      return;
    }
    try {
      const result = await handleMessage({
        tenantId,
        from: String(body.from),
        text: String(body.text),
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      logger.error('Error en devMessage', e, { tenantId });
      res.status(500).json({ ok: false, error: 'internal' });
    }
  },
);
