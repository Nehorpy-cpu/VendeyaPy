import { describe, it, expect } from 'vitest';
import { fraseCuandoRecomendar, respuestaOcasionConviene } from './productOccasion.js';
import type { Product } from '@vpw/shared';

/**
 * F7 (gramática de ocasión): el template de prod produjo "ideal si cuando buscan proyeccion
 * monstruosa y duracion" — doble conector. El compositor respeta el conector que el vendedor ya
 * escribió (si/cuando/para), agrega "si" solo cuando falta y nunca depende de textos del catálogo.
 */
describe('conversation/productOccasion fraseCuandoRecomendar (F7)', () => {
  it('BUG PROD: texto que empieza con "cuando" no duplica conector', () => {
    expect(fraseCuandoRecomendar('cuando buscan proyección monstruosa y duración')).toBe(
      ': ideal cuando buscan proyección monstruosa y duración',
    );
  });

  it('respeta "si" y "para" ya escritos por el vendedor', () => {
    expect(fraseCuandoRecomendar('si querés algo elegante')).toBe(': ideal si querés algo elegante');
    expect(fraseCuandoRecomendar('para fiestas y eventos')).toBe(': ideal para fiestas y eventos');
  });

  it('agrega "si" cuando el texto arranca directo con la cláusula', () => {
    expect(fraseCuandoRecomendar('busca algo para regalar')).toBe(': ideal si busca algo para regalar');
    expect(fraseCuandoRecomendar('quiere duración todo el día')).toBe(': ideal si quiere duración todo el día');
  });

  it('frases ya redactadas con "ideal" no lo duplican', () => {
    expect(fraseCuandoRecomendar('Es ideal para la noche')).toBe(': ideal para la noche');
    expect(fraseCuandoRecomendar('Ideal si buscás intensidad')).toBe(': ideal si buscás intensidad');
  });

  it('normaliza mayúsculas y puntuación colgante', () => {
    expect(fraseCuandoRecomendar('Cuando quieren impactar.')).toBe(': ideal cuando quieren impactar');
    expect(fraseCuandoRecomendar('  para   el   invierno , ')).toBe(': ideal para el invierno');
  });

  it('vacío/solo espacios/solo prefijo → cadena vacía (el caller usa otro motivo)', () => {
    expect(fraseCuandoRecomendar(undefined)).toBe('');
    expect(fraseCuandoRecomendar('')).toBe('');
    expect(fraseCuandoRecomendar('   ')).toBe('');
    expect(fraseCuandoRecomendar('Es ideal')).toBe('');
  });
});

const producto = (aiFicha: Record<string, unknown>): Product =>
  ({ name: 'Nova Prime', price: 250000, aiFicha }) as unknown as Product;

describe('conversation/productOccasion respuestaOcasionConviene (F7)', () => {
  it('compone español natural con el cuándo-recomendar del vendedor', () => {
    const r = respuestaOcasionConviene(producto({ cuandoRecomendar: 'cuando buscan proyección monstruosa y duración' }), 'noche');
    expect(r).toContain('va muy bien para salir de noche: ideal cuando buscan proyección monstruosa y duración.');
    expect(r).not.toContain('si cuando'); // el doble conector del bug
  });

  it('sin cuándo-recomendar cae al motivo por proyección/duración', () => {
    const r = respuestaOcasionConviene(producto({ proyeccion: 'fuerte', duracion: '8-10 horas' }), 'noche');
    expect(r).toContain('proyecta fuerte y dura 8-10 horas');
  });

  it('ficha sin datos: la frase queda natural igual (sin motivo colgante)', () => {
    const r = respuestaOcasionConviene(producto({}), 'noche');
    expect(r).toContain('va muy bien para salir de noche. ¿Te lo agrego?');
  });
});

describe('conversation/productOccasion fraseCuandoRecomendar — F7 review', () => {
  it('respeta también los conectores en/durante/al', () => {
    expect(fraseCuandoRecomendar('en las noches de fiesta')).toBe(': ideal en las noches de fiesta');
    expect(fraseCuandoRecomendar('durante el invierno')).toBe(': ideal durante el invierno');
    expect(fraseCuandoRecomendar('al salir de noche')).toBe(': ideal al salir de noche');
  });

  it('texto sin letras (solo emojis/números) → vacío, cae al motivo por ficha', () => {
    expect(fraseCuandoRecomendar('🔥🔥')).toBe('');
    expect(fraseCuandoRecomendar('100%')).toBe('');
  });
});
