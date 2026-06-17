/**
 * meta/process.ts — Procesa un evento de la bandeja de webhooks (D2)
 * =================================================================
 * Resuelve a qué empresa pertenece (vía metaExternalIndex), extrae el mensaje y
 * lo entrega al MISMO motor del bot (channel-agnostic). Marca el evento procesado.
 * Ver ADR-0009.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { WebhookInboxEvent, MetaExternalIndexEntry, MessageChannel } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { handleMessage } from '../conversation/engine.js';
import { logger } from '../lib/logger.js';

const channelOf = (platform: string): MessageChannel =>
  platform === 'instagram' ? 'instagram' : platform === 'messenger' ? 'messenger' : 'whatsapp';

export async function processWebhookEvent(eventId: string): Promise<void> {
  const ref = db().doc(paths.metaWebhookEvent(eventId));
  const snap = await ref.get();
  if (!snap.exists) return;
  const ev = snap.data() as WebhookInboxEvent;
  if (ev.processingStatus !== 'received') return; // ya procesado / en proceso
  await ref.update({ processingStatus: 'processing' });

  try {
    // Resolver empresa por el índice global (platform_externalId).
    let tenantId = ev.tenantId;
    if (!tenantId) {
      const idx = await db().doc(paths.metaExternalIndexEntry(`${ev.platform}_${ev.externalId}`)).get();
      tenantId = (idx.data() as MetaExternalIndexEntry | undefined)?.tenantId ?? null;
    }
    const payload = ev.payload as { from?: string; text?: string } | undefined;
    if (!tenantId || !payload?.from || !payload?.text) {
      await ref.update({ processingStatus: 'ignored', errorMessage: !tenantId ? 'empresa no resuelta' : 'payload sin from/text', processedAt: Timestamp.now() });
      return;
    }

    await handleMessage({ tenantId, from: payload.from, text: payload.text, channel: channelOf(ev.platform) });
    await ref.update({ processingStatus: 'processed', tenantId, processedAt: Timestamp.now() });
    logger.info('Webhook procesado', { eventId, tenantId, platform: ev.platform });
  } catch (e) {
    await ref.update({ processingStatus: 'failed', errorMessage: String(e), processedAt: Timestamp.now() });
    logger.error('Error procesando webhook', e, { eventId });
  }
}
