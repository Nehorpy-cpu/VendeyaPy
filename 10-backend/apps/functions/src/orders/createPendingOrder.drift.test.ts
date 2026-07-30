import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * ADR-0015 §8 — el checkout NO crea la orden cuando el dato público de un producto del carrito lo
 * gobierna una fuente externa que hoy publica otra cosa. Se testea en `createPendingOrder` porque
 * es el ÚNICO punto por el que nace un pedido: cubre el checkout del bot y la reanudación tras la
 * aprobación de cobertura (donde el carrito se congeló mucho antes).
 */
const productDocs = new Map<string, Record<string, unknown> | undefined>();
const docGet = vi.fn(async (path: string) => ({ exists: productDocs.has(path), data: () => productDocs.get(path) }));
const docSet = vi.fn(async (_path: string, _data: unknown) => undefined);

/** `create()` fiel a Firestore: falla con código 6 si el documento ya existe (reserva 1D). */
const docCreate = vi.fn(async (path: string, data: unknown) => {
  if (productDocs.has(path)) {
    const e = new Error('already exists') as Error & { code?: number };
    e.code = 6;
    throw e;
  }
  await docSet(path, data);
});

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      get: () => docGet(path),
      set: (d: unknown) => docSet(path, d),
      create: (d: unknown) => docCreate(path, d),
    }),
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

import { createPendingOrder, ProductNoVendibleError, ProductoConDerivaCriticaError } from './createPendingOrder.js';
import { setDriftProjection, type ProductDriftSnapshot } from '../catalog/driftGuard.js';

// Producto GENÉRICO (nada de un rubro concreto) con precio local distinto del publicado.
const CART = { items: [{ productId: 'p1', name: 'Producto Uno', price: 250000, quantity: 1 }], subtotal: 250000 };
const TODOS_LOS_CAMPOS = ['title', 'description', 'price', 'currency', 'availability', 'inventory'];
const cablear = (over: Partial<ProductDriftSnapshot> = {}) =>
  setDriftProjection({
    activa: async () => true,
    snapshots: async (_t, ids) =>
      ids.map((productId) => ({ productId, externalFields: TODOS_LOS_CAMPOS, state: 'drifted_external', driftedFields: ['price'], ...over }) as ProductDriftSnapshot),
  });

const ordenesEscritas = () => docSet.mock.calls.filter(([p]) => String(p).includes('/orders/'));
const finanzasEscritas = () => docSet.mock.calls.filter(([p]) => String(p).includes('/orderFinancials/'));

beforeEach(() => {
  vi.clearAllMocks();
  productDocs.clear();
  productDocs.set('tenants/t1/products/p1', { id: 'p1', name: 'Producto Uno', status: 'ACTIVE', inventory: { trackStock: true, stock: 5 } });
});
afterEach(() => setDriftProjection(null));

