/**
 * fichaRank.test.ts — Ranking determinístico por ficha (CAT-2)
 * Fixtures espejo de los productos REALES de la perfumería (fichas cargadas por el owner),
 * para que los pesos queden probados contra el caso que motivó el programa (smoke CAT-1).
 */
import { describe, it, expect } from 'vitest';
import type { Product } from '@vpw/shared';
import { detectarOcasionContexto, fichaScore } from './fichaRank.js';

const supremacy = {
  id: 'sup', name: 'Perfume Supremacy Not Only Intense', price: 250000, featured: false,
  perfume: {
    brand: 'Afnan', styleTags: ['frutal', 'fresco', 'intenso'], olfactiveFamily: 'amaderado, Afrutada',
    notes: { top: ['bergamota', 'manzana verde'], heart: ['patchouli', 'lavanda'], base: ['ambergris', 'musk', 'saffron'] },
  },
  aiFicha: {
    concentracion: 'Extrait', duracion: '8-10', proyeccion: 'fuerte',
    ocasiones: ['momentos especiales', 'ambientes abiertos'], clima: ['verano', 'otoño', 'primavera'],
    perfil: 'maduro, sofisticado', cuandoRecomendar: 'busca duración y presencia',
  },
} as unknown as Product;

const odyssey = {
  id: 'ody', name: 'Armaf Odyssey Mega', price: 250000, featured: true,
  perfume: {
    brand: 'Armaf', styleTags: ['Amaderado', 'citrico', 'aromatico', 'dulce'], olfactiveFamily: 'Citrico',
    notes: { top: ['naranja', 'bergamota', 'limon', 'jengibre', 'menta'], heart: ['piña', 'salvia', 'enebro', 'geranio'], base: ['almizcle', 'cedro', 'haba tonka', 'vetiver'] },
  },
  aiFicha: {
    concentracion: 'EDP', duracion: '5-6', proyeccion: 'moderada',
    ocasiones: ['fresco', 'diario'], clima: ['verano', 'dia'], perfil: 'juvenil, moderno',
    cuandoRecomendar: 'busca un aroma moderno y juvenil',
  },
} as unknown as Product;

describe('detectarOcasionContexto', () => {
  it('detecta noche/salidas/eventos', () => {
    expect(detectarOcasionContexto('quiero uno para salir de noche')).toBe('noche');
    expect(detectarOcasionContexto('algo para una fiesta')).toBe('noche');
    expect(detectarOcasionContexto('tengo un evento el sábado')).toBe('noche');
    expect(detectarOcasionContexto('para una cita')).toBe('noche');
  });
  it('detecta día/oficina/diario', () => {
    expect(detectarOcasionContexto('algo fresco para la oficina')).toBe('dia');
    expect(detectarOcasionContexto('para el trabajo, uso diario')).toBe('dia');
    expect(detectarOcasionContexto('para el día')).toBe('dia');
  });
  it('sin señal de ocasión → undefined (nota u otras consultas)', () => {
    expect(detectarOcasionContexto('quiero un perfume con olor a piña')).toBeUndefined();
    expect(detectarOcasionContexto('hola')).toBeUndefined();
  });

  // ===== Review adversarial CAT-2: falsos positivos léxicos =====

  it('review: "elegante"/"formal" NO son noche — "algo elegante para la oficina" es día', () => {
    expect(detectarOcasionContexto('mostrame algo elegante para la oficina')).toBe('dia');
    expect(detectarOcasionContexto('algo formal para el trabajo')).toBe('dia');
  });

  it('review: saludos y narrativa temporal NO son ocasión', () => {
    expect(detectarOcasionContexto('buen día, mostrame el catálogo')).toBeUndefined();
    expect(detectarOcasionContexto('buenas noches, mostrame el catálogo')).toBeUndefined();
    expect(detectarOcasionContexto('ayer a la noche vi su anuncio, tienen catálogo?')).toBeUndefined();
    expect(detectarOcasionContexto('mostrame opciones, mañana paso a retirar')).toBeUndefined();
    expect(detectarOcasionContexto('el otro día vi uno que me gustó')).toBeUndefined();
  });

  it('review: narrativa + pedido real → gana el pedido ("ayer a la noche vi el anuncio, algo para la oficina")', () => {
    expect(detectarOcasionContexto('ayer a la noche vi su anuncio, quiero algo para la oficina')).toBe('dia');
  });

  it('review: "notas de salida" es jerga de pirámide, no un pedido nocturno', () => {
    expect(detectarOcasionContexto('mostrame opciones con buenas notas de salida cítricas')).toBeUndefined();
  });

  it('review: ambigüedad real ("para el día y la noche") → sin sesgo', () => {
    expect(detectarOcasionContexto('algo que sirva para el día y la noche')).toBeUndefined();
  });

  it('review: "que dure toda la noche" y "salida nocturna" siguen siendo noche', () => {
    expect(detectarOcasionContexto('quiero uno que dure toda la noche')).toBe('noche');
    expect(detectarOcasionContexto('para una salida nocturna')).toBe('noche'); // vía "nocturna"
  });
});

