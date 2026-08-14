/**
 * ai/visionProducer.ts — Productor de jobs de visión DESACOPLADO del webhook (ADR-0019 v2)
 * ========================================================================================
 * Antes el encolado vivía como hook dentro de meta/process.ts: liberar visión obligaba a
 * actualizar onWebhookInbox y eso arrastraba el gate de automatización de ADR-0017 (dos números
 * sin migrar quedarían mudos). Ahora el productor observa la TRANSICIÓN DURABLE del evento del
 * inbox a `processed` — que el código productivo VIEJO también escribe, con el `tenantId` SELLADO
 * y DESPUÉS de que el gate de comprobantes persistió la clasificación final — y encola releyendo
 * el doc del adjunto. Cero imports de process.ts ni del motor de conversación; el canal se deriva con la MISMA autoridad compartida (derivarSessionKey). Los eventos legacy con payload.image (ORDER-1B, conjunto hoy vacío) quedan explícitamente fuera.
 *
 * Reglas fail-closed:
 *  - SOLO clasificación `generic_media` produce job. `unclassified` = el gate NO decidió (lanzó,
 *    duplicate, download_failed) ⇒ sin job (precedencia del clasificador, review MEDIO 5).
 *  - Discriminador de reintento SIN timers: al marcar processed, process.ts anula
 *    `payload.attachment.mediaId` SOLO si el archivo quedó almacenado. mediaId null + query
 *    vacía ⇒ el doc existe pero aún no es visible ⇒ REINTENTAR (redelivery de Eventarc).
 *    mediaId presente ⇒ jamás se almacenó (rechazado/fallado/nivel A off) ⇒ cerrar sin job.
 *  - Idempotencia: el id del job ES el attachmentId determinístico — redeliveries y transiciones
 *    repetidas chocan en el create() y son no-op.
 */
import { logger } from '../lib/logger.js';
import { decideVisionElegibilidad, encolarVisionJob } from './productVision.js';

export interface EventoInbox {
  processingStatus?: string;
  platform?: string;
  kind?: string;
  tenantId?: string | null;
  externalId?: string | null;
  id?: string;
  payload?: {
    from?: string;
    messageId?: string;
    attachment?: { kind?: string; mediaId?: string | null } | null;
  } | null;
}

export interface AdjuntoDelMensaje {
  attachmentId: string;
  tenantId: string;
  customerId: string;
  ingestState: string;
  class: string;
  mime?: { verified?: string | null } | null;
  classification?: { value?: string | null } | null;
  storage?: { path?: string | null } | null;
  purgedAt?: unknown;
}

export interface VisionProducerDeps {
  flagActivo: (tenantId: string) => Promise<boolean>;
  hashMessageId: (tenantId: string, providerMessageId: string) => string;
  buscarAdjuntosPorMensaje: (tenantId: string, messageIdHash: string) => Promise<AdjuntoDelMensaje[]>;
  /** null ⇒ no se pudo resolver el canal de sesión ⇒ fail-closed sin job. */
  resolverSessionKey: (tenantId: string, platform: string, externalId: string | null) => Promise<string | null>;
  encolar: (p: {
    tenantId: string; customerId: string; attachmentId: string; messageId: string | null;
    sessionKey: string; channel: string; receivedVia?: string | null;
  }) => Promise<{ encolado: boolean }>;
}

export type ProducirResultado =
  | 'encolado' | 'ya_existia' | 'no_transicion' | 'sin_adjunto' | 'flag_apagado'
  | 'no_elegible' | 'sin_tenant' | 'reintentar';

/**
 * Núcleo puro-por-DI del productor. `before`/`after` son los datos del doc del inbox en la
 * transición observada. Lanza SOLO ante errores transitorios reales (el trigger relanza por
 * redelivery); todo desenlace de negocio es un retorno tipado.
 */
