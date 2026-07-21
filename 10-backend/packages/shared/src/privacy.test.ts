import { describe, it, expect } from 'vitest';
import { maskPhone } from './privacy.js';

describe('maskPhone — enmascarado central para logs', () => {
  it('devuelve solo los últimos 4', () => {
    expect(maskPhone('595994893000')).toBe('…3000');
    expect(maskPhone('1251346811387904')).toBe('…7904');
  });
  it('jamás devuelve el valor completo', () => {
    expect(maskPhone('595994893000')).not.toContain('595994893000');
    expect(maskPhone('595994893000').length).toBeLessThan(8);
  });
  it('vacío/null/undefined ⇒ placeholder seguro', () => {
    expect(maskPhone('')).toBe('(sin dato)');
    expect(maskPhone(null)).toBe('(sin dato)');
    expect(maskPhone(undefined)).toBe('(sin dato)');
  });
  it('HARDEN: identificadores de 1 a 4 caracteres se ocultan ENTEROS (jamás el valor completo)', () => {
    for (const v of ['a', 'ab', 'abc', 'abcd', '1234']) {
      expect(maskPhone(v)).toBe('(oculto)');
      expect(maskPhone(v)).not.toContain(v);
    }
    expect(maskPhone('abcde')).toBe('…bcde'); // 5+ ⇒ últimos 4, nunca completo
  });
});