describe('fichaScore', () => {
  it('"para salir de noche" → Supremacy le gana a Odyssey (ocasión + proyección fuerte)', () => {
    const texto = 'quiero uno para salir de noche';
    const sup = fichaScore(supremacy, texto);
    const ody = fichaScore(odyssey, texto);
    expect(sup).toBeGreaterThan(ody);
    expect(sup).toBeGreaterThanOrEqual(8); // ocasiones "especiales" +6, proyección fuerte +2
    expect(ody).toBeLessThanOrEqual(0);
  });

  it('"fresco para oficina/día" → Odyssey le gana a Supremacy (diario + clima día + moderada)', () => {
    const texto = 'quiero algo fresco para la oficina';
    const ody = fichaScore(odyssey, texto);
    const sup = fichaScore(supremacy, texto);
    expect(ody).toBeGreaterThan(sup);
    expect(ody).toBeGreaterThanOrEqual(10); // ocasiones +6, clima 'dia' +2, moderada +2
  });

  it('la ventaja por ficha supera el +5 de styleTag y el +1 de featured (no se invierte el orden)', () => {
    // Peor caso real: "fresco para oficina" activa styleTag 'fresco' que lo tiene SUPREMACY.
    const texto = 'algo fresco para la oficina';
    const supConTag = fichaScore(supremacy, texto) + 5; // styleTag fresco (search.ts) va para Supremacy
    const odyConFeatured = fichaScore(odyssey, texto) + 1; // featured va para Odyssey
    expect(odyConFeatured).toBeGreaterThan(supConTag);
  });

  it('"olor a piña" → +4 solo para el que tiene piña en la pirámide', () => {
    const texto = 'quiero un perfume con olor a piña';
    expect(fichaScore(odyssey, texto)).toBeGreaterThanOrEqual(4);
    expect(fichaScore(supremacy, texto)).toBe(0);
  });

  it('cuándo-NO pesa en contra: ficha que dice "no para la noche" queda abajo', () => {
    const odyConNo = {
      ...odyssey,
      aiFicha: { ...(odyssey.aiFicha ?? {}), cuandoNoRecomendar: 'si busca algo para salidas nocturnas o eventos formales' },
    } as unknown as Product;
    expect(fichaScore(odyConNo, 'quiero uno para salir de noche')).toBeLessThan(0);
  });

  it('cuándo-SÍ suma: ficha que recomienda para la noche sube', () => {
    const p = {
      ...supremacy,
      aiFicha: { ...(supremacy.aiFicha ?? {}), cuandoRecomendar: 'ideal para la noche y eventos' },
    } as unknown as Product;
    expect(fichaScore(p, 'algo para la noche')).toBeGreaterThanOrEqual(12); // +6 ocasión, +4 cuándo-SÍ, +2 fuerte
  });

  it('sin ficha y sin notas que matcheen → 0 (productos legacy no se ven afectados)', () => {
    const legacy = { id: 'l', name: 'Viejo', perfume: { styleTags: [], notes: { top: [], heart: [], base: [] } }, aiFicha: null } as unknown as Product;
    expect(fichaScore(legacy, 'para salir de noche')).toBe(0);
    expect(fichaScore(legacy, 'olor a piña')).toBe(0);
  });

  it('texto sin señales → 0 aunque el producto tenga ficha completa', () => {
    expect(fichaScore(supremacy, 'hola, ¿cómo va?')).toBe(0);
  });
});
