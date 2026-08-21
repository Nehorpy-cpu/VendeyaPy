/**
 * engine.checkoutSinDatos.test.ts — H-04 en el camino del dinero.
 *
 * El bot le mandaba al cliente las cuentas de plantilla del seed:
 *
 *     🏦 *UENO Bank*
 *        Cuenta: REEMPLAZAR-Nro-Cuenta
 *
 * Con el default eliminado, `formatTransferInstructions` devuelve `null` cuando no hay cuentas
 * cobrables — y TypeScript **no** avisa de eso: `'texto: ' + null` compila y le mandaría la
 * palabra «null» al cliente. Por eso los dos call sites del motor se prueban acá de punta a
 * punta: lo que importa no es que la función devuelva null, es qué recibe el cliente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./coverage.js', async (io) => {
  const real = await io<typeof import('./coverage.js')>();
  return { ...real, gateCoberturaCheckout: vi.fn(async () => null) };
});
vi.mock('../orders/checkoutReuse.js', () => ({ resolveCheckoutReuse: vi.fn() }));
vi.mock('../orders/createPendingOrder.js', async (io) => {
  const real = await io<typeof import('../orders/createPendingOrder.js')>();
  return { ...real, createPendingOrder: vi.fn() };
});
vi.mock('../orders/checkoutConfig.js', async (io) => {
  const real = await io<typeof import('../orders/checkoutConfig.js')>();
  return { ...real, getCheckoutConfig: vi.fn() };
});
vi.mock('../orders/checkoutUnconfigured.js', async (io) => {
  const real = await io<typeof import('../orders/checkoutUnconfigured.js')>();
  return { ...real, avisarCheckoutSinDatos: vi.fn(async () => true) };
});
vi.mock('../entitlements/entitlements.js', async (io) => {
  const real = await io<typeof import('../entitlements/entitlements.js')>();
  return { ...real, checkQuota: vi.fn(), meterUsage: vi.fn() };
});

import { resolveCheckoutReuse } from '../orders/checkoutReuse.js';
import { createPendingOrder } from '../orders/createPendingOrder.js';
import { getCheckoutConfig } from '../orders/checkoutConfig.js';
import { avisarCheckoutSinDatos } from '../orders/checkoutUnconfigured.js';
import { checkQuota, meterUsage } from '../entitlements/entitlements.js';
import { decidirRespuesta } from './engine.js';
import type { Cart, CheckoutConfig, SessionState } from '@vpw/shared';

const reuseMock = vi.mocked(resolveCheckoutReuse);
const createMock = vi.mocked(createPendingOrder);
const configMock = vi.mocked(getCheckoutConfig);
const avisoMock = vi.mocked(avisarCheckoutSinDatos);
const quotaMock = vi.mocked(checkQuota);
const meterMock = vi.mocked(meterUsage);

const CART: Cart = { items: [{ productId: 'p1', name: 'Armaf Odyssey Mega', price: 250000, quantity: 1 }], subtotal: 250000 } as Cart;
const ORDEN = { id: 'ord_H04000001', status: 'PENDING_PAYMENT', totals: { subtotal: 250000, discount: 0, shipping: 30000, total: 280000 } };

/** Datos de prueba, inventados: ningún dato bancario real entra a este repo. */
const CONFIG_REAL: CheckoutConfig = {
  bankAccounts: [{ bank: 'Banco de Prueba', accountNumber: '00-TEST-0001', holder: 'Titular Ficticio SA', document: 'TEST-123456' }],
  sellers: [],
};
/** Lo que devolvía el default del seed: cuentas que no existen. */
const CONFIG_PLACEHOLDER: CheckoutConfig = {
  bankAccounts: [{ bank: 'UENO Bank', accountNumber: 'REEMPLAZAR-Nro-Cuenta', holder: 'REEMPLAZAR-Titular', document: 'REEMPLAZAR-CI/RUC' }],
  sellers: [],
};
/** Tenant nuevo: `config/checkout` no existe todavía. */
const CONFIG_VACIA: CheckoutConfig = { bankAccounts: [], sellers: [] };

const base = (over: Record<string, unknown> = {}) => ({
  cart: CART,
  lastShownSkus: [] as string[],
  greeting: '',
  profitMode: false,
  state: 'CART' as SessionState,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  quotaMock.mockResolvedValue({ allowed: true } as never);
  meterMock.mockResolvedValue(undefined as never);
  createMock.mockResolvedValue(ORDEN as never); // createPendingOrder devuelve la orden, no un wrapper
  reuseMock.mockResolvedValue({ kind: 'new' } as never);
  avisoMock.mockResolvedValue(true);
});

