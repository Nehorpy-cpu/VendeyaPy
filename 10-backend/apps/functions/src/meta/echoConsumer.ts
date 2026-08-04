/**
 * meta/echoConsumer.ts — El echo del vendedor y la superficie de OBSERVACIÓN (ADR-0017 §1 y §3)
 * ==============================================================================================
 * Dos cosas que parecen distintas y son la misma decisión: qué hace el sistema con tráfico de un
 * número real cuando NO puede automatizar.
 *
 * 1. EL ECHO (§3). `smb_message_echoes` avisa que el vendedor contestó desde su teléfono. Sin
 *    consumirlo, el bot le habla encima delante del cliente — que es el desenlace exacto que
 *    Coexistence existe para evitar. Se persiste como outbound HUMANO, jamás se reenvía, y activa
 *    el control humano con la semántica CANÓNICA de HANDOFF-2 (`executeHandoff`), sobre la sesión
 *    de ESE canal. No se inventa una segunda forma de silencio: ya hay una y es la que manda.
 *
 * 2. LA SUPERFICIE DE OBSERVACIÓN (§1, modo `shadow`). El ADR §4 ya razonó esto para el historial
 *    importado: «escribir en `messages` mezclaría el historial importado con el del número que ya
 *    vende». `shadow` es el mismo problema con otra puerta —el mensaje llega en vivo— y las tres
 *    consecuencias estaban confirmadas:
 *      (a) `conversation.receivedVia` del doc del CLIENTE (que no está particionado por canal)
 *          quedaba con el PNID en observación, y el mensaje manual del panel lo lee para elegir
 *          por qué número sale: el vendedor escribía y salía por el número que debe estar callado;
 *      (b) `listRecentMessages` arma el prompt del modelo sin filtrar por canal, así que lo del
 *          número en observación entraba al contexto de la IA del número que sí vende;
 *      (c) la conversación aparecía en la bandeja del panel, y tomarla ahí silencia al bot en el
 *          número que vende.
 *    Por eso `shadow` escribe acá y no en la conversación: mirar no puede tener efectos.
 *
 * DÓNDE VIVE LA OBSERVACIÓN, y por qué no en `metaWebhookInbox`: `onWebhookInbox` dispara sobre
 * TODO documento de esa bandeja —esa colección ES el disparador del motor— y además la lee
 * `isPlatformAdmin()`. La observación va a una colección propia, CERRADA (el default-deny de
 * `firestore.rules` la cubre; corresponde declararla explícita como el historial) y con TTL.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { MessageChannel } from '@vpw/shared';
import { hashProviderMessageId, permiteAutomatizacion, persisteEntrante } from '@vpw/shared';
import { db } from '../lib/firebase.js';
import { appendMessage } from '../conversation/messages.js';
import { executeHandoff } from '../conversation/handoff.js';
import { logger } from '../lib/logger.js';
import type { CanalAutomatizacion } from './automationMode.js';

/**
 * Colección de OBSERVACIÓN. Nombre en la familia `metaWebhook*` a propósito: es material del
 * webhook que solo escribe el Admin SDK, con TTL y sin ningún lector de negocio.
 *
 * PENDIENTE (igual que `COEXISTENCE_HISTORY_COLLECTION`): el nombre vive acá y no en `paths.*`
 * porque `lib/firebase.ts` lo está tocando otra superficie de este mismo programa.
 */
export const COEXISTENCE_SHADOW_COLLECTION = 'metaWebhookShadow';

/**
 * TTL de la observación: 30 días — el MISMO que el evento del que sale (`TTL_MS` de
 * `webhookHttp.ts`), que es lo que pide el ADR §1: «su TTL es el mismo del evento que la origina».
 * No es un número elegido acá: es una copia declarada. Si el TTL de `metaWebhookInbox` se acorta,
 * este tiene que acompañarlo.
 *
 * POR QUÉ NO EL TTL CORTO DEL ARCHIVO (48 h el historial, 7 d la agenda): el archivo es una
 * importación EN BLOQUE de hasta 180 días de conversaciones privadas que el sistema nunca vio, y
 * ahí cada hora de más es exposición nueva. La observación es una vista legible de un evento que
 * la bandeja ya guarda con el mismo contenido y por 30 días: acortarla no reduciría la vida real
 * del dato ni un día —seguiría entero en `metaWebhookInbox`— y a cambio dejaría al operador sin
 * poder mirar lo que su propio webhook todavía tiene. Lo que SÍ estaría mal es que durara más que
 * su origen, y por eso el número está atado a él en vez de elegido por separado.
 *
 * Y `expiresAt` no es retención por sí solo: la política TTL va en `firestore.indexes.json` y el
 * barrido que anula `text`/`customerId` antes de borrar, en `functions/meta/coexistenceRetention.ts`.
 */
