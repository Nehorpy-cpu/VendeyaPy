/**
 * meta/process.ts — Procesa un evento de la bandeja de webhooks (D2)
 * =================================================================
 * Resuelve a qué empresa pertenece (vía metaExternalIndex), extrae el mensaje y
 * lo entrega al MISMO motor del bot (channel-agnostic). Marca el evento procesado.
 * Ver ADR-0009.
 *
 * ADR-0016: un ARCHIVO ya no es un caso especial del camino de pago. Se ingesta siempre (existe
 * antes de significar algo), después opina el gate de clasificación y recién ahí —si hace falta—
 * se responde. Recibir un archivo NUNCA cambia por sí solo el estado de un pedido.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { WebhookInboxEvent, MetaExternalIndexEntry, MessageChannel } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { handleMessage } from '../conversation/engine.js';
import { botSilenciadoEnChat, evaluarSilencioPreEnvio, EXIGE_SILENCIO_LIBRE, type OutboundDiferido } from '../conversation/silencio.js';
import { appendMessage } from '../conversation/messages.js';
import { procesarUbicacionEntrante, coberturaVigente } from '../conversation/coverage.js';
import { coverageHold } from '../conversation/coverageTestHooks.js';
import { attachmentFromInboxPayload, unsupportedFromInboxPayload } from './parseWebhook.js';
import { ingestInboundAttachment, recordUnsupportedInbound, recordAttachmentIngestDisabled } from './attachmentIngest.js';
import { getAttachmentGate } from './attachmentGate.js';
import { getAttachmentIngestPolicy } from './attachmentLimits.js';
import { respuestaPorAdjunto, type AttachmentReplyClass, type AttachmentReplyReason } from './attachmentReplies.js';
import {
  getWhatsAppClient,
  type WhatsAppClient,
  type SendResult,
  type LocationRequestResult,
} from '../messaging/whatsappClient.js';
import { checkTenantInboundGate, incrementMessageUsage } from '../tenants/lifecycle.js';
import { resolveEntitlements } from '../entitlements/entitlements.js';
import { isFeatureEnabled } from '../entitlements/decide.js';
import { logger } from '../lib/logger.js';

const channelOf = (platform: string): MessageChannel =>
  platform === 'instagram' ? 'instagram' : platform === 'messenger' ? 'messenger' : 'whatsapp';

/**
 * Cuánto tiene que llevar un evento clavado en `processing` para que otra entrega lo RETOME.
 * Holgadamente mayor que el timeout de `onWebhookInbox` (180 s): si el evento sigue ahí pasado
 * ese lapso, la corrida que lo tomó ya está muerta y nadie más va a terminarlo.
 */
export const WEBHOOK_STUCK_MS = 5 * 60 * 1000;

/**
 * ¿Se puede tomar este evento? `received` es el caso normal. La otra puerta es el RESCATE:
 *
 * La entrega de Eventarc es at-least-once (por eso existe el guard de `processing` de siempre),
 * pero una corrida que muere a mitad —timeout de la función, instancia reciclada— dejaba el evento
 * en `processing` PARA SIEMPRE. Con adjuntos eso no es solo un turno perdido: el archivo del
 * cliente queda colgado en `downloading`, el mediaId de Meta vence y el binario se pierde. Ese es
 * exactamente el escenario que `INGEST_STUCK_MS` decía cubrir y que nunca podía atrapar, porque
 * ningún reintento volvía a entrar acá.
 *
 * El rescate se limita a los eventos CON ADJUNTO por una razón concreta, no por conveniencia: ese
 * camino tiene ancla de idempotencia en cada escritura (el `create()` del adjunto, el `docId`
 * determinístico de la burbuja, el corto-circuito por `duplicate`), así que re-entrar no duplica
 * nada. Un turno de TEXTO no la tiene —su burbuja se escribe con id aleatorio— y retomarlo
 * duplicaría el historial del cliente: ahí el silencio sigue siendo el mal menor.
 */