describe('H-04 · checkout nuevo sin datos de cobro', () => {
  it('con el documento ausente, el cliente NO recibe cuentas inventadas', async () => {
    configMock.mockResolvedValue(CONFIG_VACIA);

    const r = await decidirRespuesta('tenant-nuevo', '595990000001', 'quiero pagar', false, base() as never);

    expect(r.reply).not.toMatch(/REEMPLAZAR/i);
    expect(r.reply).not.toMatch(/\bnull\b/); // el bug que TS no ataja: 'texto' + null
    expect(r.reply).not.toMatch(/Transferí a cualquiera/);
  });

  it('con las cuentas de plantilla cargadas, tampoco', async () => {
    configMock.mockResolvedValue(CONFIG_PLACEHOLDER);

    const r = await decidirRespuesta('tenant-seed', '595990000001', 'quiero pagar', false, base() as never);

    expect(r.reply).not.toMatch(/REEMPLAZAR/i);
    expect(r.reply).not.toMatch(/UENO Bank/);
  });

  it('el cliente no queda mudo y el pedido sigue en pie', async () => {
    configMock.mockResolvedValue(CONFIG_VACIA);

    const r = await decidirRespuesta('tenant-nuevo', '595990000001', 'quiero pagar', false, base() as never);

    expect(r.reply.trim().length).toBeGreaterThan(0);
    expect(r.reply).toMatch(/pedido anotado/i);
    expect(r.nextState).toBe('AWAITING_PAYMENT');
    expect(r.pendingOrderId).toBe(ORDEN.id); // la orden creada no se pierde
  });

  it('el dueño se entera, con el cliente que quedó esperando', async () => {
    configMock.mockResolvedValue(CONFIG_VACIA);

    await decidirRespuesta('tenant-nuevo', '595990000001', 'quiero pagar', false, base() as never);
    await decidirRespuesta('tenant-nuevo', '595990000002', 'quiero pagar', false, base() as never);

    // El aviso se dispara siempre; la idempotencia vive en el id determinístico por día
    // (`checkoutUnconfigured.test.ts`), no en un contador de este módulo.
    expect(avisoMock).toHaveBeenCalledTimes(2);
    expect(avisoMock).toHaveBeenNthCalledWith(1, 'tenant-nuevo', '595990000001');
    expect(avisoMock).toHaveBeenNthCalledWith(2, 'tenant-nuevo', '595990000002');
  });

  it('NO REGRESIÓN: con cuentas reales el mensaje de pago sale como siempre', async () => {
    configMock.mockResolvedValue(CONFIG_REAL);

    const r = await decidirRespuesta('arfagi', '595990000001', 'quiero pagar', false, base() as never);

    expect(r.reply).toContain('💳 *Para completar tu compra*');
    expect(r.reply).toContain('Banco de Prueba');
    expect(r.reply).toContain('00-TEST-0001');
    expect(r.nextState).toBe('AWAITING_PAYMENT');
    expect(avisoMock).not.toHaveBeenCalled();
  });
});

describe('H-04 · reenvío de un pedido pendiente sin datos de cobro', () => {
  beforeEach(() => {
    reuseMock.mockResolvedValue({ kind: 'reuse', order: ORDEN, repaired: false } as never);
  });

  it('no reenvía cuentas inventadas ni la palabra null', async () => {
    configMock.mockResolvedValue(CONFIG_PLACEHOLDER);

    const r = await decidirRespuesta('tenant-seed', '595990000001', 'quiero pagar', false, base({ pendingOrderId: ORDEN.id }) as never);

    expect(r.reply).not.toMatch(/REEMPLAZAR/i);
    expect(r.reply).not.toMatch(/\bnull\b/);
    expect(r.reply).toMatch(/pedido anotado/i);
    expect(r.pendingOrderId).toBe(ORDEN.id);
    expect(avisoMock).toHaveBeenCalledWith('tenant-seed', '595990000001');
  });

  it('NO REGRESIÓN: con cuentas reales reenvía los datos como siempre', async () => {
    configMock.mockResolvedValue(CONFIG_REAL);

    const r = await decidirRespuesta('arfagi', '595990000001', 'quiero pagar', false, base({ pendingOrderId: ORDEN.id }) as never);

    expect(r.reply).toContain('Seguís con tu pedido pendiente');
    expect(r.reply).toContain('Banco de Prueba');
    expect(avisoMock).not.toHaveBeenCalled();
  });
});
