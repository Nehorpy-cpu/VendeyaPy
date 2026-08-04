import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §2 — EL PEDIDO TIENE QUE SABER POR QUÉ CANAL SE ARMÓ.
 * ===============================================================
 * `confirmPayment` cierra el checkout: vacía el carrito y pone `CHECKOUT_DONE` en la sesión del
 * cliente. Pero el `Order` no llevaba ningún dato del canal, así que la única sesión que sabía
 * cerrar era `sessions/active`.
 *
 * Lo llaman el webhook de Stripe, el callable del panel y el endpoint de prueba: NINGUNO de los
 * tres tiene el turno del webhook a mano, y volver a adivinarlo por `receivedVia` cuesta lecturas
 * y vuelve a divergir. Por eso el canal se PERSISTE en el pedido cuando se lo crea, y acá se lee.
 *
 * Con dos números, el defecto vacía el carrito de la conversación equivocada: el cliente que
 * estaba comprando por el otro número ve desaparecer su carrito, y el que sí pagó se queda con el
 * pedido pendiente colgado y el bot volviéndole a ofrecer pagar.
 *
 * Compatibilidad: un pedido SIN `sessionKey` (todos los que existen hoy) cierra `active`.
 */
const docs = new Map<string, Record<string, unknown>>();
const escribir = (path: string, data: Record<string, unknown>) => {
  const base = { ...(docs.get(path) ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(data)) {
    if (k.includes('.')) {
      const partes = k.split('.');
      let cur = base;
      for (const p of partes.slice(0, -1)) {
        cur[p] = { ...((cur[p] as Record<string, unknown>) ?? {}) };
        cur = cur[p] as Record<string, unknown>;
      }
      cur[partes[partes.length - 1]!] = v;
    } else base[k] = v;
  }
  docs.set(path, base);
};

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      update: async (d: Record<string, unknown>) => escribir(path, d),
    }),
  }),
  paths: {
    order: (t: string, o: string) => `tenants/${t}/orders/${o}`,
    session: (t: string, c: string, s: string) => `tenants/${t}/customers/${c}/sessions/${s}`,
  },
}));
vi.mock('../events/businessEvents.js', () => ({ recordBusinessEvent: vi.fn(async () => undefined) }));
vi.mock('../audit/audit.js', () => ({ recordAudit: vi.fn(async () => undefined) }));

import { confirmPayment } from './confirmPayment.js';

const TENANT = 't1';
const CLIENTE = '595000001234';
const ORDEN = `tenants/${TENANT}/orders/ord_1`;
const CANAL_HEREDADO = `tenants/${TENANT}/customers/${CLIENTE}/sessions/active`;
const CANAL_NUEVO = `tenants/${TENANT}/customers/${CLIENTE}/sessions/wa_444555666`;

const CARRITO_LLENO = { items: [{ productId: 'p1', name: 'X', price: 1000, quantity: 1 }], subtotal: 1000 };

function sembrar(sessionKey?: string): void {
  docs.clear();
  docs.set(ORDEN, {
    id: 'ord_1',
    tenantId: TENANT,
    customerId: CLIENTE,
    status: 'PENDING_PAYMENT',
    channel: 'WHATSAPP',
    totals: { total: 1000, currency: 'PYG' },
    ...(sessionKey ? { sessionKey } : {}),
  });
  for (const p of [CANAL_HEREDADO, CANAL_NUEVO]) {
    docs.set(p, { id: p.split('/').pop(), state: 'AWAITING_PAYMENT', cart: { ...CARRITO_LLENO }, context: { pendingOrderId: 'ord_1' } });
  }
}
const ses = (p: string) => docs.get(p) as { state?: string; cart?: { items: unknown[] } } | undefined;

beforeEach(() => vi.clearAllMocks());

describe('confirmPayment — cierra el checkout del canal del pedido (ADR-0017 §2)', () => {
  it('pedido del canal nuevo: se vacía ESE carrito y el del número que vende queda intacto', async () => {
    sembrar('wa_444555666');

    const r = await confirmPayment(TENANT, 'ord_1');

    expect(r.ok).toBe(true);
    expect(ses(CANAL_NUEVO)?.state).toBe('CHECKOUT_DONE');
    expect(ses(CANAL_NUEVO)?.cart?.items).toEqual([]);
    // El defecto: se vaciaba el carrito de la conversación del otro número.
    expect(ses(CANAL_HEREDADO)?.state).toBe('AWAITING_PAYMENT');
    expect(ses(CANAL_HEREDADO)?.cart?.items).toHaveLength(1);
  });

  it('pedido SIN `sessionKey` (los que ya existen): cierra el canal heredado, como siempre', async () => {
    sembrar();

    await confirmPayment(TENANT, 'ord_1');

    expect(ses(CANAL_HEREDADO)?.state).toBe('CHECKOUT_DONE');
    expect(ses(CANAL_NUEVO)?.state).toBe('AWAITING_PAYMENT');
  });
});
