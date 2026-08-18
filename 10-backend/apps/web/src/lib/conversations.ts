/**
 * Capa de acceso a clientes, conversaciones y handoff (panel · P5).
 * Lecturas directas a Firestore (gated por reglas). Las acciones de handoff
 * (tomar/devolver) pasan por Cloud Functions callable con auth.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  orderBy,
  limit as fbLimit,
  startAfter,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { Customer, Message } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';

const customersCol = (tenantId: string) =>
  collection(firebaseDb(), 'tenants', tenantId, 'customers');
const messagesCol = (tenantId: string, customerId: string) =>
  collection(firebaseDb(), 'tenants', tenantId, 'customers', customerId, 'messages');

/** Clientes ordenados por última actividad (para la página Clientes). */
export async function listCustomers(tenantId: string, max = 200): Promise<Customer[]> {
  const snap = await getDocs(
    query(customersCol(tenantId), orderBy('updatedAt', 'desc'), fbLimit(max)),
  );
  return snap.docs.map((d) => d.data() as Customer);
}

/**
 * Conversaciones (clientes que ya escribieron), ordenadas por último mensaje.
 * Los clientes sin mensajes no aparecen (no tienen conversation.lastMessageAt).
 */
export async function listConversations(tenantId: string, max = 100): Promise<Customer[]> {
  const snap = await getDocs(
    query(customersCol(tenantId), orderBy('conversation.lastMessageAt', 'desc'), fbLimit(max)),
  );
  return snap.docs.map((d) => d.data() as Customer);
}

export async function getCustomer(tenantId: string, customerId: string): Promise<Customer | null> {
  const snap = await getDoc(doc(firebaseDb(), 'tenants', tenantId, 'customers', customerId));
  return snap.exists() ? (snap.data() as Customer) : null;
}

/**
 * Historial de mensajes de una conversación (orden cronológico).
 * Los ÚLTIMOS `max` mensajes: se consulta descendente y se invierte. Con 'asc' + límite,
 * Firestore devuelve los N MÁS VIEJOS y el chat queda congelado apenas la conversación
 * supera el límite (mismo patrón correcto que listRecentMessages en functions).
 *
 * ADR-0021 (paginación hacia atrás): `before` es el `createdAt` del mensaje MÁS VIEJO ya
 * cargado — con `startAfter` sobre la misma consulta descendente se obtiene la página anterior,
 * conservando el contrato desc + reverse (fijado por conversations.window.test.ts).
 */
export async function getMessages(
  tenantId: string,
  customerId: string,
  max = 200,
  before?: unknown,
): Promise<Message[]> {
  const clauses = [
    orderBy('createdAt', 'desc'),
    ...(before != null ? [startAfter(before)] : []),
    fbLimit(max),
  ];
  const snap = await getDocs(query(messagesCol(tenantId, customerId), ...clauses));
  return snap.docs.map((d) => d.data() as Message).reverse();
}

export interface HandoffResult {
  ok: boolean;
  message: string;
}

/** El vendedor toma el chat (el bot se pausa). */
export async function takeoverChat(tenantId: string, customerId: string): Promise<HandoffResult> {
  const fn = httpsCallable<{ tenantId: string; customerId: string }, HandoffResult>(
    firebaseFunctions(),
    'chatTakeover',
  );
  const res = await fn({ tenantId, customerId });
  return res.data;
}

/** El vendedor devuelve el chat al bot. */
export async function releaseChat(tenantId: string, customerId: string): Promise<HandoffResult> {
  const fn = httpsCallable<{ tenantId: string; customerId: string }, HandoffResult>(
    firebaseFunctions(),
    'chatRelease',
  );
  const res = await fn({ tenantId, customerId });
  return res.data;
}

export interface ManualMessageResult {
  ok: boolean;
  /** true = modo mock: quedó en el historial pero NO salió a WhatsApp. */
  viaMock: boolean;
  waMessageId: string | null;
}

/** HUMAN-HANDOFF-1: mensaje humano del staff por WhatsApp (mismo número que recibió el chat). */
export async function sendManualMessage(
  tenantId: string,
  customerId: string,
  text: string,
): Promise<ManualMessageResult> {
  const fn = httpsCallable<{ tenantId: string; customerId: string; text: string }, ManualMessageResult>(
    firebaseFunctions(),
    'conversationSendManualMessage',
  );
  const res = await fn({ tenantId, customerId, text });
  return res.data;
}

// ---------------------------------------------------------------------------
// ADR-0021 — ciclo de vida, asignación, vínculo a cliente y media saliente.
// Todos los contratos son `{tenantId, customerId, …}` bajo staffAuth; la matriz de
// permisos §7 la valida el SERVER — acá solo se nombra el callable correcto.
// ---------------------------------------------------------------------------

export interface OkResult {
  ok: boolean;
}

