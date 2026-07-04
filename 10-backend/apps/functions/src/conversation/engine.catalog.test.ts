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
import { decidirRespuesta, interceptarReclamoCarrito } from './engine.js';
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

  // ---- F4-A: cortesía en confirmaciones (el bug real "Si, agrégalo porfa" no agregaba) ----

  it.each(['Sí, agrégalo porfa', 'Dale, agregalo por favor', 'Ok gracias', 'si porfa', 'dale porfa'])(
    'F4: confirmación con cortesía "%s" + ÚNICO candidato → AGREGA (porfa/gracias son relleno, no producto)',
    async (msg) => {
      getProductByIdMock.mockResolvedValueOnce(supremacy);
      const r = await decidirRespuesta('t1', 'c1', msg, false, conPendiente([supremacy]));
      expect(getProductByIdMock).toHaveBeenCalledWith('t1', '2wWm');
      expect(r.cart?.items[0]?.productId).toBe('2wWm');
      expect(r.pendingCart).toBeNull();
    },
  );

  it('F4: "no gracias" y "mejor otro porfa" siguen SIN agregar', async () => {
    const r1 = await decidirRespuesta('t1', 'c1', 'no gracias', false, conPendiente([supremacy]));
    expect(r1.cart).toBeUndefined();
    const r2 = await decidirRespuesta('t1', 'c1', 'mejor otro porfa', false, conPendiente([supremacy]));
    expect(r2.cart).toBeUndefined();
    expect(getProductByIdMock).not.toHaveBeenCalled();
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

/**
 * F4-B (anti-mentiras): el interceptor de reclamos responde con el estado REAL del carrito.
 * En prod la IA dijo "Ya lo agregué" con el carrito vacío — estos tests fijan que el reclamo
 * jamás llegue a inventar estado.
 */
describe('conversation/engine interceptarReclamoCarrito (F4-B)', () => {
  const NOW = 1_000_000;
  const supremacy = { id: '2wWm', name: 'Perfume Supremacy Not Only Intense', price: 250000 } as unknown as Product;
  const odyssey = { id: 'zgpG', name: 'Armaf Odyssey Mega', price: 250000 } as unknown as Product;
  const cartCon = (...ps: Product[]): Cart => ({
    items: ps.map((p) => ({ productId: p.id, name: p.name, price: p.price, quantity: 1, imageUrl: '' })),
    subtotal: ps.reduce((n, p) => n + p.price, 0),
  });
  const vacio: Cart = { items: [], subtotal: 0 };

  it('reclamo FUERTE + carrito VACÍO + producto nombrado → verdad honesta + oferta pendiente (el próximo "sí" agrega)', async () => {
    findProductByNameMock.mockResolvedValueOnce(supremacy);
    const r = await interceptarReclamoCarrito('t1', 'no agregaste nada, yo quería el supremacy', { cart: vacio, pendingVigente: null, nowMs: NOW }, 'fuerte');
    expect(r?.reply).toContain('Todavía no agregué nada');
    expect(r?.reply).toContain('Supremacy');
    expect(r?.reply).not.toContain('Agregué *'); // jamás afirma la acción no ejecutada
    expect(r?.pendingCart?.primaryProductId).toBe('2wWm');
    expect(r?.lastShownSkus).toEqual(['2wWm']);
  });

  it('reclamo FUERTE + carrito vacío SIN producto nombrado → honesto y pide precisión', async () => {
    findProductByNameMock.mockResolvedValueOnce(null);
    const r = await interceptarReclamoCarrito('t1', 'te equivocaste', { cart: vacio, pendingVigente: null, nowMs: NOW }, 'fuerte');
    expect(r?.reply).toContain('Todavía no agregué nada');
    expect(r?.pendingCart).toBeNull();
  });

  it('reclamo con carrito que tiene OTRO producto → muestra el estado real y ofrece agregar el nombrado', async () => {
    findProductByNameMock.mockResolvedValueOnce(supremacy);
    const r = await interceptarReclamoCarrito('t1', 'me agregaste otro, yo quería el supremacy', { cart: cartCon(odyssey), pendingVigente: null, nowMs: NOW }, 'fuerte');
    expect(r?.reply).toContain('Armaf Odyssey Mega x1'); // estado REAL
    expect(r?.reply).toContain('todavía NO está');
    expect(r?.pendingCart?.primaryProductId).toBe('2wWm');
  });

  it('reclamo con el producto CORRECTO ya en el carrito → lo confirma con estado real, ofrece pagar y DESCARTA la oferta vieja', async () => {
    findProductByNameMock.mockResolvedValueOnce(supremacy);
    const r = await interceptarReclamoCarrito('t1', 'no agregaste el supremacy', { cart: cartCon(supremacy), pendingVigente: null, nowMs: NOW }, 'fuerte');
    expect(r?.reply).toContain('está en tu carrito');
    expect(r?.reply).toContain('pagar');
    // REVIEW: la pregunta ahora es "¿pagás?" — un pending viejo no puede capturar el próximo "sí".
    expect(r?.pendingCart).toBeNull();
  });

  it('REVIEW: reclamo genérico con carrito no vacío también descarta la oferta vieja ("¿está bien así?" ≠ "¿lo agrego?")', async () => {
    findProductByNameMock.mockResolvedValueOnce(null);
    const r = await interceptarReclamoCarrito('t1', 'te equivocaste', { cart: cartCon(odyssey), pendingVigente: null, nowMs: NOW }, 'fuerte');
    expect(r?.reply).toContain('Reviso tu carrito real');
    expect(r?.pendingCart).toBeNull();
  });

  it('REVIEW: pedido cortés ("yo quería el X", débil) con carrito vacío → tono amable, sin disculpa rara', async () => {
    findProductByNameMock.mockResolvedValueOnce(supremacy);
    const r = await interceptarReclamoCarrito('t1', 'yo quería el supremacy', { cart: vacio, pendingVigente: null, nowMs: NOW }, 'debil');
    expect(r?.reply).toContain('¿Querés que agregue');
    expect(r?.reply).not.toContain('Tenés razón'); // no es una queja: no pedir perdón
    expect(r?.pendingCart?.primaryProductId).toBe('2wWm');
  });

  it('REVIEW: reclamo durante AWAITING_PAYMENT → "pedido registrado", jamás ofrece pagar/re-agregar', async () => {
    findProductByNameMock.mockResolvedValueOnce(supremacy);
    const r = await interceptarReclamoCarrito('t1', 'te pedí el supremacy', { cart: cartCon(supremacy), pendingVigente: null, nowMs: NOW, enPago: true }, 'debil');
    expect(r?.reply).toContain('ya quedó registrado');
    expect(r?.reply).not.toContain('¿Querés *pagar*');
    expect(r?.pendingCart).toBeNull();
    expect(r?.nextState).toBe('AWAITING_PAYMENT');
  });

  it('DÉBIL sin producto nombrado ("yo quería saber si hacen envíos") → null (va a la IA)', async () => {
    findProductByNameMock.mockResolvedValueOnce(null);
    const r = await interceptarReclamoCarrito('t1', 'yo quería saber si hacen envíos', { cart: vacio, pendingVigente: null, nowMs: NOW }, 'debil');
    expect(r).toBeNull();
  });

  it('DÉBIL que nombra un candidato de la oferta VIGENTE → null (lo resuelve la elección por nombre 4b)', async () => {
    findProductByNameMock.mockResolvedValueOnce(supremacy);
    const pending = buildPendingConfirmation([{ id: '2wWm', name: supremacy.name }], 'ai_recommendation', NOW);
    const r = await interceptarReclamoCarrito('t1', 'yo quería el supremacy', { cart: vacio, pendingVigente: pending, nowMs: NOW }, 'debil');
    expect(r).toBeNull();
  });
});

/** F6: cliente NUEVO — bienvenida completa SOLO con saludo puro; con intención, la intención manda. */
describe('conversation/engine decidirRespuesta — F6: primer mensaje con intención', () => {
  it('1. cliente nuevo "Hola" → bienvenida completa (comportamiento intacto)', async () => {
    const r = await decidirRespuesta('t1', 'c1', 'Hola', true, { ...prev, greeting: 'Bienvenida a Mi Tienda 💖\nSegunda línea larga.' });
    expect(r.reply).toContain('Bienvenida a Mi Tienda');
    expect(r.nextState).toBe('BROWSING');
  });

  it('2. cliente nuevo "Hola, cómo pago?" → NO se come la intención (la resuelve el motor: carrito vacío)', async () => {
    const r = await decidirRespuesta('t1', 'c1', 'Hola, cómo pago?', true, prev);
    expect(r.reply).toContain('carrito está vacío'); // quierePagar con carrito vacío
    expect(r.reply).not.toContain('Bienvenida a *Perfumería');
  });

  it('3. cliente nuevo "Hola, mostrame el catálogo" → va a la rama catálogo, no a la bienvenida', async () => {
    searchCatalogMock.mockResolvedValueOnce([producto]);
    const r = await decidirRespuesta('t1', 'c1', 'Hola, mostrame el catálogo', true, prev);
    expect(r.reply).toContain('Supremacy Not Only Intense');
    expect(r.lastShownSkus).toEqual(['p1']);
  });
});

describe('conversation/engine saludoBreve + sinSaludoInicial (F6)', async () => {
  const { saludoBreve, sinSaludoInicial } = await import('./engine.js');
  it('usa la PRIMERA LÍNEA de la bienvenida personalizada del tenant', () => {
    expect(saludoBreve('¡Hola! 💖 Bienvenida a *Perfumería AFG*.\nContame qué buscás y bla bla…')).toBe('¡Hola! 💖 Bienvenida a *Perfumería AFG*.');
  });
  it('línea larguísima → corta en la primera oración; vacía → fallback genérico', () => {
    const larga = 'Bienvenido a nuestra increíble tienda con los mejores precios del país entero. ' + 'x'.repeat(120);
    expect(saludoBreve(larga)).toBe('Bienvenido a nuestra increíble tienda con los mejores precios del país entero.');
    expect(saludoBreve('')).toBe('¡Hola! 👋 Bienvenido/a.');
    expect(saludoBreve(undefined)).toBe('¡Hola! 👋 Bienvenido/a.');
  });
  it('REVIEW: quita la pregunta de enganche del final (los defaults de provision terminan en pregunta)', () => {
    expect(saludoBreve('¡Hola! 💖 Bienvenida. Soy tu asesora de fragancias. ¿Buscás algo para vos o para regalar?'))
      .toBe('¡Hola! 💖 Bienvenida. Soy tu asesora de fragancias.');
    // Si TODO era pregunta → fallback (nunca prefijo vacío).
    expect(saludoBreve('¿Qué estás buscando hoy?')).toBe('¡Hola! 👋 Bienvenido/a.');
  });
  it('REVIEW: sinSaludoInicial evita el doble saludo cuando la IA espeja el "Hola" del cliente', () => {
    expect(sinSaludoInicial('¡Hola! Sí, tenemos el Supremacy a ₲ 250.000.')).toBe('Sí, tenemos el Supremacy a ₲ 250.000.');
    expect(sinSaludoInicial('Buenas! Te cuento: hacemos envíos.')).toBe('Te cuento: hacemos envíos.');
    expect(sinSaludoInicial('Sí, tenemos el Supremacy.')).toBe('Sí, tenemos el Supremacy.'); // sin saludo → intacto
    expect(sinSaludoInicial('¡Hola!')).toBe('¡Hola!'); // el saludo era TODO el mensaje → no vaciar
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
