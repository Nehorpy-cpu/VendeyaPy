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

  it('billing NO suspende la cuenta (5B): siempre ACTIVE; el premium lo controla la posture', () => {
    for (const s of ['active', 'trialing', 'past_due', 'canceled', 'incomplete', 'none'] as const) {
      expect(tenantStatusForSubscription(s)).toBe('ACTIVE');
    }
  });
});
