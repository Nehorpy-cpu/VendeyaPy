import { describe, it, expect } from 'vitest';
import { deriveSubscriptionUpdate, type StripeSubEvent } from './subscriptionSync.js';

const NOW = 1_700_000_500_000;
const MAP = { price_growth: 'growth', price_starter: 'starter' };
const ev = (type: string, obj: Record<string, unknown>): StripeSubEvent => ({ id: 'evt_1', type, data: { object: obj } });
const subObj = (over: Record<string, unknown> = {}) => ({ id: 'sub_1', customer: 'cus_1', current_period_end: 1_700_000_000, metadata: { tenantId: 't1' }, items: { data: [{ price: { id: 'price_growth' } }] }, ...over });

describe('deriveSubscriptionUpdate', () => {
  it('created activa → plan resuelto + período + refs genéricas (provider stripe) + sin pastDue', () => {
    const r = deriveSubscriptionUpdate(ev('customer.subscription.created', subObj({ status: 'active' })), MAP, { pastDueSinceMs: null }, NOW);
    expect(r).toMatchObject({ tenantId: 't1', provider: 'stripe', status: 'active', planId: 'growth', currentPeriodEndMs: 1_700_000_000_000, externalCustomerId: 'cus_1', externalSubscriptionId: 'sub_1', externalPlanRef: 'price_growth', pastDueSinceMs: null });
  });

  it('deleted → canceled', () => {
    const r = deriveSubscriptionUpdate(ev('customer.subscription.deleted', subObj({ status: 'active' })), MAP, { pastDueSinceMs: null }, NOW);
    expect(r.status).toBe('canceled');
  });

  it('past_due: setea pastDueSince la primera vez', () => {
    const r = deriveSubscriptionUpdate(ev('customer.subscription.updated', subObj({ status: 'past_due' })), MAP, { pastDueSinceMs: null }, NOW);
    expect(r.status).toBe('past_due');
    expect(r.pastDueSinceMs).toBe(NOW);
  });

  it('past_due: preserva el pastDueSince previo', () => {
    const OLD = NOW - 3 * 86_400_000;
    const r = deriveSubscriptionUpdate(ev('customer.subscription.updated', subObj({ status: 'past_due' })), MAP, { pastDueSinceMs: OLD }, NOW);
    expect(r.pastDueSinceMs).toBe(OLD);
  });

  it('recuperación (active) limpia el pastDueSince', () => {
    const r = deriveSubscriptionUpdate(ev('customer.subscription.updated', subObj({ status: 'active' })), MAP, { pastDueSinceMs: NOW - 1000 }, NOW);
    expect(r.pastDueSinceMs).toBeNull();
  });

  it('precio no mapeado → planId null (no cambiar el plan)', () => {
    const r = deriveSubscriptionUpdate(ev('customer.subscription.updated', subObj({ status: 'active', items: { data: [{ price: { id: 'price_x' } }] } })), MAP, { pastDueSinceMs: null }, NOW);
    expect(r.planId).toBeNull();
  });
});
