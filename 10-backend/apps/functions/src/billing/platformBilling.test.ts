import { describe, it, expect } from 'vitest';
import { normalizeStripeStatus, tenantStatusForSubscription } from './platformBilling.js';

describe('platformBilling — mapeo de suscripción → estado de empresa', () => {
  it('normaliza estados de Stripe', () => {
    expect(normalizeStripeStatus('active')).toBe('active');
    expect(normalizeStripeStatus('past_due')).toBe('past_due');
    expect(normalizeStripeStatus('unpaid')).toBe('past_due');
    expect(normalizeStripeStatus('incomplete_expired')).toBe('canceled');
    expect(normalizeStripeStatus('lo-que-sea')).toBe('none');
  });

  it('activa con suscripción al día, suspende con problemas de pago', () => {
    expect(tenantStatusForSubscription('active')).toBe('ACTIVE');
    expect(tenantStatusForSubscription('trialing')).toBe('ACTIVE');
    expect(tenantStatusForSubscription('past_due')).toBe('SUSPENDED');
    expect(tenantStatusForSubscription('canceled')).toBe('SUSPENDED');
    expect(tenantStatusForSubscription('incomplete')).toBe('SUSPENDED');
  });
});
