import { describe, it, expect, beforeEach } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * ADR-0021 §3/§7 — CICLO DE VIDA DE LA CONVERSACIÓN + ASIGNACIÓN MANUAL.
 * =======================================================================
 * Lo que este archivo fija:
 *  1. MATRIZ DE PERMISOS (normativa): archivar/desarchivar = cualquier staff (SELLER incluido);
 *     softDelete/restore y asignar = SOLO TENANT_MANAGER/TENANT_OWNER/PLATFORM_ADMIN.
 *  2. REVERSIBLE Y ORTOGONAL: softDelete no toca `archived` ni viceversa. Jamás hay delete físico.
 *  3. IDEMPOTENTE: repetir la acción vigente ⇒ ok SIN escritura (y el wrapper no re-audita).
 *  4. ASIGNAR ≠ TOMAR: la asignación nunca toca humanTakeover.
 *  5. FAIL-CLOSED en assign: el destino debe ser staff ACTIVO del MISMO tenant (users/{uid}).
 */

// ---- doble de Firestore (docs en memoria + set con merge profundo + transacción) ----
const docs = new Map<string, Record<string, unknown>>();
let escrituras = 0;

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
  collection: (path: string) => ({ doc: () => refFor(`${path}/autoid1`) }),
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: (ref: { set: (d: Record<string, unknown>, o?: { merge?: boolean }) => Promise<void> }, d: Record<string, unknown>, o?: { merge?: boolean }) => void ref.set(d, o),
    }),
} as unknown as Firestore;

import { applyConversationLifecycle, assignConversationSeller, markConversationReadExisting } from './lifecycle.js';
import { assertStaffAccess } from '../functions/conversation/staffAuth.js';

const T = 'arfagi';
const C = '595994893000';
const P_CUST = `tenants/${T}/customers/${C}`;

const seedCustomer = (conv: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  docs.set(P_CUST, {
    id: C,
    tenantId: T,
    whatsappPhone: C,
    conversation: { humanTakeover: false, unreadForSeller: 0, ...conv },
    ...extra,
  });

const seedUser = (uid: string, over: Record<string, unknown> = {}) =>
  docs.set(`users/${uid}`, { id: uid, tenantId: T, role: 'SELLER', status: 'ACTIVE', name: 'Vende Dora', email: 'v@x.com', ...over });

const cust = () => docs.get(P_CUST) as Record<string, unknown> & { conversation?: Record<string, unknown> };

const SELLER = { uid: 'u-seller', role: 'SELLER', name: 'Vendedora' };
const MANAGER = { uid: 'u-mgr', role: 'TENANT_MANAGER', name: 'Gerenta' };

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
});

