import { describe, it, expect, beforeEach } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * ADR-0021 §4 — BÚSQUEDA SERVER-SIDE DE CLIENTES (para el modal de vínculo).
 * ===========================================================================
 * Lo que este archivo fija:
 *  1. Query saneada: vacía/solo espacios ⇒ invalid-argument; largo con tope.
 *  2. DOS consultas por prefijo con índices single-field automáticos: SIEMPRE por `name`
 *     (orderBy name startAt q..q+) y, si la query es numérica, también por `whatsappPhone`.
 *     Fusión SIN duplicados.
 *  3. `limit` con clamp (≤ 20, default 10). Cursor OPACO por fuente: avanza sin duplicar y sin
 *     saltear; se agota por fuente.
 *  4. Los softDeleted NO aparecen (una ficha eliminada no puede recibir vínculos nuevos).
 */

const docs = new Map<string, Record<string, unknown>>();

const refFor = (path: string) => ({
  id: path.split('/').pop()!,
  path,
  get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
});

interface QueryState {
  path: string;
  field: string;
  startAt?: string;
  startAfter?: string;
  endAt?: string;
  limit?: number;
}

function makeQuery(state: QueryState) {
  return {
    startAt: (v: string) => makeQuery({ ...state, startAt: v }),
    startAfter: (v: string) => makeQuery({ ...state, startAfter: v }),
    endAt: (v: string) => makeQuery({ ...state, endAt: v }),
    limit: (n: number) => makeQuery({ ...state, limit: n }),
    get: async () => {
      let rows = [...docs.entries()]
        .filter(([p]) => p.startsWith(`${state.path}/`) && !p.slice(state.path.length + 1).includes('/'))
        .map(([p, d]) => ({ id: p.split('/').pop()!, data: () => d, valor: d[state.field] }))
        .filter((r) => typeof r.valor === 'string') // orderBy excluye docs sin el campo (Firestore real)
        .sort((a, b) => (a.valor as string).localeCompare(b.valor as string, undefined, { numeric: false }));
      if (state.startAt !== undefined) rows = rows.filter((r) => (r.valor as string) >= state.startAt!);
      if (state.startAfter !== undefined) rows = rows.filter((r) => (r.valor as string) > state.startAfter!);
      if (state.endAt !== undefined) rows = rows.filter((r) => (r.valor as string) <= state.endAt!);
      if (state.limit !== undefined) rows = rows.slice(0, state.limit);
      return { docs: rows, size: rows.length, empty: rows.length === 0 };
    },
  };
}

const fakeDb = {
  doc: (path: string) => refFor(path),
  collection: (path: string) => ({
    orderBy: (field: string) => makeQuery({ path, field }),
  }),
} as unknown as Firestore;

import { searchCustomers, CUSTOMER_SEARCH_MAX_LIMIT, CUSTOMER_SEARCH_DEFAULT_LIMIT } from './linking.js';

const T = 'arfagi';
const col = `tenants/${T}/customers`;

const seed = (id: string, data: Record<string, unknown>) => docs.set(`${col}/${id}`, { id, tenantId: T, ...data });

beforeEach(() => docs.clear());

const seedBase = () => {
  seed('595991111111', { name: 'María López', whatsappPhone: '595991111111' });
  seed('595992222222', { name: 'Marcos Ruiz', whatsappPhone: '595992222222' });
  seed('595993333333', { name: 'Pedro Ayala', whatsappPhone: '595993333333' });
  seed('crm_marta', { name: 'Marta Vera', whatsappPhone: '', conversation: { softDeleted: true } });
};

