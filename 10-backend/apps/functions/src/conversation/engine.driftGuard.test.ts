import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * ADR-0015 §8 — DRIFT-GUARD en el motor: para un producto cuyo precio/disponibilidad/stock público
 * gobierna una fuente externa que HOY dice otra cosa, el bot no afirma el dato, no crea la orden,
 * no manda datos bancarios y deriva por el servicio canónico. Y —igual de importante— NO le roba
 * el turno a los guards que ya existían (pedido de humano, cobertura en chat, cobertura en espera
 * de ubicación, checkout/pago) ni vuelve ofrecible nada que hoy no lo sea.
 *
 * Caso base (genérico, sin rubro): precio local 250000, publicado por la fuente externa otro.
 */
const docs = new Map<string, Record<string, unknown>>();
const docSet = vi.fn();
const txSet = vi.fn();

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (d: Record<string, unknown>) => { docSet(path, d); docs.set(path, { ...(docs.get(path) ?? {}), ...d }); },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async (ref: { path: string }) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        set: (ref: { path: string }, d: Record<string, unknown>) => { txSet(ref.path, d); docs.set(ref.path, d); },
        update: (ref: { path: string }, d: Record<string, unknown>) => { docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...d }); },
      }),
  }),
  paths: {
    session: (t: string, c: string) => `tenants/${t}/customers/${c}/sessions/active`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
  },
}));
vi.mock('./messages.js', () => ({ appendMessage: vi.fn(async () => undefined), listRecentMessages: vi.fn(async () => []), markConversationRead: vi.fn(async () => undefined) }));
vi.mock('./agentConfig.js', () => ({ getAgentConfig: vi.fn(async () => ({ greetingMessage: '', botEnabled: true, profitMode: false })) }));
vi.mock('../tracking/tracking.js', () => ({ captureTrackingCode: vi.fn(async () => undefined) }));
vi.mock('../catalog/search.js', () => ({ searchCatalog: vi.fn(async () => []), getProductById: vi.fn(async () => null), findProductByName: vi.fn(async () => null) }));
vi.mock('../ai/salesAgent.js', () => ({ runSalesAgent: vi.fn(async () => ({ used: true, reply: 'Respuesta de la IA', shownProducts: [], usedTools: [] })) }));
vi.mock('./humanRequest.js', () => ({ esPosiblePedidoHumano: vi.fn(() => false), procesarPedidoHumano: vi.fn(async () => ({ handled: false, takeover: false, reply: '' })) }));
vi.mock('./aiUnavailable.js', () => ({ derivarPorIaNoDisponible: vi.fn(), esConsultaDerivable: vi.fn(() => true) }));
vi.mock('./coverage.js', () => ({
  gateCoberturaCheckout: vi.fn(async () => null),
  clasificarTextoEnEspera: vi.fn(() => 'otro'),
  manejarTurnoEnEsperaUbicacion: vi.fn(async () => null),
  actualizarUbicacionEnRevision: vi.fn(async () => undefined),
}));
vi.mock('../orders/checkoutReuse.js', () => ({ resolveCheckoutReuse: vi.fn(async () => ({ kind: 'new' })) }));
vi.mock('../orders/checkoutConfig.js', async (io) => {
  const real = await io<typeof import('../orders/checkoutConfig.js')>();
  return { ...real, getCheckoutConfig: vi.fn(async () => ({ bankAccounts: [{ bank: 'Banco T', accountNumber: '1-1', holder: 'H', document: 'D' }], sellers: [] })) };
});
vi.mock('../orders/createPendingOrder.js', async (io) => {
  const real = await io<typeof import('../orders/createPendingOrder.js')>();
  return { ...real, createPendingOrder: vi.fn() };
});
vi.mock('../entitlements/entitlements.js', () => ({ checkQuota: vi.fn(async () => ({ allowed: true, used: 0, limit: 10 })), meterUsage: vi.fn(async () => undefined) }));
vi.mock('./driftHandoff.js', () => ({ derivarPorDerivaCritica: vi.fn() }));

