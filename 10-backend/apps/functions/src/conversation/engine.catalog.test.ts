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

import { searchCatalog } from '../catalog/search.js';
import { decidirRespuesta } from './engine.js';
import type { Product, Cart } from '@vpw/shared';

const searchCatalogMock = vi.mocked(searchCatalog);

const prev = {
  cart: { items: [], subtotal: 0 } as Cart,
  lastShownSkus: [] as string[],
  greeting: '',
  profitMode: false,
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
