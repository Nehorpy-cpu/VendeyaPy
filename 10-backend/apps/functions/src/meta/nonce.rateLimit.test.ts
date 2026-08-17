/**
 * nonce.rateLimit.test.ts — LA EMISIÓN DE NONCES GANA UN FRENO POR TENANT (ADR-0020, G10)
 * ========================================================================================
 * `startMetaConnect` no tenía límite: la emisión ilimitada era el único costado sin freno del
 * single-flight del `code`. El contrato: máximo 10 nonces por tenant por ventana de 10 minutos,
 * contados TRANSACCIONALMENTE en `metaOAuthStates/rate_{tenantId}` ({windowStartMs, count},
 * reset al vencer la ventana). Excedido ⇒ HttpsError('resource-exhausted'). Lo heredan
 * `startMetaConnect` y `coexistenceStart` porque ambos emiten por `createMetaConnectNonce`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';

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
        delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      };
      // Si el cuerpo lanza, NADA se aplica: misma semántica que una transacción real.
      const r = await fn(tx);
      for (const op of ops) {
        if (op.tipo === 'delete') docs.delete(op.path);
        else docs.set(op.path, op.data!);
      }
      return r;
    },
  }),
}));

import { createMetaConnectNonce, consumeMetaConnectNonce, NONCE_RATE_LIMIT, NONCE_RATE_WINDOW_MS } from './nonce.js';

const TENANT = 'tnt_alpha';
const UID = 'uid-1';
const ratePath = `metaOAuthStates/rate_${TENANT}`;

beforeEach(() => docs.clear());

describe('G10 — límite transaccional de emisión de nonces por tenant', () => {
  it('las primeras 10 emisiones de la ventana pasan', async () => {
    for (let i = 0; i < NONCE_RATE_LIMIT; i++) {
      await expect(createMetaConnectNonce(TENANT, UID)).resolves.toBeTruthy();
    }
  });

  it('la 11ª emisión se rechaza con resource-exhausted', async () => {
    for (let i = 0; i < NONCE_RATE_LIMIT; i++) await createMetaConnectNonce(TENANT, UID);

    const promesa = createMetaConnectNonce(TENANT, UID);
    await expect(promesa).rejects.toBeInstanceOf(HttpsError);
    await expect(createMetaConnectNonce(TENANT, UID)).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  it('el rechazo NO escribe el nonce (el contador tampoco avanza)', async () => {
    for (let i = 0; i < NONCE_RATE_LIMIT; i++) await createMetaConnectNonce(TENANT, UID);
    const antes = docs.size;

    await expect(createMetaConnectNonce(TENANT, UID)).rejects.toThrow();

    expect(docs.size).toBe(antes);
    expect(docs.get(ratePath)?.['count']).toBe(NONCE_RATE_LIMIT);
  });

  it('al vencer la ventana el contador se resetea y se vuelve a emitir', async () => {
    for (let i = 0; i < NONCE_RATE_LIMIT; i++) await createMetaConnectNonce(TENANT, UID);
    // Simular el paso del tiempo: la ventana arrancó hace más de 10 minutos.
    const rate = docs.get(ratePath)!;
    docs.set(ratePath, { ...rate, windowStartMs: Date.now() - NONCE_RATE_WINDOW_MS - 1 });

    await expect(createMetaConnectNonce(TENANT, UID)).resolves.toBeTruthy();
    expect(docs.get(ratePath)?.['count']).toBe(1);
  });

  it('el freno es POR TENANT: otro tenant sigue emitiendo normalmente', async () => {
    for (let i = 0; i < NONCE_RATE_LIMIT; i++) await createMetaConnectNonce(TENANT, UID);

    await expect(createMetaConnectNonce('tnt_beta', 'uid-2')).resolves.toBeTruthy();
  });

  it('coexistence emite por la MISMA vía y cuenta contra el mismo freno (lo hereda coexistenceStart)', async () => {
    for (let i = 0; i < NONCE_RATE_LIMIT; i++) await createMetaConnectNonce(TENANT, UID, 'coexistence');

    await expect(createMetaConnectNonce(TENANT, UID, 'standard')).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  it('un documento de rate con basura se trata como ventana nueva (no bloquea para siempre)', async () => {
    docs.set(ratePath, { windowStartMs: 'basura', count: 'mucho' });

    await expect(createMetaConnectNonce(TENANT, UID)).resolves.toBeTruthy();
    expect(docs.get(ratePath)?.['count']).toBe(1);
  });

  it('SIN REGRESIÓN: el nonce emitido bajo el freno se consume igual que siempre (uso único)', async () => {
    const nonce = await createMetaConnectNonce(TENANT, UID);

    expect(await consumeMetaConnectNonce(nonce, { tenantId: TENANT, uid: UID })).toBe(true);
    expect(await consumeMetaConnectNonce(nonce, { tenantId: TENANT, uid: UID })).toBe(false);
  });
});