import { handleMessage } from './engine.js';
import { setDriftProjection, type ProductDriftSnapshot } from '../catalog/driftGuard.js';
import { derivarPorDerivaCritica } from './driftHandoff.js';
import { findProductByName, getProductById } from '../catalog/search.js';
import { runSalesAgent } from '../ai/salesAgent.js';
import { esPosiblePedidoHumano, procesarPedidoHumano } from './humanRequest.js';
import { gateCoberturaCheckout, clasificarTextoEnEspera, manejarTurnoEnEsperaUbicacion } from './coverage.js';
import { resolveCheckoutReuse } from '../orders/checkoutReuse.js';
import { createPendingOrder, ProductoConDerivaCriticaError } from '../orders/createPendingOrder.js';
import { appendMessage } from './messages.js';
import type { Product } from '@vpw/shared';

const derivarMock = vi.mocked(derivarPorDerivaCritica);
const findMock = vi.mocked(findProductByName);
const iaMock = vi.mocked(runSalesAgent);
const crearOrdenMock = vi.mocked(createPendingOrder);
const appendMock = vi.mocked(appendMessage);

const TENANT = 't1';
const TEL = '595000005678';
const SESSION = `tenants/${TENANT}/customers/${TEL}/sessions/active`;

const PRODUCTO = {
  id: 'p1',
  name: 'Aurora Nocturna',
  price: 250000,
  status: 'ACTIVE',
  featured: false,
  inventory: { trackStock: true, stock: 5 },
  perfume: null,
} as unknown as Product;

/** Mismo producto pero CON ficha: hace que el interceptor de producto+ocasión responda de verdad. */
const PRODUCTO_CON_FICHA = {
  ...PRODUCTO,
  aiFicha: { proyeccion: 'fuerte', duracion: '8-10', ocasiones: ['salidas nocturnas'], cuandoRecomendar: 'busca presencia de noche' },
} as unknown as Product;

const TODOS_LOS_CAMPOS = ['title', 'description', 'price', 'currency', 'availability', 'inventory'];
/** Cablea la costura de la proyección de deriva (propiedad por campos + estado reconciliado). */
const cablear = (over: Partial<ProductDriftSnapshot> = {}) =>
  setDriftProjection({
    activa: async () => true,
    snapshots: async (_t, ids) =>
      ids.map((productId) => ({ productId, externalFields: TODOS_LOS_CAMPOS, state: 'drifted_external', driftedFields: ['price'], ...over }) as ProductDriftSnapshot),
  });

const sesion = (over: Record<string, unknown> = {}, contexto: Record<string, unknown> = {}) => {
  docs.set(SESSION, {
    id: 'active',
    tenantId: TENANT,
    customerId: TEL,
    state: 'BROWSING',
    cart: { items: [], subtotal: 0 },
    context: { humanTakeover: false, lastShownSkus: [], currentPage: 0, currentCategoryId: null, pendingOrderId: null, pendingPaymentId: null, ...contexto },
    ...over,
  });
};
const CARRITO = { items: [{ productId: 'p1', name: 'Aurora Nocturna', price: 250000, quantity: 1 }], subtotal: 250000 };

beforeEach(() => {
  vi.clearAllMocks();
  docs.clear();
  vi.mocked(esPosiblePedidoHumano).mockReturnValue(false);
  vi.mocked(clasificarTextoEnEspera).mockReturnValue('otro' as never);
  vi.mocked(gateCoberturaCheckout).mockResolvedValue(null as never);
  // clearAllMocks NO borra implementaciones: sin este reset, un test que fuerza `reuse` se lo
  // contagia a los siguientes.
  vi.mocked(resolveCheckoutReuse).mockResolvedValue({ kind: 'new' } as never);
  vi.mocked(getProductById).mockResolvedValue(null);
  findMock.mockResolvedValue(null);
  // La derivación real vive en driftHandoff (testeada aparte); acá se simula su efecto: el
  // servicio canónico deja la sesión en takeover, que es lo que silencia los turnos siguientes.
  derivarMock.mockImplementation(async () => {
    const s = docs.get(SESSION);
    if (s) docs.set(SESSION, { ...s, context: { ...(s.context as object), humanTakeover: true, handoffReason: 'catalog_drift' } });
    return { takeover: true, reply: 'Antes de avanzar prefiero confirmarte el precio y la disponibilidad de *Aurora Nocturna* 🙏 Te paso con Vendedora Uno.' };
  });
  iaMock.mockResolvedValue({ used: true, reply: 'Respuesta de la IA', shownProducts: [], usedTools: [] } as never);
  crearOrdenMock.mockResolvedValue({ id: 'ord_1', totals: { subtotal: 250000, discount: 0, shipping: 0, total: 250000 } } as never);
});
afterEach(() => setDriftProjection(null));

