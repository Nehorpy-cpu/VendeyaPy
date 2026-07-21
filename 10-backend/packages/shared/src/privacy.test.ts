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
  it('valores cortos no explotan', () => {
    expect(maskPhone('abc')).toBe('…abc');
  });
});