describe('createPendingOrder — revalidación de deriva del dato público', () => {
  it('precio gobernado por una fuente externa y divergente ⇒ NO nace la orden ni sus finanzas', async () => {
    cablear();
    const err = await createPendingOrder('t1', 'c1', CART as never).catch((e) => e as Error);
    expect(err).toBeInstanceOf(ProductoConDerivaCriticaError);
    expect(ordenesEscritas()).toHaveLength(0);
    expect(finanzasEscritas()).toHaveLength(0);
  });

  it.each(['remote_missing', 'unverifiable', 'stale'] as const)('%s ⇒ tampoco se crea la orden', async (state) => {
    cablear({ state, driftedFields: [] });
    await expect(createPendingOrder('t1', 'c1', CART as never)).rejects.toBeInstanceOf(ProductoConDerivaCriticaError);
    expect(ordenesEscritas()).toHaveLength(0);
  });

  it('el error es TAMBIÉN ProductNoVendibleError: la reanudación de cobertura ya sabe frenarlo', async () => {
    cablear();
    const err = await createPendingOrder('t1', 'c1', CART as never).catch((e) => e as ProductNoVendibleError);
    expect(err).toBeInstanceOf(ProductNoVendibleError);
    expect(err.productNames).toEqual(['Producto Uno']); // nombre local, sin valores remotos
    expect(err.message).not.toMatch(/\d{4,}/); // ni el precio local ni el publicado viajan en el error
  });

  it('divergencia COSMÉTICA (nombre/descripción) ⇒ la orden se crea igual: no corta la venta', async () => {
    cablear({ driftedFields: ['title', 'description'] });
    await expect(createPendingOrder('t1', 'c1', CART as never)).resolves.toMatchObject({ status: 'PENDING_PAYMENT' });
    expect(ordenesEscritas()).toHaveLength(1);
  });

  it('RECONCILIADO (verified: ambos lados iguales) ⇒ el checkout vuelve a habilitarse SOLO', async () => {
    cablear();
    await expect(createPendingOrder('t1', 'c1', CART as never)).rejects.toBeInstanceOf(ProductoConDerivaCriticaError);
    cablear({ state: 'verified', driftedFields: [] }); // el origen del feed se corrigió
    await expect(createPendingOrder('t1', 'c1', CART as never)).resolves.toMatchObject({ status: 'PENDING_PAYMENT' });
  });

  it('sin derivador cableado el checkout queda EXACTAMENTE como estaba (cero cambio de comportamiento)', async () => {
    await expect(createPendingOrder('t1', 'c1', CART as never)).resolves.toMatchObject({ status: 'PENDING_PAYMENT' });
  });

  /**
   * CONTRATO CAMBIADO (review de cobertura del guard): antes este test afirmaba que un fallo de la
   * proyección dejaba pasar el checkout ("el precio cobrado sigue siendo el LOCAL"). Eso hacía
   * fallar ABIERTO justo en el punto donde nace el compromiso comercial: `leerDeriva` tragaba
   * cualquier error y devolvía SIN_DERIVA, así que "no hay deriva" y "no pude leer si la hay" eran
   * indistinguibles para el pedido. Con el fix el camino que CREA LA ORDEN es fail-CLOSED
   * (`unverifiable`, ADR-0015 §8) y el conversacional sigue fail-open a propósito: una respuesta de
   * más no cobra nada, una orden creada a ciegas sí.
   */
  it('fail-CLOSED: un fallo de la proyección NO crea la orden — no sabemos ≠ está todo bien', async () => {
    setDriftProjection({ activa: async () => true, snapshots: async () => { throw new Error('firestore unavailable'); } });
    const err = await createPendingOrder('t1', 'c1', CART as never).catch((e) => e as ProductoConDerivaCriticaError);
    expect(err).toBeInstanceOf(ProductoConDerivaCriticaError);
    expect((err as ProductoConDerivaCriticaError).veredicto.bloqueantes[0]?.reason).toBe('unverifiable');
    expect(ordenesEscritas()).toHaveLength(0);
    expect(finanzasEscritas()).toHaveLength(0);
    // El error viaja SANEADO: nombre local del producto, ni un valor remoto ni el precio.
    expect((err as ProductoConDerivaCriticaError).productNames).toEqual(['Producto Uno']);
    expect((err as Error).message).not.toMatch(/\d{4,}/);
  });

  it('fail-closed SOLO ante un fallo real: sin proyección cableada el checkout no consulta ni frena', async () => {
    setDriftProjection(null);
    await expect(createPendingOrder('t1', 'c1', CART as never)).resolves.toMatchObject({ totals: { total: 250000 } });
  });

  /**
   * FAIL-CLOSED ACOTADO A LO PUBLICADO AFUERA (hallazgo del review adversarial).
   *
   * El fail-closed de arriba frenaba el carrito ENTERO de cualquier tenant ante un error de
   * lectura, incluso el de uno que no tiene un solo artículo publicado en Meta (credipower): no
   * nacía la orden, no salían los datos bancarios y se derivaba a una persona por un parpadeo de
   * Firestore. La regla queda igual de dura donde importa —lo publicado afuera puede contradecir
   * el precio local— y deja de castigar a lo que nadie publicó.
   *
   * Lo que NO se hizo, a propósito: usar "¿este tenant tiene gobierno externo?" como pre-gate. Esa
   * pregunta es fail-SAFE, así que el mismo parpadeo la haría responder "no aplica" y la orden
   * nacería al precio equivocado en el tenant que SÍ está gobernado por un feed.
   */
  const PRODUCTO_LOCAL = { id: 'p9', name: 'Producto Nueve', status: 'ACTIVE', inventory: { trackStock: false } };
  const CARRITO_MIXTO = {
    items: [
      { productId: 'p1', name: 'Producto Uno', price: 250000, quantity: 1 },
      { productId: 'p9', name: 'Producto Nueve', price: 100000, quantity: 1 },
    ],
    subtotal: 350000,
  };
  /** La lectura de deriva se cae; la de identidad remota contesta quién está publicado. */
  const lecturaCaida = (publicados: readonly string[]) =>
    setDriftProjection({
      activa: async () => true,
      snapshots: async () => { throw new Error('DEADLINE_EXCEEDED'); },
      conIdentidadRemota: async (_t, ids) => ids.filter((id) => publicados.includes(id)),
    });

  it('tenant sin nada publicado en Meta + error transitorio ⇒ la orden NACE (credipower intacto)', async () => {
    lecturaCaida([]);
    await expect(createPendingOrder('t1', 'c1', CART as never)).resolves.toMatchObject({ status: 'PENDING_PAYMENT', totals: { total: 250000 } });
    expect(ordenesEscritas()).toHaveLength(1);
  });

  it('tenant gobernado de afuera + error transitorio + producto PUBLICADO ⇒ NO nace la orden', async () => {
    lecturaCaida(['p1']);
    const err = await createPendingOrder('t1', 'c1', CART as never).catch((e) => e as ProductoConDerivaCriticaError);
    expect(err).toBeInstanceOf(ProductoConDerivaCriticaError);
    expect(err.veredicto.bloqueantes[0]?.reason).toBe('unverifiable');
    expect(ordenesEscritas()).toHaveLength(0);
    expect(finanzasEscritas()).toHaveLength(0);
  });

  it('carrito MIXTO + error transitorio ⇒ frena por el publicado y el local ni aparece en el aviso', async () => {
    productDocs.set('tenants/t1/products/p9', PRODUCTO_LOCAL);
    lecturaCaida(['p1']);
    const err = await createPendingOrder('t1', 'c1', CARRITO_MIXTO as never).catch((e) => e as ProductoConDerivaCriticaError);
    expect(err).toBeInstanceOf(ProductoConDerivaCriticaError);
    expect(err.productNames).toEqual(['Producto Uno']); // el local no se frena por algo que no lo toca
    expect(ordenesEscritas()).toHaveLength(0);
  });

  it('si TAMPOCO se puede saber quién está publicado ⇒ fail-closed sobre todo el carrito', async () => {
    productDocs.set('tenants/t1/products/p9', PRODUCTO_LOCAL);
    setDriftProjection({
      activa: async () => true,
      snapshots: async () => { throw new Error('DEADLINE_EXCEEDED'); },
      conIdentidadRemota: async () => { throw new Error('DEADLINE_EXCEEDED'); },
    });
    const err = await createPendingOrder('t1', 'c1', CARRITO_MIXTO as never).catch((e) => e as ProductoConDerivaCriticaError);
    expect(err.productNames).toEqual(['Producto Uno', 'Producto Nueve']);
    expect(ordenesEscritas()).toHaveLength(0);
  });

  it('precedencia: un producto NO VENDIBLE sigue fallando por vendibilidad, sin consultar la deriva', async () => {
    let consultas = 0;
    setDriftProjection({ activa: async () => true, snapshots: async () => { consultas += 1; return []; } });
    productDocs.set('tenants/t1/products/p1', { id: 'p1', name: 'Producto Uno', status: 'INACTIVE' });
    const err = await createPendingOrder('t1', 'c1', CART as never).catch((e) => e as Error);
    expect(err).toBeInstanceOf(ProductNoVendibleError);
    expect(err).not.toBeInstanceOf(ProductoConDerivaCriticaError);
    expect(consultas).toBe(0);
  });
});