export const OBSERVACION_TTL_MS = 30 * 86_400_000;

/** Qué produjo la observación. Código CERRADO: es seguro de loguear. */
export type OrigenObservacion = 'message' | 'echo';

export interface ObservacionArgs {
  tenantId: string;
  /** PNID del canal en observación (id opaco de Meta; no es un teléfono). */
  phoneNumberId: string | null;
  sessionKey: string;
  /** wa_id del cliente, solo dígitos. Es un teléfono: por eso la colección es cerrada y con TTL. */
  customerId: string;
  direction: 'in' | 'out';
  author: 'customer' | 'seller';
  kind: OrigenObservacion;
  text: string;
  channel: MessageChannel;
  /** Id del mensaje en el proveedor SIN hashear: se usa solo para derivar el id del documento. */
  providerMessageId: string;
}

/**
 * Registra lo que llegó por un número en observación. IDEMPOTENTE por `(tenant, mensaje)`: un
 * reintento del webhook no duplica el registro. El id del documento es el hash tenant-scoped del
 * id del proveedor —el mismo criterio que el resto del sistema— para no dejar wamids en claro
 * como nombres de documento.
 */
export async function registrarObservacion(args: ObservacionArgs): Promise<void> {
  const ahora = Timestamp.now();
  const docId = hashProviderMessageId(args.tenantId, `${args.kind}_${args.providerMessageId}`);
  const ref = db().collection(COEXISTENCE_SHADOW_COLLECTION).doc(docId);
  try {
    await ref.create({
      id: docId,
      tenantId: args.tenantId,
      phoneNumberId: args.phoneNumberId,
      sessionKey: args.sessionKey,
      customerId: args.customerId,
      direction: args.direction,
      author: args.author,
      kind: args.kind,
      text: args.text,
      channel: args.channel,
      // Marca dura y legible en el documento: esto NO es una bandeja de entrada. No cuenta para
      // no-leídos, no alimenta el prompt del modelo y jamás dispara negocio.
      automationEligible: false,
      unread: false,
      observedAt: ahora,
      expiresAt: Timestamp.fromMillis(ahora.toMillis() + OBSERVACION_TTL_MS),
    });
  } catch (e) {
    if (!esYaExiste(e)) throw e;
    // Reintento del webhook: el registro ya está. No se reescribe (sería mentir sobre el momento).
  }
}

function esYaExiste(e: unknown): boolean {
  const code = (e as { code?: number | string } | null)?.code;
  return code === 6 || code === 'already-exists' || /already.?exists/i.test(String(e));
}

/**
 * ADR-0016 §9 / ADR-0017 — marcadores del SISTEMA. Nunca son contenido del cliente ni del
 * vendedor: describen QUÉ pasó para que la burbuja no quede vacía en el panel. Un echo de media no
 * promueve su caption a texto (misma regla que un adjunto entrante).
 */
const MARCADOR_ECHO: Record<string, string> = {
  media: '📎 El vendedor envió un archivo desde WhatsApp Business',
  revoke: '🗑️ El vendedor eliminó un mensaje desde WhatsApp Business',
  other: '💬 El vendedor respondió desde WhatsApp Business',
};
const MARCADOR_ECHO_DEFAULT = MARCADOR_ECHO['other']!;

/** Forma NAMESPACEADA que escribe el productor: `payload.echo.*`, y jamás un `payload.from`. */
interface EchoCrudo {
  customerWaId?: unknown;
  messageId?: unknown;
  echoType?: unknown;
  text?: unknown;
}

export type DesenlaceEcho = 'procesado' | 'ignorado';

export interface ResultadoEcho {
  desenlace: DesenlaceEcho;
  /** Motivo saneado (sin números, sin texto del mensaje): va al `errorMessage` del evento. */
  motivo: string;
}

export interface ConsumirEchoArgs {
  tenantId: string;
  /** `metadata.phone_number_id` del canal por el que salió (= `externalId` del evento). */
  phoneNumberId: string | null;
  payload: unknown;
  /** Ya resuelto por el llamador: el gate por PNID le aplica al echo igual que a un inbound. */
  canal: CanalAutomatizacion;
}

/**
 * Consume un echo. Las cinco garantías, en el orden en el que importan:
 *
 *  1. el cliente sale de `to` (`payload.echo.customerWaId`). El `from` de un echo es el NEGOCIO y
 *     acá ni se mira: transportarlo abriría una conversación de la empresa consigo misma;
 *  2. el gate por PNID manda: `inactive` no hace nada, `shadow` solo observa;
 *  3. el control humano se activa ANTES de escribir la burbuja — si algo falla después, el bot ya
 *     está callado, que es la parte que el cliente ve;
 *  4. se persiste como outbound HUMANO, idempotente por wamid;
 *  5. no se envía nada, no se cobra metering, no corre el motor ni la ingesta de adjuntos.
 */
