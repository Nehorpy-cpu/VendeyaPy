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

/** Historial de mensajes de una conversación (orden cronológico). */
export async function getMessages(
  tenantId: string,
  customerId: string,
  max = 200,
): Promise<Message[]> {
  const snap = await getDocs(
    query(messagesCol(tenantId, customerId), orderBy('createdAt', 'asc'), fbLimit(max)),
  );
  return snap.docs.map((d) => d.data() as Message);
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
