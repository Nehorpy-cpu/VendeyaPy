import { describe, it, expect, beforeEach } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * ADR-0021 §4 — VÍNCULO CONVERSACIÓN ↔ CLIENTE.
 * ==============================================
 * Lo que este archivo fija:
 *  1. PERMISOS: solo TENANT_MANAGER/TENANT_OWNER/PLATFORM_ADMIN (SELLER ⇒ permission-denied).
 *  2. BLOQUEOS del vínculo, transaccionales (el destino se relee DENTRO de la tx):
 *     destino inexistente ⇒ client_not_found; destino softDeleted ⇒ client_deleted;
 *     auto-vínculo ⇒ invalid-argument; destino a su vez vinculado (cadena) ⇒ client_already_linked.
 *  3. createClient: id `crm_<autoid>` (jamás derivado del teléfono), name confirmado OBLIGATORIO
 *     (saneado), ficha SIN `conversation`, y el vínculo sale en la MISMA operación atómica.
 *  4. Idempotencia: re-vincular al mismo destino / desvincular lo no vinculado ⇒ ok sin escritura.
 */

const docs = new Map<string, Record<string, unknown>>();
let escrituras = 0;
let autoN = 0;

const esObjetoPlano = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

function mergeProfundo(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = esObjetoPlano(v) && esObjetoPlano(out[k]) ? mergeProfundo(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

const refFor = (path: string) => ({
  id: path.split('/').pop()!,
  path,
  get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
  set: async (d: Record<string, unknown>, opts?: { merge?: boolean }) => {
    escrituras++;
    docs.set(path, opts?.merge ? mergeProfundo(docs.get(path) ?? {}, d) : { ...d });
  },
});

const fakeDb = {
  doc: (path: string) => refFor(path),
  collection: (path: string) => ({
    doc: () => refFor(`${path}/aut0${++autoN}`),
    // Query por igualdad (para el check de "¿el source ya es ficha canónica de alguien?").
    where: (field: string, _op: string, value: unknown) => ({
      limit: (n: number) => ({
        get: async () => {
          const hijos = [...docs.entries()]
            .filter(([p, d]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/') && d[field] === value)
            .slice(0, n)
            .map(([p, d]) => ({ id: p.split('/').pop()!, ref: refFor(p), data: () => d }));
          return { empty: hijos.length === 0, size: hijos.length, docs: hijos };
        },
      }),
    }),
  }),
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: (ref: { set: (d: Record<string, unknown>, o?: { merge?: boolean }) => Promise<void> }, d: Record<string, unknown>, o?: { merge?: boolean }) => void ref.set(d, o),
      create: (ref: { path: string; set: (d: Record<string, unknown>) => Promise<void> }, d: Record<string, unknown>) => {
        if (docs.has(ref.path)) throw Object.assign(new Error('already exists'), { code: 6 });
        void ref.set(d);
      },
    }),
} as unknown as Firestore;

import { linkConversationToClient, unlinkConversationClient, createAndLinkClient } from './linking.js';

const T = 'arfagi';
const C = '595994893000';
const P_CUST = `tenants/${T}/customers/${C}`;
const CRM = 'crm_abc123';
const P_CRM = `tenants/${T}/customers/${CRM}`;

const seed = (path: string, data: Record<string, unknown> = {}) =>
  docs.set(path, { id: path.split('/').pop(), tenantId: T, ...data });

const cust = (p = P_CUST) => docs.get(p) as Record<string, unknown>;

const MANAGER = { uid: 'u-mgr', role: 'TENANT_MANAGER', name: 'Gerenta' };
const SELLER = { uid: 'u-seller', role: 'SELLER', name: 'Vendedora' };

const kindOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return ((e as HttpsError).details as { kind?: string } | undefined)?.kind ?? (e as HttpsError).code;
  }
};

beforeEach(() => {
  docs.clear();
  escrituras = 0;
  autoN = 0;
});

