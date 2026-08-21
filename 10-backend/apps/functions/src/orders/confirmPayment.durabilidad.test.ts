import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * H-05 — UN PAGO CONFIRMADO NO PUEDE QUEDAR SIN RASTRO.
 * =====================================================
 * `confirmPayment` marcaba `PAID` y DESPUÉS limpiaba la sesión con `.update()`, que lanza
 * NOT_FOUND si el documento no existe. Cuando eso pasaba:
 *
 *   - el pedido ya estaba `PAID` (commiteado),
 *   - el evento `Purchase` NUNCA se registraba (atribución sin la venta),
 *   - el audit `payment.confirmed` NUNCA se registraba,
 *   - y el reintento lo SELLABA: el cortocircuito veía `PAID` y devolvía «ya estaba», así que
 *     esos dos pasos no volvían a ejecutarse jamás.
 *
 * Lo encontraron dos auditorías independientes (A2-3 y A4-3) por caminos distintos.
 *
 * El arreglo tiene dos mitades, y las dos se prueban acá:
 *   1. ORDEN: primero el rastro (Purchase, audit) y al final la limpieza de sesión, que es la
 *      escritura falible — y la única recuperable, porque el motor la repara sola en el
 *      siguiente mensaje (`engine.ts`, rama `kind === 'paid'`).
 *   2. El cortocircuito COMPLETA en vez de sellar.
 *
 * Nota: ningún dato de pago real entra acá. Todo es inventado.
 */

const docs = new Map<string, Record<string, unknown>>();
/** Rutas cuyo `.update()` debe lanzar NOT_FOUND (simula el doc inexistente del SDK real). */
const sesionesInexistentes = new Set<string>();

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

/** El error EXACTO que tira el Admin SDK sobre un `.update()` de un doc que no existe. */
const notFound = (path: string) =>
  Object.assign(new Error(`5 NOT_FOUND: no entity to update: ${path}`), { code: 5 });

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      update: async (d: Record<string, unknown>) => {
        if (sesionesInexistentes.has(path)) throw notFound(path);
        escribir(path, d);
      },
      set: async (d: Record<string, unknown>) => escribir(path, d),
    }),
  }),
  paths: {
    order: (t: string, o: string) => `tenants/${t}/orders/${o}`,
    session: (t: string, c: string, s: string) => `tenants/${t}/customers/${c}/sessions/${s}`,
  },
}));

const purchaseMock = vi.fn(async () => undefined);
const auditMock = vi.fn(async () => undefined);
vi.mock('../events/businessEvents.js', () => ({ recordBusinessEvent: (...a: unknown[]) => purchaseMock(...(a as [])) }));
vi.mock('../audit/audit.js', () => ({ recordAudit: (...a: unknown[]) => auditMock(...(a as [])) }));

import { confirmPayment } from './confirmPayment.js';

const TENANT = 't1';
const CLIENTE = '595000001234';
const ORDEN_ID = 'ord_H05_0001';
const P_ORDEN = `tenants/${TENANT}/orders/${ORDEN_ID}`;
const P_SESION = `tenants/${TENANT}/customers/${CLIENTE}/sessions/active`;

const sembrarOrden = (status = 'PENDING_PAYMENT') => {
  docs.set(P_ORDEN, {
    id: ORDEN_ID,
    tenantId: TENANT,
    customerId: CLIENTE,
    status,
    channel: 'WHATSAPP',
    totals: { total: 280000, currency: 'PYG' },
  });
};
const sembrarSesion = () => {
  docs.set(P_SESION, {
    state: 'AWAITING_PAYMENT',
    cart: { items: [{ productId: 'p1', name: 'X', price: 280000, quantity: 1 }], subtotal: 280000 },
    context: { pendingOrderId: ORDEN_ID },
  });
};
const orden = () => docs.get(P_ORDEN) as { status?: string } | undefined;
const sesion = () => docs.get(P_SESION) as { state?: string; cart?: { items: unknown[] } } | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  docs.clear();
  sesionesInexistentes.clear();
  purchaseMock.mockResolvedValue(undefined);
  auditMock.mockResolvedValue(undefined);
});