describe('engine — guard de deriva: el bot no cotiza lo que no puede confirmar', () => {
  it('consulta por un producto en deriva ⇒ NO cotiza el precio local, deriva y NO llama a la IA', async () => {
    sesion();
    cablear();
    findMock.mockResolvedValue(PRODUCTO);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: '¿cuánto sale el Aurora Nocturna?', messageId: 'wamid.1' });
    expect(r.reply).not.toContain('250.000');
    expect(r.reply).not.toMatch(/\d{3}\.\d{3}/);
    expect(r.reply).toMatch(/confirmar/i);
    expect(iaMock).not.toHaveBeenCalled(); // cero llamadas a la IA en un turno que igual se deriva
    expect(derivarMock).toHaveBeenCalledTimes(1);
    expect(derivarMock.mock.calls[0]?.[2].bloqueantes[0]).toMatchObject({ productId: 'p1', reason: 'drifted_external', fields: ['price'] });
    // El takeover ya lo persistió el servicio canónico: este turno NO pisa la sesión.
    expect(txSet).not.toHaveBeenCalled();
    expect(appendMock).toHaveBeenCalledWith(TENANT, TEL, expect.objectContaining({ direction: 'out', humanTakeover: true }));
  });

  it('el handoff ocurre UNA sola vez: el segundo turno ya está en atención humana', async () => {
    sesion();
    cablear();
    findMock.mockResolvedValue(PRODUCTO);
    await handleMessage({ tenantId: TENANT, from: TEL, text: '¿cuánto sale el Aurora Nocturna?', messageId: 'wamid.1' });
    const r2 = await handleMessage({ tenantId: TENANT, from: TEL, text: 'y el Aurora Nocturna tiene stock?', messageId: 'wamid.2' });
    expect(derivarMock).toHaveBeenCalledTimes(1);
    expect(r2.handledByHuman).toBe(true);
    expect(r2.reply).toBe('');
  });

  it('el carrito y la conversación se conservan: el guard no vacía ni modifica el carrito', async () => {
    sesion({ cart: CARRITO }, {});
    cablear();
    findMock.mockResolvedValue(PRODUCTO);
    await handleMessage({ tenantId: TENANT, from: TEL, text: '¿el Aurora Nocturna sigue costando lo mismo?', messageId: 'wamid.3' });
    expect((docs.get(SESSION) as { cart: typeof CARRITO }).cart).toEqual(CARRITO);
  });

  it('RECONCILIADO (verified) ⇒ el camino se rehabilita SOLO: sin derivación y con el flujo normal', async () => {
    sesion();
    cablear({ state: 'verified', driftedFields: [] });
    findMock.mockResolvedValue(PRODUCTO);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: '¿cuánto sale el Aurora Nocturna?', messageId: 'wamid.4' });
    expect(derivarMock).not.toHaveBeenCalled();
    expect(iaMock).toHaveBeenCalledTimes(1);
    expect(r.reply).toContain('Respuesta de la IA');
  });

  it('divergencia COSMÉTICA (nombre/descripción) NO corta la conversación', async () => {
    sesion();
    cablear({ driftedFields: ['title', 'description'] });
    findMock.mockResolvedValue(PRODUCTO);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: '¿cuánto sale el Aurora Nocturna?', messageId: 'wamid.5' });
    expect(derivarMock).not.toHaveBeenCalled();
    expect(r.reply).toContain('Respuesta de la IA');
  });

  it('sin derivador cableado el motor queda EXACTAMENTE como estaba (cero cambio de comportamiento)', async () => {
    sesion();
    findMock.mockResolvedValue(PRODUCTO);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: '¿cuánto sale el Aurora Nocturna?', messageId: 'wamid.6' });
    expect(derivarMock).not.toHaveBeenCalled();
    expect(r.reply).toContain('Respuesta de la IA');
  });

  it('un "sí" sobre la oferta vigente NO agrega ni anuncia un total: eso también es afirmar un precio', async () => {
    const ahora = Date.now();
    sesion({}, {
      pendingCartConfirmation: {
        products: [{ id: 'p1', name: 'Aurora Nocturna' }],
        primaryProductId: 'p1',
        source: 'catalog_listing',
        createdAtMs: ahora,
        expiresAtMs: ahora + 600_000,
        needsDisambiguation: false,
      },
    });
    cablear();
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'sí, dale', messageId: 'wamid.15' });
    expect(derivarMock).toHaveBeenCalledTimes(1);
    expect(r.reply).not.toMatch(/Agregué|Total/i);
    expect((docs.get(SESSION) as { cart: { items: unknown[] } }).cart.items).toHaveLength(0);
  });

  it('ver el carrito con un producto en deriva no lista precios: deriva primero', async () => {
    sesion({ cart: CARRITO, state: 'CART' });
    cablear();
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'mostrame mi carrito', messageId: 'wamid.16' });
    expect(derivarMock).toHaveBeenCalledTimes(1);
    expect(r.reply).not.toMatch(/\d{3}\.\d{3}/);
  });

  it('tenant SIN gobierno externo (gate por tenant en false) ⇒ ni consulta de deriva ni derivación', async () => {
    sesion();
    setDriftProjection({ activa: async () => false, snapshots: async () => { throw new Error('no debería consultarse'); } });
    findMock.mockResolvedValue(PRODUCTO);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: '¿tenés stock del Aurora Nocturna?', messageId: 'wamid.17' });
    expect(derivarMock).not.toHaveBeenCalled();
    expect(r.reply).toContain('Respuesta de la IA');
  });

  /**
   * Los interceptores determinísticos corren ANTES del guard (el guard solo evalúa si ninguno
   * resolvió el turno), así que tienen que consultar la deriva ellos mismos o cotizan igual.
   */
  it('reclamo de carrito ("yo quería el X") ⇒ NO cotiza el precio del reclamado: deriva', async () => {
    sesion();
    cablear();
    findMock.mockResolvedValue(PRODUCTO);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'yo quería el Aurora Nocturna', messageId: 'wamid.18' });
    expect(r.reply).not.toMatch(/\d{3}\.\d{3}/); // sin el "(₲ 250.000)" que ofrecía el interceptor
    expect(r.reply).not.toMatch(/Querés que agregue/i);
    expect(derivarMock).toHaveBeenCalledTimes(1);
    expect(derivarMock.mock.calls[0]?.[2].bloqueantes[0]?.productId).toBe('p1');
  });

  it('reclamo de carrito con el producto EN el carrito ⇒ no lista el detalle ni el total: deriva', async () => {
    sesion({ cart: CARRITO, state: 'CART' });
    cablear();
    findMock.mockResolvedValue(PRODUCTO);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'te equivocaste', messageId: 'wamid.19' });
    expect(r.reply).not.toMatch(/\d{3}\.\d{3}/);
    expect(derivarMock).toHaveBeenCalledTimes(1);
  });

  it('pregunta producto+ocasión ⇒ no afirma disponibilidad del producto en deriva: deriva', async () => {
    sesion();
    cablear();
    findMock.mockResolvedValue(PRODUCTO_CON_FICHA);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: '¿el Aurora Nocturna sirve para salir de noche?', messageId: 'wamid.20' });
    expect(r.reply).not.toMatch(/va muy bien|Te lo agrego/i); // la respuesta por ficha afirmaba y ofrecía
    expect(r.reply).toMatch(/confirmar/i);
    expect(derivarMock).toHaveBeenCalledTimes(1);
  });

  it('el interceptor de reclamo NO consulta la deriva cuando no cotiza nada (en pago)', async () => {
    sesion({ cart: CARRITO, state: 'AWAITING_PAYMENT' });
    setDriftProjection({ activa: async () => true, snapshots: async () => { throw new Error('no debería consultarse'); } });
    findMock.mockResolvedValue(PRODUCTO);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'yo quería el Aurora Nocturna', messageId: 'wamid.21' });
    expect(r.reply).toContain('Tu pedido ya quedó registrado');
    expect(derivarMock).not.toHaveBeenCalled();
  });

  it('un saludo puro no dispara ni el escaneo del catálogo ni la derivación', async () => {
    sesion();
    cablear();
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'hola', messageId: 'wamid.7' });
    expect(derivarMock).not.toHaveBeenCalled();
    expect(r.reply).toContain('Hola de nuevo');
  });
});

