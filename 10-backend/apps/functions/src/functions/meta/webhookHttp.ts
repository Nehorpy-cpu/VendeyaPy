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

const VERIFY_TOKEN = 'aiafg-verify-demo'; // en prod: por empresa/config
const TTL_MS = 30 * 86_400_000;

function inboxEvent(id: string, platform: string, externalId: string, payload: unknown): WebhookInboxEvent {
  const now = Timestamp.now();
  return {
    id, platform, objectType: 'message', eventType: 'messages', externalId, tenantId: null,
    processingStatus: 'received', payload, errorMessage: '', receivedAt: now, processedAt: null,
    expiresAt: Timestamp.fromMillis(now.toMillis() + TTL_MS),
  };
}

export const metaWebhook = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  // 1) Verificación (handshake de Meta).
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(String(challenge ?? ''));
    else res.status(403).send('forbidden');
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false }); return; }

  // 2) Recepción: guardar crudo + responder rápido (procesa el trigger onWebhookInbox).
  try {
    const body = (req.body ?? {}) as { platform?: string; externalId?: string; from?: string; text?: string };
    const ref = db().collection(paths.metaWebhookInbox()).doc();
    await ref.set(inboxEvent(ref.id, body.platform ?? 'whatsapp', body.externalId ?? '', body));
    res.status(200).json({ ok: true });
  } catch (e) {
    logger.error('Error en metaWebhook', e);
    res.status(200).json({ ok: false }); // 200 igual: evita reintentos en loop de Meta
  }
});

export const devSimulateInbound = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
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
