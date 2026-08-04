/**
 * nonce.codigo.test.ts — EL `code` DE META SE PODÍA REPRODUCIR
 * =============================================================
 * El nonce se consume una sola vez, pero nada impedía pedir OTRO nonce (`startMetaConnect` no tiene
 * límite) y volver a mandar el MISMO `code`. Sin registro de códigos usados no hay single-flight:
 * dos invocaciones concurrentes del mismo code corrían el flujo entero dos veces, cada una
 * escribiendo secreto y conexión sobre la conexión que está vendiendo.
 *
 * El registro guarda el HASH del code, nunca el code: es una credencial de un solo uso y no tiene
 * por qué quedar legible en Firestore.
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

import { createMetaConnectNonce, consumeMetaConnectNonce, claimMetaConnectCode } from './nonce.js';

const CTX = { tenantId: 'tnt_alpha', uid: 'uid-1' };
const CODE = 'code-de-prueba-no-real';

beforeEach(() => docs.clear());

describe('claimMetaConnectCode — un code se usa UNA sola vez', () => {
  it('el primer reclamo lo toma', async () => {
    expect(await claimMetaConnectCode(CODE, CTX)).toBe(true);
  });

  it('el segundo reclamo del MISMO code se rechaza (replay)', async () => {
    expect(await claimMetaConnectCode(CODE, CTX)).toBe(true);
    expect(await claimMetaConnectCode(CODE, CTX)).toBe(false);
  });

  it('tampoco lo puede reclamar otro tenant con un nonce nuevo', async () => {
    expect(await claimMetaConnectCode(CODE, CTX)).toBe(true);
    expect(await claimMetaConnectCode(CODE, { tenantId: 'tnt_beta', uid: 'uid-2' })).toBe(false);
  });

  it('un code distinto sigue pudiendo reclamarse', async () => {
    expect(await claimMetaConnectCode(CODE, CTX)).toBe(true);
    expect(await claimMetaConnectCode('otro-code-de-prueba', CTX)).toBe(true);
  });

  it('un code vacío nunca se reclama (no se le abre la puerta a un input ausente)', async () => {
    expect(await claimMetaConnectCode('', CTX)).toBe(false);
  });

  it('el code NO queda legible en Firestore: ni en el id del documento ni en sus campos', async () => {
    await claimMetaConnectCode(CODE, CTX);
    const guardado = [...docs.entries()];
    expect(guardado).toHaveLength(1);
    expect(JSON.stringify(guardado)).not.toContain(CODE);
  });
});

describe('nonce — el modelo queda listo para la limpieza y para el modo', () => {
  it('el nonce se crea con un campo de vencimiento apto para TTL de Firestore', async () => {
    const nonce = await createMetaConnectNonce(CTX.tenantId, CTX.uid);
    const doc = docs.get(`metaOAuthStates/${nonce}`)!;
    // `metaOAuthStates` crecía sin límite: sin un campo Timestamp no se puede declarar la política.
    expect(doc['expiresAt']).toBeDefined();
    expect(typeof (doc['expiresAt'] as { toMillis?: unknown })?.toMillis).toBe('function');
  });

  it('SIN REGRESIÓN: el nonce se sigue consumiendo una sola vez', async () => {
    const nonce = await createMetaConnectNonce(CTX.tenantId, CTX.uid);
    expect(await consumeMetaConnectNonce(nonce, CTX)).toBe(true);
    expect(await consumeMetaConnectNonce(nonce, CTX)).toBe(false);
  });
});
