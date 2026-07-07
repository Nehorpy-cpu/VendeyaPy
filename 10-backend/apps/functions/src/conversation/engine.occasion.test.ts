/**
 * engine.occasion.test.ts — Interceptor "¿PRODUCTO sirve para OCASIÓN?" (CAT-2B)
 * Reproduce el bug REAL de prod: "El Odyssey Mega sirve para usarlo de noche?" caía al listado
 * genérico en loop. Fixtures espejo de los productos reales (fichas cargadas por el owner).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../catalog/search.js', () => ({
  searchCatalog: vi.fn(),
  getProductById: vi.fn(),
  findProductByName: vi.fn(),
}));
vi.mock('../lib/firebase.js', () => ({ db: vi.fn(), paths: {} }));
vi.mock('./agentConfig.js', () => ({ getAgentConfig: vi.fn() }));
vi.mock('./messages.js', () => ({ appendMessage: vi.fn(), listRecentMessages: vi.fn() }));
vi.mock('../ai/salesAgent.js', () => ({ runSalesAgent: vi.fn() }));
vi.mock('../orders/createPendingOrder.js', () => ({ createPendingOrder: vi.fn() }));
vi.mock('../orders/checkoutReuse.js', () => ({ resolveCheckoutReuse: vi.fn() }));
vi.mock('../orders/checkoutConfig.js', () => ({ getCheckoutConfig: vi.fn(), formatTransferInstructions: vi.fn() }));
vi.mock('../tracking/tracking.js', () => ({ captureTrackingCode: vi.fn() }));
vi.mock('../entitlements/entitlements.js', () => ({ meterUsage: vi.fn(), checkQuota: vi.fn() }));

import { interceptarPreguntaProductoOcasion } from './engine.js';
import { veredictoOcasion, respuestaOcasionNoConviene, respuestaOcasionConviene } from './productOccasion.js';
import { searchCatalog, getProductById, findProductByName } from '../catalog/search.js';
import { buildPendingConfirmation } from './cartIntent.js';
import type { Product } from '@vpw/shared';

const searchMock = vi.mocked(searchCatalog);
const byIdMock = vi.mocked(getProductById);
const byNameMock = vi.mocked(findProductByName);

const supremacy = {
  id: 'sup', name: 'Perfume Supremacy Not Only Intense', price: 250000,
  perfume: { brand: 'Afnan', styleTags: ['frutal', 'fresco', 'intenso'], notes: { top: [], heart: [], base: [] } },
  aiFicha: {
    duracion: '8-10', proyeccion: 'fuerte', ocasiones: ['momentos especiales', 'ambientes abiertos'],
    clima: ['verano', 'otoño'], perfil: 'maduro, sofisticado',
    cuandoRecomendar: 'busca duración y presencia', cuandoNoRecomendar: 'cuando quiere algo suave',
  },
} as unknown as Product;

const odyssey = {
  id: 'ody', name: 'Armaf Odyssey Mega', price: 250000,
  perfume: { brand: 'Armaf', styleTags: ['citrico', 'dulce'], notes: { top: [], heart: ['piña'], base: [] } },
  aiFicha: {
    duracion: '5-6', proyeccion: 'moderada', ocasiones: ['fresco', 'diario'], clima: ['verano', 'dia'],
    perfil: 'juvenil, moderno', cuandoRecomendar: 'busca un aroma moderno y juvenil',
    cuandoNoRecomendar: 'Si busca algo para salidas nocturnas, eventos formales o una fragancia intensa de alta proyección.',
  },
} as unknown as Product;

const prevBase = { pendingVigente: null, lastShownSkus: [] as string[], nowMs: 1_000_000 };

beforeEach(() => {
  searchMock.mockReset();
  byIdMock.mockReset();
  byNameMock.mockReset();
});

describe('productOccasion veredictoOcasion (puro)', () => {
  it('el cuándo-NO del vendedor gana: Odyssey NO conviene para la noche', () => {
    expect(veredictoOcasion(odyssey, 'noche')).toBe('no_conviene');
  });
  it('ocasiones/cuándo-SÍ dan conviene: Supremacy sirve para la noche, Odyssey para el día', () => {
    expect(veredictoOcasion(supremacy, 'noche')).toBe('conviene');
    expect(veredictoOcasion(odyssey, 'dia')).toBe('conviene');
  });
  it('cuándo-NO gana aunque haya señales positivas', () => {
    const contradictorio = { ...odyssey, aiFicha: { ...odyssey.aiFicha, ocasiones: ['noche'] } } as unknown as Product;
    expect(veredictoOcasion(contradictorio, 'noche')).toBe('no_conviene');
  });
  it('sin ficha → sin señal (delega)', () => {
    const legacy = { id: 'l', name: 'Viejo', aiFicha: null } as unknown as Product;
    expect(veredictoOcasion(legacy, 'noche')).toBe('sin_senal');
  });
});

describe('interceptarPreguntaProductoOcasion (CAT-2B)', () => {
  it('1. "El Odyssey Mega sirve para salir de noche?" → honesto + alternativa Supremacy como oferta', async () => {
    byNameMock.mockResolvedValueOnce(odyssey);
    searchMock.mockResolvedValueOnce([supremacy, odyssey]); // ranking CAT-2: Supremacy 1ro para noche
    const text = 'El Odyssey Mega sirve para salir de noche?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), prevBase);
    expect(r?.tipo).toBe('respuesta');
    if (r?.tipo !== 'respuesta') return;
    expect(r.result.reply).toContain('Armaf Odyssey Mega');
    expect(r.result.reply).toContain('no es mi primera recomendación');
    expect(r.result.reply).toContain('Supremacy'); // sugiere la alternativa
    expect(r.result.reply).not.toContain('te elegí estas opciones'); // JAMÁS el listado genérico
    expect(r.result.pendingCart?.primaryProductId).toBe('sup'); // el próximo "sí" agrega la alternativa
    expect(r.result.lastShownSkus).toEqual(['sup']);
    expect('cart' in r.result).toBe(false); // preguntar NUNCA escribe el carrito
  });

  it('2. "El Odyssey Mega es para usar en la noche?" → mismo resultado', async () => {
    byNameMock.mockResolvedValueOnce(odyssey);
    searchMock.mockResolvedValueOnce([supremacy, odyssey]);
    const text = 'El Odyssey Mega es para usar en la noche?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), prevBase);
    expect(r?.tipo).toBe('respuesta');
    if (r?.tipo !== 'respuesta') return;
    expect(r.result.reply).toContain('Supremacy');
    expect(r.result.pendingCart?.primaryProductId).toBe('sup');
  });

  it('3. anáfora: "Ese sirve para usarlo de noche?" con Odyssey como oferta vigente → mismo resultado', async () => {
    byNameMock.mockResolvedValueOnce(null); // "ese" no matchea nombre
    byIdMock.mockResolvedValueOnce(odyssey);
    searchMock.mockResolvedValueOnce([supremacy, odyssey]);
    const text = 'Ese sirve para usarlo de noche?';
    const pending = buildPendingConfirmation([{ id: 'ody', name: odyssey.name }], 'ai_recommendation', prevBase.nowMs);
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), { ...prevBase, pendingVigente: pending });
    expect(byIdMock).toHaveBeenCalledWith('t1', 'ody');
    expect(r?.tipo).toBe('respuesta');
    if (r?.tipo !== 'respuesta') return;
    expect(r.result.reply).toContain('Supremacy');
    expect(r.result.pendingCart?.primaryProductId).toBe('sup');
  });

  it('4. "El Supremacy sirve para salir de noche?" → sí honesto + oferta del consultado', async () => {
    byNameMock.mockResolvedValueOnce(supremacy);
    const text = 'El Supremacy sirve para salir de noche?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), prevBase);
    expect(r?.tipo).toBe('respuesta');
    if (r?.tipo !== 'respuesta') return;
    expect(r.result.reply).toContain('¡Sí!');
    expect(r.result.reply).toContain('Supremacy');
    expect(r.result.reply).toContain('busca duración y presencia'); // motivo desde la ficha
    expect(r.result.pendingCart?.primaryProductId).toBe('sup');
    expect(searchMock).not.toHaveBeenCalled(); // no hace falta alternativa
  });

  it('7. producto+ocasión SIN señal en la ficha → delega a la IA (no listado)', async () => {
    const legacy = { id: 'l', name: 'Perfume Viejo Legacy', price: 100, aiFicha: null, perfume: { styleTags: [] } } as unknown as Product;
    byNameMock.mockResolvedValueOnce(legacy);
    const text = 'El Viejo Legacy sirve para salir de noche?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), prevBase);
    expect(r).toEqual({ tipo: 'delegar' });
  });

  it('guard: pregunta+producto SIN ocasión pero con estilo (capturaría el catálogo) → delega', async () => {
    byNameMock.mockResolvedValueOnce(odyssey);
    const text = '¿El odyssey es dulce?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), prevBase);
    expect(r).toEqual({ tipo: 'delegar' }); // 'dulce' activaba el listado genérico; ahora va a la IA
  });

  it('no-pregunta ("agregá el odyssey mega") → null (el flujo de carrito sigue intacto)', async () => {
    const text = 'agregá el odyssey mega';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), prevBase);
    expect(r).toBeNull();
    expect(byNameMock).not.toHaveBeenCalled();
  });

  it('pregunta de ocasión SIN producto ("tenés algo para la noche?") → null (catálogo normal)', async () => {
    byNameMock.mockResolvedValueOnce(null);
    const text = 'tenés algo para la noche?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), prevBase);
    expect(r).toBeNull();
  });

  it('anáfora ambigua (varios mostrados, sin primary) → null: no se adivina el producto', async () => {
    byNameMock.mockResolvedValueOnce(null);
    const pending = buildPendingConfirmation(
      [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      'catalog_listing',
      prevBase.nowMs,
    );
    const text = 'Ese sirve para la noche?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), {
      ...prevBase,
      pendingVigente: { ...pending, primaryProductId: null },
      lastShownSkus: ['a', 'b'],
    });
    expect(r).toBeNull();
    expect(byIdMock).not.toHaveBeenCalled();
  });

  // ===== Review adversarial CAT-2B: fixes =====

  it('review: "¿me agregás el odyssey para la noche?" NO se intercepta (flujo agregar manda)', async () => {
    const text = '¿Me agregás el odyssey para la noche?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), prevBase);
    expect(r).toBeNull();
    expect(byNameMock).not.toHaveBeenCalled();
  });

  it('review: "¿puedo pagar el odyssey esta noche?" NO se intercepta (checkout F5 manda)', async () => {
    const text = '¿Puedo pagar el odyssey esta noche?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), prevBase);
    expect(r).toBeNull();
  });

  it('review: logística "¿me lo mandás esta noche?" NO es ocasión (aunque haya oferta vigente)', async () => {
    const pending = buildPendingConfirmation([{ id: 'ody', name: odyssey.name }], 'ai_recommendation', prevBase.nowMs);
    const text = '¿Me lo mandás esta noche?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), { ...prevBase, pendingVigente: pending });
    expect(r).toBeNull();
    expect(byIdMock).not.toHaveBeenCalled();
  });

  it('review: ordinal "¿el 2 sirve para la noche?" resuelve contra la oferta vigente', async () => {
    byNameMock.mockResolvedValueOnce(null);
    byIdMock.mockResolvedValueOnce(odyssey);
    searchMock.mockResolvedValueOnce([supremacy, odyssey]);
    const pending = buildPendingConfirmation(
      [{ id: 'sup', name: supremacy.name }, { id: 'ody', name: odyssey.name }],
      'catalog_listing',
      prevBase.nowMs,
    );
    const text = '¿El 2 sirve para la noche?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), { ...prevBase, pendingVigente: pending });
    expect(byIdMock).toHaveBeenCalledWith('t1', 'ody'); // el 2 de la lista
    expect(r?.tipo).toBe('respuesta');
    if (r?.tipo !== 'respuesta') return;
    expect(r.result.reply).toContain('no es mi primera recomendación');
  });

  it('review: la alternativa con su PROPIO cuándo-NO para la ocasión se descarta (sin auto-contradicción)', async () => {
    const otroDiurno = {
      ...supremacy, id: 'otro', name: 'Otro Fresco Diurno',
      aiFicha: { ocasiones: ['diario'], cuandoNoRecomendar: 'no para salidas nocturnas' },
    } as unknown as Product;
    byNameMock.mockResolvedValueOnce(odyssey);
    searchMock.mockResolvedValueOnce([otroDiurno, odyssey]); // el único candidato también es anti-noche
    const text = 'El Odyssey Mega sirve para salir de noche?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), prevBase);
    expect(r?.tipo).toBe('respuesta');
    if (r?.tipo !== 'respuesta') return;
    expect(r.result.reply).not.toContain('Otro Fresco Diurno'); // no recomienda lo que su dueño vetó
    expect(r.result.reply).toContain('¿Querés que te muestre opciones');
    expect(r.result.pendingCart).toBeNull();
  });

  it('sin alternativa disponible → honesto igual, sin oferta colgada', async () => {
    byNameMock.mockResolvedValueOnce(odyssey);
    searchMock.mockResolvedValueOnce([odyssey]); // solo él en el catálogo
    const text = 'El Odyssey Mega sirve para salir de noche?';
    const r = await interceptarPreguntaProductoOcasion('t1', text, text.toLowerCase(), prevBase);
    expect(r?.tipo).toBe('respuesta');
    if (r?.tipo !== 'respuesta') return;
    expect(r.result.reply).toContain('no es mi primera recomendación');
    expect(r.result.pendingCart).toBeNull();
    expect(r.result.lastShownSkus).toEqual([]);
  });
});

describe('productOccasion respuestas (puras)', () => {
  it('no-conviene con alternativa: honesto, describe al consultado desde SU ficha y motiva la alternativa', () => {
    const out = respuestaOcasionNoConviene(odyssey, 'noche', supremacy);
    expect(out).toContain('es más fresco y diario'); // ficha del Odyssey, no inventado
    expect(out).toContain('Supremacy');
    expect(out).toContain('proyecta fuerte y dura 8-10'); // ficha del Supremacy
    expect(out).toContain('¿Querés que te lo agregue?');
  });
  it('conviene: confirma con el cuándo-SÍ de la ficha', () => {
    const out = respuestaOcasionConviene(supremacy, 'noche');
    expect(out).toContain('¡Sí!');
    expect(out).toContain('ideal si busca duración y presencia');
  });
});