describe('engine — checkout: la orden no nace con un dato que no podemos confirmar', () => {
  it('"pagar" con deriva crítica ⇒ NO se crea la orden, NO salen datos bancarios y se deriva', async () => {
    sesion({ cart: CARRITO, state: 'CART' });
    cablear();
    crearOrdenMock.mockRejectedValue(
      new ProductoConDerivaCriticaError({ bloqueantes: [{ productId: 'p1', productName: 'Aurora Nocturna', reason: 'drifted_external', fields: ['price'] }], advertencias: [] }),
    );
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'quiero pagar', messageId: 'wamid.8' });
    expect(r.reply).not.toMatch(/Banco T|1-1/); // ni una cuenta bancaria
    expect(r.reply).not.toMatch(/\d{3}\.\d{3}/);
    expect(derivarMock).toHaveBeenCalledTimes(1);
    expect(derivarMock.mock.calls[0]?.[2].bloqueantes[0]?.productId).toBe('p1');
  });

  /**
   * El camino de REUSO retorna ANTES de createPendingOrder (donde vivía el único freno), así que
   * "pagar" sobre un pedido ya abierto reenviaba banco y total de un producto que no podemos
   * confirmar. Ahora el reuso también evalúa la deriva antes de reenviar nada.
   */
  it('"pagar" sobre un pedido REUTILIZABLE con deriva ⇒ NO reenvía datos bancarios ni el total', async () => {
    sesion({ cart: CARRITO, state: 'CART' }, { pendingOrderId: 'ord_1' });
    cablear();
    vi.mocked(resolveCheckoutReuse).mockResolvedValue({
      kind: 'reuse',
      repaired: false,
      order: { id: 'ord_1', customerId: TEL, status: 'PENDING_PAYMENT', items: [{ productId: 'p1', productName: 'Aurora Nocturna', quantity: 1 }], totals: { total: 250000 } },
    } as never);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'pagar', messageId: 'wamid.22' });
    expect(r.reply).not.toMatch(/Banco T|1-1/);
    expect(r.reply).not.toMatch(/\d{3}\.\d{3}/);
    expect(r.reply).not.toMatch(/Seguís con tu pedido pendiente/);
    expect(crearOrdenMock).not.toHaveBeenCalled(); // el reuso no crea nada, y tampoco reenvía
    expect(derivarMock).toHaveBeenCalledTimes(1);
    expect(derivarMock.mock.calls[0]?.[2].bloqueantes[0]?.productId).toBe('p1');
  });

  it('"pagar" sobre un pedido REUTILIZABLE sin deriva sigue reenviando el pedido (cero regresión)', async () => {
    sesion({ cart: CARRITO, state: 'CART' }, { pendingOrderId: 'ord_1' });
    cablear({ state: 'verified', driftedFields: [] });
    vi.mocked(resolveCheckoutReuse).mockResolvedValue({
      kind: 'reuse',
      repaired: false,
      order: { id: 'ord_1', customerId: TEL, status: 'PENDING_PAYMENT', items: [{ productId: 'p1', productName: 'Aurora Nocturna', quantity: 1 }], totals: { total: 250000 } },
    } as never);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'pagar', messageId: 'wamid.23' });
    expect(r.reply).toContain('Seguís con tu pedido pendiente');
    expect(r.state).toBe('AWAITING_PAYMENT');
    expect(derivarMock).not.toHaveBeenCalled();
  });

  it('el guard conversacional NO se mete en el turno de "pagar": ese camino es del checkout', async () => {
    sesion({ cart: CARRITO, state: 'CART' });
    cablear(); // deriva bloqueante vigente
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'quiero pagar', messageId: 'wamid.9' });
    expect(crearOrdenMock).toHaveBeenCalledTimes(1); // el checkout corrió su secuencia completa
    expect(derivarMock).not.toHaveBeenCalled(); // la orden se creó: no había nada que derivar
    expect(r.state).toBe('AWAITING_PAYMENT');
  });
});

