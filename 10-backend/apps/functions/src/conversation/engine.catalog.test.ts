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

import { searchCatalog, getProductById, findProductByName } from '../catalog/search.js';
import { decidirRespuesta } from './engine.js';
import { buildPendingConfirmation } from './cartIntent.js';
import type { Product, Cart, SessionState } from '@vpw/shared';

const searchCatalogMock = vi.mocked(searchCatalog);
const getProductByIdMock = vi.mocked(getProductById);
const findProductByNameMock = vi.mocked(findProductByName);

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
  findProductByNameMock.mockReset();
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

/**
 * F3 (CART-TARGETING): la resolución del carrito contra la OFERTA VIGENTE (pendingCartConfirmation).
 * Fixture = el bug real del live smoke: la oferta traía [Odyssey, Supremacy] pero el cliente venía
 * hablando de Supremacy — "sí"/"el primero" agregaban Odyssey. Ahora: nombre > índice > único claro.
 */
describe('conversation/engine decidirRespuesta — F3: oferta pendiente contextual', () => {
  const NOW = 1_000_000;
  const odyssey = { ...producto, id: 'zgpG', name: 'Armaf Odyssey Mega' } as unknown as Product;
  const supremacy = { ...producto, id: '2wWm', name: 'Perfume Supremacy Not Only Intense' } as unknown as Product;
  const cand = (p: Product) => ({ id: p.id, name: p.name });
  const conPendiente = (prods: Product[]) => ({
    ...prev,
    state: 'VIEWING_PRODUCT' as SessionState,
    lastShownSkus: prods.map((p) => p.id),
    pendingCart: buildPendingConfirmation(prods.map(cand), 'ai_recommendation', NOW),
    nowMs: NOW + 1000, // vigente
  });

  it.each(['sí', 'Sí', 'SI', 'si', 'dale', 'ok', 'sí, agregalo', 'quiero ese', 'ese'])(
    '1-2. confirmación "%s" con ÚNICO candidato → agrega exactamente ese',
    async (msg) => {
      getProductByIdMock.mockResolvedValueOnce(supremacy);
      const r = await decidirRespuesta('t1', 'c1', msg, false, conPendiente([supremacy]));
      expect(getProductByIdMock).toHaveBeenCalledWith('t1', '2wWm');
      expect(r.cart?.items[0]?.productId).toBe('2wWm');
      expect(r.pendingCart).toBeNull(); // 9. oferta consumida
    },
  );

  it('3. negativa "no gracias" con oferta vigente NO agrega (a nivel motor tampoco)', async () => {
    const r = await decidirRespuesta('t1', 'c1', 'no gracias', false, conPendiente([supremacy]));
    expect(r.cart).toBeUndefined();
    expect(getProductByIdMock).not.toHaveBeenCalled();
  });

  it('4. BUG REAL: "sí" con VARIOS candidatos → NO adivina, pide elegir con lista numerada', async () => {
    const r = await decidirRespuesta('t1', 'c1', 'sí', false, conPendiente([odyssey, supremacy]));
    expect(r.cart).toBeUndefined();
    expect(getProductByIdMock).not.toHaveBeenCalled();
    expect(r.reply).toContain('¿Cuál querés que agregue?');
    expect(r.reply).toContain('1. Armaf Odyssey Mega');
    expect(r.reply).toContain('2. Perfume Supremacy Not Only Intense');
    expect(r.pendingCart?.products.map((p) => p.id)).toEqual(['zgpG', '2wWm']); // renovada
  });

  it('5-6. "el primero"/"el segundo" resuelven por índice CONTRA LA OFERTA', async () => {
    getProductByIdMock.mockResolvedValueOnce(odyssey);
    const r1 = await decidirRespuesta('t1', 'c1', 'el primero', false, conPendiente([odyssey, supremacy]));
    expect(getProductByIdMock).toHaveBeenLastCalledWith('t1', 'zgpG');
    expect(r1.cart?.items[0]?.productId).toBe('zgpG');

    getProductByIdMock.mockResolvedValueOnce(supremacy);
    const r2 = await decidirRespuesta('t1', 'c1', 'el segundo', false, conPendiente([odyssey, supremacy]));
    expect(getProductByIdMock).toHaveBeenLastCalledWith('t1', '2wWm');
    expect(r2.cart?.items[0]?.productId).toBe('2wWm');
    expect(r2.pendingCart).toBeNull();
  });

  it('7a. BUG REAL: "agregame el supremacy" gana al orden viejo (Odyssey primero en la oferta)', async () => {
    findProductByNameMock.mockResolvedValueOnce(supremacy);
    const r = await decidirRespuesta('t1', 'c1', 'agregame el supremacy', false, conPendiente([odyssey, supremacy]));
    expect(findProductByNameMock).toHaveBeenCalled();
    expect(r.cart?.items[0]?.productId).toBe('2wWm');
    expect(r.cart?.items[0]?.name).toContain('Supremacy');
  });

  it('7b. BUG REAL: "El Supremacy quiero" (sin verbo) elige al candidato nombrado, no al primero', async () => {
    getProductByIdMock.mockResolvedValueOnce(supremacy);
    const r = await decidirRespuesta('t1', 'c1', 'El Supremacy quiero', false, conPendiente([odyssey, supremacy]));
    expect(getProductByIdMock).toHaveBeenCalledWith('t1', '2wWm');
    expect(r.cart?.items[0]?.productId).toBe('2wWm');
  });

  it('7c. pregunta que nombra un candidato ("¿el supremacy es dulce?") NO agrega', async () => {
    searchCatalogMock.mockResolvedValueOnce([]); // "dulce" activa la rama catálogo (F1) — irrelevante acá
    const r = await decidirRespuesta('t1', 'c1', '¿el supremacy es dulce?', false, conPendiente([odyssey, supremacy]));
    expect(r.cart).toBeUndefined();
    expect(getProductByIdMock).not.toHaveBeenCalled();
  });

  it('8. oferta VENCIDA + "sí" → repregunta, NO agrega ni usa contexto viejo (ni por legacy)', async () => {
    const vencida = {
      ...prev,
      state: 'VIEWING_PRODUCT' as SessionState, // el caso más filoso: el legacy PODRÍA agregar
      lastShownSkus: ['zgpG'],
      pendingCart: null, // el caller (handleMessage) ya filtró la vencida
      pendingExpirada: true,
      nowMs: NOW,
    };
    const r = await decidirRespuesta('t1', 'c1', 'sí', false, vencida);
    expect(r.cart).toBeUndefined();
    expect(getProductByIdMock).not.toHaveBeenCalled();
    expect(r.reply).toContain('Decime cuál');
    expect(r.pendingCart).toBeNull();

    // "el primero" sobre contexto vencido tampoco agrega.
    const r2 = await decidirRespuesta('t1', 'c1', 'el primero', false, { ...vencida, lastShownSkus: ['zgpG', '2wWm'] });
    expect(r2.cart).toBeUndefined();
    expect(getProductByIdMock).not.toHaveBeenCalled();
  });

  it('10. agregar no toca pendingOrderId (una orden stale nunca contamina la recomendación)', async () => {
    getProductByIdMock.mockResolvedValueOnce(supremacy);
    const r = await decidirRespuesta('t1', 'c1', 'sí', false, conPendiente([supremacy]));
    expect(r.pendingOrderId).toBeUndefined(); // el write de sesión conserva el que había, sin usarlo
  });

  // ---- Fixes del review adversarial F3 ----

  it.each(['no lo quiero', 'no me lo llevo', 'no la quiero'])(
    'REVIEW: negación "%s" con oferta única JAMÁS agrega (quiereAgregar matcheaba "(lo) quiero" adentro)',
    async (msg) => {
      const r = await decidirRespuesta('t1', 'c1', msg, false, conPendiente([supremacy]));
      expect(r.cart).toBeUndefined();
      expect(getProductByIdMock).not.toHaveBeenCalled();
      expect(r.reply).toContain('no lo agrego');
      expect(r.pendingCart).toBeNull(); // la oferta rechazada se descarta
    },
  );

  it('REVIEW: "el supremacy no me convence" (negación que NOMBRA al candidato) no agrega y descarta la oferta', async () => {
    const r = await decidirRespuesta('t1', 'c1', 'el supremacy no me convence', false, conPendiente([odyssey, supremacy]));
    expect(r.cart).toBeUndefined();
    expect(getProductByIdMock).not.toHaveBeenCalled();
    expect(r.pendingCart).toBeNull();
  });

  it('REVIEW: "agregame el invictus" (producto inexistente) con oferta única NO agrega el pendiente en silencio', async () => {
    findProductByNameMock.mockResolvedValueOnce(null); // 'invictus' no matchea el catálogo
    const r = await decidirRespuesta('t1', 'c1', 'agregame el invictus', false, conPendiente([supremacy]));
    expect(r.cart).toBeUndefined();
    expect(getProductByIdMock).not.toHaveBeenCalled();
    expect(r.reply).toContain('Decime cuál'); // repregunta, jamás otro producto a ciegas
  });

  it('REVIEW: opinión que menciona al candidato ("me encanta el supremacy pero esta caro") no agrega ni desambigua', async () => {
    searchCatalogMock.mockResolvedValueOnce([]); // 'caro' activa la rama catálogo (precio PREMIUM, F1)
    const r = await decidirRespuesta('t1', 'c1', 'me encanta el supremacy pero esta caro', false, conPendiente([odyssey, supremacy]));
    expect(r.cart).toBeUndefined();
    expect(getProductByIdMock).not.toHaveBeenCalled();
  });

  it('REVIEW: pregunta con ordinal ("¿cuánto sale el 2?") no agrega; la oferta sigue viva para el próximo "sí"', async () => {
    const r = await decidirRespuesta('t1', 'c1', '¿cuánto sale el 2?', false, conPendiente([odyssey, supremacy]));
    expect(r.cart).toBeUndefined();
    expect(getProductByIdMock).not.toHaveBeenCalled();
    expect(r.pendingCart).toBeUndefined(); // conserva la oferta (la IA contesta el precio)
  });

  it('legacy (sesión sin oferta F3): "sí" con VARIOS lastShownSkus → desambigua leyendo nombres, nunca el primero a ciegas', async () => {
    getProductByIdMock.mockResolvedValueOnce(odyssey).mockResolvedValueOnce(supremacy);
    const r = await decidirRespuesta('t1', 'c1', 'sí', false, {
      ...prev,
      state: 'VIEWING_PRODUCT' as SessionState,
      lastShownSkus: ['zgpG', '2wWm'],
      nowMs: NOW,
    });
    expect(r.cart).toBeUndefined();
    expect(r.reply).toContain('¿Cuál querés que agregue?');
    expect(r.pendingCart?.products.map((p) => p.id)).toEqual(['zgpG', '2wWm']); // upgrade a F3
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
