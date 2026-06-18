import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyStripeSignature, StripeSignatureError } from './stripeSignature.js';

const secret = 'whsec_test_123';
const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
const sign = (ts: number, body = payload, sec = secret) =>
  `t=${ts},v1=${createHmac('sha256', sec).update(`${ts}.${body}`).digest('hex')}`;

describe('verifyStripeSignature', () => {
  const now = 1_700_000_000;

  it('acepta una firma válida dentro de tolerancia', () => {
    expect(() => verifyStripeSignature(payload, sign(now), secret, { nowSec: now })).not.toThrow();
  });

  it('rechaza una firma con secreto incorrecto', () => {
    expect(() => verifyStripeSignature(payload, sign(now, payload, 'otro'), secret, { nowSec: now })).toThrow(
      StripeSignatureError,
    );
  });

  it('rechaza un body manipulado (misma firma)', () => {
    expect(() => verifyStripeSignature('{"id":"evt_2"}', sign(now), secret, { nowSec: now })).toThrow(
      StripeSignatureError,
    );
  });

  it('rechaza un timestamp viejo (replay)', () => {
    expect(() => verifyStripeSignature(payload, sign(now - 10_000), secret, { nowSec: now })).toThrow(
      StripeSignatureError,
    );
  });

  it('rechaza si falta la cabecera', () => {
    expect(() => verifyStripeSignature(payload, undefined, secret, { nowSec: now })).toThrow(StripeSignatureError);
  });
});
