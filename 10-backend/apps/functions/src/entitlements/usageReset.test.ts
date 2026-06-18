import { describe, it, expect } from 'vitest';
import { shouldResetUsage } from './usageReset.js';

const MAY_1 = Date.UTC(2026, 4, 1);
const MAY_20 = Date.UTC(2026, 4, 20);
const JUN_1 = Date.UTC(2026, 5, 1);
const MAY_2027 = Date.UTC(2027, 4, 1);

describe('shouldResetUsage', () => {
  it('mismo mes calendario → no reinicia', () => {
    expect(shouldResetUsage(MAY_1, MAY_20)).toBe(false);
  });
  it('mes distinto → reinicia', () => {
    expect(shouldResetUsage(MAY_1, JUN_1)).toBe(true);
  });
  it('año distinto (mismo mes) → reinicia', () => {
    expect(shouldResetUsage(MAY_1, MAY_2027)).toBe(true);
  });
  it('sin período conocido → no reinicia', () => {
    expect(shouldResetUsage(null, MAY_20)).toBe(false);
    expect(shouldResetUsage(undefined, MAY_20)).toBe(false);
  });
});