describe('H-05 · el rastro del pago sobrevive a que falle la limpieza de sesión', () => {
  it('el caso del informe: la sesión no existe ⇒ el pedido queda PAID Y con Purchase Y con audit', async () => {
    sembrarOrden();
    sesionesInexistentes.add(P_SESION); // el cliente no tiene sesión en ese canal

    const r = await confirmPayment(TENANT, ORDEN_ID);

    expect(orden()?.status).toBe('PAID');
    expect(purchaseMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![0]).toMatchObject({ action: 'payment.confirmed', targetId: ORDEN_ID });
    // Y el llamador no recibe una excepción por algo que ya no es crítico.
    expect(r.ok).toBe(true);
  });

  it('el fallo de la limpieza NO es silencioso: queda registrado con tenant y pedido', async () => {
    sembrarOrden();
    sesionesInexistentes.add(P_SESION);
    const { logger } = await import('../lib/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await confirmPayment(TENANT, ORDEN_ID);

    const registrado = warn.mock.calls.some(
      ([, ctx]) => (ctx as { tenantId?: string; orderId?: string })?.tenantId === TENANT &&
        (ctx as { orderId?: string })?.orderId === ORDEN_ID,
    );
    expect(registrado).toBe(true);
    warn.mockRestore();
  });

  it('EL CORAZÓN DE H-05: el reintento sobre un pedido PAID sin rastro lo COMPLETA', async () => {
    // Estado real que hay hoy en producción: pagado, pero sin Purchase ni audit. La sesión sigue
    // esperando ESE pago (`pendingOrderId` apunta al pedido), así que también se repara.
    sembrarOrden('PAID');
    sembrarSesion();

    const r = await confirmPayment(TENANT, ORDEN_ID);

    expect(r.ok).toBe(true);
    expect(purchaseMock).toHaveBeenCalledTimes(1); // idempotente por id: repetir es seguro
    expect(auditMock).toHaveBeenCalledTimes(1);
    // Y de paso repara lo que quedó sucio para el cliente.
    expect(sesion()?.state).toBe('CHECKOUT_DONE');
    expect(sesion()?.cart?.items).toEqual([]);
  });

  it('la reparación NO pisa el carrito que el cliente armó DESPUÉS', async () => {
    // La sesión es de vida larga por (cliente, canal), NO por pedido. La primera versión de este
    // fix limpiaba a ciegas en el cortocircuito: reparar el rastro del pedido A le borraba al
    // cliente el carrito nuevo, irrecuperable (review). Mismo criterio que `checkoutReuse`.
    sembrarOrden('PAID');
    docs.set(P_SESION, {
      state: 'CART',
      cart: { items: [{ productId: 'p9', name: 'otra cosa', price: 90000, quantity: 2 }], subtotal: 180000 },
      context: { pendingOrderId: 'ord_OTRO' }, // la conversación ya siguió su camino
    });

    const r = await confirmPayment(TENANT, ORDEN_ID);

    expect(r.ok).toBe(true);
    expect(auditMock).toHaveBeenCalledTimes(1); // el rastro SÍ se completa
    // …y el carrito vivo del cliente queda intacto.
    expect(sesion()?.state).toBe('CART');
    expect(sesion()?.cart?.items).toHaveLength(1);
  });

  it('un pedido que YA avanzó (PREPARING) todavía se puede reparar', async () => {
    // Sin esto, apenas un vendedor avanzaba el pedido el rastro quedaba imposible de completar:
    // `confirmPayment` rechazaba el estado y no había ninguna otra puerta (review).
    sembrarOrden('PREPARING');
    sembrarSesion();

    const r = await confirmPayment(TENANT, ORDEN_ID);

    expect(r.ok).toBe(true);
    expect(r.status).toBe('PREPARING'); // no se retrocede el estado
    expect(purchaseMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(orden()?.status).toBe('PREPARING');
  });

  it('el audit del reintento es IDEMPOTENTE: id determinístico, no una entrada nueva por intento', async () => {
    sembrarOrden('PAID');
    sembrarSesion();

    await confirmPayment(TENANT, ORDEN_ID);
    await confirmPayment(TENANT, ORDEN_ID);

    // Se vuelve a llamar (completa), pero SIEMPRE con el mismo id ⇒ Firestore no acumula copias.
    const ids = auditMock.mock.calls.map(([e]) => (e as { id?: string }).id);
    expect(ids).toEqual([`payment-confirmed-${ORDEN_ID}`, `payment-confirmed-${ORDEN_ID}`]);
  });
});

describe('H-05 · NO REGRESIÓN', () => {
  it('happy path: mismos efectos y mismo `message` que antes', async () => {
    sembrarOrden();
    sembrarSesion();

    const r = await confirmPayment(TENANT, ORDEN_ID);

    expect(r).toMatchObject({ ok: true, status: 'PAID' });
    expect(r.message).toContain('🎉 ¡Pago confirmado!');
    expect(r.message).toContain(ORDEN_ID); // H-06 va a necesitar este texto intacto
    expect(orden()?.status).toBe('PAID');
    expect(sesion()?.state).toBe('CHECKOUT_DONE');
    expect(sesion()?.cart?.items).toEqual([]);
    expect(purchaseMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it('idempotencia: confirmar dos veces deja UN pago y UN Purchase', async () => {
    sembrarOrden();
    sembrarSesion();

    const primera = await confirmPayment(TENANT, ORDEN_ID);
    const segunda = await confirmPayment(TENANT, ORDEN_ID);

    expect(primera.ok).toBe(true);
    expect(segunda.ok).toBe(true);
    expect(orden()?.status).toBe('PAID');
    // El Purchase se vuelve a escribir con el MISMO id (`purchase-{orderId}`): merge, no copia.
    const idsPurchase = purchaseMock.mock.calls.map(([, e]) => (e as { id?: string }).id);
    expect(new Set(idsPurchase)).toEqual(new Set([`purchase-${ORDEN_ID}`]));
  });

  it('un pedido CANCELLED se sigue rechazando igual que hoy', async () => {
    sembrarOrden('CANCELLED');
    sembrarSesion();

    const r = await confirmPayment(TENANT, ORDEN_ID);

    expect(r.ok).toBe(false);
    expect(r.message).toContain('CANCELLED');
    expect(purchaseMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    expect(orden()?.status).toBe('CANCELLED');
  });

  it('orden inexistente: mismo rechazo, sin efectos', async () => {
    const r = await confirmPayment(TENANT, 'ord_no_existe');

    expect(r).toMatchObject({ ok: false });
    expect(purchaseMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('H-05 · cero Purchase fantasma', () => {
  it('si la escritura de PAID falla, NO hay Purchase ni audit de pago', async () => {
    sembrarOrden();
    sembrarSesion();
    sesionesInexistentes.add(P_ORDEN); // el `.update()` del pedido revienta

    await expect(confirmPayment(TENANT, ORDEN_ID)).rejects.toThrow(/NOT_FOUND/);

    expect(purchaseMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    expect(orden()?.status).toBe('PENDING_PAYMENT'); // el dinero no se marcó
  });

  it('el fallo de recordBusinessEvent deja rastro suficiente para encontrarlo', async () => {
    sembrarOrden();
    sembrarSesion();
    purchaseMock.mockRejectedValue(new Error('firestore no disponible'));
    const { logger } = await import('../lib/logger.js');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const r = await confirmPayment(TENANT, ORDEN_ID);

    expect(r.ok).toBe(true); // el pago sigue confirmado: el evento es alimentación de atribución
    const ctx = error.mock.calls.map(([, , c]) => c as { tenantId?: string; orderId?: string });
    expect(ctx.some((c) => c?.tenantId === TENANT && c?.orderId === ORDEN_ID)).toBe(true);
    // Y el audit sale igual: un fallo de la atribución no puede llevarse puesta la trazabilidad.
    expect(auditMock).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
