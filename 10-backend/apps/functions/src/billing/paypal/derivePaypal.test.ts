import { describe, it, expect } from 'vitest';
import { derivePayPalSubscriptionUpdate, type PayPalEvent } from './derivePaypal.js';

const NOW = 1_700_000_500_000;
const MAP = { 'P-GROWTH': 'growth' };
const ev = (event_type: string, resource: Record<string, unknown>): PayPalEvent => ({ id: 'WH-1', event_type, resource });
const sub = (over: Record<string, unknown> = {}) => ({ id: 'I-SUB1', plan_id: 'P-GROWTH', custom_id: 't1', subscriber: { payer_id: 'PAYER1' }, billing_info: { next_billing_time: '2026-01-01T00:00:00Z' }, status: 'ACTIVE', ...over });

describe('derivePayPalSubscriptionUpdate', () => {
  it('ACTIVATED → active + plan + período + refs (provider paypal) enlazado por custom_id', () => {
    const r = derivePayPalSubscriptionUpdate(ev('BILLING.SUBSCRIPTION.ACTIVATED', sub()), MAP, { pastDueSinceMs: null }, NOW);
    expect(r).toMatchObject({
      tenantId: 't1', provider: 'paypal', status: 'active', planId: 'growth',
      externalSubscriptionId: 'I-SUB1', externalCustomerId: 'PAYER1', externalPlanRef: 'P-GROWTH', pastDueSinceMs: null,
    });
    expect(r.currentPeriodEndMs).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('CANCELLED → canceled', () => {
    expect(derivePayPalSubscriptionUpdate(ev('BILLING.SUBSCRIPTION.CANCELLED', sub({ status: 'CANCELLED' })), MAP, { pastDueSinceMs: null }, NOW).status).toBe('canceled');
  });

  it('SUSPENDED → past_due y setea pastDueSince', () => {
    const r = derivePayPalSubscriptionUpdate(ev('BILLING.SUBSCRIPTION.SUSPENDED', sub({ status: 'SUSPENDED' })), MAP, { pastDueSinceMs: null }, NOW);
    expect(r.status).toBe('past_due');
    expect(r.pastDueSinceMs).toBe(NOW);
  });

  it('past_due preserva el pastDueSince previo', () => {
    const OLD = NOW - 3 * 86_400_000;
    expect(derivePayPalSubscriptionUpdate(ev('BILLING.SUBSCRIPTION.PAYMENT.FAILED', sub()), MAP, { pastDueSinceMs: OLD }, NOW).pastDueSinceMs).toBe(OLD);
  });

  it('PAYMENT.SALE.COMPLETED enlaza por billing_agreement_id', () => {
    const r = derivePayPalSubscriptionUpdate(ev('PAYMENT.SALE.COMPLETED', { billing_agreement_id: 'I-SUB1', custom: 't1' }), MAP, { pastDueSinceMs: null }, NOW);
    expect(r).toMatchObject({ status: 'active', externalSubscriptionId: 'I-SUB1', tenantId: 't1' });
  });

  it('plan PayPal no mapeado → planId null', () => {
    expect(derivePayPalSubscriptionUpdate(ev('BILLING.SUBSCRIPTION.ACTIVATED', sub({ plan_id: 'P-XXX' })), MAP, { pastDueSinceMs: null }, NOW).planId).toBeNull();
  });
});
