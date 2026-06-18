import { describe, it, expect } from 'vitest';
import { missingScopes, pickSelectedPhone } from './connectFlow.js';
import type { MetaPhoneNumber } from './graphClient.js';

const phone = (id: string): MetaPhoneNumber => ({ id, displayPhoneNumber: id, verifiedName: '', qualityRating: '', codeVerificationStatus: '' });

describe('missingScopes', () => {
  it('devuelve los scopes que faltan', () => {
    expect(missingScopes(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
    expect(missingScopes(['a', 'b', 'c'], ['a', 'b'])).toEqual([]);
  });
});

describe('pickSelectedPhone', () => {
  it('elige el pedido si existe entre los del WABA', () => {
    expect(pickSelectedPhone([phone('wa-1'), phone('wa-2')], 'wa-2')).toBe('wa-2');
  });
  it('si el pedido no existe → el primero', () => {
    expect(pickSelectedPhone([phone('wa-1'), phone('wa-2')], 'wa-9')).toBe('wa-1');
  });
  it('sin pedido → el primero', () => {
    expect(pickSelectedPhone([phone('wa-1')])).toBe('wa-1');
  });
  it('sin números → null', () => {
    expect(pickSelectedPhone([], 'wa-1')).toBeNull();
  });
});