describe('engine — precedencia: el guard nuevo no le roba el turno a los que ya existían', () => {
  it('Coverage (chat): una consulta de cobertura que además nombra el producto la responde Coverage', async () => {
    sesion();
    cablear();
    findMock.mockResolvedValue(PRODUCTO);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: '¿hacen envíos al interior?', messageId: 'wamid.10' });
    expect(r.reply).toContain('cobertura, el costo y el tiempo de envío');
    expect(derivarMock).not.toHaveBeenCalled();
    expect(iaMock).not.toHaveBeenCalled();
  });

  it('Coverage (en espera de ubicación): la dirección la procesa Coverage, no el guard de deriva', async () => {
    sesion({}, { coverage: { requestId: 'covr_1', status: 'awaiting_location', updatedAt: { toMillis: () => 1 } } });
    cablear();
    findMock.mockResolvedValue(PRODUCTO);
    vi.mocked(clasificarTextoEnEspera).mockReturnValue('direccion' as never);
    vi.mocked(manejarTurnoEnEsperaUbicacion).mockResolvedValue({ reply: 'Gracias, lo estamos revisando.', takeover: false } as never);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'Avenida Siempre Viva 742, casi Segunda', messageId: 'wamid.11' });
    expect(r.reply).toContain('lo estamos revisando');
    expect(derivarMock).not.toHaveBeenCalled();
  });

  it('Shipping/Coverage en el checkout: el gate pide la ubicación ANTES de cualquier freno por deriva', async () => {
    sesion({ cart: CARRITO, state: 'CART' });
    cablear();
    vi.mocked(gateCoberturaCheckout).mockResolvedValue({ reply: '📍 Necesitamos tu ubicación para confirmar la cobertura.', locationRequest: true } as never);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'pagar', messageId: 'wamid.12' });
    expect(r.reply).toContain('ubicación');
    expect(crearOrdenMock).not.toHaveBeenCalled();
    expect(derivarMock).not.toHaveBeenCalled();
  });

  it('pedido de una persona: HANDOFF-2 conserva su precedencia (razón customer_requested)', async () => {
    sesion();
    cablear();
    findMock.mockResolvedValue(PRODUCTO);
    vi.mocked(esPosiblePedidoHumano).mockReturnValue(true);
    vi.mocked(procesarPedidoHumano).mockResolvedValue({ handled: true, takeover: true, reply: 'Te paso con una persona.' } as never);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'quiero hablar con un vendedor por el Aurora Nocturna', messageId: 'wamid.13' });
    expect(r.reply).toContain('Te paso con una persona');
    expect(derivarMock).not.toHaveBeenCalled();
  });

  it('en AWAITING_PAYMENT manda el flujo de pago/comprobante: el guard no interviene', async () => {
    sesion({ cart: CARRITO, state: 'AWAITING_PAYMENT' });
    cablear();
    findMock.mockResolvedValue(PRODUCTO);
    await handleMessage({ tenantId: TENANT, from: TEL, text: '¿el Aurora Nocturna ya está confirmado?', messageId: 'wamid.14' });
    expect(derivarMock).not.toHaveBeenCalled();
  });

  /**
   * ÚNICA excepción al gate por estado: la VISTA DE CARRITO. El cliente que ya pidió pagar y
   * después escribe "carrito" recibía `formatCart` — detalle por ítem Y total — o sea la
   * afirmación de precio más explícita del bot, sin pasar por el guard. Ese turno no es del flujo
   * de pago: no manda banco, no toca la orden y no lee un comprobante.
   */
  it('en AWAITING_PAYMENT la VISTA DE CARRITO con deriva no lista precios ni total: deriva', async () => {
    sesion({ cart: CARRITO, state: 'AWAITING_PAYMENT' }, { pendingOrderId: 'ord_1' });
    cablear();
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'mostrame mi carrito', messageId: 'wamid.24' });
    expect(r.reply).not.toMatch(/\d{3}\.\d{3}/); // ni el precio por ítem ni el total
    expect(r.reply).not.toMatch(/Tu carrito|Total/i);
    expect(derivarMock).toHaveBeenCalledTimes(1);
    expect(derivarMock.mock.calls[0]?.[2].bloqueantes[0]).toMatchObject({ productId: 'p1', reason: 'drifted_external', fields: ['price'] });
  });

  it('en AWAITING_PAYMENT y SIN deriva, la vista de carrito sigue mostrando el detalle (cero regresión)', async () => {
    sesion({ cart: CARRITO, state: 'AWAITING_PAYMENT' }, { pendingOrderId: 'ord_1' });
    cablear({ state: 'verified', driftedFields: [] });
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'mostrame mi carrito', messageId: 'wamid.25' });
    expect(r.reply).toContain('Tu carrito');
    expect(r.reply).toContain('250.000');
    expect(derivarMock).not.toHaveBeenCalled();
  });
});

