import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §3 — LIBERAR EL CHAT NO PUEDE BORRAR EL CHECKOUT EN CURSO.
 * ==================================================================
 * `releaseToBot` escribía `state: 'IDLE'` incondicionalmente. Con eso, un vendedor que toma el
 * chat para responder una duda y lo devuelve, DEGRADA a IDLE una sesión que estaba en
 * `AWAITING_PAYMENT`: el cliente ya recibió los datos bancarios y tiene un pedido pendiente.
 *
 * Ese estado es load-bearing, no cosmético:
 *  - `receiptGate` exige `AWAITING_PAYMENT` para aceptar un comprobante (receiptGate.ts §239);
 *  - el drift guard cede el paso al flujo de pago solo en `AWAITING_PAYMENT` (engine.ts:1305,1362);
 *  - el gate de reuso de checkout se apoya en él para no duplicar el pedido.
 * Degradarlo hace que el comprobante del cliente rebote y que el bot vuelva a ofrecer pagar algo
 * que ya se pidió.
 *
 * Hasta hoy tomar y liberar era excepcional. Con Coexistence (echoes del vendedor desde su
 * teléfono) pasa a ser el RITMO NORMAL de trabajo, así que el defecto se dispararía todos los días
 * sobre el número real. Por eso se arregla ANTES de habilitar `live`.
 */

const docs = new Map<string, Record<string, unknown>>();

const esPlano = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { toMillis?: unknown }).toMillis !== 'function';

/** Escritura con rutas punteadas ('context.humanTakeover') y merge superficial. */
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
  db: () => ({ doc: (path: string) => refFor(path) }),
  paths: {
    session: (t: string, c: string, s = 'active') => `tenants/${t}/customers/${c}/sessions/${s}`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    notifications: (t: string) => `tenants/${t}/notifications`,
  },
}));
const mensajes: Array<Record<string, unknown>> = [];
vi.mock('./messages.js', () => ({
  appendMessage: vi.fn(async (_t: string, _c: string, m: Record<string, unknown>) => {
    mensajes.push(m);
  }),
  markConversationRead: vi.fn(async () => undefined),
}));

import { releaseToBot } from './handoff.js';

const TENANT = 't1';
const CLIENTE = '595000001234';
const SESION = `tenants/${TENANT}/customers/${CLIENTE}/sessions/active`;

/** Sesión tomada por un humano, en el estado que se quiera probar. */
function sesionTomada(state: string, context: Record<string, unknown> = {}): void {
  docs.clear();
  mensajes.length = 0;
  docs.set(SESION, {
    id: 'active',
    tenantId: TENANT,
    customerId: CLIENTE,
    state,
    cart: { items: [{ sku: 'SKU1', qty: 1, price: 250000 }], subtotal: 250000 },
    context: {
      humanTakeover: true,
      handoffReason: 'seller_manual',
      handoffSellerName: 'Vendedora',
      ...context,
    },
  });
}
const sesion = () => docs.get(SESION) as { state?: string; context?: Record<string, unknown> } | undefined;

beforeEach(() => {
  docs.clear();
  mensajes.length = 0;
});

describe('releaseToBot — preservación del checkout en curso (ADR-0017 §3)', () => {
  it('AWAITING_PAYMENT sobrevive a la liberación: el comprobante del cliente sigue siendo aceptable', async () => {
    sesionTomada('AWAITING_PAYMENT', { pendingOrderId: 'ord_1' });

    const r = await releaseToBot(TENANT, CLIENTE);

    expect(r.ok).toBe(true);
    // El corazón del defecto: liberar NO puede degradar el estado del checkout.
    expect(sesion()?.state).toBe('AWAITING_PAYMENT');
    // Y el puntero de la orden pendiente tampoco se pierde: sin él, el comprobante no tiene a
    // qué pedido asociarse aunque el estado estuviera bien.
    expect(sesion()?.context?.pendingOrderId).toBe('ord_1');
    // Lo que sí tiene que pasar: el bot vuelve a atender.
    expect(sesion()?.context?.humanTakeover).toBe(false);
    expect(sesion()?.context?.handoffReason).toBeNull();
  });

  it('SELECTING_PAYMENT sobrevive: el cliente estaba eligiendo cómo pagar, no navegando', async () => {
    sesionTomada('SELECTING_PAYMENT');

    await releaseToBot(TENANT, CLIENTE);

    expect(sesion()?.state).toBe('SELECTING_PAYMENT');
    expect(sesion()?.context?.humanTakeover).toBe(false);
  });

  it('el mensaje de sistema refleja el estado REAL, no un IDLE inventado', async () => {
    sesionTomada('AWAITING_PAYMENT', { pendingOrderId: 'ord_1' });

    await releaseToBot(TENANT, CLIENTE);

    // `appendMessage` persiste `state` en el historial: si dice IDLE mientras la sesión está en
    // AWAITING_PAYMENT, el panel y la auditoría muestran dos verdades distintas.
    const sistema = mensajes.find((m) => m.author === 'system');
    expect(sistema?.state).toBe('AWAITING_PAYMENT');
  });

  it('CERO REGRESIÓN: un estado conversacional sí se reinicia a IDLE al liberar', async () => {
    sesionTomada('BROWSING', { currentPage: 3 });

    await releaseToBot(TENANT, CLIENTE);

    // Comportamiento histórico deliberado: el bot retoma "de cero" una navegación abandonada.
    expect(sesion()?.state).toBe('IDLE');
    expect(sesion()?.context?.humanTakeover).toBe(false);
  });

  it('CERO REGRESIÓN: la oferta pendiente del bot se limpia igual (F3)', async () => {
    sesionTomada('AWAITING_PAYMENT', { pendingOrderId: 'ord_1', pendingCartConfirmation: { sku: 'SKU9' } });

    await releaseToBot(TENANT, CLIENTE);

    // Un "sí" dirigido al vendedor jamás debe agregar lo que el bot había ofrecido antes de la
    // pausa — eso se limpia SIEMPRE, incluso preservando el estado del checkout.
    expect(sesion()?.context?.pendingCartConfirmation).toBeNull();
  });

  it('sin sesión no inventa nada', async () => {
    const r = await releaseToBot(TENANT, CLIENTE);
    expect(r.ok).toBe(false);
    expect(docs.has(SESION)).toBe(false);
  });
});