export async function consumirEcho(args: ConsumirEchoArgs): Promise<ResultadoEcho> {
  const { tenantId, phoneNumberId, canal } = args;
  const crudo = ((args.payload as { echo?: EchoCrudo } | undefined)?.echo ?? {}) as EchoCrudo;
  const customerId = String(crudo.customerWaId ?? '').replace(/[^0-9]/g, '');
  const messageId = String(crudo.messageId ?? '').trim();
  // Sin `to` no hay a quién atribuirlo y sin wamid no hay idempotencia posible: el parser ya
  // descarta esos echoes, pero un documento viejo o corrupto no puede terminar en la conversación
  // de nadie. Es terminal: no hay reintento que lo arregle.
  if (customerId === '' || messageId === '') {
    return { desenlace: 'ignorado', motivo: 'echo sin cliente o sin wamid' };
  }

  if (!persisteEntrante(canal.mode)) {
    return { desenlace: 'ignorado', motivo: `número sin automatización (${canal.mode})` };
  }

  const echoType = String(crudo.echoType ?? 'other');
  const texto = echoType === 'text' || echoType === 'edit' ? String(crudo.text ?? '').trim() : '';
  const textoFinal = texto || MARCADOR_ECHO[echoType] || MARCADOR_ECHO_DEFAULT;
  // La clave de idempotencia discrimina el TIPO por la misma razón que `echoIdempotencyKey` en el
  // parser: un `revoke` o un `edit` pueden referirse al mismo mensaje que ya produjo un echo.
  const claveEcho = echoType === 'revoke' || echoType === 'edit' ? `echo_${echoType}_${messageId}` : `echo_${messageId}`;

  /**
   * `shadow`: el vendedor atiende A MANO y el sistema MIRA — ver el echo es justamente el punto
   * del modo. Pero mirar no puede tener efectos: no se escribe en la conversación del cliente
   * (compartida con el número que vende) ni se toca el control humano, porque en `shadow` el gate
   * ya deja al bot mudo para ese número y un takeover solo agregaría estado con alcance ajeno —
   * el resumen del cliente NO está particionado por canal.
   */
  if (!permiteAutomatizacion(canal.mode)) {
    await registrarObservacion({
      tenantId,
      phoneNumberId,
      sessionKey: canal.sessionKey,
      customerId,
      direction: 'out',
      author: 'seller',
      kind: 'echo',
      text: textoFinal,
      channel: 'whatsapp',
      providerMessageId: claveEcho,
    });
    return { desenlace: 'procesado', motivo: `observado (${canal.mode})` };
  }

  const sourceId = hashProviderMessageId(tenantId, claveEcho);
  /**
   * EL SILENCIO PRIMERO. `createSessionIfMissing` no es comodidad: si el cliente todavía no tiene
   * sesión en ese canal, sin crearla el handoff sería un no-op y el bot seguiría contestando
   * encima del vendedor — el desenlace exacto que Coexistence existe para evitar.
   *
   * `reassignIfTaken` queda en false: un echo no reasigna un chat que otro vendedor ya tomó. Si ya
   * hay control humano vigente, `executeHandoff` es idempotente y no toca nada.
   */
  const handoff = await executeHandoff(tenantId, customerId, {
    reason: 'seller_manual',
    sellerName: null,
    sellerUid: null,
    sourceId,
    sessionKey: canal.sessionKey,
    createSessionIfMissing: true,
  });
  if (!handoff.ok) {
    logger.warn('Echo: no se pudo activar el control humano de la conversación', { tenantId });
  }

  await appendMessage(tenantId, customerId, {
    direction: 'out',
    author: 'seller',
    text: textoFinal,
    channel: 'whatsapp',
    receivedVia: phoneNumberId,
    // ADR-0017 §3: «se persiste como outbound humano con origen `whatsapp_business_app`». Es lo
    // que distingue, en el panel, lo que salió del teléfono del vendedor de lo que salió de acá.
    origin: 'whatsapp_business_app',
    // El resumen del cliente tiene que coincidir con la sesión que el handoff acaba de escribir
    // (mismo criterio que `takeoverChat`). Nunca suma "sin leer": lo escribió el propio vendedor.
    humanTakeover: true,
    // Idempotente por wamid: un reintento del webhook no duplica la burbuja del vendedor.
    docId: hashProviderMessageId(tenantId, claveEcho),
  });

  return { desenlace: 'procesado', motivo: '' };
}
