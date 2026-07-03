import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * F1 (GROUNDING): la rama catálogo de decidirRespuesta.
 *  - searchCatalog vacío → devuelve el canned PERO con `catalogEmpty: true`, la señal con la que
 *    handleMessage intenta el sales agent IA antes de mandar el canned.
 *  - searchCatalog con resultados → lista numerada, sin flag.
 *  - el filtro de género que llega a searchCatalog es `undefined` si el texto no lo dice
 *    (el default 'Femenino' dejaba catálogos masculinos siempre vacíos).
 * Solo se mockea catalog/search.js: la rama catálogo no toca otra E/S.
 */
vi.mock('../catalog/search.js', () => ({
  searchCatalog: vi.fn(),
  getProductById: vi.fn(),
  findProductByName: vi.fn(),
}));

import { searchCatalog, getProductById } from '../catalog/search.js';
import { decidirRespuesta } from './engine.js';
import type { Product, Cart, SessionState } from '@vpw/shared';

const searchCatalogMock = vi.mocked(searchCatalog);
const getProductByIdMock = vi.mocked(getProductById);

const prev = {
  cart: { items: [], subtotal: 0 } as Cart,
  lastShownSkus: [] as string[],
  greeting: '',
  profitMode: false,
  state: null as SessionState | null,
};

const producto = {
  id: 'p1',
  name: 'Supremacy Not Only Intense',
  price: 250000,
  featured: false,
  inventory: { trackStock: true, stock: 10, lowStockThreshold: 3, sku: 'sku-1' },
  perfume: { brand: 'Afnan', styleTags: [] },
} as unknown as Product;

beforeEach(() => {
  searchCatalogMock.mockReset();
  getProductByIdMock.mockReset();
});

describe('conversation/engine decidirRespuesta — F2: agregar por confirmación/intención pura', () => {
  const viendo = { ...prev, state: 'VIEWING_PRODUCT' as SessionState, lastShownSkus: ['p1'] };

  it.each(['sí, agregalo', 'sumalo', 'quiero ese'])(
    '"%s" en VIEWING_PRODUCT con lastShownSkus → agrega el PRIMER producto mostrado',
    async (msg) => {
      getProductByIdMock.mockResolvedValueOnce(producto);
      const r = await decidirRespuesta('t1', 'c1', msg, false, viendo);
      expect(getProductByIdMock).toHaveBeenCalledWith('t1', 'p1');
      expect(r.reply).toContain('Agregué');
      expect(r.reply).toContain('Supremacy Not Only Intense');
      expect(r.nextState).toBe('CART');
      expect(r.cart?.items[0]?.productId).toBe('p1');
      expect(r.cart?.items[0]?.quantity).toBe(1);
    },
  );

  it('"sí" fuera de VIEWING_PRODUCT NO agrega (cae al fallback genérico)', async () => {
    const r = await decidirRespuesta('t1', 'c1', 'sí', false, { ...prev, state: 'BROWSING' as SessionState });
    expect(getProductByIdMock).not.toHaveBeenCalled();
    expect(r.cart).toBeUndefined();
    expect(r.reply).toContain('Puedo ayudarte');
  });

  it('"sí, agregalo" sin lastShownSkus NO agrega a ciegas (repregunta cuál)', async () => {
    const r = await decidirRespuesta('t1', 'c1', 'sí, agregalo', false, { ...prev, state: 'VIEWING_PRODUCT' as SessionState });
    expect(getProductByIdMock).not.toHaveBeenCalled();
    expect(r.reply).toContain('Decime cuál');
  });

  it('"agregá la good girl" (nombra producto) NO usa el atajo del primero: resuelve por nombre', async () => {
    // findProductByName está mockeado y devuelve null → debe repreguntar, no agregar lastShownSkus[0]
    const r = await decidirRespuesta('t1', 'c1', 'agregá la good girl', false, viendo);
    expect(getProductByIdMock).not.toHaveBeenCalledWith('t1', 'p1');
    expect(r.reply).toContain('Decime cuál');
  });

  it('"quiero pagar" con carrito vacío → respuesta segura (sin crear orden)', async () => {
    const r = await decidirRespuesta('t1', 'c1', 'quiero pagar', false, viendo);
    expect(r.reply).toContain('carrito está vacío');
    expect(r.nextState).toBe('BROWSING');
  });
});

describe('conversation/engine decidirRespuesta — rama catálogo (F1)', () => {
  it('catálogo sin resultados → canned con catalogEmpty:true (handleMessage delega a la IA)', async () => {
    searchCatalogMock.mockResolvedValueOnce([]);
    const r = await decidirRespuesta('t1', 'c1', 'mostrame el catálogo', false, prev);
    expect(r.catalogEmpty).toBe(true);
    expect(r.reply).toContain('no encontré');
    expect(r.nextState).toBe('BROWSING');
  });

  it('catálogo con resultados → lista numerada, sin flag', async () => {
    searchCatalogMock.mockResolvedValueOnce([producto]);
    const r = await decidirRespuesta('t1', 'c1', 'mostrame el catálogo', false, prev);
    expect(r.catalogEmpty).toBeUndefined();
    expect(r.reply).toContain('Supremacy Not Only Intense');
    expect(r.nextState).toBe('VIEWING_PRODUCT');
    expect(r.lastShownSkus).toEqual(['p1']);
  });

  it('sin género en el texto → searchCatalog recibe gender undefined (no filtra)', async () => {
    searchCatalogMock.mockResolvedValueOnce([producto]);
    await decidirRespuesta('t1', 'c1', 'mostrame el catálogo', false, prev);
    expect(searchCatalogMock).toHaveBeenCalledWith('t1', expect.objectContaining({ gender: undefined }));
  });

  it('con género explícito → searchCatalog recibe el filtro', async () => {
    searchCatalogMock.mockResolvedValueOnce([producto]);
    await decidirRespuesta('t1', 'c1', 'mostrame el catálogo para hombre', false, prev);
    expect(searchCatalogMock).toHaveBeenCalledWith('t1', expect.objectContaining({ gender: 'Masculino' }));
  });
});
