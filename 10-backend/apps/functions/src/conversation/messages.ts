/**
 * conversation/messages.ts — Historial de mensajes (P5)
 * =====================================================
 * Persiste cada mensaje del chat en tenants/{t}/customers/{c}/messages y mantiene
 * un resumen denormalizado en el doc del cliente (conversation.*) para poder
 * armar la bandeja/lista de clientes sin leer toda la subcolección.
 *
 * Channel-agnostic: lo usa el motor del bot y (a futuro) el webhook de WhatsApp.
 */

import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import type { Message, MessageDirection, MessageAuthor, SessionState, MessageChannel } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';

export interface AppendMessageInput {
  direction: MessageDirection;
  author: MessageAuthor;
  text: string;
  /** Momento del mensaje (default: ahora). Permite agrupar in/out con el mismo reloj. */
  now?: Timestamp;
  /** Estado de la sesión a reflejar en la meta del cliente. */
  state?: SessionState | null;
  /** Si se define, fija conversation.humanTakeover en la meta. */
  humanTakeover?: boolean;
  /** true = suma 1 a "sin leer" del vendedor (solo cuando el bot no atiende). */
  countUnread?: boolean;
  /** Canal del mensaje (omnicanal, D2). Default 'whatsapp'. */
  channel?: MessageChannel;
  /** MULTI-NUMBER-1: phone_number_id del número del NEGOCIO por el que entró/salió el mensaje. */
  receivedVia?: string | null;
  /** HUMAN-HANDOFF-1: uid del staff que escribió (author 'seller'). */
  senderUid?: string | null;
  /** HUMAN-HANDOFF-1: nombre legible del staff (para la burbuja del panel). */
  senderName?: string | null;
  /** HUMAN-HANDOFF-1: wamid de Meta si el envío fue live. */
  waMessageId?: string | null;
  /** HUMAN-HANDOFF-1: true = el outbound quedó retenido por modo mock (no salió a Meta). */
  viaMock?: boolean;
  /**
   * ADR-0017 §3: de DÓNDE salió un outbound humano. `whatsapp_business_app` = lo mandó el vendedor
   * desde su teléfono y nos enteramos por un echo — nunca salió de acá. Es lo que le permite al
   * panel distinguirlo de un mensaje manual del propio panel, que sí pasó por Cloud API.
   * Opcional y aditivo: los mensajes que ya existen no lo tienen y siguen siendo válidos.
   */
  origin?: string | null;
  /**
   * ADR-0016: id DETERMINÍSTICO del documento. Con él, el mensaje se escribe con `create()` y un
   * reintento del webhook NO duplica la burbuja en el chat. Sin él (default) se usa un id
   * aleatorio y el comportamiento es el de siempre.
   */
  docId?: string | null;
  /**
   * ADR-0016: punteros a `tenants/{t}/attachments/{id}`. Si el doc ya existía (reintento o
   * segundo adjunto del mismo mensaje del proveedor), se acumulan con `arrayUnion` — nunca se
   * pisan: un segundo envío ACUMULA, no reemplaza.
   */
  attachmentIds?: string[];
}

function preview(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
}

/** Marcador NEUTRAL para la bandeja cuando el mensaje es solo un archivo (sin caption). Es un
 *  resumen denormalizado, NO evidencia: la autoridad sobre el adjunto es `hasAttachments`. */
const PREVIEW_SOLO_ADJUNTO = '📎 Adjunto';

function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: number | string } | null)?.code;
  return code === 6 || code === 'already-exists' || /already.?exists/i.test(String(e));
}

