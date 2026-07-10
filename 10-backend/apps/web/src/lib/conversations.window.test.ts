/**
 * conversations.window.test.ts — ventana de mensajes del chat (/conversations).
 * Bug real en prod: getMessages con orderBy 'asc' + limit devolvía los 200 MÁS VIEJOS,
 * congelando el chat cuando la conversación superaba el límite (la lista sí mostraba
 * los nuevos porque lee el resumen denormalizado del cliente).
 * Fija: consulta descendente (últimos N) + reverse a orden cronológico.
 */
import { describe, it, expect, vi } from 'vitest';

const { getDocsMock, orderByMock } = vi.hoisted(() => ({
  getDocsMock: vi.fn(),
  orderByMock: vi.fn((field: string, dir: string) => ({ field, dir })),
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(),
  getDoc: vi.fn(),
  getDocs: getDocsMock,
  query: vi.fn((_col: unknown, ...clauses: unknown[]) => ({ clauses })),
  orderBy: orderByMock,
  limit: vi.fn((n: number) => ({ limit: n })),
}));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn() }));
vi.mock('./firebase', () => ({ firebaseDb: () => ({}), firebaseFunctions: () => ({}) }));

import { getMessages } from './conversations';

describe('getMessages (ventana de los ÚLTIMOS mensajes)', () => {
  it('consulta descendente por createdAt (los últimos N, no los primeros)', async () => {
    getDocsMock.mockResolvedValueOnce({ docs: [] });
    await getMessages('arfagi', 'c1');
    expect(orderByMock).toHaveBeenCalledWith('createdAt', 'desc');
  });

  it('invierte el resultado a orden cronológico (viejo → nuevo)', async () => {
    // Firestore desc entrega el más nuevo primero.
    getDocsMock.mockResolvedValueOnce({
      docs: [
        { data: () => ({ text: 'm3-nuevo' }) },
        { data: () => ({ text: 'm2' }) },
        { data: () => ({ text: 'm1-viejo' }) },
      ],
    });
    const msgs = await getMessages('arfagi', 'c1');
    expect(msgs.map((m) => (m as { text: string }).text)).toEqual(['m1-viejo', 'm2', 'm3-nuevo']);
  });
});
