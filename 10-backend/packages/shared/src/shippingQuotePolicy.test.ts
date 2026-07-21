import { describe, it, expect } from 'vitest';
import { shippingQuotePolicyOf, shippingQuoteOfFlowState } from './shippingQuotePolicy.js';

const cov = (shippingQuote: unknown) => ({ enabled: true, activationId: 'act-test-000001', shippingQuote });

describe('shippingQuotePolicyOf — matriz fail-closed completa', () => {
  it('bloque AUSENTE ⇒ off', () => {
    expect(shippingQuotePolicyOf({ enabled: true, activationId: 'a'.repeat(12) })).toEqual({ status: 'off' });
    expect(shippingQuotePolicyOf(undefined)).toEqual({ status: 'off' });
    expect(shippingQuotePolicyOf(null)).toEqual({ status: 'off' });
    expect(shippingQuotePolicyOf('basura')).toEqual({ status: 'off' });
    expect(shippingQuotePolicyOf([])).toEqual({ status: 'off' });
  });

  it('required === false (booleano estricto) ⇒ off', () => {
    expect(shippingQuotePolicyOf(cov({ required: false, maxChargeGs: 5_000_000 }))).toEqual({ status: 'off' });
    expect(shippingQuotePolicyOf(cov({ required: false }))).toEqual({ status: 'off' });
  });

  it('required === true + maxChargeGs safe-int > 0 ⇒ required', () => {
    expect(shippingQuotePolicyOf(cov({ required: true, maxChargeGs: 5_000_000 }))).toEqual({ status: 'required', maxChargeGs: 5_000_000 });
    expect(shippingQuotePolicyOf(cov({ required: true, maxChargeGs: 1 }))).toEqual({ status: 'required', maxChargeGs: 1 });
    expect(shippingQuotePolicyOf(cov({ required: true, maxChargeGs: Number.MAX_SAFE_INTEGER }))).toEqual({
      status: 'required',
      maxChargeGs: Number.MAX_SAFE_INTEGER,
    });
  });

  it('CUALQUIER otra forma presente ⇒ invalid (jamás degrada a off): required no-booleano', () => {
    expect(shippingQuotePolicyOf(cov({ required: 'true', maxChargeGs: 5_000_000 }))).toEqual({ status: 'invalid' });
    expect(shippingQuotePolicyOf(cov({ required: 1, maxChargeGs: 5_000_000 }))).toEqual({ status: 'invalid' });
    expect(shippingQuotePolicyOf(cov({ required: null, maxChargeGs: 5_000_000 }))).toEqual({ status: 'invalid' });
    expect(shippingQuotePolicyOf(cov({ maxChargeGs: 5_000_000 }))).toEqual({ status: 'invalid' }); // sin required
  });

  it('invalid: max inválido con required=true (string, 0, negativo, float, NaN, Infinity, unsafe)', () => {
    for (const bad of ['5000000', 0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(shippingQuotePolicyOf(cov({ required: true, maxChargeGs: bad }))).toEqual({ status: 'invalid' });
    }
    expect(shippingQuotePolicyOf(cov({ required: true }))).toEqual({ status: 'invalid' }); // sin max
  });

  it('invalid: bloque presente pero malformado (array, string, número)', () => {
    expect(shippingQuotePolicyOf(cov([]))).toEqual({ status: 'invalid' });
    expect(shippingQuotePolicyOf(cov('required'))).toEqual({ status: 'invalid' });
    expect(shippingQuotePolicyOf(cov(42))).toEqual({ status: 'invalid' });
    expect(shippingQuotePolicyOf(cov(null))).toEqual({ status: 'off' }); // null == ausente en Firestore merge
  });
});

describe('shippingQuoteOfFlowState — compat con respuesta antigua (deploy skew)', () => {
  it('shippingQuote ausente ⇒ off', () => {
    expect(shippingQuoteOfFlowState({} as never)).toEqual({ status: 'off' });
    expect(shippingQuoteOfFlowState(null)).toEqual({ status: 'off' });
    expect(shippingQuoteOfFlowState(undefined)).toEqual({ status: 'off' });
  });
  it('shippingQuote presente ⇒ passthrough', () => {
    expect(shippingQuoteOfFlowState({ shippingQuote: { status: 'required', maxChargeGs: 9 } })).toEqual({ status: 'required', maxChargeGs: 9 });
    expect(shippingQuoteOfFlowState({ shippingQuote: { status: 'invalid' } })).toEqual({ status: 'invalid' });
  });
});
