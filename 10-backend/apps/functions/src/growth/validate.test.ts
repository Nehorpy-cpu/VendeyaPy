import { describe, it, expect } from 'vitest';
import { validatePromotionPatch, validateTrackingSourcePatch } from './validate.js';

describe('validatePromotionPatch', () => {
  it('create requiere name+type; whitelist descarta server-only', () => {
    const r = validatePromotionPatch({ name: 'Verano', type: 'PERCENTAGE', discountValue: 20, tenantId: 'evil', id: 'x', attribution: { foo: 1 }, createdAt: 1 }, { requireCreate: true });
    expect(r).toEqual({ name: 'Verano', type: 'PERCENTAGE', discountValue: 20 });
    expect(r).not.toHaveProperty('tenantId');
    expect(r).not.toHaveProperty('attribution');
    expect(() => validatePromotionPatch({ name: 'X' }, { requireCreate: true })).toThrow();
    expect(() => validatePromotionPatch({ type: 'PERCENTAGE' }, { requireCreate: true })).toThrow();
  });
  it('valida enums, números y fechas (ms|ISO|null)', () => {
    expect(() => validatePromotionPatch({ name: 'X', type: 'NOPE' }, { requireCreate: true })).toThrow();
    expect(() => validatePromotionPatch({ name: 'X', type: 'PERCENTAGE', discountValue: -1 }, { requireCreate: true })).toThrow();
    const r = validatePromotionPatch({ startDate: 1_700_000_000_000, endDate: '2026-01-01T00:00:00Z', status: 'ACTIVE' }, { requireCreate: false });
    expect(r.startDate).toBe(1_700_000_000_000);
    expect(r.endDate).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(r.status).toBe('ACTIVE');
    expect(validatePromotionPatch({ startDate: null }, { requireCreate: false }).startDate).toBeNull();
    expect(() => validatePromotionPatch({ startDate: 'no-fecha' }, { requireCreate: false })).toThrow();
  });
  it('update no exige requeridos', () => {
    expect(validatePromotionPatch({ description: 'x' }, { requireCreate: false })).toEqual({ description: 'x' });
  });
});

describe('validateTrackingSourcePatch', () => {
  it('create requiere name+code+type; descarta attribution', () => {
    const r = validateTrackingSourcePatch({ name: 'QR Local', code: 'VERANO20', type: 'coupon', active: true, attribution: { x: 1 } }, { requireCreate: true });
    expect(r).toEqual({ name: 'QR Local', code: 'VERANO20', type: 'coupon', active: true });
    expect(r).not.toHaveProperty('attribution');
    expect(() => validateTrackingSourcePatch({ name: 'X', code: 'C' }, { requireCreate: true })).toThrow();
    expect(() => validateTrackingSourcePatch({ name: 'X', code: 'C', type: 'sms' }, { requireCreate: true })).toThrow();
  });
});
