import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §2 — LA SESIÓN ES DEL CANAL, Y EL MOTOR TIENE QUE DECIRLO.
 * ===================================================================
 * Dos defectos distintos, los dos en el mismo turno del motor:
 *
 *  1. `engine.ts` escribía `id: 'active'` DENTRO de cualquier sesión, incluida la de un canal
 *     que no es el heredado. El documento vive en `sessions/wa_{pnid}` pero su campo `id` jura
 *     ser `active`: cualquier lector que confíe en el campo (el panel, una auditoría, un job que
 *     re-derive el path desde el documento) termina operando sobre la conversación del número
 *     que HOY vende. El molde correcto ya existe y es `handoff.ts:142`.
 *
 *  2. Los guards que el motor delega —pedido de humano, cobertura— recibían el tenant y el
 *     cliente pero NO el canal, así que ejecutaban su transición sobre `sessions/active`. El
 *     cliente que pide «quiero hablar con una persona» por el número nuevo recibe la promesa de
 *     pausa mientras el bot sigue hablando en ese número y el que SÍ vende queda mudo.
 *
 * El caso heredado (sin `sessionKey`) tiene que quedar EXACTAMENTE igual: `active`.
 */
const docs = new Map<string, Record<string, unknown>>();

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (d: Record<string, unknown>) => { docs.set(path, { ...(docs.get(path) ?? {}), ...d }); },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async (ref: { path: string }) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        set: (ref: { path: string }, d: Record<string, unknown>) => { docs.set(ref.path, d); },
        update: (ref: { path: string }, d: Record<string, unknown>) => { docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...d }); },
      }),
  }),
  paths: {
    session: (t: string, c: string, s: string) => `tenants/${t}/customers/${c}/sessions/${s}`,
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
  return { ...real, createPendingOrder: vi.fn(async () => ({ id: 'ord_1', totals: { subtotal: 1, discount: 0, shipping: 0, total: 1 } })) };
});
vi.mock('../entitlements/entitlements.js', () => ({ checkQuota: vi.fn(async () => ({ allowed: true, used: 0, limit: 10 })), meterUsage: vi.fn(async () => undefined) }));
vi.mock('./driftHandoff.js', () => ({ derivarPorDerivaCritica: vi.fn() }));

import { handleMessage } from './engine.js';
import { esPosiblePedidoHumano, procesarPedidoHumano } from './humanRequest.js';
import { gateCoberturaCheckout, clasificarTextoEnEspera, manejarTurnoEnEsperaUbicacion } from './coverage.js';

const TENANT = 't1';
const TEL = '595000005678';
/** El número que YA vende vive en el canal heredado; el que entra por Coexistence, en el suyo. */
const CANAL_HEREDADO = `tenants/${TENANT}/customers/${TEL}/sessions/active`;
const CANAL_NUEVO = `tenants/${TENANT}/customers/${TEL}/sessions/wa_444555666`;