/**
 * INTERSECCIÓN pagar ∧ carrito (hallazgo ALTO del review de cierre). El gate del guard se apagaba
 * con `quierePagar` sola, pero `decidirRespuesta` atiende la VISTA DE CARRITO ANTES que el
 * checkout: un mensaje que dispara las DOS intenciones no termina en el checkout —termina en
 * `formatCart`, con el detalle por ítem y el total— y salteaba el guard entero. No es un problema
 * de estado de sesión (pasa en CART igual que en AWAITING_PAYMENT): es la intersección.
 */
describe('engine — guard de deriva: la intersección "pagar" ∧ "ver carrito" NO saltea el guard', () => {
  const MENSAJES_MIXTOS = [
    'quiero pagar mi pedido',
    'pagar, qué llevo?',
    'quiero comprar, mostrame mi carrito',
    'dale pago mi compra',
  ] as const;
  const ESTADOS = ['CART', 'AWAITING_PAYMENT'] as const;

  for (const estado of ESTADOS) {
    for (const [i, msg] of MENSAJES_MIXTOS.entries()) {
      it(`[${estado}] "${msg}" con deriva ⇒ no lista precios ni total, no crea orden y deriva`, async () => {
        sesion({ cart: CARRITO, state: estado }, estado === 'AWAITING_PAYMENT' ? { pendingOrderId: 'ord_1' } : {});
        cablear();
        const r = await handleMessage({ tenantId: TENANT, from: TEL, text: msg, messageId: `wamid.mix.${estado}.${i}` });
        expect(r.reply).not.toMatch(/\d{3}\.\d{3}/); // ni el precio por ítem ni el total
        expect(r.reply).not.toMatch(/Tu carrito|Total:/i);
        expect(r.reply).not.toMatch(/Banco T|1-1/); // tampoco datos bancarios por el checkout
        expect(crearOrdenMock).not.toHaveBeenCalled();
        expect(derivarMock).toHaveBeenCalledTimes(1);
        expect(derivarMock.mock.calls[0]?.[2].bloqueantes[0]).toMatchObject({ productId: 'p1', reason: 'drifted_external', fields: ['price'] });
      });
    }

    for (const [i, msg] of MENSAJES_MIXTOS.entries()) {
      it(`[${estado}] "${msg}" SIN deriva sigue mostrando el carrito (cero regresión)`, async () => {
        sesion({ cart: CARRITO, state: estado }, estado === 'AWAITING_PAYMENT' ? { pendingOrderId: 'ord_1' } : {});
        cablear({ state: 'verified', driftedFields: [] });
        const r = await handleMessage({ tenantId: TENANT, from: TEL, text: msg, messageId: `wamid.mixok.${estado}.${i}` });
        expect(r.reply).toContain('Tu carrito');
        expect(r.reply).toContain('250.000');
        expect(derivarMock).not.toHaveBeenCalled();
      });
    }
  }

  it('el pago PURO conserva su exclusión: sigue siendo del checkout (que tiene su propio freno)', async () => {
    sesion({ cart: CARRITO, state: 'CART' });
    cablear(); // deriva bloqueante vigente
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'quiero pagar', messageId: 'wamid.puro' });
    expect(crearOrdenMock).toHaveBeenCalledTimes(1); // el checkout corrió su secuencia completa
    expect(derivarMock).not.toHaveBeenCalled();
    expect(r.state).toBe('AWAITING_PAYMENT');
  });
});

