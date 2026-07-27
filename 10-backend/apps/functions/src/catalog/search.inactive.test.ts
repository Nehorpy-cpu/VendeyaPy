import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * META-CATALOG-RECONCILIATION-1 — un producto que NO está ACTIVE jamás puede ser ofrecido,
 * agregado al carrito ni llegar a un pedido. Es la propiedad de seguridad sobre la que se
 * apoya toda la importación desde Meta (los importados nacen INACTIVE).
 */
const docGet = vi.fn();
vi.mock('../lib/firebase.js', () => ({
  db: () => ({ doc: () => ({ get: docGet }) }),
  paths: { product: (t: string, p: string) => `tenants/${t}/products/${p}` },
}));

import { getProductById, getProductByIdRaw } from './search.js';

const producto = (status: string) => ({
  exists: true,
  data: () => ({ id: 'p1', name: 'Importado de Meta', status, inventory: { trackStock: false, stock: 0, sku: 'RID-1' } }),
});

beforeEach(() => vi.clearAllMocks());

describe('getProductById — gate de vendibilidad', () => {
  it('ACTIVE ⇒ lo devuelve', async () => {
    docGet.mockResolvedValue(producto('ACTIVE'));
    expect(await getProductById('t1', 'p1')).not.toBeNull();
  });

  it.each(['INACTIVE', 'ARCHIVED'])('%s ⇒ devuelve null (no puede entrar al carrito)', async (status) => {
    docGet.mockResolvedValue(producto(status));
    expect(await getProductById('t1', 'p1')).toBeNull();
  });

  it('producto inexistente ⇒ null', async () => {
    docGet.mockResolvedValue({ exists: false });
    expect(await getProductById('t1', 'p1')).toBeNull();
  });

  it('un producto importado de Meta (INACTIVE) NUNCA se resuelve para el bot', async () => {
    docGet.mockResolvedValue({
      exists: true,
      data: () => ({ id: 'imp', name: 'ARMAF ODYSSEY', status: 'INACTIVE', syncToMeta: false, metaRetailerId: 'ARM-1' }),
    });
    expect(await getProductById('t1', 'imp')).toBeNull();
  });

  it('la lectura CRUDA (paneles/administración) sí lo devuelve', async () => {
    docGet.mockResolvedValue(producto('INACTIVE'));
    const raw = await getProductByIdRaw('t1', 'p1');
    expect(raw?.status).toBe('INACTIVE');
  });
});
