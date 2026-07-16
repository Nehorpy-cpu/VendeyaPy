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
import { procesarUbicacionEntrante } from '../conversation/coverage.js';
import { processComprobanteImage } from '../orders/comprobanteImage.js';
import { getWhatsAppClient } from '../messaging/whatsappClient.js';
import { checkTenantInboundGate, incrementMessageUsage } from '../tenants/lifecycle.js';
import { resolveEntitlements } from '../entitlements/entitlements.js';
import { isFeatureEnabled } from '../entitlements/decide.js';
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
    const payload = ev.payload as
      | { from?: string; text?: string; adReferral?: { campaignId?: string; adId?: string }; messageId?: string; image?: { mediaId?: string; mimeType?: string | null; caption?: string | null }; location?: { latitude?: number; longitude?: number; name?: string | null; address?: string | null; contextMessageId?: string | null } }
      | undefined;
    const esImagen = !!payload?.image?.mediaId && ev.platform === 'whatsapp';
    // COVERAGE-1B: ubicación nativa (solo WhatsApp; el parser ya validó rangos/strings).
    const esUbicacion = ev.platform === 'whatsapp' && typeof payload?.location?.latitude === 'number' && typeof payload?.location?.longitude === 'number';
    if (!tenantId || !payload?.from || (!payload?.text && !esImagen && !esUbicacion)) {
      // PRIVACIDAD: la ubicación exacta jamás queda retenida en el inbox, ni en los ignorados.
      await ref.update({ processingStatus: 'ignored', errorMessage: !tenantId ? 'empresa no resuelta' : 'payload sin from/text', processedAt: Timestamp.now(), ...(esUbicacion ? { 'payload.location': null } : {}) });
      return;
    }

    // Gate de empresa (Fase 4): suspendida o sobre el límite de mensajes → no procesar.
    const gate = await checkTenantInboundGate(tenantId);
    if (!gate.allowed) {
      await ref.update({ processingStatus: 'ignored', tenantId, errorMessage: `empresa ${gate.reason}`, processedAt: Timestamp.now(), ...(esUbicacion ? { 'payload.location': null } : {}) });
      logger.info('Inbound bloqueado por gate de empresa', { tenantId, reason: gate.reason });
      return;
    }

    const platform = channelOf(ev.platform);

    // MULTI-NUMBER-1: en WhatsApp, ev.externalId ES el phone_number_id del número del negocio
    // que recibió el mensaje → se persiste en la conversación y la respuesta sale por ese número.
    const receivedBy = ev.platform === 'whatsapp' ? ev.externalId : null;

    // COVERAGE-1B: ubicación nativa → camino propio (JAMÁS pasa por el bot/IA). El handler
    // persiste solo el placeholder en el historial; las coordenadas van al coverageRequest.
    // Al terminar se ANULA payload.location del inbox (la ubicación exacta no queda acá).
    if (esUbicacion) {
      const resultado = await procesarUbicacionEntrante({
        tenantId,
        from: payload.from,
        location: {
          latitude: payload.location!.latitude!,
          longitude: payload.location!.longitude!,
          name: payload.location!.name ?? null,
          address: payload.location!.address ?? null,
          contextMessageId: payload.location!.contextMessageId ?? null,
        },
        messageId: payload.messageId ?? ev.id,
        receivedByPhoneNumberId: receivedBy,
        channel: platform,
      });
      await incrementMessageUsage(tenantId).catch(() => { /* métrica de uso, no crítica */ });
      if (resultado.reply.trim()) {
        try {
          const client = await getWhatsAppClient(tenantId, undefined, receivedBy);
          await client.sendText(payload.from, resultado.reply, { tenantId, channel: platform });
        } catch (e) {
          logger.error('No se pudo entregar la respuesta de cobertura', e, { tenantId });
        }
      }
      await ref.update({ processingStatus: 'processed', tenantId, processedAt: Timestamp.now(), 'payload.location': null });
      logger.info('Webhook procesado (ubicación)', { eventId, tenantId });
      return;
    }

    // ORDER-1B: imagen entrante = posible COMPROBANTE de pago. Camino propio (no pasa por el
    // bot): asocia a la orden pendiente, Storage, PENDING_VERIFICATION + handoff. Nunca PAID.
    // La respuesta sale por el mismo cliente (mock la retiene; la recepción no depende del modo).
    if (esImagen) {
      const resultado = await processComprobanteImage({
        tenantId,
        customerId: payload.from.replace(/[^0-9]/g, ''),
        from: payload.from,
        messageId: payload.messageId ?? ev.id,
        image: { mediaId: payload.image!.mediaId!, mimeType: payload.image!.mimeType, caption: payload.image!.caption },
        receivedByPhoneNumberId: receivedBy,
      });
      await incrementMessageUsage(tenantId).catch(() => { /* métrica de uso, no crítica */ });
      if (resultado.reply.trim()) {
        try {
          const client = await getWhatsAppClient(tenantId, undefined, receivedBy);
          await client.sendText(payload.from, resultado.reply, { tenantId, channel: platform });
        } catch (e) {
          logger.error('No se pudo entregar la respuesta del comprobante', e, { tenantId });
        }
      }
      await ref.update({ processingStatus: 'processed', tenantId, processedAt: Timestamp.now() });
      logger.info('Webhook procesado (comprobante imagen)', { eventId, tenantId, attached: resultado.attachedOrderId != null });
      return;
    }

    // PLAN-LIMITS-3B: gate de multiChannel. WhatsApp NUNCA se gatea (incluido en todos los planes).
    // Los canales NO-WhatsApp (Instagram/Messenger) requieren la feature `multiChannel` del plan
    // efectivo (o un featureOverride del tenant). Chequeo NO-lanzante: NO usamos assertFeatureEnabled
    // porque lanza HttpsError y caería en el catch de abajo marcando el evento 'failed' (con
    // reintento/alerta); acá lo correcto es marcarlo 'ignored' (mismo patrón que el gate de empresa).
    if (platform !== 'whatsapp') {
      const ent = await resolveEntitlements(tenantId);
      if (!isFeatureEnabled(ent.features, 'multiChannel')) {
        await ref.update({ processingStatus: 'ignored', tenantId, errorMessage: 'canal no incluido en el plan (multiChannel)', processedAt: Timestamp.now() });
        logger.info('Inbound no-WhatsApp bloqueado por feature del plan', { tenantId, platform: ev.platform });
        return;
      }
    }

    // A esta altura no es imagen → el guard de arriba garantiza text presente.
    const result = await handleMessage({
      tenantId,
      from: payload.from,
      text: payload.text!,
      channel: platform,
      receivedByPhoneNumberId: receivedBy,
      // HANDOFF-2: el wamid viaja al motor para que el aviso de handoff sea idempotente
      // ante reintentos/duplicados del webhook.
      messageId: payload.messageId ?? ev.id,
    });
    await incrementMessageUsage(tenantId).catch(() => { /* métrica de uso, no crítica */ });

    // Entregar la respuesta por el MISMO número que recibió (multi-número); mock/live intactos.
    if (result.reply && result.reply.trim() && !result.handledByHuman) {
      try {
        const client = await getWhatsAppClient(tenantId, undefined, receivedBy);
        // COVERAGE-1B: si el turno pide ubicación, se intenta el botón nativo
        // (location_request_message). Si el canal no es WhatsApp o el interactivo falla,
        // FALLBACK TEXTUAL UNA SOLA VEZ (el mismo texto ya incluye la alternativa escrita).
        if (result.locationRequest && platform === 'whatsapp') {
          const lr = await client.sendLocationRequest(payload.from, result.reply, { tenantId, channel: platform });
          if (!lr.ok) {
            logger.info('Cobertura: location request falló, fallback textual', { tenantId, reason: lr.reason });
            await client.sendText(payload.from, result.reply, { tenantId, channel: platform });
          }
        } else {
          await client.sendText(payload.from, result.reply, { tenantId, channel: platform });
        }
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
    // PRIVACIDAD: si el evento traía ubicación, se anula también en 'failed' (los failed no se
    // reprocesan — sin esto las coordenadas quedarían retenidas en el inbox hasta el TTL).
    const teniaUbicacion = !!(ev.payload as { location?: unknown } | undefined)?.location;
    await ref.update({ processingStatus: 'failed', errorMessage: String(e), processedAt: Timestamp.now(), ...(teniaUbicacion ? { 'payload.location': null } : {}) });
    logger.error('Error procesando webhook', e, { eventId });
  }
}