/** Fábrica interna: callables de ciclo de vida que solo llevan `{tenantId, customerId}`. */
async function lifecycleCall(name: string, tenantId: string, customerId: string): Promise<OkResult> {
  const fn = httpsCallable<{ tenantId: string; customerId: string }, OkResult>(
    firebaseFunctions(),
    name,
  );
  return (await fn({ tenantId, customerId })).data;
}

/** Archivar (reversible; un entrante nuevo desarchiva — ADR-0021 §3). */
export const archiveConversation = (tenantId: string, customerId: string): Promise<OkResult> =>
  lifecycleCall('conversationArchive', tenantId, customerId);

export const unarchiveConversation = (tenantId: string, customerId: string): Promise<OkResult> =>
  lifecycleCall('conversationUnarchive', tenantId, customerId);

/** Eliminación LÓGICA reversible: jamás borra mensajes, adjuntos ni evidencia. */
export const softDeleteConversation = (tenantId: string, customerId: string): Promise<OkResult> =>
  lifecycleCall('conversationSoftDelete', tenantId, customerId);

export const restoreConversation = (tenantId: string, customerId: string): Promise<OkResult> =>
  lifecycleCall('conversationRestore', tenantId, customerId);

/** Marcar leído al abrir la conversación (fire-and-forget desde la página). */
export const markConversationRead = (tenantId: string, customerId: string): Promise<OkResult> =>
  lifecycleCall('conversationMarkRead', tenantId, customerId);

export interface AssignResult {
  ok: boolean;
  sellerName?: string;
}

/** Asignar vendedor (`sellerUid: null` = quitar asignación). Solo MANAGER/OWNER/ADMIN. */
export async function assignConversation(
  tenantId: string,
  customerId: string,
  sellerUid: string | null,
): Promise<AssignResult> {
  const fn = httpsCallable<
    { tenantId: string; customerId: string; sellerUid: string | null },
    AssignResult
  >(firebaseFunctions(), 'conversationAssign');
  return (await fn({ tenantId, customerId, sellerUid })).data;
}

/** Vincular la conversación a una ficha de cliente existente del MISMO tenant. */
export async function linkConversationClient(
  tenantId: string,
  customerId: string,
  clientId: string,
): Promise<OkResult> {
  const fn = httpsCallable<{ tenantId: string; customerId: string; clientId: string }, OkResult>(
    firebaseFunctions(),
    'conversationLinkClient',
  );
  return (await fn({ tenantId, customerId, clientId })).data;
}

export async function unlinkConversationClient(
  tenantId: string,
  customerId: string,
): Promise<OkResult> {
  const fn = httpsCallable<{ tenantId: string; customerId: string }, OkResult>(
    firebaseFunctions(),
    'conversationUnlinkClient',
  );
  return (await fn({ tenantId, customerId })).data;
}

export interface CreateClientResult {
  ok: boolean;
  clientId: string;
}

/** Crear ficha CRM desde datos confirmados y vincularla a esta conversación. */
export async function createAndLinkClient(
  tenantId: string,
  customerId: string,
  name: string,
  notes?: string,
): Promise<CreateClientResult> {
  const fn = httpsCallable<
    { tenantId: string; customerId: string; name: string; notes?: string },
    CreateClientResult
  >(firebaseFunctions(), 'conversationCreateClient');
  return (await fn({ tenantId, customerId, name, ...(notes ? { notes } : {}) })).data;
}

export interface CustomerSearchItem {
  id: string;
  name: string;
  profileName?: string;
  whatsappPhone: string;
}

export interface CustomerSearchResult {
  items: CustomerSearchItem[];
  nextCursor?: string;
}

/** Búsqueda server-side paginada de clientes (para el modal de vínculo). */
export async function searchCustomers(
  tenantId: string,
  q: string,
  limit?: number,
  cursor?: string,
): Promise<CustomerSearchResult> {
  const fn = httpsCallable<
    { tenantId: string; query: string; limit?: number; cursor?: string },
    CustomerSearchResult
  >(firebaseFunctions(), 'customerSearch');
  return (
    await fn({
      tenantId,
      query: q,
      ...(limit != null ? { limit } : {}),
      ...(cursor ? { cursor } : {}),
    })
  ).data;
}

export interface SendAttachmentInput {
  tenantId: string;
  customerId: string;
  /** Idempotencia: el mismo op reintentado NUNCA produce doble envío (ADR-0021 §5). */
  operationId: string;
  kind: 'image' | 'document';
  filename: string;
  mimeType: string;
  dataBase64: string;
  caption?: string;
}

export interface SendAttachmentResult {
  ok: boolean;
  attachmentId: string;
  messageId: string;
  viaMock?: boolean;
}

/** Envío manual de imagen/documento por el MISMO camino de routing que el texto. */
export async function sendConversationAttachment(
  input: SendAttachmentInput,
): Promise<SendAttachmentResult> {
  const fn = httpsCallable<SendAttachmentInput, SendAttachmentResult>(
    firebaseFunctions(),
    'conversationSendAttachment',
  );
  return (await fn(input)).data;
}