/**
 * ADR-0015 §8 + COVERAGE-1D — CARRERA ENTRE WORKERS SOBRE UN `orderId` RESERVADO.
 * ==============================================================================
 * Con un `orderId` reservado, si la orden YA existe la función vuelve antes de las dos
 * revalidaciones: la orden ajena se reusa tal cual (garantía COVERAGE-1D — un worker stale jamás
 * pisa lo que otro creó ni sus finanzas congeladas). Eso está bien para NO ESCRIBIR y estaba mal
 * para SEGUIR: el llamador recibía la orden intacta y continuaba el flujo comercial —total e
 * instrucciones bancarias— sobre un producto que pudo entrar en deriva crítica en el medio.
 *
 * La ventana es angosta (el único llamador con `orderId` ya evalúa la deriva antes de llegar
 * acá), pero es exactamente el patrón que dejó pasar el bug original: entre una lectura y la otra,
 * otro worker crea la orden. Lo que se prueba: la orden existente NO se toca nunca, y el flujo
 * comercial no continúa cuando el dato público no se puede afirmar.
 */
describe('createPendingOrder — orden reservada que YA existe (carrera entre workers)', () => {
  const ORDER_ID = 'ord-reservada-1';
  const RUTA_ORDEN = `tenants/t1/orders/${ORDER_ID}`;
  const ORDEN_AJENA = {
    id: ORDER_ID,
    tenantId: 't1',
    customerId: 'c1',
    status: 'PENDING_PAYMENT',
    items: [{ productId: 'p1', productName: 'Producto Uno', quantity: 1, unitPrice: 250000, subtotal: 250000 }],
    totals: { subtotal: 250000, discount: 0, shipping: 0, total: 250000, currency: 'PYG' },
  };
  const sembrarOrdenAjena = (over: Record<string, unknown> = {}) => productDocs.set(RUTA_ORDEN, { ...ORDEN_AJENA, ...over });
  const reusar = () => createPendingOrder('t1', 'c1', CART as never, { orderId: ORDER_ID });

  it('deriva crítica aparecida en el medio ⇒ NO se sigue, y la orden ajena queda intacta', async () => {
    cablear();
    sembrarOrdenAjena();
    const err = await reusar().catch((e) => e as Error);
    expect(err).toBeInstanceOf(ProductoConDerivaCriticaError);
    // COVERAGE-1D intacto: ni la orden ni sus finanzas se reescriben.
    expect(ordenesEscritas()).toHaveLength(0);
    expect(finanzasEscritas()).toHaveLength(0);
    expect(productDocs.get(RUTA_ORDEN)).toEqual(ORDEN_AJENA);
  });

  it('se evalúa lo que pide LA ORDEN existente, no el carrito que llegó por parámetro', async () => {
    // El carrito trae p1; la orden que ganó la carrera trae p9. Lo que se va a cobrar es la orden.
    const consultados: string[][] = [];
    setDriftProjection({
      activa: async () => true,
      snapshots: async (_t, ids) => {
        consultados.push([...ids]);
        return ids.map((productId) => ({ productId, externalFields: TODOS_LOS_CAMPOS, state: 'drifted_external', driftedFields: ['price'] }) as ProductDriftSnapshot);
      },
    });
    sembrarOrdenAjena({ items: [{ productId: 'p9', productName: 'Producto Nueve', quantity: 1, unitPrice: 999000, subtotal: 999000 }] });
    const err = await reusar().catch((e) => e as ProductoConDerivaCriticaError);
    expect(consultados).toEqual([['p9']]);
    expect(err.productNames).toEqual(['Producto Nueve']);
  });

  it('fail-CLOSED: si la proyección no se puede LEER tampoco se sigue sobre la orden ajena', async () => {
    setDriftProjection({ activa: async () => true, snapshots: async () => { throw new Error('firestore unavailable'); } });
    sembrarOrdenAjena();
    const err = await reusar().catch((e) => e as ProductoConDerivaCriticaError);
    expect(err).toBeInstanceOf(ProductoConDerivaCriticaError);
    expect(err.veredicto.bloqueantes[0]?.reason).toBe('unverifiable');
    expect(ordenesEscritas()).toHaveLength(0);
  });

  it('fail-closed ACOTADO: si la orden ajena no tiene nada publicado afuera, se devuelve igual', async () => {
    // Mismo parpadeo de lectura que el test de arriba, pero en un tenant que no publicó un solo
    // artículo: nada externo puede contradecir ese total, así que el pedido no se frena.
    setDriftProjection({
      activa: async () => true,
      snapshots: async () => { throw new Error('DEADLINE_EXCEEDED'); },
      conIdentidadRemota: async () => [],
    });
    sembrarOrdenAjena();
    await expect(reusar()).resolves.toEqual(ORDEN_AJENA);
    expect(ordenesEscritas()).toHaveLength(0);
  });

  it('una orden reservada SIN ítems legibles no se sigue: no se sabe qué se está por cobrar', async () => {
    cablear({ state: 'verified', driftedFields: [] }); // ni siquiera hay deriva: el problema es la orden
    sembrarOrdenAjena({ items: [] });
    await expect(reusar()).rejects.toBeInstanceOf(ProductoConDerivaCriticaError);
  });

  it('SIN deriva la orden existente se devuelve TAL CUAL y no se escribe una coma', async () => {
    cablear({ state: 'verified', driftedFields: [] });
    sembrarOrdenAjena();
    await expect(reusar()).resolves.toEqual(ORDEN_AJENA);
    expect(ordenesEscritas()).toHaveLength(0);
    expect(finanzasEscritas()).toHaveLength(0);
  });

  it('sin proyección cableada el reuso queda EXACTAMENTE como estaba (cero cambios)', async () => {
    setDriftProjection(null);
    sembrarOrdenAjena();
    await expect(reusar()).resolves.toEqual(ORDEN_AJENA);
    expect(ordenesEscritas()).toHaveLength(0);
    expect(finanzasEscritas()).toHaveLength(0);
  });

  it('sin orden previa el camino reservado sigue creando el pedido (cero regresión)', async () => {
    cablear({ state: 'verified', driftedFields: [] });
    await expect(reusar()).resolves.toMatchObject({ id: ORDER_ID, status: 'PENDING_PAYMENT' });
  });
});
