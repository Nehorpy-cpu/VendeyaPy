import { describe, it, expect } from 'vitest';
import { gateActivacionVenta } from './productUpsert.js';

/**
 * MEDIO-2 de la review adversarial (ONBOARDING-QUALITY-1): el gate de venta debe mirar el
 * status RESULTANTE del merge, no el del patch — un UPDATE que omite `status` sobre un
 * producto ya ACTIVE también puede dejarlo en venta con precio inválido.
 */
describe('gateActivacionVenta — sobre el status resultante', () => {
  it('resultante ACTIVE + bloqueos de venta ⇒ rechaza (aunque el patch no traiga status)', () => {
    expect(() => gateActivacionVenta('ACTIVE', ['price_invalid'])).toThrowError(/precio no es válido/);
    expect(() => gateActivacionVenta('ACTIVE', ['name_missing'])).toThrowError(/falta el nombre/);
  });

  it('resultante INACTIVE (o sin status) ⇒ pasa aunque haya bloqueos: no está en venta', () => {
    expect(() => gateActivacionVenta('INACTIVE', ['price_invalid'])).not.toThrow();
    expect(() => gateActivacionVenta(undefined, ['price_invalid'])).not.toThrow();
  });

  it('ACTIVE sin bloqueos ⇒ pasa', () => {
    expect(() => gateActivacionVenta('ACTIVE', [])).not.toThrow();
  });
});
