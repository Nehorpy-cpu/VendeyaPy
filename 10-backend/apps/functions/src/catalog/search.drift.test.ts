import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * ADR-0015 §8 — cobertura del guard en los caminos que MUESTRAN productos.
 *
 * Hallazgo que motiva estos tests: el guard del motor solo evaluaba lo que el turno NOMBRABA, así
 * que el LISTADO del catálogo y la respuesta de la IA seguían cotizando el precio de un producto
 * cuyo dato público lo gobierna una fuente externa que hoy publica otro número. `searchCatalog` es
 * el embudo de los tres caminos (listado rule-based, alternativa de CAT-2B y la tool
 * `buscar_productos` del sales agent): lo que no sale de acá, nadie lo puede cotizar.
 *
 * Caso base genérico (sin rubro): precio local 250000, la fuente externa publica otra cosa.
 */
const colGet = vi.fn();
vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: () => ({ get: vi.fn() }),
    collection: () => ({ where: () => ({ get: colGet }), get: colGet }),
  }),
  paths: {
    product: (t: string, p: string) => `tenants/${t}/products/${p}`,
    products: (t: string) => `tenants/${t}/products`,
    productFinancials: (t: string) => `tenants/${t}/productFinancials`,
  },
}));

import { searchCatalog } from './search.js';
import { setDriftProjection, type ProductDriftSnapshot } from './driftGuard.js';
import { buscarProductos } from '../ai/tools/salesTools.js';

const fila = (id: string, name: string, price: number) => ({
  data: () => ({ id, name, price, status: 'ACTIVE', inventory: { trackStock: true, stock: 5, sku: id } }),
});

const CATALOGO = { docs: [fila('p1', 'Aurora Nocturna', 250000), fila('p2', 'Brisa Clara', 180000)] };

/** Cablea la proyección: `derivados` quedan en deriva crítica de precio; el resto, verificado. */
const cablear = (derivados: string[], over: Partial<ProductDriftSnapshot> = {}) =>
  setDriftProjection({
    activa: async () => true,
    snapshots: async (_t, ids) =>
      ids.map((productId): ProductDriftSnapshot =>
        derivados.includes(productId)
          ? { productId, externalFields: ['title', 'price', 'currency', 'availability', 'inventory'], state: 'drifted_external', driftedFields: ['price'], ...over }
          : { productId, externalFields: ['title', 'price', 'currency', 'availability', 'inventory'], state: 'verified', driftedFields: [] },
      ),
  });

beforeEach(() => {
  vi.clearAllMocks();
  colGet.mockResolvedValue(CATALOGO);
});
afterEach(() => setDriftProjection(null));

describe('searchCatalog — el listado no cotiza lo que no podemos afirmar', () => {
  it('el producto en deriva crítica NO se lista; el resto del catálogo sí', async () => {
    cablear(['p1']);
    const nombres = (await searchCatalog('t1', { limit: 10 })).map((p) => p.name);
    expect(nombres).not.toContain('Aurora Nocturna');
    expect(nombres).toContain('Brisa Clara');
  });

  it('la divergencia COSMÉTICA (título/imagen) no lo saca del listado: no corta la venta', async () => {
    cablear(['p1'], { driftedFields: ['title', 'image'] });
    expect((await searchCatalog('t1', { limit: 10 })).map((p) => p.name)).toContain('Aurora Nocturna');
  });

  it.each(['remote_missing', 'unverifiable', 'stale'] as const)('%s (no sabemos nada del remoto) ⇒ tampoco se lista', async (state) => {
    cablear(['p1'], { state, driftedFields: [] });
    expect((await searchCatalog('t1', { limit: 10 })).map((p) => p.name)).not.toContain('Aurora Nocturna');
  });

  it('reconciliado (verified) ⇒ vuelve al listado solo, sin intervención', async () => {
    cablear([]);
    expect((await searchCatalog('t1', { limit: 10 })).map((p) => p.name)).toContain('Aurora Nocturna');
  });

  it('tenant SIN gobierno externo ⇒ ni una consulta de deriva y el listado queda igual', async () => {
    let consultas = 0;
    setDriftProjection({ activa: async () => false, snapshots: async () => { consultas += 1; return []; } });
    expect(await searchCatalog('t1', { limit: 10 })).toHaveLength(2);
    expect(consultas).toBe(0);
  });

  it('sin proyección cableada el catálogo se comporta EXACTAMENTE como antes', async () => {
    expect(await searchCatalog('t1', { limit: 10 })).toHaveLength(2);
  });

  it('el filtro de deriva no revive lo no vendible: un INACTIVE/agotado sigue afuera', async () => {
    // La query ya filtra por status; acá se cubre el stock (predicado trackStock-aware).
    colGet.mockResolvedValue({ docs: [fila('p1', 'Aurora Nocturna', 250000), { data: () => ({ id: 'p3', name: 'Agotado', price: 1, status: 'ACTIVE', inventory: { trackStock: true, stock: 0 } }) }] });
    cablear([]); // nada en deriva: aun así el agotado no puede aparecer
    expect((await searchCatalog('t1', { limit: 10 })).map((p) => p.name)).toEqual(['Aurora Nocturna']);
  });
});

describe('buscar_productos (contexto de la IA) — el modelo no ve lo que no puede cotizar', () => {
  it('el producto en deriva crítica JAMÁS entra al contexto del sales agent', async () => {
    cablear(['p1']);
    // Sin `deps`: se usa el searchCatalog real, que es el que el agente llama en producción.
    const out = (await buscarProductos.execute('t1', {})) as Array<{ name: string; price: number }>;
    expect(out.map((p) => p.name)).toEqual(['Brisa Clara']);
    // Ni el precio en disputa ni el nombre del producto derivado viajan al modelo.
    expect(JSON.stringify(out)).not.toContain('250000');
    expect(JSON.stringify(out)).not.toContain('Aurora');
  });

  it('sin deriva, la tool sigue devolviendo el catálogo completo (cero regresión)', async () => {
    cablear([]);
    const out = (await buscarProductos.execute('t1', {})) as Array<{ name: string }>;
    expect(out.map((p) => p.name).sort()).toEqual(['Aurora Nocturna', 'Brisa Clara']);
  });
});