function puedeTomarseElEvento(ev: WebhookInboxEvent, nowMs: number): boolean {
  if (ev.processingStatus === 'received') return true;
  if (ev.processingStatus !== 'processing') return false;
  if (ev.platform !== 'whatsapp' || !attachmentFromInboxPayload(ev.payload)) return false;
  // Sin `processingStartedAt` (eventos anteriores a este cambio) manda `receivedAt`: el trigger
  // arranca a milisegundos de la creación, así que como piso de antigüedad alcanza y sobra.
  const desde = ev.processingStartedAt ?? ev.receivedAt;
  const desdeMs = (desde as { toMillis?: () => number } | null | undefined)?.toMillis?.() ?? 0;
  return nowMs - desdeMs >= WEBHOOK_STUCK_MS;
}

/**
 * SHIPPING-CHAT-3B: el resultado del transporte es TIPADO y acá NO se descarta — decide qué queda
 * en el historial:
 *  - `accepted` / `mock` ⇒ se registra, con el wamid real o la marca de mock.
 *  - `rejected` (4xx CONFIRMADO de Graph) ⇒ el cliente nunca lo vio: NO se registra. Es el mismo
 *    criterio del mensaje manual del vendedor: el historial no miente sobre lo que salió.
 *  - `unknown` (5xx / timeout / 2xx sin wamid) ⇒ el mensaje PUDO salir: SÍ se registra. Que el
 *    vendedor no vea algo que el cliente quizá leyó es peor que una burbuja de más.
 */
function desenlaceDelEnvio(r: SendResult | LocationRequestResult): {
  registrar: boolean;
  waMessageId: string | null;
  viaMock: boolean;
  outcome: string;
} {
  if (r.ok) {
    return {
      registrar: true,
      waMessageId: r.id ?? null,
      viaMock: r.viaMock === true,
      // El interactivo (location_request) no declara `outcome`: se deriva de su propia marca de
      // mock en vez de asumir 'accepted', que en los logs se leería como "salió a Meta".
      outcome: 'outcome' in r ? r.outcome : r.viaMock === true ? 'mock' : 'accepted',
    };
  }
  const outcome = 'outcome' in r ? r.outcome : r.reason;
  return { registrar: outcome !== 'rejected', waMessageId: null, viaMock: false, outcome };
}

interface EntregaAutomaticaArgs {
  tenantId: string;
  customerId: string;
  /** Destino del canal (teléfono tal como vino en el webhook). */
  to: string;
  texto: string;
  channel: MessageChannel;
  receivedVia: string | null;
  /** Ya resuelto por el caller: resolver credenciales acá reabriría la ventana del guard. */
  client: WhatsAppClient;
  /** COVERAGE-1B: intentar primero el botón nativo, con fallback textual UNA sola vez. */
  locationRequest?: boolean;
  /** Qué burbuja escribir si la respuesta efectivamente sale. null = no registrar. */
  outbound: OutboundDiferido | null;
  /**
   * KILL-SWITCH-1: gate propio del caller que también tiene que ser fresco al borde. Se pasa como
   * función —y no como booleano ya evaluado— justamente para que se evalúe ACÁ ADENTRO: si el
   * caller lo resolviera antes de llamar, las lecturas del guard de silencio quedarían en el medio
   * y la ventana del interruptor de emergencia se ensancharía. `false` ⇒ no se envía ni se
   * persiste, igual que el silencio.
   */
  gateFinal?: () => Promise<boolean>;
}

/**
 * ADR-0016 §12 — EL BORDE DE ENVÍO de toda respuesta automática. Cuatro reglas, en este orden:
 *
 *  1. El chequeo de silencio es AUTORITATIVO (relee sesión + config, no confía en lo que se leyó
 *     al empezar el turno) e INMEDIATAMENTE anterior al POST: el caller ya resolvió credenciales,
 *     así que entre el guard y el envío no queda ninguna E/S que reabra la ventana.
 *  2. KILL-SWITCH-1 conserva su lugar de ÚLTIMO gate. `gateFinal` se evalúa acá adentro, después
 *     del silencio y pegado al POST. Al principio este borde se metió ENTRE `coberturaVigente()`
 *     y el `sendText`, y sus dos lecturas ensancharon una ventana que era de cero E/S por diseño:
 *     un interruptor de emergencia de un flujo con plata pasaba a tener decenas de ms de retraso.
 *     Ningún test lo detectó —el hold del E2E dispara antes— así que queda dicho acá: los dos
 *     gates van seguidos, sin nada en el medio, y el de cobertura es el último.
 *  3. Una respuesta SUPRIMIDA no se persiste. Nada se escribe antes de enviar: un outbound en el
 *     historial que nunca salió le miente al vendedor sobre lo que el cliente vio.
 *  4. El registro se hace DESPUÉS, con el desenlace REAL del transporte (ver `desenlaceDelEnvio`).
 *
 * VENTANA FÍSICA QUE NINGÚN CÓDIGO PUEDE CERRAR: si el vendedor toma el chat después de que el
 * POST salió hacia Meta, el mensaje ya viajó. Se documenta en vez de fingir que no existe; lo
 * único que se garantiza es que a partir de ese instante no sale ninguna respuesta automática más.
 */
