import { describe, it, expect } from 'vitest';
import {
  computeOrderTotals,
  normalizeOrderTotals,
  formatCanonicalShippingMessage,
  formatGuaranies,
} from './orderTotals.js';
import type { OrderTotals } from './types/order.types.js';

describe('computeOrderTotals — fórmula y validaciones', () => {
  it('sin descuento: total = subtotal + shipping', () => {
    expect(computeOrderTotals({ subtotalGs: 100000, discountGs: 0, shippingGs: 30000 })).toEqual({
      subtotal: 100000,
      discount: 0,
      shipping: 30000,
      total: 130000,
      currency: 'PYG',
    });
  });

  it('con descuento: total = subtotal - discount + shipping', () => {
    expect(computeOrderTotals({ subtotalGs: 200000, discountGs: 50000, shippingGs: 30000 })).toEqual({
      subtotal: 200000,
      discount: 50000,
      shipping: 30000,
      total: 180000,
      currency: 'PYG',
    });
  });

  it('envío 0: total = subtotal - discount', () => {
    const t = computeOrderTotals({ subtotalGs: 100000, discountGs: 10000, shippingGs: 0 });
    expect(t.total).toBe(90000);
    expect(t.shipping).toBe(0);
  });

  it('descuento == subtotal: total = shipping', () => {
    expect(computeOrderTotals({ subtotalGs: 50000, discountGs: 50000, shippingGs: 30000 }).total).toBe(30000);
  });

  it('el envío NUNCA se suma al subtotal', () => {
    const t = computeOrderTotals({ subtotalGs: 100000, discountGs: 0, shippingGs: 30000 });
    expect(t.subtotal).toBe(100000);
  });

  it('rechaza descuento > subtotal', () => {
    expect(() => computeOrderTotals({ subtotalGs: 100000, discountGs: 150000, shippingGs: 0 })).toThrow();
  });

  it('rechaza subtotal negativo', () => {
    expect(() => computeOrderTotals({ subtotalGs: -1, discountGs: 0, shippingGs: 0 })).toThrow();
  });

  it('rechaza shipping negativo', () => {
    expect(() => computeOrderTotals({ subtotalGs: 100000, discountGs: 0, shippingGs: -30000 })).toThrow();
  });

  it('rechaza no-enteros', () => {
    expect(() => computeOrderTotals({ subtotalGs: 100000.5, discountGs: 0, shippingGs: 0 })).toThrow();
  });

  it('rechaza NaN', () => {
    expect(() => computeOrderTotals({ subtotalGs: NaN, discountGs: 0, shippingGs: 0 })).toThrow();
  });

  it('rechaza Infinity', () => {
    expect(() => computeOrderTotals({ subtotalGs: Infinity, discountGs: 0, shippingGs: 0 })).toThrow();
  });

  it('rechaza entero fuera de rango seguro', () => {
    expect(() => computeOrderTotals({ subtotalGs: Number.MAX_SAFE_INTEGER + 1, discountGs: 0, shippingGs: 0 })).toThrow();
  });
});

describe('normalizeOrderTotals — compatibilidad de órdenes viejas', () => {
  it('shipping ausente ⇒ 0', () => {
    const old = { subtotal: 100000, discount: 0, total: 100000, currency: 'PYG' } as OrderTotals;
    expect(normalizeOrderTotals(old).shipping).toBe(0);
  });

  it('NO muta el objeto original', () => {
    const old = { subtotal: 100000, discount: 0, total: 100000, currency: 'PYG' } as OrderTotals;
    const out = normalizeOrderTotals(old);
    expect(old.shipping).toBeUndefined();
    expect(out).not.toBe(old);
  });

  it('NO recalcula total (respeta el total viejo)', () => {
    const old = { subtotal: 100000, discount: 0, total: 100000, currency: 'PYG' } as OrderTotals;
    expect(normalizeOrderTotals(old).total).toBe(100000);
  });

  it('shipping presente ⇒ se mantiene', () => {
    const nuevo = { subtotal: 100000, discount: 0, shipping: 30000, total: 130000, currency: 'PYG' } as OrderTotals;
    expect(normalizeOrderTotals(nuevo).shipping).toBe(30000);
  });
});

describe('formatCanonicalShippingMessage — mensaje canónico sin PII', () => {
  it('monto > 0', () => {
    expect(formatCanonicalShippingMessage(30000)).toBe('El costo de envío para tu ubicación es ₲30.000.');
  });

  it('monto 0 (gratis confirmado)', () => {
    expect(formatCanonicalShippingMessage(0)).toBe('El envío para tu ubicación es sin costo.');
  });

  it('monto grande con separadores de miles', () => {
    expect(formatCanonicalShippingMessage(1500000)).toBe('El costo de envío para tu ubicación es ₲1.500.000.');
  });

  it('no contiene dirección ni coordenadas (solo el monto)', () => {
    const msg = formatCanonicalShippingMessage(30000);
    expect(msg).not.toMatch(/\d+\s*,\s*-?\d+/); // sin pares de coordenadas
    expect(msg.toLowerCase()).not.toContain('calle');
    expect(msg.toLowerCase()).not.toContain('av.');
  });

  it('rechaza negativo', () => expect(() => formatCanonicalShippingMessage(-1)).toThrow());
  it('rechaza no-entero', () => expect(() => formatCanonicalShippingMessage(30000.5)).toThrow());
});

describe('formatGuaranies — separador de miles es-PY', () => {
  it('30000 ⇒ "30.000"', () => expect(formatGuaranies(30000)).toBe('30.000'));
  it('1500000 ⇒ "1.500.000"', () => expect(formatGuaranies(1500000)).toBe('1.500.000'));
  it('0 ⇒ "0"', () => expect(formatGuaranies(0)).toBe('0'));
  it('100 ⇒ "100"', () => expect(formatGuaranies(100)).toBe('100'));
  it('rechaza negativo', () => expect(() => formatGuaranies(-5)).toThrow());
});
