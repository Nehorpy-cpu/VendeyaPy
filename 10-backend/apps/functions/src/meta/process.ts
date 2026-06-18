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
import { getWhatsAppClient } from '../messaging/whatsappClient.js';
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
    const payload = ev.payload as { from?: string; text?: string; adReferral?: { campaignId?: string; adId?: string } } | undefined;
    if (!tenantId || !payload?.from || !payload?.text) {
      await ref.update({ processingStatus: 'ignored', errorMessage: !tenantId ? 'empresa no resuelta' : 'payload sin from/text', processedAt: Timestamp.now() });
      return;
    }

    const platform = channelOf(ev.platform);
    const result = await handleMessage({ tenantId, from: payload.from, text: payload.text, channel: platform });

    // Entregar la respuesta del bot por el canal (Cloud API en prod; mock en emulador/demo).
    if (result.reply && result.reply.trim() && !result.handledByHuman) {
      try {
        const client = await getWhatsAppClient(tenantId);
        await client.sendText(payload.from, result.reply, { tenantId, channel: platform });
      } catch (e) {
        logger.error('No se pudo entregar la respuesta del bot', e, { tenantId });
      }
    }

    // Atribución (D5): si el mensaje vino de un anuncio (referral de Meta), registrar la campaña.
    if (payload.adReferral?.campaignId) {
      const customerId = payload.from.replace(/[^0-9]/g, '');
      await db().doc(paths.customer(tenantId, customerId)).set(
        { attribution: { campaignId: payload.adReferral.campaignId, adId: payload.adReferral.adId ?? null, type: 'direct_meta', confidence: 1, platform }, updatedAt: Timestamp.now() },
        { merge: true },
      );
    }

    await ref.update({ processingStatus: 'processed', tenantId, processedAt: Timestamp.now() });
    logger.info('Webhook procesado', { eventId, tenantId, platform: ev.platform });
  } catch (e) {
    await ref.update({ processingStatus: 'failed', errorMessage: String(e), processedAt: Timestamp.now() });
    logger.error('Error procesando webhook', e, { eventId });
  }
}