async function entregarRespuestaAutomatica(args: EntregaAutomaticaArgs): Promise<void> {
  const { tenantId, customerId, texto, channel, client } = args;
  // Hook SOLO-EMULADOR (no-op en producción, sin lecturas): pausa con la respuesta ya construida
  // y el cliente ya resuelto. Es la única forma de reproducir la carrera real —el vendedor toma
  // el chat justo en este punto— sin depender del timing.
  await coverageHold(tenantId, 'bot_reply_pre_send');
  if ((await evaluarSilencioPreEnvio(tenantId, customerId, args.outbound?.expectativa)) === 'silenciado') {
    logger.info('Respuesta automática SUPRIMIDA en el borde de envío (atención humana o bot apagado)', { tenantId });
    return; // ni se envía ni se persiste
  }
  // ÚLTIMA operación antes del POST (ver regla 2). No hay E/S entre esto y `sendText`.
  if (args.gateFinal && !(await args.gateFinal())) {
    logger.info('Respuesta automática NO enviada: el gate final del caller la frenó', { tenantId });
    return; // ni se envía ni se persiste
  }

  let res: SendResult | LocationRequestResult;
  try {
    if (args.locationRequest && channel === 'whatsapp') {
      const lr = await client.sendLocationRequest(args.to, texto, { tenantId, channel });
      if (lr.ok) {
        res = lr;
      } else {
        logger.info('Cobertura: location request falló, fallback textual', { tenantId, reason: lr.reason });
        res = await client.sendText(args.to, texto, { tenantId, channel });
      }
    } else {
      res = await client.sendText(args.to, texto, { tenantId, channel });
    }
  } catch (e) {
    // Excepción cruda del transporte: el POST PUDO haber salido ⇒ mismo criterio que 'unknown'.
    logger.error('Fallo crudo entregando la respuesta automática (pudo haber salido)', e, { tenantId });
    res = { ok: false, outcome: 'unknown' };
  }

  const desenlace = desenlaceDelEnvio(res);
  if (!desenlace.registrar) {
    logger.warn('WhatsApp RECHAZÓ la respuesta automática: no se registra en el chat', { tenantId, outcome: desenlace.outcome });
    return;
  }
  if (!res.ok) {
    logger.warn('Respuesta automática con envío DESCONOCIDO: se registra porque pudo haber salido', { tenantId, outcome: desenlace.outcome });
  }
  const out = args.outbound;
  if (!out) return;
  try {
    await appendMessage(tenantId, customerId, {
      direction: 'out',
      author: 'bot',
      text: texto,
      // `undefined` significa "no tocar" en el resumen del cliente: el acuse de un adjunto nunca
      // escribió `state` ni `humanTakeover` y no puede empezar a hacerlo por un default de tipos.
      ...(out.state === undefined ? {} : { state: out.state }),
      ...(out.humanTakeover === undefined ? {} : { humanTakeover: out.humanTakeover }),
      ...(out.countUnread === undefined ? {} : { countUnread: out.countUnread }),
      channel,
      receivedVia: args.receivedVia,
      waMessageId: desenlace.waMessageId,
      viaMock: desenlace.viaMock,
    });
  } catch (e) {
    logger.error('La respuesta salió pero no se pudo registrar en el chat', e, { tenantId });
  }
}

