import { describe, it, expect } from 'vitest';
import { parsePriceMap, planIdForPrice } from './priceMap.js';

describe('parsePriceMap', () => {
  it('parsea un JSON válido de price→plan', () => {
    expect(parsePriceMap('{"price_1":"starter","price_2":"growth"}')).toEqual({ price_1: 'starter', price_2: 'growth' });
  });
  it('descarta valores no-string', () => {
    expect(parsePriceMap('{"price_1":"growth","price_2":3}')).toEqual({ price_1: 'growth' });
  });
  it('vacío / inválido / array → {}', () => {
    expect(parsePriceMap(undefined)).toEqual({});
    expect(parsePriceMap('')).toEqual({});
    expect(parsePriceMap('no-json')).toEqual({});
    expect(parsePriceMap('[1,2,3]')).toEqual({});
  });
});

describe('planIdForPrice', () => {
  const map = { price_g: 'growth' };
  it('resuelve el plan del precio mapeado', () => {
    expect(planIdForPrice('price_g', map)).toBe('growth');
  });
  it('precio no mapeado o nulo → null', () => {
    expect(planIdForPrice('price_x', map)).toBeNull();
    expect(planIdForPrice(null, map)).toBeNull();
    expect(planIdForPrice(undefined, map)).toBeNull();
  });
});
