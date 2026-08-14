/**
 * ai/productVisionRuntime.ts — Cableado real del worker de visión (ADR-0019)
 * ===========================================================================
 * Separado del núcleo (productVision.ts, 100% testeable por DI) para que los tests no arrastren
 * los grafos de imports de catálogo/mensajería/Storage. Acá viven las dependencias REALES:
 * flag fail-closed, adjunto, sesión, reserva de cuota, bytes del Storage privado, extracción,
 * búsqueda con los guards vigentes, envío por el mismo camino que el resto del bot y proyección
 * del estado al doc del adjunto para el chip del panel.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { buildAttachmentDocPath, type MessageChannel } from '@vpw/shared';
import { db, paths, storage } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { reservarTurnoDeIa, estimacionDeTokens } from '../entitlements/aiReservation.js';
import { searchCatalog } from '../catalog/search.js';
import { splitByQueryMatch } from '../catalog/match.js';
import { getWhatsAppClient } from '../messaging/whatsappClient.js';
import { appendMessage } from '../conversation/messages.js';
import { evaluarSilencioPreEnvio, EXIGE_SILENCIO_LIBRE } from '../conversation/silencio.js';
import { runVisionExtraction } from './gateway.js';
import {
  procesarVisionJob,
  type AdjuntoParaVision,
  type ProcesarResultado,
  type VisionJobDeps,
} from './productVision.js';

/** Flag tenant-scoped, FAIL-CLOSED, apagado por defecto. Vive en su módulo HOJA
 *  (productVisionFlag.ts) para que el productor no arrastre este runtime; se re-exporta acá
 *  por compatibilidad con los consumidores existentes. */
export { productVisionActiva } from './productVisionFlag.js';
import { productVisionActiva } from './productVisionFlag.js';

const MAX_VISION_BYTES = 10 * 1024 * 1024; // el mismo techo duro de la ingesta

function depsReales(receivedVia: string | null): VisionJobDeps {
  return {
    flagActivo: productVisionActiva,
    leerAdjunto: async (tenantId, attachmentId) =>
      ((await db().doc(buildAttachmentDocPath(tenantId, attachmentId)).get()).data() as AdjuntoParaVision | undefined) ?? null,
    sesionEnTakeover: async (tenantId, customerId, sessionKey) => {
      const ses = (await db().doc(paths.session(tenantId, customerId, sessionKey)).get()).data() as { context?: { humanTakeover?: unknown } } | undefined;
      return ses?.context?.humanTakeover === true;
    },
    reservar: (tenantId, clave) =>
      reservarTurnoDeIa(tenantId, clave, estimacionDeTokens('imagen_vision'), { context: 'product_vision' }),
    leerBytes: async (adjunto) => {
      const path = adjunto.storage?.path;
      if (!path) throw new Error('sin path');
      if ((adjunto.bytes ?? 0) > MAX_VISION_BYTES) throw new Error('excede el techo');
      const [buf] = await storage().bucket().file(path).download();
      return buf;
    },
    extraer: (input) => runVisionExtraction(input),
    buscar: async (tenantId, consulta) => {
      // Review ALTO 2: searchCatalog RELLENA con sugerencias (featured/isNew) cuando nada
      // matchea — correcto para el sales agent, letal para visión (presentaría cualquier
      // producto como "identificación"). Acá solo cuentan los MATCHES reales de la consulta.
      const productos = await searchCatalog(tenantId, { query: consulta, limit: 4 });
      const { pinned } = splitByQueryMatch(consulta, productos);
      return pinned.map((p) => ({ id: p.id, name: p.name, price: p.price }));
    },
    enviar: async (texto, ctx) => {
      // El MISMO camino de salida del resto del bot (coverageResume): cliente por tenant y
      // número receptor, y la burbuja persistida con appendMessage. Una falla acá se reporta
      // como no-enviado y el job queda `envio_incierto` — jamás un reintento a ciegas.
      const canal = (['whatsapp', 'instagram', 'messenger'].includes(ctx.channel) ? ctx.channel : 'whatsapp') as MessageChannel;
      const client = await getWhatsAppClient(ctx.tenantId, undefined, receivedVia ?? undefined, 'automatico');
      // Review ALTO 1: el chequeo AUTORITATIVO de silencio como ÚLTIMA operación antes del POST
      // (regla canónica de silencio.ts: humanTakeover || !botEnabled). Un vendedor que tomó el
      // chat durante la extracción — o el bot apagado desde el panel — callan la visión acá.
      const veredicto = await evaluarSilencioPreEnvio(ctx.tenantId, ctx.customerId, EXIGE_SILENCIO_LIBRE, ctx.sessionKey);
      if (veredicto === 'silenciado') return { enviado: false, silenciado: true };
      const r = await client.sendText(ctx.customerId, texto, { tenantId: ctx.tenantId, channel: canal });
      if (!r?.ok) return { enviado: false };
      try {
        await appendMessage(ctx.tenantId, ctx.customerId, {
          direction: 'out', author: 'bot', text: texto, channel: canal, receivedVia: receivedVia ?? undefined,
        });
      } catch {
        logger.warn('productVision: burbuja no persistida (el mensaje sí salió)', { tenantId: ctx.tenantId });
      }
      return { enviado: true };
    },
    proyectarEnAdjunto: async (tenantId, attachmentId, vision) => {
      await db().doc(buildAttachmentDocPath(tenantId, attachmentId)).set(
        { vision: { ...vision, at: Timestamp.now() }, updatedAt: Timestamp.now() },
        { merge: true },
      );
    },
    now: () => Date.now(),
  };
}

/** Entrada del trigger y del barrido: procesa un job con las dependencias reales. */
export async function ejecutarVisionJob(tenantId: string, jobId: string, receivedVia: string | null): Promise<{ resultado: ProcesarResultado }> {
  return procesarVisionJob(tenantId, jobId, depsReales(receivedVia));
}