describe('linkConversationToClient', () => {
  it('MANAGER vincula a una ficha existente del MISMO tenant', async () => {
    seed(P_CUST);
    seed(P_CRM, { name: 'María Pérez' });
    const r = await linkConversationToClient(fakeDb, { tenantId: T, customerId: C, clientId: CRM }, MANAGER);
    expect(r).toEqual({ ok: true, changed: true });
    expect(cust()['linkedClientId']).toBe(CRM);
  });

  it('SELLER no puede vincular/desvincular/crear ⇒ permission-denied sin escritura', async () => {
    seed(P_CUST);
    seed(P_CRM);
    await expect(linkConversationToClient(fakeDb, { tenantId: T, customerId: C, clientId: CRM }, SELLER)).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(unlinkConversationClient(fakeDb, { tenantId: T, customerId: C }, SELLER)).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(createAndLinkClient(fakeDb, { tenantId: T, customerId: C, name: 'Ana' }, SELLER)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(escrituras).toBe(0);
  });

  it('auto-vínculo (clientId === customerId) ⇒ invalid-argument', async () => {
    seed(P_CUST);
    await expect(linkConversationToClient(fakeDb, { tenantId: T, customerId: C, clientId: C }, MANAGER)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(escrituras).toBe(0);
  });

  it('destino inexistente ⇒ client_not_found; conversación inexistente ⇒ not-found', async () => {
    seed(P_CUST);
    expect(await kindOf(linkConversationToClient(fakeDb, { tenantId: T, customerId: C, clientId: 'crm_nadie' }, MANAGER))).toBe('client_not_found');
    docs.clear();
    seed(P_CRM);
    await expect(linkConversationToClient(fakeDb, { tenantId: T, customerId: C, clientId: CRM }, MANAGER)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('destino softDeleted ⇒ client_deleted (fail-closed, se relee EN la tx)', async () => {
    seed(P_CUST);
    seed(P_CRM, { conversation: { softDeleted: true } });
    expect(await kindOf(linkConversationToClient(fakeDb, { tenantId: T, customerId: C, clientId: CRM }, MANAGER))).toBe('client_deleted');
    expect(cust()['linkedClientId']).toBeUndefined();
  });

  it('destino que a su vez está vinculado (cadena) ⇒ client_already_linked', async () => {
    seed(P_CUST);
    seed(P_CRM, { linkedClientId: 'crm_canonica' });
    expect(await kindOf(linkConversationToClient(fakeDb, { tenantId: T, customerId: C, clientId: CRM }, MANAGER))).toBe('client_already_linked');
    expect(cust()['linkedClientId']).toBeUndefined();
  });

  it('M1: el SOURCE que ya es ficha canónica de otros NO puede vincularse (cadena inversa A→B→C)', async () => {
    // A (595880…) ya apunta a C: C es ficha canónica. Vincular C→CRM crearía A→C→CRM.
    seed(P_CUST);
    seed(`tenants/${T}/customers/595880000000`, { linkedClientId: C });
    seed(P_CRM);
    expect(await kindOf(linkConversationToClient(fakeDb, { tenantId: T, customerId: C, clientId: CRM }, MANAGER))).toBe('client_is_canonical');
    expect(cust()['linkedClientId']).toBeUndefined();
  });

  it('M1 legítimo: DOS conversaciones pueden apuntar a la MISMA ficha (A→B y C→B)', async () => {
    // A ya apunta a CRM; C→CRM no es cadena (CRM no tiene vínculo propio y C no es canónica).
    seed(P_CUST);
    seed(`tenants/${T}/customers/595880000000`, { linkedClientId: CRM });
    seed(P_CRM);
    const r = await linkConversationToClient(fakeDb, { tenantId: T, customerId: C, clientId: CRM }, MANAGER);
    expect(r).toEqual({ ok: true, changed: true });
    expect(cust()['linkedClientId']).toBe(CRM);
  });

  it('B3: el SOURCE softDeleted no puede vincularse (coherente con el bloqueo de envíos)', async () => {
    seed(P_CUST, { conversation: { softDeleted: true } });
    seed(P_CRM);
    expect(await kindOf(linkConversationToClient(fakeDb, { tenantId: T, customerId: C, clientId: CRM }, MANAGER))).toBe('conversation_deleted');
    expect(cust()['linkedClientId']).toBeUndefined();
  });

  it('re-vincular al MISMO destino ⇒ no-op; CAMBIAR de destino ⇒ escribe', async () => {
    seed(P_CUST, { linkedClientId: CRM });
    seed(P_CRM);
    seed(`tenants/${T}/customers/crm_otra`, {});
    const antes = escrituras;
    expect((await linkConversationToClient(fakeDb, { tenantId: T, customerId: C, clientId: CRM }, MANAGER)).changed).toBe(false);
    expect(escrituras).toBe(antes);
    expect((await linkConversationToClient(fakeDb, { tenantId: T, customerId: C, clientId: 'crm_otra' }, MANAGER)).changed).toBe(true);
    expect(cust()['linkedClientId']).toBe('crm_otra');
  });
});

describe('unlinkConversationClient', () => {
  it('quita el vínculo; desvincular lo no vinculado ⇒ no-op', async () => {
    seed(P_CUST, { linkedClientId: CRM });
    const r = await unlinkConversationClient(fakeDb, { tenantId: T, customerId: C }, MANAGER);
    expect(r).toEqual({ ok: true, changed: true });
    expect(cust()['linkedClientId']).toBeNull();
    expect((await unlinkConversationClient(fakeDb, { tenantId: T, customerId: C }, MANAGER)).changed).toBe(false);
  });

  it('conversación inexistente ⇒ not-found', async () => {
    await expect(unlinkConversationClient(fakeDb, { tenantId: T, customerId: C }, MANAGER)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('createAndLinkClient', () => {
  it('crea la ficha crm_<autoid> con name saneado y vincula EN la misma operación', async () => {
    seed(P_CUST);
    const r = await createAndLinkClient(fakeDb, { tenantId: T, customerId: C, name: '  María   Pérez  ', notes: ' cliente de la sucursal ' }, MANAGER);
    expect(r.ok).toBe(true);
    expect(r.clientId).toMatch(/^crm_/);
    const ficha = cust(`tenants/${T}/customers/${r.clientId}`);
    expect(ficha).toMatchObject({
      id: r.clientId,
      tenantId: T,
      name: 'María Pérez',
      notes: 'cliente de la sucursal',
      whatsappPhone: '',
      tags: [],
      stats: { totalOrders: 0, totalSpent: 0, lastOrderAt: null, firstOrderAt: null },
    });
    // La ficha CRM NO tiene conversación: no es una bandeja, es una ficha.
    expect('conversation' in ficha).toBe(false);
    expect(cust()['linkedClientId']).toBe(r.clientId);
  });

  it('name vacío / solo espacios ⇒ invalid-argument sin crear nada', async () => {
    seed(P_CUST);
    for (const name of ['', '   ', '\n\t']) {
      await expect(createAndLinkClient(fakeDb, { tenantId: T, customerId: C, name }, MANAGER)).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(escrituras).toBe(0);
  });

  it('name larguísimo se recorta al tope (no se rechaza: dato confirmado, se sanea)', async () => {
    seed(P_CUST);
    const r = await createAndLinkClient(fakeDb, { tenantId: T, customerId: C, name: 'A'.repeat(500) }, MANAGER);
    expect((cust(`tenants/${T}/customers/${r.clientId}`)['name'] as string).length).toBeLessThanOrEqual(120);
  });

  it('conversación origen inexistente ⇒ not-found, sin ficha creada', async () => {
    await expect(createAndLinkClient(fakeDb, { tenantId: T, customerId: C, name: 'Ana' }, MANAGER)).rejects.toMatchObject({ code: 'not-found' });
    expect([...docs.keys()].some((p) => p.includes('/customers/crm_'))).toBe(false);
  });

  it('M1: crear ficha SOBRE una conversación que ya es canónica de otros ⇒ client_is_canonical, sin ficha', async () => {
    seed(P_CUST);
    seed(`tenants/${T}/customers/595880000000`, { linkedClientId: C });
    expect(await kindOf(createAndLinkClient(fakeDb, { tenantId: T, customerId: C, name: 'Ana' }, MANAGER))).toBe('client_is_canonical');
    expect([...docs.keys()].some((p) => p.includes('/customers/crm_'))).toBe(false);
    expect(cust()['linkedClientId']).toBeUndefined();
  });

  it('B3: crear ficha SOBRE una conversación softDeleted ⇒ conversation_deleted, sin ficha', async () => {
    seed(P_CUST, { conversation: { softDeleted: true } });
    expect(await kindOf(createAndLinkClient(fakeDb, { tenantId: T, customerId: C, name: 'Ana' }, MANAGER))).toBe('conversation_deleted');
    expect([...docs.keys()].some((p) => p.includes('/customers/crm_'))).toBe(false);
  });
});