describe('applyConversationLifecycle — archivar/desarchivar (cualquier staff)', () => {
  it('SELLER archiva: flags + actor + timestamp, softDeleted intacto', async () => {
    seedCustomer();
    const r = await applyConversationLifecycle(fakeDb, T, C, 'archive', SELLER);
    expect(r).toEqual({ ok: true, changed: true });
    expect(cust().conversation).toMatchObject({ archived: true, archivedBy: 'u-seller' });
    expect(cust().conversation?.['archivedAt']).toBeTruthy();
    expect(cust().conversation?.['softDeleted']).toBeUndefined();
    // El resto del resumen NO se pisa (merge de hoja).
    expect(cust().conversation?.['humanTakeover']).toBe(false);
  });

  it('archivar lo ya archivado ⇒ ok idempotente SIN escritura', async () => {
    seedCustomer({ archived: true, archivedAt: 'antes', archivedBy: 'otro' });
    const antes = escrituras;
    const r = await applyConversationLifecycle(fakeDb, T, C, 'archive', SELLER);
    expect(r).toEqual({ ok: true, changed: false });
    expect(escrituras).toBe(antes);
    expect(cust().conversation?.['archivedBy']).toBe('otro'); // no se re-firma
  });

  it('desarchivar limpia los tres campos; desarchivar lo no archivado ⇒ no-op', async () => {
    seedCustomer({ archived: true, archivedAt: 'x', archivedBy: 'u' });
    const r1 = await applyConversationLifecycle(fakeDb, T, C, 'unarchive', SELLER);
    expect(r1.changed).toBe(true);
    expect(cust().conversation).toMatchObject({ archived: false, archivedAt: null, archivedBy: null });
    const r2 = await applyConversationLifecycle(fakeDb, T, C, 'unarchive', SELLER);
    expect(r2.changed).toBe(false);
  });

  it('conversación inexistente ⇒ not-found', async () => {
    await expect(applyConversationLifecycle(fakeDb, T, C, 'archive', SELLER)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('applyConversationLifecycle — softDelete/restore (solo manager+)', () => {
  it('SELLER NO puede softDelete ni restore ⇒ permission-denied sin escritura', async () => {
    seedCustomer();
    for (const action of ['softDelete', 'restore'] as const) {
      await expect(applyConversationLifecycle(fakeDb, T, C, action, SELLER)).rejects.toMatchObject({ code: 'permission-denied' });
    }
    expect(escrituras).toBe(0);
  });

  it('MANAGER/OWNER/PLATFORM_ADMIN sí pueden softDelete (reversible, sin delete físico)', async () => {
    for (const role of ['TENANT_MANAGER', 'TENANT_OWNER', 'PLATFORM_ADMIN']) {
      docs.clear();
      seedCustomer();
      const r = await applyConversationLifecycle(fakeDb, T, C, 'softDelete', { uid: 'u1', role });
      expect(r.changed).toBe(true);
      expect(cust().conversation).toMatchObject({ softDeleted: true, softDeletedBy: 'u1' });
      // El doc del cliente SIGUE existiendo: es eliminación lógica.
      expect(docs.has(P_CUST)).toBe(true);
    }
  });

  it('softDelete NO toca archived (y restore tampoco)', async () => {
    seedCustomer({ archived: true, archivedAt: 'x', archivedBy: 'u9' });
    await applyConversationLifecycle(fakeDb, T, C, 'softDelete', MANAGER);
    expect(cust().conversation).toMatchObject({ archived: true, archivedAt: 'x', archivedBy: 'u9', softDeleted: true });
    await applyConversationLifecycle(fakeDb, T, C, 'restore', MANAGER);
    expect(cust().conversation).toMatchObject({ archived: true, softDeleted: false, softDeletedAt: null, softDeletedBy: null });
  });

  it('softDelete repetido / restore de lo no eliminado ⇒ no-op idempotente', async () => {
    seedCustomer({ softDeleted: true, softDeletedAt: 'x', softDeletedBy: 'u' });
    expect((await applyConversationLifecycle(fakeDb, T, C, 'softDelete', MANAGER)).changed).toBe(false);
    await applyConversationLifecycle(fakeDb, T, C, 'restore', MANAGER);
    expect((await applyConversationLifecycle(fakeDb, T, C, 'restore', MANAGER)).changed).toBe(false);
  });
});

describe('assignConversationSeller — asignar vendedor (solo manager+)', () => {
  it('MANAGER asigna a un SELLER activo del MISMO tenant: persiste id + nombre legible', async () => {
    seedCustomer({ humanTakeover: true });
    seedUser('u-dest');
    const r = await assignConversationSeller(fakeDb, T, C, 'u-dest', MANAGER);
    expect(r).toEqual({ ok: true, changed: true, sellerName: 'Vende Dora' });
    expect(cust()).toMatchObject({ assignedSellerId: 'u-dest', assignedSellerName: 'Vende Dora' });
    // ASIGNAR ≠ TOMAR: humanTakeover queda EXACTAMENTE como estaba.
    expect(cust().conversation?.['humanTakeover']).toBe(true);
  });

  it('SELLER no puede asignar ⇒ permission-denied', async () => {
    seedCustomer();
    seedUser('u-dest');
    await expect(assignConversationSeller(fakeDb, T, C, 'u-dest', SELLER)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(escrituras).toBe(0);
  });

  it('destino inexistente / de OTRO tenant / DISABLED / VIEWER ⇒ seller_not_found sin escritura', async () => {
    seedCustomer();
    seedUser('u-otro-tenant', { tenantId: 'otra-empresa' });
    seedUser('u-off', { status: 'DISABLED' });
    seedUser('u-viewer', { role: 'TENANT_VIEWER' });
    for (const uid of ['u-fantasma', 'u-otro-tenant', 'u-off', 'u-viewer']) {
      expect(await kindOf(assignConversationSeller(fakeDb, T, C, uid, MANAGER))).toBe('seller_not_found');
    }
    expect(cust()['assignedSellerId']).toBeUndefined();
  });

  it('sellerUid null limpia la asignación; limpiar lo no asignado ⇒ no-op', async () => {
    seedCustomer({}, { assignedSellerId: 'u-dest', assignedSellerName: 'Vende Dora' });
    const r = await assignConversationSeller(fakeDb, T, C, null, MANAGER);
    expect(r).toEqual({ ok: true, changed: true, sellerName: null });
    expect(cust()).toMatchObject({ assignedSellerId: null, assignedSellerName: null });
    expect((await assignConversationSeller(fakeDb, T, C, null, MANAGER)).changed).toBe(false);
  });

  it('re-asignar al MISMO vendedor ⇒ no-op idempotente', async () => {
    seedCustomer({}, { assignedSellerId: 'u-dest', assignedSellerName: 'Vende Dora' });
    seedUser('u-dest');
    const antes = escrituras;
    expect((await assignConversationSeller(fakeDb, T, C, 'u-dest', MANAGER)).changed).toBe(false);
    expect(escrituras).toBe(antes);
  });

  it('conversación inexistente ⇒ not-found', async () => {
    seedUser('u-dest');
    await expect(assignConversationSeller(fakeDb, T, C, 'u-dest', MANAGER)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('markConversationReadExisting — marcar leído SIN crear docs fantasma (B4)', () => {
  it('cliente inexistente ⇒ not-found customer_not_found y NO se crea ningún doc stub', async () => {
    expect(await kindOf(markConversationReadExisting(fakeDb, T, C))).toBe('customer_not_found');
    expect(docs.has(P_CUST)).toBe(false);
    expect(escrituras).toBe(0);
  });

  it('cliente existente ⇒ resetea unreadForSeller a 0 sin pisar el resto; idempotente', async () => {
    seedCustomer({ unreadForSeller: 3, humanTakeover: true, archived: true });
    const r1 = await markConversationReadExisting(fakeDb, T, C);
    expect(r1).toEqual({ ok: true });
    expect(cust().conversation).toMatchObject({ unreadForSeller: 0, humanTakeover: true, archived: true });
    const r2 = await markConversationReadExisting(fakeDb, T, C);
    expect(r2).toEqual({ ok: true });
    expect(cust().conversation?.['unreadForSeller']).toBe(0);
  });
});

describe('matriz §7 — el corte de VIEWER y cross-tenant lo hace staffAuth (cubierto acá)', () => {
  it('TENANT_VIEWER no es staff ⇒ permission-denied antes de llegar a cualquier callable', () => {
    expect(() => assertStaffAccess({ uid: 'u', token: { tenantId: T, role: 'TENANT_VIEWER' } }, T)).toThrow(HttpsError);
  });

  it('staff de OTRO tenant ⇒ permission-denied (cross-tenant imposible)', () => {
    expect(() => assertStaffAccess({ uid: 'u', token: { tenantId: 'otra-empresa', role: 'TENANT_OWNER' } }, T)).toThrow(/acceso/);
  });
});
