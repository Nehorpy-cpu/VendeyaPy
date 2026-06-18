import { describe, it, expect } from 'vitest';
import { decidePreflightStatus } from './preflight.js';
import { META_REQUIRED_SCOPES } from './scopes.js';

const REQ = META_REQUIRED_SCOPES;
const OK_SCOPES = [...META_REQUIRED_SCOPES];

describe('decidePreflightStatus', () => {
  it('token inválido → expired / token_invalid', () => {
    expect(decidePreflightStatus({ tokenValid: false, scopes: OK_SCOPES, requiredScopes: REQ, phoneFound: true })).toEqual({ status: 'expired', ready: false, reason: 'token_invalid' });
  });

  it('scopes faltantes → permission_missing', () => {
    expect(decidePreflightStatus({ tokenValid: true, scopes: ['whatsapp_business_messaging'], requiredScopes: REQ, phoneFound: true })).toEqual({ status: 'permission_missing', ready: false, reason: 'permission_missing' });
  });

  it('sin número válido → error / no_phone_asset', () => {
    expect(decidePreflightStatus({ tokenValid: true, scopes: OK_SCOPES, requiredScopes: REQ, phoneFound: false })).toEqual({ status: 'error', ready: false, reason: 'no_phone_asset' });
  });

  it('token válido + scopes + número → active / ok', () => {
    expect(decidePreflightStatus({ tokenValid: true, scopes: OK_SCOPES, requiredScopes: REQ, phoneFound: true })).toEqual({ status: 'active', ready: true, reason: 'ok' });
  });
});
