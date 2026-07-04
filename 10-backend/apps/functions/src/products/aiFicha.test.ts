/**
 * aiFicha.test.ts — Calidad de la ficha para recomendaciones + composers (CAT-1)
 * Lógica compartida (@vpw/shared/aiFicha): niveles, faltantes y generación determinística.
 */
import { describe, it, expect } from 'vitest';
import {
  aiFichaQuality,
  composeAiNotesFromFicha,
  composeDescriptionFromFicha,
  AI_FICHA_LEVEL_LABEL,
  type AiFichaQualityInput,
} from '@vpw/shared';

/** Perfume SIN ficha (como los productos existentes pre-CAT-1). */
const perfumeVacio: AiFichaQualityInput = {
  description: '',
  aiNotes: '',
  perfume: { olfactiveFamily: '', styleTags: [], sizeMl: null, notes: { top: [], heart: [], base: [] } },
  aiFicha: null,
};

/** Perfume con TODO completo (las 17 señales). */
const perfumeCompleto: AiFichaQualityInput & { name: string } = {
  name: 'Supremacy Collector',
  description: 'Perfume árabe intenso de larga duración, ideal para quien busca presencia.',
  aiNotes: 'EDP 100ml. Dulce especiado, dura todo el día, gran proyección. Ideal para regalo.',
  perfume: {
    olfactiveFamily: 'Oriental',
    styleTags: ['dulce', 'intenso', 'árabe'],
    sizeMl: 100,
    notes: { top: ['piña', 'bergamota'], heart: ['abedul', 'pachulí'], base: ['almizcle', 'vainilla'] },
  },
  aiFicha: {
    cuandoRecomendar: 'busca duración y presencia fuerte',
    cuandoNoRecomendar: 'quiere algo suave para oficina',
    objeciones: '"es caro" → rinde como uno de lujo',
    frasesVenta: ['El favorito para regalar'],
    similares: ['Odyssey Mega', 'Asad'],
    concentracion: 'EDP',
    duracion: '8-10 horas',
    proyeccion: 'fuerte',
    ocasiones: ['cita', 'fiesta'],
    clima: ['invierno'],
    perfil: 'juvenil',
  },
};

describe('aiFichaQuality', () => {
  it('producto existente sin ficha → incompleto, con faltantes que guían', () => {
    const q = aiFichaQuality(perfumeVacio);
    expect(q.level).toBe('incompleto');
    expect(q.score).toBe(0);
    expect(q.total).toBe(17); // 8 base + 9 de perfumería
    expect(q.faltantes).toContain('cuándo recomendarlo');
    expect(q.faltantes).toContain('familia olfativa');
  });

  it('producto completo → "Excelente para IA" (17/17)', () => {
    const q = aiFichaQuality(perfumeCompleto);
    expect(q.level).toBe('excelente');
    expect(q.score).toBe(17);
    expect(q.faltantes).toEqual([]);
    expect(AI_FICHA_LEVEL_LABEL[q.level]).toBe('Excelente para IA');
  });

  it('niveles intermedios: básico y bueno según % de señales', () => {
    // 5/17 ≈ 0.29 → básico
    const basico = aiFichaQuality({
      ...perfumeVacio,
      description: 'Una descripción con más de veinte caracteres.',
      aiNotes: 'Notas para la IA con contenido suficiente.',
      perfume: { ...perfumeVacio.perfume!, olfactiveFamily: 'Floral', styleTags: ['dulce', 'floral'], sizeMl: 50 },
    });
    expect(basico.level).toBe('basico');
    // 12/17 ≈ 0.71 → bueno
    const bueno = aiFichaQuality({
      ...perfumeCompleto,
      aiFicha: { ...perfumeCompleto.aiFicha, cuandoRecomendar: '', cuandoNoRecomendar: '', objeciones: '', frasesVenta: [], similares: [] },
    });
    expect(bueno.level).toBe('bueno');
  });

  it('producto genérico (perfume: null) usa solo las señales base (7) y puede ser excelente', () => {
    const q = aiFichaQuality({ description: '', aiNotes: '', perfume: null, aiFicha: null });
    expect(q.total).toBe(7);
    expect(q.faltantes).not.toContain('familia olfativa');
    // estilos viven en PerfumeAttributes: no pueden ser una señal imposible para genéricos
    expect(q.faltantes).not.toContain('estilos (2+)');
    const completo = aiFichaQuality({
      description: 'Crema hidratante con caléndula, rinde 3 meses.',
      aiNotes: 'Recomendar para piel seca; evitar si busca perfume.',
      perfume: null,
      aiFicha: {
        cuandoRecomendar: 'piel seca o sensible',
        cuandoNoRecomendar: 'busca fragancia intensa',
        objeciones: '"es chica" → rinde 3 meses',
        frasesVenta: ['La más vendida del invierno'],
        similares: ['Crema de karité'],
      },
    });
    expect(completo.level).toBe('excelente'); // 7/7
  });

  it('señales exigen contenido real: espacios o textos cortos no cuentan', () => {
    const q = aiFichaQuality({
      ...perfumeVacio,
      description: '   ',
      aiFicha: { cuandoRecomendar: 'corto', frasesVenta: ['  '] },
    });
    expect(q.score).toBe(0);
  });
});

