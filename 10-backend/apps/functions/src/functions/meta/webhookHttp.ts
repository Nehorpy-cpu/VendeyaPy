/**
 * metaWebhook / devSimulateInbound — Entrada de mensajes de Meta (D2)
 * ==================================================================
 * metaWebhook: GET = handshake de verificación de Meta (ex-F1). POST = guarda el
 * evento crudo en la bandeja (metaWebhookInbox) y responde rápido; el trigger lo
 * procesa después (ADR-0009).
 * devSimulateInbound: simula un mensaje entrante (para probar sin Meta real).
 */

import { onRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { WebhookInboxEvent } from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { verifyMetaSignature } from '../../middleware/webhookSignature.js';
import { guardDevEndpoint } from '../../middleware/devGuard.js';
import { parseMetaWebhookPayload } from '../../meta/parseWebhook.js';

const TTL_MS = 30 * 86_400_000;
const isEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';
// Token del handshake de verificación (Meta). En prod: WHATSAPP_WEBHOOK_VERIFY_TOKEN.
const verifyToken = () => process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || (isEmulator() ? 'aiafg-verify-demo' : '');

// Id de inbox determinístico por (platform, messageId) para idempotencia. Sanitiza
// caracteres no válidos de Firestore (p.ej. '/' en wamid base64).
const inboxDocId = (platform: string, messageId: string): string =>
  messageId ? `${platform}_${messageId}`.replace(/[^\w.:=+-]/g, '_').slice(0, 256) : '';

function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: number | string } | null)?.code;
  return code === 6 || code === 'already-exists' || /already.?exists/i.test(String(e));
}

function inboxEvent(id: string, platform: string, externalId: string, payload: unknown): WebhookInboxEvent {
  const now = Timestamp.now();
  return {
    id, platform, objectType: 'message', eventType: 'messages', externalId, tenantId: null,
    processingStatus: 'received', payload, errorMessage: '', receivedAt: now, processedAt: null,
    expiresAt: Timestamp.fromMillis(now.toMillis() + TTL_MS),
  };
}

export const metaWebhook = onRequest({ region: 'us-central1', cors: false }, async (req, res) => {
  // 1) Verificación (handshake de Meta) — token por entorno, no hardcodeado.
  if (req.method === 'GET') {
    const expected = verifyToken();
    if (req.query['hub.mode'] === 'subscribe' && expected && req.query['hub.verify_token'] === expected) {
      res.status(200).send(String(req.query['hub.challenge'] ?? ''));
    } else {
      res.status(403).send('forbidden');
    }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false }); return; }

  // 2) Verificación de FIRMA (X-Hub-Signature-256): impide que cualquiera inyecte eventos.
  //    Fuera del emulador la firma es OBLIGATORIA (fail-closed). En el emulador se omite para
  //    poder probar el webhook real localmente (la demo usa devSimulateInbound).
  if (!isEmulator()) {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      logger.error('metaWebhook: falta WHATSAPP_APP_SECRET; se rechaza por seguridad');
      res.status(401).json({ ok: false, error: 'not configured' });
      return;
    }
    try {
      verifyMetaSignature(req.rawBody, req.get('x-hub-signature-256'), appSecret);
    } catch {
      logger.warn('metaWebhook: firma inválida, rechazado');
      res.status(401).json({ ok: false, error: 'invalid signature' });
      return;
    }
  }

  // 3) Parsear el payload REAL de Meta → un evento NORMALIZADO por mensaje, idempotente
  //    por messageId (.create() falla si ya existe → duplicado). El trigger onWebhookInbox
  //    los procesa después. El shape del payload (from/text/adReferral) se mantiene para process.ts.
  try {
    const parsed = parseMetaWebhookPayload(req.body);
    let written = 0;
    let duplicates = 0;
    for (const m of parsed.messages) {
      const payload = {
        from: m.from,
        text: m.text,
        messageId: m.messageId,
        timestamp: m.timestamp,
        ...(m.adReferral ? { adReferral: m.adReferral } : {}),
        rawMessage: m.rawMessage, // mínimo para auditoría/debug; sin tokens ni secretos
      };
      const id = inboxDocId(m.platform, m.messageId);
      const ref = id ? db().collection(paths.metaWebhookInbox()).doc(id) : db().collection(paths.metaWebhookInbox()).doc();
      try {
        await ref.create(inboxEvent(ref.id, m.platform, m.externalId, payload));
        written++;
      } catch (e) {
        if (isAlreadyExists(e)) {
          duplicates++;
          logger.info('metaWebhook: mensaje duplicado (mismo messageId), ignorado', { platform: m.platform, messageId: m.messageId });
        } else {
          // NO esconder otros errores como duplicados.
          logger.error('metaWebhook: no se pudo escribir el evento del inbox', e, { platform: m.platform, messageId: m.messageId });
        }
      }
    }
    logger.info('metaWebhook recibido', { written, duplicates, ignored: parsed.ignored });
    res.status(200).json({ ok: true, written, duplicates, ignored: parsed.ignored });
  } catch (e) {
    logger.error('Error en metaWebhook', e);
    res.status(200).json({ ok: false }); // 200 igual: evita reintentos en loop de Meta
  }
});

export const devSimulateInbound = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (!guardDevEndpoint(req, res)) return;
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Usá POST' }); return; }
  const b = (req.body ?? {}) as { platform?: string; externalId?: string; from?: string; text?: string; adReferral?: unknown };
  try {
    const ref = db().collection(paths.metaWebhookInbox()).doc();
    const payload = { from: b.from, text: b.text, ...(b.adReferral ? { adReferral: b.adReferral } : {}) };
    await ref.set(inboxEvent(ref.id, b.platform ?? 'whatsapp', b.externalId ?? 'wa-595', payload));
    res.json({ ok: true, eventId: ref.id });
  } catch (e) {
    logger.error('Error en devSimulateInbound', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});