/** Guarda un mensaje y actualiza el resumen de conversación del cliente. */
export async function appendMessage(
  tenantId: string,
  customerId: string,
  input: AppendMessageInput,
): Promise<Message> {
  const now = input.now ?? Timestamp.now();
  const col = db().collection(paths.messages(tenantId, customerId));
  const ref = input.docId ? col.doc(input.docId) : col.doc();
  const channel: MessageChannel = input.channel ?? 'whatsapp';
  const attachmentIds = input.attachmentIds?.filter((id) => typeof id === 'string' && id !== '') ?? [];
  const msg: Message = {
    id: ref.id,
    tenantId,
    customerId,
    direction: input.direction,
    author: input.author,
    text: input.text,
    channel,
    createdAt: now,
    ...(attachmentIds.length ? { attachmentIds, hasAttachments: true } : {}),
  };
  // Metadata adicional opcional (MULTI-NUMBER-1 / HUMAN-HANDOFF-1): solo los campos presentes.
  const extra: Record<string, unknown> = {};
  if (input.receivedVia) extra['receivedVia'] = input.receivedVia;
  if (input.senderUid) extra['senderUid'] = input.senderUid;
  if (input.senderName) extra['senderName'] = input.senderName;
  if (input.waMessageId) extra['waMessageId'] = input.waMessageId;
  if (input.viaMock) extra['viaMock'] = true;
  if (input.origin) extra['origin'] = input.origin;
  // ADR-0021 §1: la burbuja saliente ACEPTADA por un proveedor real nace 'pending' («enviando»).
  // Todo avance posterior proviene EXCLUSIVAMENTE de los `value.statuses` del webhook. Los
  // viaMock NO llevan estado (nada salió a ningún proveedor) y los 'system' tampoco (son eventos
  // internos del panel). Los entrantes jamás tienen estado de entrega.
  if (input.direction === 'out' && (input.author === 'bot' || input.author === 'seller') && input.viaMock !== true) {
    extra['deliveryStatus'] = 'pending';
  }
  const doc = Object.keys(extra).length ? { ...msg, ...extra } : msg;

  if (input.docId) {
    try {
      await ref.create(doc);
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      // Reintento del webhook o SEGUNDO adjunto del mismo mensaje del proveedor. No se duplica
      // la burbuja ni se vuelve a tocar el resumen (evita inflar `unreadForSeller`); solo se
      // acumulan los punteros nuevos, que es idempotente.
      if (attachmentIds.length) {
        await ref.set(
          { attachmentIds: FieldValue.arrayUnion(...attachmentIds), hasAttachments: true },
          { merge: true },
        );
      }
      return msg;
    }
  } else {
    await ref.set(doc);
  }

  // Resumen denormalizado (deep-merge sobre el doc del cliente).
  //
  // MONOTÓNICO (H7 / ADR-0017 §2): este resumen es el que lee `resolverCanalDeConversacion` para
  // decidir por dónde SALE la próxima respuesta manual. Sin comparar contra el `lastMessageAt`
  // vigente, una operación VIEJA que termina tarde pisaba `channel`/`receivedVia` y ruteaba al
  // vendedor contra la conversación equivocada. Por eso los campos de «última actividad» solo se
  // escriben si este mensaje es más nuevo o igual que el vigente. Cuesta 1 lectura por mensaje:
  // Firestore no tiene precondición por campo en un set/merge, y leer el resumen es la única
  // forma de saber si este mensaje sigue siendo el último. Queda una ventana residual si dos
  // resúmenes se leen/escriben exactamente intercalados (cerrarla del todo exige transacción).
  const customerRef = db().doc(paths.customer(tenantId, customerId));
  // La MISMA lectura trae `archived` (ADR-0021 §3): el desarchivado no paga un round-trip extra.
  const prevConv = ((await customerRef.get()).data() as
    | { conversation?: { lastMessageAt?: { toMillis?: () => number }; archived?: unknown } }
    | undefined)?.conversation;
  const prevAt = prevConv?.lastMessageAt;
  // EMPATE (>=): gana la operación que termina última — es el comportamiento vigente para los
  // pares in/out agrupados con el MISMO reloj (`input.now` compartido): el out se escribe segundo
  // y debe quedar como último mensaje del resumen. Un resumen sin `lastMessageAt` legible
  // (cliente nuevo o dato viejo con otra forma) no veta nada: se escribe, como siempre.
  const esMasNuevo = typeof prevAt?.toMillis !== 'function' || now.toMillis() >= prevAt.toMillis();

  const conv: Record<string, unknown> = {};
  if (esMasNuevo) {
    conv['lastMessageAt'] = now;
    conv['lastMessagePreview'] = preview(input.text) || (attachmentIds.length ? PREVIEW_SOLO_ADJUNTO : '');
    conv['lastMessageDirection'] = input.direction;
    conv['channel'] = channel;
    if (input.receivedVia) conv['receivedVia'] = input.receivedVia; // para el badge de /conversations
  }
  // Lo que NO es «última actividad» se aplica igual aunque el mensaje sea viejo: `state` y
  // `humanTakeover` son decisiones EXPLÍCITAS del llamador (handoff/motor), y el contador de
  // no-leídos es un increment conmutativo — el orden de llegada no le cambia el resultado.
  if (input.state !== undefined) conv['state'] = input.state ?? null;
  if (input.humanTakeover !== undefined) conv['humanTakeover'] = input.humanTakeover;
  // "Sin leer" para el vendedor: solo cuando el bot no está atendiendo (handoff/bot off).
  if (input.countUnread) {
    conv['unreadForSeller'] = FieldValue.increment(1);
  }
  // ADR-0021 §3 — DESARCHIVADO AUTOMÁTICO (comportamiento WhatsApp): la vuelta del cliente
  // desarchiva en la MISMA actualización del resumen. No es «última actividad» —aplica aunque
  // este mensaje llegue viejo para el guard monotónico: el hecho es que el cliente volvió a
  // escribir— y NUNCA toca `softDeleted`: la eliminación lógica solo se revierte explícitamente
  // desde el panel.
  if (input.direction === 'in' && prevConv?.archived === true) {
    conv['archived'] = false;
    conv['archivedAt'] = null;
    conv['archivedBy'] = null;
  }

  /**
   * `conversation` SOLO viaja si tiene algo adentro. Un mapa VACÍO con `merge:true` NO fusiona:
   * el SDK serializa `updateMask: ["conversation"]` con `mapValue:{}` y REEMPLAZA el mapa entero
   * (verificado contra @google-cloud/firestore 7.11.6; con contenido serializa `conversation.x`,
   * que sí es merge de hoja). Con el guard monotónico de arriba, un mensaje viejo sin `state`,
   * `humanTakeover` ni `countUnread` —la forma exacta del mensaje manual del panel y de la
   * ingesta de adjuntos— dejaba `conv` vacío y BORRABA el resumen del cliente: `receivedVia`
   * (por dónde sale la próxima respuesta manual), `channel`, `humanTakeover`, `state` y el
   * contador de no leídos.
   */
  const resumen: Record<string, unknown> = { id: customerId, tenantId, updatedAt: now };
  if (Object.keys(conv).length > 0) resumen['conversation'] = conv;
  await customerRef.set(resumen, { merge: true });

  return msg;
}

/** Lee el historial de mensajes (orden cronológico ascendente). */
export async function listMessages(
  tenantId: string,
  customerId: string,
  max = 200,
): Promise<Message[]> {
  const snap = await db()
    .collection(paths.messages(tenantId, customerId))
    .orderBy('createdAt', 'asc')
    .limit(max)
    .get();
  return snap.docs.map((d) => d.data() as Message);
}

/** Últimos `max` mensajes en orden cronológico ascendente (historial para el sales agent IA, F1). */
export async function listRecentMessages(
  tenantId: string,
  customerId: string,
  max = 6,
): Promise<Message[]> {
  const snap = await db()
    .collection(paths.messages(tenantId, customerId))
    .orderBy('createdAt', 'desc')
    .limit(max)
    .get();
  return snap.docs.map((d) => d.data() as Message).reverse();
}

/** Marca como leídos los mensajes entrantes (resetea el contador del vendedor). */
export async function markConversationRead(tenantId: string, customerId: string): Promise<void> {
  await db()
    .doc(paths.customer(tenantId, customerId))
    .set({ conversation: { unreadForSeller: 0 } }, { merge: true });
}