export async function processWebhookEvent(eventId: string): Promise<void> {
  const ref = db().doc(paths.metaWebhookEvent(eventId));
  const snap = await ref.get();
  if (!snap.exists) return;
  const ev = snap.data() as WebhookInboxEvent;
  const ahora = Timestamp.now();
  if (!puedeTomarseElEvento(ev, ahora.toMillis())) return; // ya procesado / en proceso
  if (ev.processingStatus === 'processing') {
    logger.warn('Webhook con adjunto clavado en processing: se retoma', { eventId, tenantId: ev.tenantId ?? undefined });
  }
  await ref.update({ processingStatus: 'processing', processingStartedAt: ahora });

  try {
    // Resolver empresa por el índice global (platform_externalId).
    let tenantId = ev.tenantId;
    if (!tenantId) {
      const idx = await db().doc(paths.metaExternalIndexEntry(`${ev.platform}_${ev.externalId}`)).get();
      tenantId = (idx.data() as MetaExternalIndexEntry | undefined)?.tenantId ?? null;
    }
    const payload = ev.payload as
      | { from?: string; text?: string; adReferral?: { campaignId?: string; adId?: string }; messageId?: string; location?: { latitude?: number; longitude?: number; name?: string | null; address?: string | null; contextMessageId?: string | null } }
      | undefined;
    // ADR-0016: adjunto GENÉRICO (imagen o PDF). El mapper acepta también la forma legacy
    // `payload.image` para no perder los eventos que quedaron en vuelo al desplegar.
    const adjunto = ev.platform === 'whatsapp' ? attachmentFromInboxPayload(ev.payload) : null;
    const noSoportado = ev.platform === 'whatsapp' ? unsupportedFromInboxPayload(ev.payload) : null;
    // COVERAGE-1B: ubicación nativa (solo WhatsApp; el parser ya validó rangos/strings).
    const esUbicacion = ev.platform === 'whatsapp' && typeof payload?.location?.latitude === 'number' && typeof payload?.location?.longitude === 'number';
    if (!tenantId || !payload?.from || (!payload?.text && !adjunto && !noSoportado && !esUbicacion)) {
      // PRIVACIDAD: la ubicación exacta jamás queda retenida en el inbox, ni en los ignorados.
      await ref.update({ processingStatus: 'ignored', errorMessage: !tenantId ? 'empresa no resuelta' : 'payload sin from/contenido', processedAt: Timestamp.now(), ...(esUbicacion ? { 'payload.location': null } : {}) });
      return;
    }

    // Identidad del cliente dentro del tenant (solo dígitos). Se deriva UNA vez: los dos caminos
    // que responden —ubicación nativa y bot/adjuntos— tienen que hablar del mismo `customerId`
    // que lee el guard de silencio, o el chequeo miraría otra conversación.
    const customerId = payload.from.replace(/[^0-9]/g, '');

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

    // `||` y NO `??`: el parser escribe cadena VACÍA cuando Meta no manda `id`. Con `??` el ''
    // no caía al fallback, `hashProviderMessageId('')` producía un id degenerado y el evento
    // entero terminaba en 'failed' — perdiendo el archivo, que es el bug que este programa mata.
    const providerMessageId = payload.messageId || ev.id;

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
        messageId: providerMessageId,
        receivedByPhoneNumberId: receivedBy,
        channel: platform,
        // ADR-0016 §12: la burbuja de SALIDA la escribe el borde de envío, no el handler.
        deferOutbound: true,
      });
      // OFF-INERTE (H1): con cobertura apagada la ubicación nativa es INERTE — comportamiento
      // heredado pre-Coverage: se IGNORA en silencio, SIN incrementMessageUsage ni reply. El inbox
      // solo conserva la redacción diseñada (payload.location=null; rawMessage ya redactado).
      if (resultado.inerte) {
        await ref.update({ processingStatus: 'ignored', tenantId, errorMessage: 'ubicación sin cobertura activa', processedAt: Timestamp.now(), 'payload.location': null });
        logger.info('Webhook ignorado (ubicación, cobertura off)', { eventId, tenantId });
        return;
      }
      await incrementMessageUsage(tenantId).catch(() => { /* métrica de uso, no crítica */ });
      if (resultado.reply.trim()) {
        try {
          // KILL-SWITCH-1: el cliente (resolución de credenciales) se construye ANTES de los
          // re-chequeos para que ninguna E/S quede entre el último guard y el POST (mismo patrón
          // que enviarPorOutbox). El re-chequeo de cobertura viaja como `gateFinal` para que lo
          // evalúe el borde: resolverlo acá lo dejaría por DETRÁS de las lecturas del guard de
          // silencio, que es exactamente la ventana que KILL-SWITCH-1 no puede tener.
          const client = await getWhatsAppClient(tenantId, undefined, receivedBy);
          await coverageHold(tenantId, 'reply_pre_send');
          await entregarRespuestaAutomatica({
            tenantId,
            customerId,
            to: payload.from,
            texto: resultado.reply,
            channel: platform,
            receivedVia: receivedBy,
            client,
            outbound: resultado.outbound ?? null,
            gateFinal: async () => {
              const vigente = await coberturaVigente(tenantId, resultado.coverageActivationId ?? null);
              if (!vigente) logger.info('Cobertura: respuesta de ubicación NO enviada (kill-switch antes del envío)', { tenantId });
              return vigente;
            },
          });
        } catch (e) {
          logger.error('No se pudo entregar la respuesta de cobertura', e, { tenantId });
        }
      }
      await ref.update({ processingStatus: 'processed', tenantId, processedAt: Timestamp.now(), 'payload.location': null });
      logger.info('Webhook procesado (ubicación)', { eventId, tenantId });
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

    // ADR-0016: ADJUNTOS. Acá estaba el `if (esImagen)` que mandaba TODA imagen al camino de
    // comprobante y salía con un return: una foto de producto congelaba el pedido en
    // PENDING_VERIFICATION y sacaba al bot del chat. Ahora el archivo se INGESTA SIEMPRE (existe
    // antes de significar nada) y recién después se consulta el gate, que es quien sabe si hay un
    // contexto de pago declarado. Sin ese contexto, el mensaje sigue su curso normal por el motor.
    /** Respuesta ESPECÍFICA sobre el archivo: la ingesta falló o el gate decidió decir algo. */
    let adjuntoReply = '';
    /** Acuse genérico. Es la red que impide el silencio; cede ante cualquier respuesta real. */
    let adjuntoAcuse = '';
    let adjuntoAlmacenado = false;
    /** Caption del archivo. DECIDE con las reglas, pero jamás se persiste ni llega al modelo. */
    let adjuntoCaption = '';
    /** NIVEL A del rollout apagado para este tenant ⇒ el archivo NO se toca (ADR-0016 §10). */
    let ingestaApagada = false;
    if (adjunto) {
      adjuntoCaption = adjunto.caption.trim();
      // ADR-0016 §10 — NIVEL A del rollout, fail-closed y por tenant. Una sola lectura trae el
      // interruptor y los límites, que viven en el mismo doc de config. Sin esto la fundación de
      // medios se encendía SOLA al desplegar: el primer webhook con imagen ya bajaba bytes de
      // Graph para todos los tenants a la vez. §8 sigue valiendo: el tope y los formatos son
      // configuración por tenant, no ramas en el código.
      const politica = await getAttachmentIngestPolicy(tenantId);
      if (!politica.enabled) {
        ingestaApagada = true;
        // El caption se DESCARTA acá mismo, no más abajo: sin ingesta no hay documento donde
        // persistirlo y, sobre todo, no puede abrir un turno del motor (que terminaría en el
        // modelo). §10 es taxativo: «sin caption a la IA, sin tocar pedidos, sin handoff».
        adjuntoCaption = '';
        // Cero Graph, cero Storage, cero documento de adjunto — pero el inbound queda VISIBLE y
        // el cliente recibe una respuesta honesta. No se restaura el camino legacy.
        const apagado = await recordAttachmentIngestDisabled({
          tenantId,
          customerId,
          channel: platform,
          providerMessageId,
          attachment: adjunto,
          receivedByPhoneNumberId: receivedBy,
        });
        adjuntoReply = apagado.reply;
      } else {
        const ingesta = await ingestInboundAttachment({
          tenantId,
          customerId,
          channel: platform,
          providerMessageId,
          attachment: adjunto,
          receivedByPhoneNumberId: receivedBy,
          limits: politica.limits,
        });
        adjuntoReply = ingesta.reply;
        adjuntoAlmacenado = ingesta.ingestState === 'stored';
        let motivo: AttachmentReplyReason | null = ingesta.reason;
        /** true ⇒ el gate ya le dio significado de PAGO al archivo (y ya se acusó recibo antes). */
        let yaPropuestoComoPago = false;
        // El gate corre SOLO sobre un archivo efectivamente almacenado y solo la primera vez (un
        // reintento no vuelve a proponer nada). Si falla, el adjunto YA está guardado y visible:
        // la conversación no se rompe por un problema de clasificación.
        if (!ingesta.duplicate && ingesta.attachment && ingesta.ingestState === 'stored') {
          try {
            const decision = await getAttachmentGate()({
              tenantId,
              customerId,
              channel: platform,
              attachment: ingesta.attachment,
              messageId: ingesta.messageId,
              receivedByPhoneNumberId: receivedBy,
            });
            if (decision.reply.trim()) adjuntoReply = decision.reply;
            else motivo = decision.reason ?? null;
            yaPropuestoComoPago =
              decision.classification === 'payment_receipt_candidate' ||
              decision.classification === 'payment_receipt_linked';
          } catch (e) {
            logger.error('Gate de adjunto falló (el archivo ya quedó guardado)', e, { tenantId, attachmentId: ingesta.attachmentId });
          }
        }
        // ADR-0016 §4: «un rechazo NUNCA bloquea la conversación: se responde al cliente y queda
        // rastro visible en el chat». Acá se cierra el agujero del SILENCIO TOTAL: el gate degradaba
        // a `generic_media` con reply '' y —como el caption ya no se promueve a texto— no corría
        // ningún bloque de envío. El cliente que mandaba el PDF del banco no recibía NADA y creía
        // que nadie lo había visto. Toda recepción de archivo produce una respuesta honesta; la
        // única excepción es la idempotencia: un reintento del webhook —o un archivo que el gate ya
        // había propuesto como pago y por eso no vuelve a hablar— no repite el acuse.
        if (!adjuntoReply.trim() && !ingesta.duplicate && !yaPropuestoComoPago) {
          const clase: AttachmentReplyClass = ingesta.attachment?.class ?? adjunto.kind;
          adjuntoAcuse = respuestaPorAdjunto(motivo, clase);
        }
      }
    } else if (noSoportado) {
      // Audio/video/sticker: no se descarga nada, pero deja mensaje visible (antes se perdían).
      const registro = await recordUnsupportedInbound({
        tenantId,
        customerId,
        channel: platform,
        providerMessageId,
        unsupported: noSoportado,
        receivedByPhoneNumberId: receivedBy,
      });
      adjuntoReply = registro.reply;
    }

    // El turno del motor: texto real si lo hay; si no, el CAPTION del archivo.
    //
    // Por qué el caption sí entra al motor: que el cliente mande una foto preguntando "¿cuánto
    // sale este?" no puede quedar sin respuesta — antes el bot contestaba y la primera versión de
    // ADR-0016 lo dejó mudo. Y por qué NO viola §9: con `attachmentCaption` el motor usa el texto
    // SOLO para las reglas determinísticas, no lo persiste como mensaje (la burbuja ya la creó la
    // ingesta, con el marcador del sistema) y NO delega en el modelo. El caption no aparece en el
    // prompt de este turno ni en el historial de los siguientes.
    //
    // PRECEDENCIA: si el archivo YA tiene algo específico que decir —la descarga falló, o el gate
    // lo propuso como comprobante— eso gana y el caption no abre un turno. Contestarle "recibí tu
    // comprobante, un vendedor lo revisa" es más importante que responder el pie de foto, y de
    // paso se sostiene la regla de un solo mensaje por turno.
    //
    // EVENTOS LEGACY EN VUELO: el parser actual deja `text: ''` aunque haya caption, así que un
    // evento que traiga adjunto Y texto solo puede venir de la forma vieja (ORDER-1B), donde el
    // caption SÍ se promovía a `text`. Tratarlo como texto libre lo mandaría derecho al modelo:
    // por eso la marca depende de que haya adjunto, no de dónde vino el texto.
    //
    // NIVEL A APAGADO: el archivo NUNCA abre turno del motor, ni por su caption ni por el `text`
    // de un evento legacy (donde el caption venía promovido). No alcanza con vaciar el caption:
    // esto es una garantía dura del §10 —«sin caption a la IA, sin tocar pedidos, sin handoff»—
    // y no puede depender de que la respuesta del camino apagado nunca quede vacía.
    const hayRespuestaDelArchivo = adjuntoReply.trim() !== '';
    const textoDelTurno = adjunto && (hayRespuestaDelArchivo || ingestaApagada) ? '' : payload.text || adjuntoCaption;
    const esTurnoDeCaption = !!adjunto && textoDelTurno !== '';
    const result = textoDelTurno
      ? await handleMessage({
          tenantId,
          from: payload.from,
          text: textoDelTurno,
          channel: platform,
          receivedByPhoneNumberId: receivedBy,
          // HANDOFF-2: el wamid viaja al motor para que el aviso de handoff sea idempotente
          // ante reintentos/duplicados del webhook.
          messageId: providerMessageId,
          ...(esTurnoDeCaption ? { attachmentCaption: true } : {}),
          // ADR-0016 §12: el motor NO persiste su burbuja de salida. La escribe el borde de
          // envío, después del chequeo autoritativo de silencio y con el desenlace real del POST.
          deferOutbound: true,
        })
      : null;
    await incrementMessageUsage(tenantId).catch(() => { /* métrica de uso, no crítica */ });

    // Respuesta del camino de adjuntos (rechazo, fallo de descarga o lo que decida el gate). Solo
    // se envía si el motor no produjo una respuesta propia: nunca dos mensajes por un turno.
    //
    // Y NUNCA rompe el silencio de HANDOFF-2. Acá alcanzaba con `!result?.handledByHuman`, que
    // MENTÍA en el caso más común: sin caption el motor no corre, `result` queda en `null` y la
    // condición daba SIEMPRE true. Resultado: el vendedor tomaba el chat (típicamente por
    // `payment_verification`), el cliente mandaba la foto del comprobante —sin pie, como se manda
    // un comprobante— y el bot contestaba encima igual. Si el motor corrió, su veredicto ya es la
    // verdad; si no corrió, se consulta el estado REAL, y solo cuando hay algo que decir (la
    // lectura extra no se paga en el camino feliz).
    //
    // Si la consulta del estado se cae, se elige CALLAR: hablarle encima a un vendedor rompe una
    // garantía y lo ve el cliente; perder un acuse por un turno es recuperable —el archivo ya está
    // en el chat con su burbuja— y no arrastra el evento entero a 'failed'.
    const respuestaDelArchivo = adjuntoReply.trim() ? adjuntoReply : adjuntoAcuse;
    const silenciado = result
      ? result.handledByHuman === true
      : respuestaDelArchivo.trim() === '' ||
        (await botSilenciadoEnChat(tenantId, customerId).catch((e) => {
          logger.error('No se pudo leer el estado de silencio del bot; no se responde el adjunto', e, { tenantId });
          return true;
        }));
    const puedeResponderElBot = respuestaDelArchivo.trim() !== '' && !result?.reply?.trim() && !silenciado;
    if (puedeResponderElBot) {
      // ADR-0016: "se responde al cliente y QUEDA RASTRO VISIBLE EN EL CHAT" — pero §12 fija el
      // orden: primero el guard autoritativo, después el POST y recién ahí la burbuja. El chequeo
      // de arriba (`silenciado`) queda como ATAJO barato —evita resolver credenciales cuando ya
      // se sabe que no hay nada que decir—; la AUTORIDAD es el guard del borde. Persistir antes,
      // como se hacía, dejaba en el chat un acuse que el vendedor lee como "ya le contestamos"
      // aunque el envío se hubiera suprimido o Meta lo hubiera rechazado.
      try {
        const client = await getWhatsAppClient(tenantId, undefined, receivedBy);
        await entregarRespuestaAutomatica({
          tenantId,
          customerId,
          to: payload.from,
          texto: respuestaDelArchivo,
          channel: platform,
          receivedVia: receivedBy,
          client,
          // Sin `state` ni `humanTakeover`: el acuse del adjunto nunca tocó el resumen del cliente.
          outbound: { expectativa: EXIGE_SILENCIO_LIBRE },
        });
      } catch (e) {
        logger.error('No se pudo entregar la respuesta del adjunto', e, { tenantId });
      }
    }

    // Entregar la respuesta por el MISMO número que recibió (multi-número); mock/live intactos.
    if (result && result.reply && result.reply.trim() && !result.handledByHuman) {
      try {
        // El cliente se construye ANTES de los gates para que ninguna E/S (resolución de
        // credenciales) quede entre el último chequeo y el envío físico — mismo patrón que el outbox.
        const client = await getWhatsAppClient(tenantId, undefined, receivedBy);
        // KILL-SWITCH-1: si el reply es de cobertura (coverageActivationId presente), se re-lee el
        // flag JUSTO antes del envío — un apagado de emergencia frena la solicitud de ubicación /
        // la promesa de revisión aún no enviadas. Los replies no-cobertura (id null) no se gatean.
        // Va como `gateFinal` para que se evalúe DENTRO del borde: si se resolviera acá, las dos
        // lecturas del guard de silencio quedarían entre el interruptor y el POST.
        const esCobertura = result.coverageActivationId != null;
        if (esCobertura) await coverageHold(tenantId, 'reply_pre_send');
        await entregarRespuestaAutomatica({
          tenantId,
          customerId,
          to: payload.from,
          texto: result.reply,
          channel: platform,
          receivedVia: receivedBy,
          client,
          ...(result.locationRequest ? { locationRequest: true } : {}),
          // Fallback defensivo: con `deferOutbound` el motor SIEMPRE manda descriptor cuando hay
          // texto. Si algún camino futuro se lo olvidara, preferimos registrar de más (con la
          // vara estricta del silencio) antes que perder del historial algo que el cliente vio.
          outbound: result.outbound ?? { expectativa: EXIGE_SILENCIO_LIBRE },
          ...(esCobertura
            ? {
                gateFinal: async () => {
                  const vigente = await coberturaVigente(tenantId, result.coverageActivationId ?? null);
                  if (!vigente) logger.info('Cobertura: respuesta NO enviada (kill-switch antes del envío)', { tenantId });
                  return vigente;
                },
              }
            : {}),
        });
      } catch (e) {
        logger.error('No se pudo entregar la respuesta del bot', e, { tenantId });
      }
    }

    // Atribución (D5): si el mensaje vino de un anuncio (referral de Meta), registrar la campaña.
    if (payload.adReferral?.campaignId) {
      await db().doc(paths.customer(tenantId, customerId)).set(
        { attribution: { campaignId: payload.adReferral.campaignId, adId: payload.adReferral.adId ?? null, type: 'direct_meta', confidence: 1, platform }, updatedAt: Timestamp.now() },
        { merge: true },
      );
    }

    // PRIVACIDAD: con los bytes YA en nuestro Storage, el mediaId del inbox no sirve para nada y
    // es un puntero al archivo del cliente: se anula. Si la ingesta NO terminó almacenada, se
    // conserva a propósito — es lo único que permitiría recuperar el archivo a mano.
    const crudo = ev.payload as { attachment?: unknown; image?: unknown } | undefined;
    await ref.update({
      processingStatus: 'processed',
      tenantId,
      processedAt: Timestamp.now(),
      ...(adjuntoAlmacenado && crudo?.attachment ? { 'payload.attachment.mediaId': null } : {}),
      ...(adjuntoAlmacenado && crudo?.image ? { 'payload.image': null } : {}),
    });
    logger.info('Webhook procesado', { eventId, tenantId, platform: ev.platform, conAdjunto: !!adjunto });
  } catch (e) {
    // PRIVACIDAD: si el evento traía ubicación, se anula también en 'failed' (los failed no se
    // reprocesan — sin esto las coordenadas quedarían retenidas en el inbox hasta el TTL).
    const teniaUbicacion = !!(ev.payload as { location?: unknown } | undefined)?.location;
    await ref.update({ processingStatus: 'failed', errorMessage: String(e), processedAt: Timestamp.now(), ...(teniaUbicacion ? { 'payload.location': null } : {}) });
    logger.error('Error procesando webhook', e, { eventId });
  }
}