describe('searchCustomers — saneo y límites', () => {
  it('query vacía o solo espacios ⇒ invalid-argument', async () => {
    for (const q of ['', '   ', '\t']) {
      await expect(searchCustomers(fakeDb, { tenantId: T, query: q })).rejects.toMatchObject({ code: 'invalid-argument' });
    }
  });

  it('cursor corrupto ⇒ invalid-argument', async () => {
    seedBase();
    await expect(searchCustomers(fakeDb, { tenantId: T, query: 'Mar', cursor: '@@no-es-base64@@' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('limit se clampea a 20 y defaultea en 10', async () => {
    for (let i = 10; i < 45; i++) seed(`c${i}`, { name: `Cliente ${i}`, whatsappPhone: `59599${i}` });
    const conTope = await searchCustomers(fakeDb, { tenantId: T, query: 'Cliente', limit: 50 });
    expect(conTope.items.length).toBe(CUSTOMER_SEARCH_MAX_LIMIT);
    const porDefecto = await searchCustomers(fakeDb, { tenantId: T, query: 'Cliente' });
    expect(porDefecto.items.length).toBe(CUSTOMER_SEARCH_DEFAULT_LIMIT);
    expect(porDefecto.nextCursor).toBeTruthy();
  });
});

describe('searchCustomers — prefijos y fusión', () => {
  it('prefijo de nombre: matchea María y Marcos, no Pedro; softDeleted EXCLUIDO', async () => {
    seedBase();
    const r = await searchCustomers(fakeDb, { tenantId: T, query: 'Mar' });
    expect(r.items.map((i) => i.name).sort()).toEqual(['Marcos Ruiz', 'María López']);
    expect(r.items.some((i) => i.name === 'Marta Vera')).toBe(false);
    expect(r.nextCursor).toBeUndefined();
  });

  it('query numérica agrega la consulta por teléfono, fusionada SIN duplicados', async () => {
    seedBase();
    // Nombre que EMPIEZA con los mismos dígitos que su teléfono: aparecería en las dos consultas.
    seed('595994444444', { name: '5959 Shop', whatsappPhone: '595994444444' });
    const r = await searchCustomers(fakeDb, { tenantId: T, query: '5959' });
    const ids = r.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // sin duplicados
    expect(ids).toContain('595991111111');
    expect(ids).toContain('595994444444');
  });

  it('query NO numérica no consulta teléfonos (solo prefijo de nombre)', async () => {
    seedBase();
    const r = await searchCustomers(fakeDb, { tenantId: T, query: 'Pedro' });
    expect(r.items.map((i) => i.id)).toEqual(['595993333333']);
  });

  it('los items exponen id, name, whatsappPhone y profileName solo si existe', async () => {
    seed('595997777777', { name: 'Nina', whatsappPhone: '595997777777', profileName: 'Nina WA' });
    seed('595998888888', { name: 'Noa', whatsappPhone: '595998888888' });
    const r = await searchCustomers(fakeDb, { tenantId: T, query: 'N' });
    const nina = r.items.find((i) => i.id === '595997777777');
    const noa = r.items.find((i) => i.id === '595998888888');
    expect(nina).toEqual({ id: '595997777777', name: 'Nina', whatsappPhone: '595997777777', profileName: 'Nina WA' });
    expect(noa).toEqual({ id: '595998888888', name: 'Noa', whatsappPhone: '595998888888' });
  });
});

describe('searchCustomers — cursor', () => {
  it('pagina por nombre sin duplicar ni saltear y se agota', async () => {
    for (const n of ['01', '02', '03', '04', '05']) seed(`c${n}`, { name: `Cliente ${n}`, whatsappPhone: `5959${n}` });
    const p1 = await searchCustomers(fakeDb, { tenantId: T, query: 'Cliente', limit: 2 });
    expect(p1.items.map((i) => i.name)).toEqual(['Cliente 01', 'Cliente 02']);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await searchCustomers(fakeDb, { tenantId: T, query: 'Cliente', limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((i) => i.name)).toEqual(['Cliente 03', 'Cliente 04']);
    const p3 = await searchCustomers(fakeDb, { tenantId: T, query: 'Cliente', limit: 2, cursor: p2.nextCursor! });
    expect(p3.items.map((i) => i.name)).toEqual(['Cliente 05']);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('pagina por teléfono (query numérica) sin duplicar', async () => {
    seed('a', { name: 'Ana', whatsappPhone: '595901' });
    seed('b', { name: 'Bea', whatsappPhone: '595902' });
    seed('c', { name: 'Cami', whatsappPhone: '595903' });
    const p1 = await searchCustomers(fakeDb, { tenantId: T, query: '5959', limit: 2 });
    expect(p1.items.map((i) => i.whatsappPhone)).toEqual(['595901', '595902']);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await searchCustomers(fakeDb, { tenantId: T, query: '5959', limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((i) => i.whatsappPhone)).toEqual(['595903']);
    expect(p2.nextCursor).toBeUndefined();
  });
});
