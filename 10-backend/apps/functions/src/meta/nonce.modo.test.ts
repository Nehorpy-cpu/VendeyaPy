/**
 * nonce.modo.test.ts — UN NONCE ESTÁNDAR NO PUEDE CONSUMIRSE COMO COEXISTENCE
 * ===========================================================================
 * ADR-0017 §5: el onboarding de Coexistence NO es el mismo acto que un alta estándar. Pide otro
 * consentimiento, otro `config_id`, otra ventana (24 h) y tiene otras consecuencias sobre un número
 * con clientes vivos. `nonce.ts` ya declaraba el campo `mode`, pero SIN escribirlo ni validarlo:
 * cualquiera podía pedir un nonce por el botón estándar y presentarlo para cerrar un Coexistence
 * (o al revés), y el backend no tenía cómo notarlo.
 *
 * La atadura tiene que ser TRANSACCIONAL y en el mismo documento que el tenant, el uid y el
 * vencimiento: un modo que viviera aparte se podría desincronizar justo en el medio del flujo.
 *
 * RETROCOMPATIBILIDAD: los nonces ya emitidos (sin campo) son ESTÁNDAR — que es el único flujo que
 * existía cuando se emitieron. Tratarlos de otra forma rompería un flujo en curso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (data: Record<string, unknown>) => { docs.set(path, data); },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const ops: Array<{ tipo: 'set' | 'delete'; path: string; data?: Record<string, unknown> }> = [];
      const tx = {
        get: async (ref: { path: string }) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        set: (ref: { path: string }, data: Record<string, unknown>) => ops.push({ tipo: 'set', path: ref.path, data }),
        create: (ref: { path: string }, data: Record<string, unknown>) => ops.push({ tipo: 'set', path: ref.path, data }),
        delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      };
      const r = await fn(tx);
      for (const op of ops) {
        if (op.tipo === 'delete') docs.delete(op.path);
        else docs.set(op.path, op.data!);
      }
      return r;
    },
  }),
}));

import { createMetaConnectNonce, consumeMetaConnectNonce, isNonceValid, type NonceDoc } from './nonce.js';

const CTX = { tenantId: 'tnt_alpha', uid: 'uid-1' };
const NOW = 1_000_000;

beforeEach(() => docs.clear());

describe('isNonceValid — el modo es parte de la identidad del nonce', () => {
  const base: NonceDoc = { tenantId: 'tnt_alpha', uid: 'uid-1', createdAtMs: NOW - 1000, expiresAtMs: NOW + 1000 };

  it('un nonce de Coexistence NO vale para cerrar un alta estándar', () => {
    const doc = { ...base, mode: 'coexistence' as const };
    expect(isNonceValid(doc, { ...CTX, nowMs: NOW, mode: 'standard' })).toBe(false);
  });

  it('un nonce estándar NO vale para cerrar un Coexistence', () => {
    const doc = { ...base, mode: 'standard' as const };
    expect(isNonceValid(doc, { ...CTX, nowMs: NOW, mode: 'coexistence' })).toBe(false);
  });

  it('cada modo vale para el suyo', () => {
    expect(isNonceValid({ ...base, mode: 'coexistence' }, { ...CTX, nowMs: NOW, mode: 'coexistence' })).toBe(true);
    expect(isNonceValid({ ...base, mode: 'standard' }, { ...CTX, nowMs: NOW, mode: 'standard' })).toBe(true);
  });

  it('RETROCOMPATIBLE: un nonce SIN modo (ya emitido) es estándar', () => {
    expect(isNonceValid(base, { ...CTX, nowMs: NOW, mode: 'standard' })).toBe(true);
    expect(isNonceValid(base, { ...CTX, nowMs: NOW, mode: 'coexistence' })).toBe(false);
  });

  it('un modo IRRECONOCIBLE en el documento no habilita nada (fail-closed)', () => {
    const doc = { ...base, mode: 'COEXISTENCE' as unknown as NonceDoc['mode'] };
    expect(isNonceValid(doc, { ...CTX, nowMs: NOW, mode: 'coexistence' })).toBe(false);
    expect(isNonceValid(doc, { ...CTX, nowMs: NOW, mode: 'standard' })).toBe(false);
  });

  it('el modo no reemplaza a las otras ataduras: tenant, uid y vencimiento siguen mandando', () => {
    const doc = { ...base, mode: 'coexistence' as const };
    expect(isNonceValid(doc, { tenantId: 'tnt_beta', uid: 'uid-1', nowMs: NOW, mode: 'coexistence' })).toBe(false);
    expect(isNonceValid(doc, { tenantId: 'tnt_alpha', uid: 'uid-2', nowMs: NOW, mode: 'coexistence' })).toBe(false);
    expect(isNonceValid({ ...doc, expiresAtMs: NOW - 1 }, { ...CTX, nowMs: NOW, mode: 'coexistence' })).toBe(false);
  });
});

describe('el modo queda escrito en el MISMO documento que el resto de la atadura', () => {
  it('createMetaConnectNonce persiste el modo junto a tenant, uid y vencimiento', async () => {
    const nonce = await createMetaConnectNonce(CTX.tenantId, CTX.uid, 'coexistence');
    const doc = docs.get(`metaOAuthStates/${nonce}`)!;
    expect(doc['mode']).toBe('coexistence');
    expect(doc['tenantId']).toBe(CTX.tenantId);
    expect(doc['uid']).toBe(CTX.uid);
    expect(typeof doc['expiresAtMs']).toBe('number');
  });

  it('sin modo explícito se emite un nonce ESTÁNDAR (el flujo que ya existía)', async () => {
    const nonce = await createMetaConnectNonce(CTX.tenantId, CTX.uid);
    expect(docs.get(`metaOAuthStates/${nonce}`)!['mode']).toBe('standard');
  });
});

describe('consumeMetaConnectNonce — el cruce de modos se rechaza de punta a punta', () => {
  it('un nonce de Coexistence presentado como estándar se rechaza', async () => {
    const nonce = await createMetaConnectNonce(CTX.tenantId, CTX.uid, 'coexistence');
    expect(await consumeMetaConnectNonce(nonce, { ...CTX, mode: 'standard' })).toBe(false);
  });

  it('un nonce estándar presentado como Coexistence se rechaza', async () => {
    const nonce = await createMetaConnectNonce(CTX.tenantId, CTX.uid, 'standard');
    expect(await consumeMetaConnectNonce(nonce, { ...CTX, mode: 'coexistence' })).toBe(false);
  });

  it('cada nonce se consume en su modo, y UNA sola vez', async () => {
    const nonce = await createMetaConnectNonce(CTX.tenantId, CTX.uid, 'coexistence');
    expect(await consumeMetaConnectNonce(nonce, { ...CTX, mode: 'coexistence' })).toBe(true);
    expect(await consumeMetaConnectNonce(nonce, { ...CTX, mode: 'coexistence' })).toBe(false);
  });

  it('un rechazo por modo tampoco deja el nonce reutilizable (se quema igual)', async () => {
    const nonce = await createMetaConnectNonce(CTX.tenantId, CTX.uid, 'standard');
    expect(await consumeMetaConnectNonce(nonce, { ...CTX, mode: 'coexistence' })).toBe(false);
    expect(await consumeMetaConnectNonce(nonce, { ...CTX, mode: 'standard' })).toBe(false);
  });
});
