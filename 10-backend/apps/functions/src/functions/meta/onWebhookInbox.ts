/**
 * onWebhookInbox — Trigger: procesa cada evento nuevo de la bandeja de webhooks (D2)
 * =================================================================================
 * Al crearse un doc en metaWebhookInbox, lo procesa en segundo plano: resuelve la
 * empresa y lo entrega al motor del bot. Ver ADR-0009.
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { processWebhookEvent } from '../../meta/process.js';
import { logger } from '../../lib/logger.js';

export const onWebhookInbox = onDocumentCreated(
  { region: 'us-central1', document: 'metaWebhookInbox/{eventId}' },
  async (event) => {
    try {
      await processWebhookEvent(event.params.eventId);
    } catch (e) {
      logger.error('Error en onWebhookInbox', e, { eventId: event.params.eventId });
    }
  },
);