describe('composeAiNotesFromFicha', () => {
  it('arma notas con pirámide, rendimiento y guía de venta, ≤300 chars', () => {
    const out = composeAiNotesFromFicha(perfumeCompleto);
    expect(out).toContain('EDP');
    expect(out).toContain('100ml');
    expect(out).toContain('Salida: piña');
    expect(out).toContain('Dura 8-10 horas');
    expect(out).toContain('Recomendalo si: busca duración');
    expect(out.length).toBeLessThanOrEqual(300);
  });

  it('ficha vacía → cadena vacía (no inventa nada)', () => {
    expect(composeAiNotesFromFicha({ ...perfumeVacio, name: 'X' })).toBe('');
  });

  it('nunca incluye datos que no estén en la ficha', () => {
    const out = composeAiNotesFromFicha({
      name: 'Y',
      perfume: { olfactiveFamily: 'Cítrica', styleTags: [], sizeMl: null, notes: { top: [], heart: [], base: [] } },
      aiFicha: { duracion: '4 horas' },
    });
    expect(out).toContain('Cítrica');
    expect(out).toContain('Dura 4 horas');
    expect(out).not.toContain('Salida');
    expect(out).not.toContain('Ideal');
  });

  it('un solo campo muy largo NO deja la salida vacía: se trunca a 300', () => {
    // validateAiFicha permite 500 chars: el compactador no puede devolver '' con ficha válida
    const out = composeAiNotesFromFicha({
      name: 'Z',
      perfume: null,
      aiFicha: { cuandoRecomendar: 'quiere presencia y duración, '.repeat(12) },
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain('Recomendalo si');
  });

  it('una parte que no entra se saltea sin cortar las siguientes más cortas', () => {
    const out = composeAiNotesFromFicha({
      name: 'Z',
      perfume: null,
      aiFicha: {
        concentracion: 'EDP',
        cuandoRecomendar: 'texto larguísimo que no entra en el presupuesto restante, '.repeat(6),
        similares: ['Asad'],
      },
    });
    expect(out).toContain('EDP');
    expect(out).toContain('Alternativas: Asad'); // antes el break la descartaba
    expect(out.length).toBeLessThanOrEqual(300);
  });
});

describe('composeDescriptionFromFicha', () => {
  it('descripción corta para el cliente, ≤200 chars, capitalizada', () => {
    const out = composeDescriptionFromFicha(perfumeCompleto);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.charAt(0)).toBe(out.charAt(0).toUpperCase());
    expect(out).toContain('Abre con notas de piña');
  });

  it('NO filtra datos internos de venta (objeciones/frases/cuándo NO)', () => {
    const out = composeDescriptionFromFicha(perfumeCompleto);
    expect(out).not.toContain('caro');
    expect(out).not.toContain('oficina');
    expect(out).not.toContain('regalar');
  });

  it('ficha vacía → cadena vacía', () => {
    expect(composeDescriptionFromFicha({ ...perfumeVacio, name: 'X' })).toBe('');
  });
});
