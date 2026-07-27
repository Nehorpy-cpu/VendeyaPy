import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * META-CATALOG-RECONCILIATION-1 — el checkout REVALIDA la vendibilidad antes de crear el
 * pedido: el carrito pudo armarse antes de que el producto se desactivara o se quedara sin
 * stock. Un pedido jamás nace con algo que ya no se puede vender.
 */
const productDocs = new Map<string, Record<string, unknown> | undefined>();
const docGet = vi.fn(async (path: string) => ({
  exists: productDocs.has(path),
  data: () => productDocs.get(path),
}));

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({ get: () => docGet(path), set: vi.fn() }),
    batch: () => ({ set: vi.fn(), commit: vi.fn(async () => undefined) }),
    runTransaction: vi.fn(),
  }),
  paths: {
    product: (t: string, p: string) => `tenants/${t}/products/${p}`,
    order: (t: string, o: string) => `tenants/${t}/orders/${o}`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    orderFinancial: (t: string, o: string) => `tenants/${t}/orderFinancials/${o}`,
    productFinancial: (t: string, p: string) => `tenants/${t}/productFinancials/${p}`,
  },
}));
vi.mock('../catalog/financials.js', () => ({ getProductCost: vi.fn(async () => 100) }));

import { createPendingOrder, ProductNoVendibleError } from './createPendingOrder.js';

const CART = { items: [{ productId: 'p1', name: 'Perfume A', price: 250000, quantity: 1 }], subtotal: 250000 };

const setProducto = (over: Record<string, unknown>) =>
  productDocs.set('tenants/t1/products/p1', { id: 'p1', name: 'Perfume A', status: 'ACTIVE', inventory: { trackStock: true, stock: 5 }, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  productDocs.clear();
});

describe('createPendingOrder — revalidación de vendibilidad', () => {
  it.each([
    ['INACTIVE (p.ej. importado de Meta)', { status: 'INACTIVE' }],
    ['ARCHIVED', { status: 'ARCHIVED' }],
    ['sin stock', { inventory: { trackStock: true, stock: 0 } }],
  ])('%s ⇒ lanza ProductNoVendibleError y NO crea el pedido', async (_l, over) => {
    setProducto(over);
    await expect(createPendingOrder('t1', 'c1', CART as never)).rejects.toBeInstanceOf(ProductNoVendibleError);
  });

  it('producto borrado del catálogo ⇒ también bloquea', async () => {
    // productDocs vacío: el doc no existe
    await expect(createPendingOrder('t1', 'c1', CART as never)).rejects.toBeInstanceOf(ProductNoVendibleError);
  });

  it('el error nombra los productos afectados (para responder con honestidad)', async () => {
    setProducto({ status: 'INACTIVE' });
    const err = await createPendingOrder('t1', 'c1', CART as never).catch((e) => e as ProductNoVendibleError);
    expect(err.productNames).toEqual(['Perfume A']);
  });

  it('sin trackStock, un ACTIVE con stock 0 sigue siendo vendible', async () => {
    setProducto({ inventory: { trackStock: false, stock: 0 } });
    // Llega más allá de la revalidación (falla después, por los mocks incompletos del resto).
    const r = await createPendingOrder('t1', 'c1', CART as never).catch((e) => e);
    expect(r).not.toBeInstanceOf(ProductNoVendibleError);
  });
});
