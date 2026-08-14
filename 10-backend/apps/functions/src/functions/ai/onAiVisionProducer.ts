/**
 * functions/ai/onAiVisionProducer.ts — Trigger del productor de visión (ADR-0019 v2)
 * ==================================================================================
 * Observa la transición durable `metaWebhookInbox: * → processed` (la escribe el process.ts
 * productivo VIEJO igual que el nuevo, con tenantId sellado y DESPUÉS del gate de comprobantes)
 * y encola el job de visión releyendo la clasificación final del adjunto. Responsabilidad única:
 * NO importa process.ts ni el motor de conversación, NO llama a la IA, NO descarga imágenes,
 * NO envía mensajes, NO necesita el secreto del proveedor. `retry: true` + el retorno
 * 'reintentar' del núcleo son el mecanismo de recuperación (redelivery de Eventarc) — sin timers.
 */
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { hashProviderMessageId, derivarSessionKey, sessionKeyDePlataforma, type DeclaracionDeCanal } from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { productVisionActiva } from '../../ai/productVisionFlag.js';
import { encolarVisionJob } from '../../ai/productVision.js';
import { producirVisionDesdeEvento, type EventoInbox, type AdjuntoDelMensaje, type VisionProducerDeps } from '../../ai/visionProducer.js';

const depsReales: VisionProducerDeps = {
  flagActivo: productVisionActiva,
  hashMessageId: hashProviderMessageId,
  buscarAdjuntosPorMensaje: async (tenantId, messageIdHash) => {
    const q = await db()
      .collection(`${paths.tenant(tenantId)}/attachments`)
      .where('messageId', '==', messageIdHash)
      .limit(5)
      .get();
    return q.docs.map((d) => d.data() as AdjuntoDelMensaje);
  },
  resolverSessionKey: async (tenantId, platform, externalId) => {
    // La MISMA autoridad de canal que el resto del sistema (review ALTO 1 + MEDIO 2): el asset
    // manda (`derivarSessionKey` de @vpw/shared — un segundo número del WABA de la conexión
    // `main` declara sessionKey wa_{pnid} aunque su índice diga connectionId main; y un índice
    // legacy SIN connectionId no mata la visión del número heredado). Sin importar process.ts.
    if (platform === 'instagram' || platform === 'messenger') return sessionKeyDePlataforma(platform);
    if (!externalId) return null;
    const [assetSnap, indiceSnap] = await Promise.all([
      db().doc(paths.metaAsset(tenantId, externalId)).get(),
      db().doc(paths.metaExternalIndexEntry(`whatsapp_${externalId}`)).get(),
    ]);
    const asset = (assetSnap.data() as DeclaracionDeCanal | undefined) ?? null;
    const indice = (indiceSnap.data() as DeclaracionDeCanal | undefined) ?? null;
    if (!asset && !indice) return null; // sin ninguna evidencia del canal ⇒ fail-closed
    return derivarSessionKey(externalId, asset, indice);
  },
  encolar: encolarVisionJob,
};

export const onAiVisionProducer = onDocumentUpdated(
  {
    document: 'metaWebhookInbox/{eventId}',
    region: 'us-central1',
    retry: true,
    // Solo lecturas + un create: no necesita el secreto de IA ni memoria/timeout grandes.
    timeoutSeconds: 60,
  },
  async (event) => {
    const before = event.data?.before?.data() as EventoInbox | undefined;
    const after = event.data?.after?.data() as EventoInbox | undefined;
    const r = await producirVisionDesdeEvento(before, after, depsReales);
    if (r.resultado === 'reintentar') {
      // El adjunto almacenado aún no es visible para la query: la redelivery lo reevalúa.
      throw new Error('vision producer: adjunto aun no visible');
    }
    if (r.resultado === 'encolado') logger.info('Visión: productor encoló', { eventId: event.params.eventId });
  },
);
