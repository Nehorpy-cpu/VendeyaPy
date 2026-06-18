import { describe, it, expect } from 'vitest';
import { decideWhatsappCreds } from './resolveWhatsappCreds.js';

const NOW = 1_000_000;

describe('decideWhatsappCreds (decisión pura de credenciales por tenant)', () => {
  it('sin tenantId → no_tenant', () => {
    expect(decideWhatsappCreds({ nowMs: NOW })).toEqual({ ok: false, reason: 'no_tenant' });
  });

  it('conexión no activa (null o connected_limited) → not_connected', () => {
    expect(decideWhatsappCreds({ tenantId: 't', connectionStatus: null, nowMs: NOW })).toEqual({ ok: false, reason: 'not_connected' });
    expect(decideWhatsappCreds({ tenantId: 't', connectionStatus: 'connected_limited', nowMs: NOW })).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('token vencido → token_expired (aunque haya asset y token)', () => {
    expect(
      decideWhatsappCreds({ tenantId: 't', connectionStatus: 'active', tokenExpiresAtMs: NOW - 1, phoneNumberId: 'wa-1', token: 'x', nowMs: NOW }),
    ).toEqual({ ok: false, reason: 'token_expired' });
  });

  it('sin asset whatsapp_phone_number → no_phone_asset', () => {
    expect(
      decideWhatsappCreds({ tenantId: 't', connectionStatus: 'active', phoneNumberId: null, token: 'x', nowMs: NOW }),
    ).toEqual({ ok: false, reason: 'no_phone_asset' });
  });

  it('sin token → token_unavailable', () => {
    expect(
      decideWhatsappCreds({ tenantId: 't', connectionStatus: 'active', phoneNumberId: 'wa-1', token: null, nowMs: NOW }),
    ).toEqual({ ok: false, reason: 'token_unavailable' });
  });

  it('activo + asset + token (no vencido) → ok con phoneNumberId/token/tokenExpiresAtMs', () => {
    expect(
      decideWhatsappCreds({ tenantId: 't', connectionStatus: 'active', tokenExpiresAtMs: NOW + 10_000, phoneNumberId: 'wa-1', token: 'tok', nowMs: NOW }),
    ).toEqual({ ok: true, phoneNumberId: 'wa-1', accessToken: 'tok', tokenExpiresAtMs: NOW + 10_000 });
  });

  it('token sin expiración (null) → ok', () => {
    expect(
      decideWhatsappCreds({ tenantId: 't', connectionStatus: 'active', tokenExpiresAtMs: null, phoneNumberId: 'wa-1', token: 'tok', nowMs: NOW }),
    ).toMatchObject({ ok: true, tokenExpiresAtMs: null });
  });
});
