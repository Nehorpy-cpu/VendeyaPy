import { describe, it, expect } from 'vitest';
import { mapPaypalResourceStatus, payPalEventToStatus } from './payPalStatus.js';

describe('mapPaypalResourceStatus', () => {
  it('mapea el estado del recurso PayPal a interno', () => {
    expect(mapPaypalResourceStatus('ACTIVE')).toBe('active');
    expect(mapPaypalResourceStatus('APPROVAL_PENDING')).toBe('incomplete');
    expect(mapPaypalResourceStatus('APPROVED')).toBe('incomplete');
    expect(mapPaypalResourceStatus('SUSPENDED')).toBe('past_due');
    expect(mapPaypalResourceStatus('CANCELLED')).toBe('canceled');
    expect(mapPaypalResourceStatus('EXPIRED')).toBe('canceled');
    expect(mapPaypalResourceStatus('???')).toBe('none');
  });
});

describe('payPalEventToStatus', () => {
  it('mapea el tipo de evento (manda el evento)', () => {
    expect(payPalEventToStatus('BILLING.SUBSCRIPTION.ACTIVATED', undefined)).toBe('active');
    expect(payPalEventToStatus('PAYMENT.SALE.COMPLETED', undefined)).toBe('active');
    expect(payPalEventToStatus('BILLING.SUBSCRIPTION.SUSPENDED', undefined)).toBe('past_due');
    expect(payPalEventToStatus('BILLING.SUBSCRIPTION.PAYMENT.FAILED', undefined)).toBe('past_due');
    expect(payPalEventToStatus('BILLING.SUBSCRIPTION.CANCELLED', undefined)).toBe('canceled');
    expect(payPalEventToStatus('BILLING.SUBSCRIPTION.EXPIRED', undefined)).toBe('canceled');
    expect(payPalEventToStatus('BILLING.SUBSCRIPTION.CREATED', undefined)).toBe('incomplete');
  });
  it('UPDATED usa el estado del recurso', () => {
    expect(payPalEventToStatus('BILLING.SUBSCRIPTION.UPDATED', 'ACTIVE')).toBe('active');
    expect(payPalEventToStatus('BILLING.SUBSCRIPTION.UPDATED', 'SUSPENDED')).toBe('past_due');
  });
});
