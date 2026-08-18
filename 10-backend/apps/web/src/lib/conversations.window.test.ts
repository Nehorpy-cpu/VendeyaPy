/**
 * conversations.window.test.ts — ventana de mensajes del chat (/conversations).
 * Bug real en prod: getMessages con orderBy 'asc' + limit devolvía los 200 MÁS VIEJOS,
 * congelando el chat cuando la conversación superaba el límite (la lista sí mostraba
 * los nuevos porque lee el resumen denormalizado del cliente).
 * Fija: consulta descendente (últimos N) + reverse a orden cronológico.
 */
import { describe, it, expect, vi } from 'vitest';

const { getDocsMock, orderByMock, startAfterMock, queryMock } = vi.hoisted(() => ({
  getDocsMock: vi.fn(),
  orderByMock: vi.fn((field: string, dir: string) => ({ field, dir })),
  startAfterMock: vi.fn((cursor: unknown) => ({ startAfter: cursor })),
  queryMock: vi.fn((_col: unknown, ...clauses: unknown[]) => ({ clauses })),
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(),
  getDoc: vi.fn(),
  getDocs: getDocsMock,
  query: queryMock,
  orderBy: orderByMock,
  limit: vi.fn((n: number) => ({ limit: n })),
  startAfter: startAfterMock,
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

  it('sin cursor NO agrega startAfter (la ventana viva no cambia de forma)', async () => {
    getDocsMock.mockResolvedValueOnce({ docs: [] });
    startAfterMock.mockClear();
    await getMessages('arfagi', 'c1');
    expect(startAfterMock).not.toHaveBeenCalled();
  });
});

describe('getMessages con cursor (ADR-0021 — paginación hacia atrás)', () => {
  it('mantiene desc + startAfter(cursor) + reverse: la página anterior llega cronológica', async () => {
    // Página anterior en desc: Firestore entrega el más nuevo (de los viejos) primero.
    getDocsMock.mockResolvedValueOnce({
      docs: [
        { data: () => ({ id: 'b', text: 'viejo-2' }) },
        { data: () => ({ id: 'a', text: 'viejo-1' }) },
      ],
    });
    orderByMock.mockClear();
    startAfterMock.mockClear();
    queryMock.mockClear();

    const cursor = { seconds: 100 }; // createdAt del mensaje más viejo ya cargado
    const msgs = await getMessages('arfagi', 'c1', 50, cursor);

    expect(orderByMock).toHaveBeenCalledWith('createdAt', 'desc');
    expect(startAfterMock).toHaveBeenCalledWith(cursor);
    // El orden de cláusulas importa: orderBy → startAfter → limit (cursor sobre el MISMO orden).
    const clauses = (queryMock.mock.calls[0] as unknown[]).slice(1);
    expect(clauses).toEqual([
      { field: 'createdAt', dir: 'desc' },
      { startAfter: cursor },
      { limit: 50 },
    ]);
    expect(msgs.map((m) => (m as { text: string }).text)).toEqual(['viejo-1', 'viejo-2']);
  });
});
