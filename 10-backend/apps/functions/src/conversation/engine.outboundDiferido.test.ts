import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0016 §12 — QUIÉN ESCRIBE LA BURBUJA DEL BOT.
 * ================================================
 * El motor persistía su respuesta ANTES de que existiera cualquier envío. Con eso, cualquier
 * supresión posterior —la que exige §12— dejaba un mensaje fantasma: el vendedor abre la
 * conversación, lee "el bot le contestó esto" y el cliente nunca lo recibió.
 *
 * Con `deferOutbound` el motor deja de persistir y devuelve el DESCRIPTOR: qué burbuja habría que
 * escribir y con qué vara medir el silencio. Sin la marca (simulador del panel, chat de prueba,
 * dev) nadie envía nada y el motor sigue registrando, exactamente como antes.
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
    session: (t: string, c: string) => `tenants/${t}/customers/${c}/sessions/active`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
  },
}));
vi.mock('./messages.js', () => ({
  appendMessage: vi.fn(async () => undefined),
  listRecentMessages: vi.fn(async () => []),
  markConversationRead: vi.fn(async () => undefined),
}));
vi.mock('./agentConfig.js', () => ({ getAgentConfig: vi.fn(async () => ({ greetingMessage: '', botEnabled: true, profitMode: false })) }));
vi.mock('../tracking/tracking.js', () => ({ captureTrackingCode: vi.fn(async () => undefined) }));
vi.mock('../catalog/search.js', () => ({ searchCatalog: vi.fn(async () => []), getProductById: vi.fn(async () => null), findProductByName: vi.fn(async () => null) }));
vi.mock('../ai/salesAgent.js', () => ({ runSalesAgent: vi.fn(async () => ({ used: false, reason: 'feature_unavailable' })) }));
const procesarPedidoHumano = vi.fn(async () => ({ handled: false, takeover: false, reply: '' }));
const esPosiblePedidoHumano = vi.fn(() => false);
vi.mock('./humanRequest.js', () => ({
  esPosiblePedidoHumano: (...a: unknown[]) => esPosiblePedidoHumano(...(a as [])),
  procesarPedidoHumano: (...a: unknown[]) => procesarPedidoHumano(...(a as [])),
}));
vi.mock('./aiUnavailable.js', () => ({ derivarPorIaNoDisponible: vi.fn(), esConsultaDerivable: vi.fn(() => false) }));
vi.mock('./coverage.js', () => ({
  gateCoberturaCheckout: vi.fn(async () => null),
  clasificarTextoEnEspera: vi.fn(() => 'otro'),
  manejarTurnoEnEsperaUbicacion: vi.fn(async () => null),
  actualizarUbicacionEnRevision: vi.fn(async () => undefined),
}));
vi.mock('../orders/checkoutReuse.js', () => ({ resolveCheckoutReuse: vi.fn(async () => ({ kind: 'new' })) }));
vi.mock('../orders/checkoutConfig.js', async (io) => {
  const real = await io<typeof import('../orders/checkoutConfig.js')>();
  return { ...real, getCheckoutConfig: vi.fn(async () => ({ bankAccounts: [], sellers: [] })) };
});
vi.mock('../orders/createPendingOrder.js', async (io) => {
  const real = await io<typeof import('../orders/createPendingOrder.js')>();
  return { ...real, createPendingOrder: vi.fn() };
});
vi.mock('../entitlements/entitlements.js', () => ({ checkQuota: vi.fn(async () => ({ allowed: true, used: 0, limit: 10 })), meterUsage: vi.fn(async () => undefined) }));
vi.mock('./driftHandoff.js', () => ({ derivarPorDerivaCritica: vi.fn() }));

import { handleMessage } from './engine.js';
import { appendMessage } from './messages.js';

const appendMock = vi.mocked(appendMessage);
const salidas = () => appendMock.mock.calls.filter(([, , arg]) => (arg as { direction: string }).direction === 'out');

const TENANT = 't_def';
const TEL = '595000001111';

beforeEach(() => {
  docs.clear();
  appendMock.mockClear();
  esPosiblePedidoHumano.mockReturnValue(false);
  procesarPedidoHumano.mockResolvedValue({ handled: false, takeover: false, reply: '' });
});

describe('handleMessage con `deferOutbound` (ADR-0016 §12)', () => {
  it('NO persiste la respuesta del bot y devuelve el descriptor con la vara ESTRICTA', async () => {
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'hola', messageId: 'wamid.d1', deferOutbound: true });

    expect(r.reply.trim().length).toBeGreaterThan(0);
    expect(salidas()).toHaveLength(0); // la burbuja la escribe el borde de envío, no el motor
    expect(r.outbound).toBeDefined();
    expect(r.outbound!.expectativa).toEqual({ modo: 'requiere_silencio_libre' });
    expect(r.outbound!.humanTakeover).toBe(false);
  });

  it('CONTROL: sin la marca (simulador/dev) el motor persiste como siempre y no devuelve descriptor', async () => {
    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'hola', messageId: 'wamid.d2' });

    expect(salidas()).toHaveLength(1);
    expect(r.outbound).toBeUndefined();
  });

  it('la confirmación de un handoff propio viaja con su sourceId (si no, el guard la mataría)', async () => {
    esPosiblePedidoHumano.mockReturnValue(true);
    procesarPedidoHumano.mockResolvedValue({ handled: true, takeover: true, reply: 'Dale, te paso con Ana 🙌' });

    const r = await handleMessage({ tenantId: TENANT, from: TEL, text: 'quiero hablar con un vendedor', messageId: 'wamid.d3', deferOutbound: true });

    expect(salidas()).toHaveLength(0);
    // El wamid es el MISMO sourceId con el que `procesarPedidoHumano` persistió la transición.
    expect(r.outbound!.expectativa).toEqual({ modo: 'confirma_handoff_propio', sourceId: 'wamid.d3' });
    // Y la burbuja, cuando salga, tiene que reflejar el handoff en la bandeja del vendedor.
    expect(r.outbound!.humanTakeover).toBe(true);
    expect(r.outbound!.countUnread).toBe(true);
  });
});
