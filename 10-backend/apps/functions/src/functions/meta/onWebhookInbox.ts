/**
 * onWebhookInbox — Trigger: procesa cada evento nuevo de la bandeja de webhooks (D2)
 * =================================================================================
 * Al crearse un doc en metaWebhookInbox, lo procesa en segundo plano: resuelve la
 * empresa y lo entrega al motor del bot. Ver ADR-0009.
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { processWebhookEvent } from '../../meta/process.js';
import { ANTHROPIC_API_KEY } from '../../ai/aiSecret.js';
import { logger } from '../../lib/logger.js';

// Es el camino REAL del bot de WhatsApp (inbound → handleMessage → sales agent IA): bindea el secret
// de Anthropic (least-privilege) para que getAiClient() lo lea en runtime.
export const onWebhookInbox = onDocumentCreated(
  { region: 'us-central1', document: 'metaWebhookInbox/{eventId}', secrets: [ANTHROPIC_API_KEY] },
  async (event) => {
    try {
      await processWebhookEvent(event.params.eventId);
    } catch (e) {
      logger.error('Error en onWebhookInbox', e, { eventId: event.params.eventId });
    }
  },
);
