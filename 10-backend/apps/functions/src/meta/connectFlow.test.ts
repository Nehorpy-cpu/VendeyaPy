import { describe, it, expect } from 'vitest';
import { missingScopes, pickSelectedPhone, wabaAutorizado } from './connectFlow.js';
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
  it('si el pedido no existe → null (antes caía en silencio al primero y conectaba OTRO número)', () => {
    expect(pickSelectedPhone([phone('wa-1'), phone('wa-2')], 'wa-9')).toBeNull();
  });
  it('sin pedido → el primero', () => {
    expect(pickSelectedPhone([phone('wa-1')])).toBe('wa-1');
  });
  it('pedido en blanco = sin pedido', () => {
    expect(pickSelectedPhone([phone('wa-1')], '  ')).toBe('wa-1');
  });
  it('sin números → null', () => {
    expect(pickSelectedPhone([], 'wa-1')).toBeNull();
  });
});

describe('wabaAutorizado', () => {
  it('el WABA pedido está entre los del token → autorizado', () => {
    expect(wabaAutorizado('waba-1', ['waba-1', 'waba-2'])).toBe(true);
  });
  it('el WABA pedido NO está entre los del token → rechazado', () => {
    expect(wabaAutorizado('waba-ajena', ['waba-1'])).toBe(false);
  });
  it('token sin granular_scopes → no hay con qué contrastar, se acepta el pedido', () => {
    expect(wabaAutorizado('waba-1', [])).toBe(true);
  });
});