/**
 * FAIL-CLOSED de la rama de REUSO (hallazgo MEDIO del review de cierre). Reenviar los datos
 * bancarios y el total de un pedido abierto compromete plata igual que crear la orden, así que
 * "no hay deriva" y "no pude leer si la hay" NO son lo mismo acá: un error transitorio de la
 * proyección tiene que frenar y volver a preguntar (ADR-0015 §8), no dejar pasar.
 */
describe('engine — checkout: la rama de REUSO falla CERRADO ante un error de la proyección', () => {
  const REUSO = {
    kind: 'reuse',
    repaired: false,
    order: { id: 'ord_1', customerId: TEL, status: 'PENDING_PAYMENT', items: [{ productId: 'p1', productName: 'Aurora Nocturna', quantity: 1 }], totals: { total: 250000 } },
  };

  it('la proyección no se puede LEER ⇒ NO se reenvían datos bancarios ni el total: se deriva honesto', async () => {
    sesion({ cart: CARRITO, state: 'CART' }, { pendingOrderId: 'ord_1' });
    setDriftProjection({
      activa: async () => true,
      snapshots: async () => { throw new Error('lectura de la proyección caída'); },
    });
    vi.mocked(resolveCheckoutReuse).mockResolvedValue(REUSO as never);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'pagar', messageId: 'wamid.reuse.fc1' });
    expect(r.reply).not.toMatch(/Banco T|1-1/);
    expect(r.reply).not.toMatch(/\d{3}\.\d{3}/);
    expect(r.reply).not.toMatch(/Seguís con tu pedido pendiente/);
    expect(crearOrdenMock).not.toHaveBeenCalled();
    expect(derivarMock).toHaveBeenCalledTimes(1);
    expect(derivarMock.mock.calls[0]?.[2].bloqueantes[0]).toMatchObject({ productId: 'p1', reason: 'unverifiable' });
  });

  it('el gate barato por tenant tampoco puede abrir la puerta: si `activa` falla, igual se evalúa', async () => {
    sesion({ cart: CARRITO, state: 'CART' }, { pendingOrderId: 'ord_1' });
    setDriftProjection({
      activa: async () => { throw new Error('config ilegible'); },
      snapshots: async (_t, ids) => ids.map((productId) => ({ productId, externalFields: TODOS_LOS_CAMPOS, state: 'drifted_external' as const, driftedFields: ['price'] })),
    });
    vi.mocked(resolveCheckoutReuse).mockResolvedValue(REUSO as never);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'pagar', messageId: 'wamid.reuse.fc2' });
    expect(r.reply).not.toMatch(/Banco T|Seguís con tu pedido pendiente/);
    expect(derivarMock).toHaveBeenCalledTimes(1);
    expect(derivarMock.mock.calls[0]?.[2].bloqueantes[0]).toMatchObject({ productId: 'p1', reason: 'drifted_external' });
  });

  it('un pedido abierto SIN ítems legibles es `unverifiable`: no se manda el total de lo que no sabemos atribuir', async () => {
    sesion({ cart: CARRITO, state: 'CART' }, { pendingOrderId: 'ord_1' });
    cablear({ state: 'verified', driftedFields: [] }); // proyección sana: lo que falta es la orden
    vi.mocked(resolveCheckoutReuse).mockResolvedValue({ ...REUSO, order: { ...REUSO.order, items: [] } } as never);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'pagar', messageId: 'wamid.reuse.fc3' });
    expect(r.reply).not.toMatch(/Banco T|Seguís con tu pedido pendiente|\d{3}\.\d{3}/);
    expect(derivarMock).toHaveBeenCalledTimes(1);
    expect(derivarMock.mock.calls[0]?.[2].bloqueantes[0]).toMatchObject({ reason: 'unverifiable' });
  });

  it('sin proyección cableada la rama de reuso queda EXACTAMENTE como estaba (cero cambio)', async () => {
    sesion({ cart: CARRITO, state: 'CART' }, { pendingOrderId: 'ord_1' });
    vi.mocked(resolveCheckoutReuse).mockResolvedValue(REUSO as never);
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'pagar', messageId: 'wamid.reuse.fc4' });
    expect(r.reply).toContain('Seguís con tu pedido pendiente');
    expect(r.state).toBe('AWAITING_PAYMENT');
    expect(derivarMock).not.toHaveBeenCalled();
  });
});
