import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * COVERAGE-CHECKOUT-REUSE-GATE-1 — precedencia normativa del checkout (hallazgo MEDIO de
 * COVERAGE-ARFAGI-ACTIVATION-AUDIT-2): un pedido REUTILIZABLE/abierto se resuelve ANTES de que
 * Coverage pueda iniciar una cotización; el gate corre SOLO para una compra realmente nueva
 * (decisiones `new` / `new_cart_changed`). Con Coverage OFF (gate null) el F5 queda idéntico.
 */
vi.mock('./coverage.js', async (io) => {
  const real = await io<typeof import('./coverage.js')>();
  return { ...real, gateCoberturaCheckout: vi.fn() };
});
vi.mock('../orders/checkoutReuse.js', () => ({ resolveCheckoutReuse: vi.fn() }));
vi.mock('../orders/createPendingOrder.js', () => ({ createPendingOrder: vi.fn() }));
vi.mock('../orders/checkoutConfig.js', async (io) => {
  const real = await io<typeof import('../orders/checkoutConfig.js')>();
  return { ...real, getCheckoutConfig: vi.fn() };
});
vi.mock('../entitlements/entitlements.js', async (io) => {
  const real = await io<typeof import('../entitlements/entitlements.js')>();
  return { ...real, checkQuota: vi.fn(), meterUsage: vi.fn() };
});

import { gateCoberturaCheckout } from './coverage.js';
import { resolveCheckoutReuse } from '../orders/checkoutReuse.js';
import { createPendingOrder } from '../orders/createPendingOrder.js';
import { getCheckoutConfig } from '../orders/checkoutConfig.js';
import { checkQuota, meterUsage } from '../entitlements/entitlements.js';
import { decidirRespuesta } from './engine.js';
import type { Cart, SessionState } from '@vpw/shared';

const gateMock = vi.mocked(gateCoberturaCheckout);
const reuseMock = vi.mocked(resolveCheckoutReuse);
const createMock = vi.mocked(createPendingOrder);
const configMock = vi.mocked(getCheckoutConfig);
const quotaMock = vi.mocked(checkQuota);
const meterMock = vi.mocked(meterUsage);

const CART: Cart = { items: [{ productId: 'p1', name: 'Armaf Odyssey Mega', price: 250000, quantity: 1 }], subtotal: 250000 } as Cart;
const ORDEN = { id: 'ord_REUSE0001', status: 'PENDING_PAYMENT', totals: { subtotal: 250000, discount: 0, shipping: 30000, total: 280000 } };
const CONFIG = { bankAccounts: [{ bank: 'Banco T', accountNumber: '1-1', holder: 'H', document: 'D' }] };
const GATE = { reply: '📍 Necesitamos tu ubicación para confirmar la cobertura.', locationRequest: true, coverage: { requestId: 'covr_x' } };

const base = (over: Record<string, unknown> = {}) => ({
  cart: CART,
  lastShownSkus: [] as string[],
  greeting: '',
  profitMode: false,
  state: 'CART' as SessionState,
  pendingOrderId: 'ord_REUSE0001',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  configMock.mockResolvedValue(CONFIG as never);
  quotaMock.mockResolvedValue({ allowed: true, used: 0, limit: 10 } as never);
  meterMock.mockResolvedValue(undefined as never);
  createMock.mockResolvedValue({ id: 'ord_NUEVA00001', totals: { subtotal: 250000, discount: 0, shipping: 0, total: 250000 } } as never);
  gateMock.mockResolvedValue(GATE as never); // Coverage ON y bloqueando, salvo que el test lo apague
});

