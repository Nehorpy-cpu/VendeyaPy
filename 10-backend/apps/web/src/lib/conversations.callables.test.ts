/**
 * conversations.callables.test.ts — los wrappers de la lib llaman al callable CORRECTO con el
 * payload EXACTO del contrato ADR-0021. El backend se implementa en paralelo: estos tests fijan
 * los nombres para que el panel y las functions no se desincronicen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { httpsCallableMock, llamadas } = vi.hoisted(() => {
  const llamadas: { name: string; payload: unknown }[] = [];
  const httpsCallableMock = vi.fn((_fns: unknown, name: string) => (payload: unknown) => {
    llamadas.push({ name, payload });
    return Promise.resolve({ data: { ok: true, sellerName: 'Ana', clientId: 'crm_1', items: [], attachmentId: 'a', messageId: 'm' } });
  });
  return { httpsCallableMock, llamadas };
});

vi.mock('firebase/functions', () => ({ httpsCallable: httpsCallableMock }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  doc: vi.fn(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  query: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
  startAfter: vi.fn(),
}));
vi.mock('./firebase', () => ({ firebaseDb: () => ({}), firebaseFunctions: () => ({}) }));

import {
  archiveConversation,
  unarchiveConversation,
  softDeleteConversation,
  restoreConversation,
  markConversationRead,
  assignConversation,
  linkConversationClient,
  unlinkConversationClient,
  createAndLinkClient,
  searchCustomers,
  sendConversationAttachment,
} from './conversations';

beforeEach(() => {
  llamadas.length = 0;
});

const ultima = () => llamadas[llamadas.length - 1]!;

describe('ciclo de vida (ADR-0021 §3)', () => {
  it.each([
    ['conversationArchive', archiveConversation],
    ['conversationUnarchive', unarchiveConversation],
    ['conversationSoftDelete', softDeleteConversation],
    ['conversationRestore', restoreConversation],
    ['conversationMarkRead', markConversationRead],
  ] as const)('%s recibe {tenantId, customerId}', async (name, fn) => {
    const r = await fn('t1', 'c1');
    expect(ultima()).toEqual({ name, payload: { tenantId: 't1', customerId: 'c1' } });
    expect(r.ok).toBe(true);
  });
});

describe('asignación y vínculo (§4 y §7)', () => {
  it('conversationAssign lleva sellerUid (string) y devuelve sellerName', async () => {
    const r = await assignConversation('t1', 'c1', 'uid9');
    expect(ultima()).toEqual({ name: 'conversationAssign', payload: { tenantId: 't1', customerId: 'c1', sellerUid: 'uid9' } });
    expect(r.sellerName).toBe('Ana');
  });

  it('conversationAssign acepta null EXPLÍCITO para quitar la asignación', async () => {
    await assignConversation('t1', 'c1', null);
    expect(ultima().payload).toEqual({ tenantId: 't1', customerId: 'c1', sellerUid: null });
  });

  it('conversationLinkClient / conversationUnlinkClient', async () => {
    await linkConversationClient('t1', 'c1', 'crm_9');
    expect(ultima()).toEqual({ name: 'conversationLinkClient', payload: { tenantId: 't1', customerId: 'c1', clientId: 'crm_9' } });
    await unlinkConversationClient('t1', 'c1');
    expect(ultima()).toEqual({ name: 'conversationUnlinkClient', payload: { tenantId: 't1', customerId: 'c1' } });
  });

  it('conversationCreateClient: notes solo si viene (no manda undefined)', async () => {
    const r = await createAndLinkClient('t1', 'c1', 'María', 'nota');
    expect(ultima()).toEqual({
      name: 'conversationCreateClient',
      payload: { tenantId: 't1', customerId: 'c1', name: 'María', notes: 'nota' },
    });
    expect(r.clientId).toBe('crm_1');
    await createAndLinkClient('t1', 'c1', 'María');
    expect(ultima().payload).toEqual({ tenantId: 't1', customerId: 'c1', name: 'María' });
  });

  it('customerSearch: query + limit + cursor opcionales', async () => {
    await searchCustomers('t1', 'mar', 10, 'CUR');
    expect(ultima()).toEqual({
      name: 'customerSearch',
      payload: { tenantId: 't1', query: 'mar', limit: 10, cursor: 'CUR' },
    });
    await searchCustomers('t1', 'mar');
    expect(ultima().payload).toEqual({ tenantId: 't1', query: 'mar' });
  });
});

describe('media saliente (§5)', () => {
  it('conversationSendAttachment lleva el contrato completo con operationId', async () => {
    await sendConversationAttachment({
      tenantId: 't1',
      customerId: 'c1',
      operationId: 'op-123',
      kind: 'image',
      filename: 'foto.jpg',
      mimeType: 'image/jpeg',
      dataBase64: 'QUJD',
      caption: 'mirá',
    });
    expect(ultima()).toEqual({
      name: 'conversationSendAttachment',
      payload: {
        tenantId: 't1',
        customerId: 'c1',
        operationId: 'op-123',
        kind: 'image',
        filename: 'foto.jpg',
        mimeType: 'image/jpeg',
        dataBase64: 'QUJD',
        caption: 'mirá',
      },
    });
  });
});