const sesion = (path: string, over: Record<string, unknown> = {}) => {
  docs.set(path, {
    id: path.split('/').pop(),
    tenantId: TENANT,
    customerId: TEL,
    state: 'BROWSING',
    cart: { items: [], subtotal: 0 },
    context: { humanTakeover: false, lastShownSkus: [], currentPage: 0, currentCategoryId: null, pendingOrderId: null, pendingPaymentId: null },
    ...over,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  docs.clear();
  vi.mocked(esPosiblePedidoHumano).mockReturnValue(false);
  vi.mocked(clasificarTextoEnEspera).mockReturnValue('otro' as never);
  vi.mocked(gateCoberturaCheckout).mockResolvedValue(null as never);
  vi.mocked(manejarTurnoEnEsperaUbicacion).mockResolvedValue(null as never);
});

describe('engine — el campo `id` de la sesión dice el canal REAL (ADR-0017 §2)', () => {
  it('canal propio: la sesión escrita en `wa_444555666` NO puede declarar `id: "active"`', async () => {
    sesion(CANAL_NUEVO);

    await handleMessage({ tenantId: TENANT, from: TEL, text: 'hola', sessionKey: 'wa_444555666' });

    const escrita = docs.get(CANAL_NUEVO) as { id?: string } | undefined;
    expect(escrita).toBeDefined();
    // El defecto: el documento vive en `wa_444555666` y juraba llamarse `active`.
    expect(escrita?.id).toBe('wa_444555666');
    // Y el canal heredado —el del número que HOY vende— no se tocó ni una vez.
    expect(docs.has(CANAL_HEREDADO)).toBe(false);
  });

  it('canal heredado (sin `sessionKey`): sigue siendo exactamente `active`', async () => {
    sesion(CANAL_HEREDADO);

    await handleMessage({ tenantId: TENANT, from: TEL, text: 'hola' });

    expect((docs.get(CANAL_HEREDADO) as { id?: string }).id).toBe('active');
    expect(docs.has(CANAL_NUEVO)).toBe(false);
  });
});

describe('dos números del mismo tenant hablando con el MISMO cliente', () => {
  it('no comparten carrito, estado ni takeover: cada turno escribe SOLO su canal', async () => {
    // El canal heredado tiene un checkout en curso; el nuevo, una charla recién empezada.
    sesion(CANAL_HEREDADO, {
      state: 'AWAITING_PAYMENT',
      cart: { items: [{ productId: 'p1', name: 'Aurora', price: 250000, quantity: 1 }], subtotal: 250000 },
      context: { humanTakeover: true, handoffReason: 'payment_verification', lastShownSkus: [], currentPage: 0, currentCategoryId: null, pendingOrderId: 'ord_9', pendingPaymentId: null },
    });
    sesion(CANAL_NUEVO);

    await handleMessage({ tenantId: TENANT, from: TEL, text: 'hola', sessionKey: 'wa_444555666' });

    const heredado = docs.get(CANAL_HEREDADO) as { state?: string; cart?: { items: unknown[] }; context?: Record<string, unknown> };
    // El número que ya vende conserva su checkout, su carrito y su takeover, intactos.
    expect(heredado.state).toBe('AWAITING_PAYMENT');
    expect(heredado.cart?.items).toHaveLength(1);
    expect(heredado.context?.humanTakeover).toBe(true);
    expect(heredado.context?.pendingOrderId).toBe('ord_9');
    // Y el canal nuevo arrancó vacío: no heredó nada del otro.
    const nuevo = docs.get(CANAL_NUEVO) as { cart?: { items: unknown[] }; context?: Record<string, unknown> };
    expect(nuevo.cart?.items).toHaveLength(0);
    expect(nuevo.context?.humanTakeover).toBe(false);
    expect(nuevo.context?.pendingOrderId ?? null).toBeNull();
  });

  it('el takeover del canal heredado NO silencia al bot en el canal nuevo', async () => {
    sesion(CANAL_HEREDADO, { context: { humanTakeover: true, handoffReason: 'seller_manual', lastShownSkus: [], currentPage: 0, currentCategoryId: null, pendingOrderId: null, pendingPaymentId: null } });
    sesion(CANAL_NUEVO);

    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'hola', sessionKey: 'wa_444555666' });

    // Con la sesión compartida, este turno salía mudo (el bot se creía en pausa por el OTRO número).
    expect(r.reply.trim()).not.toBe('');
    expect(r.handledByHuman).not.toBe(true);
  });
});

describe('engine — los guards que el motor delega reciben el canal', () => {
  it('pedido de atención humana: `procesarPedidoHumano` recibe el `sessionKey` del turno', async () => {
    sesion(CANAL_NUEVO);
    vi.mocked(esPosiblePedidoHumano).mockReturnValue(true);
    vi.mocked(procesarPedidoHumano).mockResolvedValue({ handled: true, takeover: true, reply: 'Listo ✅' } as never);

    await handleMessage({ tenantId: TENANT, from: TEL, text: 'quiero hablar con una persona', sessionKey: 'wa_444555666', messageId: 'wamid.1' });

    // Sin esto, la pausa prometida al cliente se persiste en la conversación del OTRO número.
    expect(vi.mocked(procesarPedidoHumano).mock.calls[0]?.[3]).toMatchObject({ sessionKey: 'wa_444555666' });
  });

  it('cobertura: el gate del checkout recibe el `sessionKey` del turno', async () => {
    sesion(CANAL_NUEVO, { state: 'CART', cart: { items: [{ productId: 'p1', name: 'X', price: 1000, quantity: 1 }], subtotal: 1000 } });

    await handleMessage({ tenantId: TENANT, from: TEL, text: 'quiero pagar', sessionKey: 'wa_444555666' });

    expect(vi.mocked(gateCoberturaCheckout).mock.calls[0]?.[3]).toMatchObject({ sessionKey: 'wa_444555666' });
  });

  it('cobertura en espera de ubicación: el turno de espera recibe el `sessionKey`', async () => {
    // El puntero de cobertura vive EN la sesión del canal: es lo que habilita este camino.
    sesion(CANAL_NUEVO, {
      context: {
        humanTakeover: false, lastShownSkus: [], currentPage: 0, currentCategoryId: null,
        pendingOrderId: null, pendingPaymentId: null,
        coverage: { requestId: 'covr_1', status: 'awaiting_location', locationFingerprint: null },
      },
    });
    vi.mocked(clasificarTextoEnEspera).mockReturnValue('direccion' as never);
    vi.mocked(manejarTurnoEnEsperaUbicacion).mockResolvedValue({ takeover: false, reply: 'Recibí tu ubicación ✅' } as never);

    await handleMessage({ tenantId: TENANT, from: TEL, text: 'Asunción, barrio Villa Morra', sessionKey: 'wa_444555666' });

    expect(vi.mocked(manejarTurnoEnEsperaUbicacion).mock.calls[0]?.[4]).toMatchObject({ sessionKey: 'wa_444555666' });
  });
});