describe('precedencia: pedido reutilizable/abierto ANTES que Coverage', () => {
  it('1. Coverage ON + PENDING_PAYMENT + mismo carrito + "pagar" ⇒ MISMO orderId + banco reutilizado; cero segunda orden; el gate NO corre', async () => {
    reuseMock.mockResolvedValue({ kind: 'reuse', order: ORDEN, repaired: false } as never);
    const r = await decidirRespuesta('t1', 'c1', 'quiero pagar', false, base() as never);
    expect(r.reply).toContain('pedido pendiente');
    expect(r.pendingOrderId).toBe('ord_REUSE0001');
    expect(r.nextState).toBe('AWAITING_PAYMENT');
    expect(gateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('2. puntero perdido + PENDING_PAYMENT reciente ⇒ se repara y reutiliza ANTES de Coverage', async () => {
    reuseMock.mockResolvedValue({ kind: 'reuse', order: ORDEN, repaired: true } as never);
    const r = await decidirRespuesta('t1', 'c1', 'pagar', false, base({ pendingOrderId: null }) as never);
    expect(reuseMock).toHaveBeenCalledWith('t1', 'c1', null, CART);
    expect(r.pendingOrderId).toBe('ord_REUSE0001');
    expect(gateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('3. Coverage ON + PENDING_VERIFICATION ⇒ "comprobante en revisión"; cero orden/banco/cotización/handoff', async () => {
    reuseMock.mockResolvedValue({ kind: 'verification', order: ORDEN } as never);
    const r = await decidirRespuesta('t1', 'c1', 'pago', false, base() as never);
    expect(r.reply).toContain('comprobante ya está en revisión');
    expect(gateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(configMock).not.toHaveBeenCalled(); // el banco NO se re-presenta
  });

  it('4. orden creada tras aprobación de Coverage + "pagar" repetido ⇒ reutiliza, SIN REQUOTE ni segunda orden', async () => {
    // La ventana post-aprobación: la orden existe en PENDING_PAYMENT (con envío) y el cliente repite "pagar".
    reuseMock.mockResolvedValue({ kind: 'reuse', order: ORDEN, repaired: false } as never);
    const r = await decidirRespuesta('t1', 'c1', 'para pagar cuál es', false, base() as never);
    expect(r.reply).toContain('280.000'); // el banco reutiliza el total CON envío del pedido existente
    expect(gateMock).not.toHaveBeenCalled(); // jamás REQUOTE sobre un pedido abierto
    expect(createMock).not.toHaveBeenCalled();
  });

  it('5. pedido PAID del mismo carrito ⇒ limpieza existente; NO entra a Coverage', async () => {
    reuseMock.mockResolvedValue({ kind: 'paid', order: ORDEN } as never);
    const r = await decidirRespuesta('t1', 'c1', 'pagar', false, base() as never);
    expect(r.reply).toContain('ya figura pagado');
    expect(r.pendingOrderId).toBeNull();
    expect(r.cart).toEqual({ items: [], subtotal: 0 });
    expect(gateMock).not.toHaveBeenCalled();
  });

  it('6. compra realmente NUEVA ⇒ SÍ pasa por el gate; bloqueado ⇒ cero orden/banco/cuota/metering', async () => {
    reuseMock.mockResolvedValue({ kind: 'new' } as never);
    const r = await decidirRespuesta('t1', 'c1', 'quiero pagar', false, base({ pendingOrderId: null }) as never);
    expect(gateMock).toHaveBeenCalledTimes(1);
    expect(r.reply).toContain('ubicación');
    expect(r.locationRequest).toBe(true);
    expect(createMock).not.toHaveBeenCalled();
    expect(quotaMock).not.toHaveBeenCalled();
    expect(meterMock).not.toHaveBeenCalled();
    expect(configMock).not.toHaveBeenCalled();
  });

  it('7. new_cart_changed + gate null ⇒ avisoCambio + orden nueva (la anterior NO se toca)', async () => {
    reuseMock.mockResolvedValue({ kind: 'new_cart_changed', previous: ORDEN } as never);
    gateMock.mockResolvedValue(null as never);
    const r = await decidirRespuesta('t1', 'c1', 'pagar', false, base() as never);
    expect(gateMock).toHaveBeenCalledTimes(1);
    expect(r.reply).toContain('carrito cambió');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('7b. new_cart_changed + gate BLOQUEANDO ⇒ ni orden nueva ni se pisa/cancela la anterior', async () => {
    reuseMock.mockResolvedValue({ kind: 'new_cart_changed', previous: ORDEN } as never);
    const r = await decidirRespuesta('t1', 'c1', 'pagar', false, base() as never);
    expect(r.reply).toContain('ubicación');
    expect(createMock).not.toHaveBeenCalled();
    expect(r.pendingOrderId).toBeUndefined(); // la semántica del puntero no se altera desde el gate
  });

  it('8. Coverage OFF (gate null) ⇒ F5 idéntico: new crea orden; reuse reutiliza', async () => {
    gateMock.mockResolvedValue(null as never);
    reuseMock.mockResolvedValueOnce({ kind: 'new' } as never);
    const r1 = await decidirRespuesta('t1', 'c1', 'pagar', false, base({ pendingOrderId: null }) as never);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r1.nextState).toBe('AWAITING_PAYMENT');
    reuseMock.mockResolvedValueOnce({ kind: 'reuse', order: ORDEN, repaired: false } as never);
    const r2 = await decidirRespuesta('t1', 'c1', 'pagar', false, base() as never);
    expect(r2.pendingOrderId).toBe('ord_REUSE0001');
    expect(createMock).toHaveBeenCalledTimes(1); // sin segunda orden
  });

  it('9. reuse se resuelve UNA sola vez por turno (sin doble consulta ni doble orden)', async () => {
    reuseMock.mockResolvedValue({ kind: 'reuse', order: ORDEN, repaired: false } as never);
    await decidirRespuesta('t1', 'c1', 'pagar', false, base() as never);
    expect(reuseMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
  });
});
