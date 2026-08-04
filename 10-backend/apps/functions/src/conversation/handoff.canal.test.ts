import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §2 — TOMAR Y LIBERAR SON DEL CANAL, NO DEL CLIENTE.
 * ============================================================
 * `takeoverChat` y `releaseToBot` escribían siempre en `sessions/active`. Con dos números del
 * mismo tenant atendiendo al MISMO cliente, eso tiene dos consecuencias y las dos se ven desde
 * afuera:
 *
 *  · el vendedor toca «Tomar conversación» en el chat del número nuevo y el bot se calla en el
 *    número que HOY vende (donde nadie pidió nada);
 *  · y no se calla en el número nuevo, así que le habla encima al vendedor delante del cliente.
 *
 * `releaseToBot` es la mitad peor: devuelve al bot una conversación que nunca estuvo tomada.
 *
 * El canal heredado (sin `sessionKey`) tiene que seguir resolviendo `active`, que es donde viven
 * todas las conversaciones de hoy.
 */
const docs = new Map<string, Record<string, unknown>>();

const esPlano = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { toMillis?: unknown }).toMillis !== 'function';

function escribir(path: string, data: Record<string, unknown>, merge: boolean): void {
  const base: Record<string, unknown> = merge ? { ...(docs.get(path) ?? {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (k.includes('.')) {
      const partes = k.split('.');
      let cur = base;
      for (const p of partes.slice(0, -1)) {
        cur[p] = { ...((cur[p] as Record<string, unknown>) ?? {}) };
        cur = cur[p] as Record<string, unknown>;
      }
      cur[partes[partes.length - 1]!] = v;
    } else if (merge && esPlano(v) && esPlano(base[k])) {
      base[k] = { ...(base[k] as Record<string, unknown>), ...v };
    } else {
      base[k] = v;
    }
  }
  docs.set(path, base);
}
const refFor = (path: string) => ({
  path,
  get: async () => snapFor(path),
  set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => escribir(path, d, o?.merge === true),
  update: async (d: Record<string, unknown>) => escribir(path, d, true),
});
const snapFor = (path: string) => ({ exists: docs.has(path), ref: refFor(path), data: () => docs.get(path) });

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => refFor(path),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async (ref: { path: string }) => snapFor(ref.path),
        set: (ref: { path: string }, d: Record<string, unknown>) => escribir(ref.path, d, false),
        update: (ref: { path: string }, d: Record<string, unknown>) => escribir(ref.path, d, true),
      }),
  }),
  paths: {
    session: (t: string, c: string, s: string) => `tenants/${t}/customers/${c}/sessions/${s}`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    notifications: (t: string) => `tenants/${t}/notifications`,
  },
}));
vi.mock('./messages.js', () => ({
  appendMessage: vi.fn(async () => undefined),
  markConversationRead: vi.fn(async () => undefined),
}));

import { takeoverChat, releaseToBot } from './handoff.js';

const TENANT = 't1';
const CLIENTE = '595000001234';
const CANAL_HEREDADO = `tenants/${TENANT}/customers/${CLIENTE}/sessions/active`;
const CANAL_NUEVO = `tenants/${TENANT}/customers/${CLIENTE}/sessions/wa_444555666`;

function sembrar(path: string, context: Record<string, unknown>): void {
  docs.set(path, {
    id: path.split('/').pop(),
    tenantId: TENANT,
    customerId: CLIENTE,
    state: 'BROWSING',
    cart: { items: [], subtotal: 0 },
    context,
  });
}
const ctx = (path: string) => (docs.get(path) as { context?: Record<string, unknown> } | undefined)?.context;

beforeEach(() => docs.clear());

describe('takeoverChat / releaseToBot por canal (ADR-0017 §2)', () => {
  it('tomar la conversación del número nuevo NO puede silenciar al número que ya vende', async () => {
    sembrar(CANAL_HEREDADO, { humanTakeover: false });
    sembrar(CANAL_NUEVO, { humanTakeover: false });

    const r = await takeoverChat(TENANT, CLIENTE, 'Vendedora', 'uid_1', 'wa_444555666');

    expect(r.ok).toBe(true);
    expect(ctx(CANAL_NUEVO)?.humanTakeover).toBe(true);
    // El corazón del defecto: la sesión del número que vende quedaba tomada sin que nadie lo pidiera.
    expect(ctx(CANAL_HEREDADO)?.humanTakeover).toBe(false);
  });

  it('liberar el canal nuevo no devuelve al bot la conversación del canal heredado', async () => {
    sembrar(CANAL_HEREDADO, { humanTakeover: true, handoffReason: 'seller_manual' });
    sembrar(CANAL_NUEVO, { humanTakeover: true, handoffReason: 'seller_manual' });

    const r = await releaseToBot(TENANT, CLIENTE, 'wa_444555666');

    expect(r.ok).toBe(true);
    expect(ctx(CANAL_NUEVO)?.humanTakeover).toBe(false);
    expect(ctx(CANAL_HEREDADO)?.humanTakeover).toBe(true);
  });

  it('sin canal declarado se opera el heredado (`active`): las conversaciones de hoy no se mueven', async () => {
    sembrar(CANAL_HEREDADO, { humanTakeover: false });

    await takeoverChat(TENANT, CLIENTE, 'Vendedora', 'uid_1');

    expect(ctx(CANAL_HEREDADO)?.humanTakeover).toBe(true);
    expect(docs.has(CANAL_NUEVO)).toBe(false);
  });

  it('liberar un canal SIN sesión no crea una sesión fantasma en el otro', async () => {
    sembrar(CANAL_HEREDADO, { humanTakeover: true, handoffReason: 'seller_manual' });

    const r = await releaseToBot(TENANT, CLIENTE, 'wa_444555666');

    expect(r.ok).toBe(false);
    expect(docs.has(CANAL_NUEVO)).toBe(false);
    expect(ctx(CANAL_HEREDADO)?.humanTakeover).toBe(true);
  });
});
