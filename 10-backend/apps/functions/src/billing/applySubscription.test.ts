import { describe, it, expect } from 'vitest';
import { resolvePaymentProvider } from './applySubscription.js';

describe('resolvePaymentProvider (regla de legacy)', () => {
  it('usa paymentProvider si existe', () => {
    expect(resolvePaymentProvider({ paymentProvider: 'paypal' })).toBe('paypal');
    expect(resolvePaymentProvider({ paymentProvider: 'stripe' })).toBe('stripe');
  });
  it('sin campo pero con ids Stripe → stripe (legacy)', () => {
    expect(resolvePaymentProvider({ stripeSubscriptionId: 'sub_1' })).toBe('stripe');
    expect(resolvePaymentProvider({ stripeCustomerId: 'cus_1' })).toBe('stripe');
  });
  it('sin billing externo → manual', () => {
    expect(resolvePaymentProvider({})).toBe('manual');
    expect(resolvePaymentProvider(undefined)).toBe('manual');
  });
});
