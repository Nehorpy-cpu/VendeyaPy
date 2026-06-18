import { describe, it, expect } from 'vitest';
import { parseDebugToken, parsePhoneNumbers } from './graphClient.js';

describe('parseDebugToken', () => {
  it('extrae is_valid, scopes, WABA ids (granular_scopes) y expiración', () => {
    const r = parseDebugToken({
      data: {
        is_valid: true,
        scopes: ['whatsapp_business_messaging', 'whatsapp_business_management', 'public_profile'],
        granular_scopes: [
          { scope: 'whatsapp_business_management', target_ids: ['waba-1', 'waba-2'] },
          { scope: 'whatsapp_business_messaging', target_ids: ['waba-1'] },
          { scope: 'public_profile' },
        ],
        expires_at: 1_700_000_000,
      },
    });
    expect(r.isValid).toBe(true);
    expect(r.scopes).toHaveLength(3);
    expect(r.wabaIds).toEqual(['waba-1', 'waba-2']);
    expect(r.expiresAtMs).toBe(1_700_000_000_000);
  });

  it('token inválido / vacío → isValid false, sin scopes/waba, sin expiración', () => {
    const r = parseDebugToken({ data: { is_valid: false } });
    expect(r.isValid).toBe(false);
    expect(r.scopes).toEqual([]);
    expect(r.wabaIds).toEqual([]);
    expect(r.expiresAtMs).toBeNull();
  });

  it('expires_at = 0 (System User) → null (no expira)', () => {
    expect(parseDebugToken({ data: { is_valid: true, expires_at: 0 } }).expiresAtMs).toBeNull();
  });
});

describe('parsePhoneNumbers', () => {
  it('normaliza los números y descarta los sin id', () => {
    const r = parsePhoneNumbers({
      data: [
        { id: 'wa-1', display_phone_number: '+595 981 111', verified_name: 'Mi Tienda', quality_rating: 'GREEN', code_verification_status: 'VERIFIED' },
        { id: '' },
      ],
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 'wa-1', displayPhoneNumber: '+595 981 111', verifiedName: 'Mi Tienda', codeVerificationStatus: 'VERIFIED' });
  });

  it('payload sin data → []', () => {
    expect(parsePhoneNumbers({})).toEqual([]);
  });
});
