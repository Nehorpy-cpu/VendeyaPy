import { describe, it, expect } from 'vitest';
import { isNonceValid, type NonceDoc } from './nonce.js';

const NOW = 1_000_000;
const base: NonceDoc = { tenantId: 'perfumeria', uid: 'uid-1', createdAtMs: NOW - 1000, expiresAtMs: NOW + 1000 };

describe('isNonceValid', () => {
  it('válido: mismo tenant+uid y no expirado', () => {
    expect(isNonceValid(base, { tenantId: 'perfumeria', uid: 'uid-1', nowMs: NOW })).toBe(true);
  });
  it('inexistente → false', () => {
    expect(isNonceValid(undefined, { tenantId: 'perfumeria', uid: 'uid-1', nowMs: NOW })).toBe(false);
  });
  it('expirado → false', () => {
    expect(isNonceValid({ ...base, expiresAtMs: NOW - 1 }, { tenantId: 'perfumeria', uid: 'uid-1', nowMs: NOW })).toBe(false);
  });
  it('tenant distinto → false', () => {
    expect(isNonceValid(base, { tenantId: 'otra', uid: 'uid-1', nowMs: NOW })).toBe(false);
  });
  it('uid distinto → false', () => {
    expect(isNonceValid(base, { tenantId: 'perfumeria', uid: 'uid-2', nowMs: NOW })).toBe(false);
  });
});