export async function producirVisionDesdeEvento(
  before: EventoInbox | undefined,
  after: EventoInbox | undefined,
  deps: VisionProducerDeps,
): Promise<{ resultado: ProducirResultado }> {
  // 1) SOLO la transición de ENTRADA a processed (redelivery con before ya processed = no-op).
  if (!after || after.processingStatus !== 'processed') return { resultado: 'no_transicion' };
  if (before?.processingStatus === 'processed') return { resultado: 'no_transicion' };

  // 2) SOLO mensajes de WhatsApp con adjunto de IMAGEN. `kind` ausente = evento del código
  //    productivo viejo ⇒ 'message'. Echo/unknown/texto/ubicación/documento: jamás visión.
  const kind = after.kind ?? 'message';
  if (kind !== 'message') return { resultado: 'sin_adjunto' };
  if (after.platform !== 'whatsapp') return { resultado: 'sin_adjunto' };
  const adjuntoCrudo = after.payload?.attachment;
  if (!adjuntoCrudo || adjuntoCrudo.kind !== 'image') return { resultado: 'sin_adjunto' };

  // 3) Tenant: SIEMPRE el sellado por el procesamiento en el doc (autoritativo, server-side).
  const tenantId = after.tenantId;
  if (!tenantId || typeof tenantId !== 'string') return { resultado: 'sin_tenant' };

  // 4) Flag fail-closed ANTES de cualquier otra lectura.
  if (!(await deps.flagActivo(tenantId))) return { resultado: 'flag_apagado' };

  // 5) El adjunto YA persistido, por su messageId determinístico (la misma regla que process.ts:
  //    providerMessageId = payload.messageId || id del evento).
  const providerMessageId = after.payload?.messageId || after.id || '';
  if (!providerMessageId) return { resultado: 'sin_adjunto' };
  const messageIdHash = deps.hashMessageId(tenantId, providerMessageId);
  const adjuntos = await deps.buscarAdjuntosPorMensaje(tenantId, messageIdHash);

  if (adjuntos.length === 0) {
    // Discriminador SIN timers: mediaId anulado ⇒ el archivo SÍ se almacenó ⇒ el doc existe y
    // esta lectura llegó temprano ⇒ reintentar. mediaId presente ⇒ nunca se almacenó ⇒ cerrar.
    return adjuntoCrudo.mediaId == null ? { resultado: 'reintentar' } : { resultado: 'sin_adjunto' };
  }

  // 6) Gates de ADR-0019 sobre la clasificación FINAL, con la regla ESTRICTA del productor:
  //    solo `generic_media` (el gate decidió y degradó a medio normal) produce job.
  let sessionKey: string | null = null;
  let encolados = 0;
  let yaExistia = 0;
  for (const adj of adjuntos) {
    if (adj.tenantId !== tenantId) continue; // jamás cruzar tenants, ni ante datos corruptos
    const cls = adj.classification?.value ?? 'unclassified';
    if (cls !== 'generic_media') continue;
    const eleg = decideVisionElegibilidad({
      flag: true,
      ingestState: adj.ingestState,
      clase: adj.class,
      mimeVerificado: adj.mime?.verified ?? null,
      duplicate: false,
      yaPropuestoComoPago: false,
      classification: cls,
      purgado: Boolean(adj.purgedAt) || !adj.storage?.path,
    });
    if (!eleg.elegible) continue;
    sessionKey ??= await deps.resolverSessionKey(tenantId, after.platform ?? 'whatsapp', after.externalId ?? null);
    if (!sessionKey) return { resultado: 'no_elegible' };
    const r = await deps.encolar({
      tenantId,
      customerId: adj.customerId,
      attachmentId: adj.attachmentId,
      messageId: messageIdHash,
      sessionKey,
      channel: after.platform ?? 'whatsapp',
      receivedVia: after.externalId ?? null,
    });
    if (r.encolado) encolados++;
    else yaExistia++;
  }

  if (encolados > 0) {
    logger.info('Visión: job(s) encolados desde la transición processed', { tenantId, encolados });
    return { resultado: 'encolado' };
  }
  if (yaExistia > 0) return { resultado: 'ya_existia' };
  return { resultado: 'no_elegible' };
}

export { encolarVisionJob };
