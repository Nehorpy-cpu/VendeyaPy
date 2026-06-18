import { describe, it, expect } from 'vitest';
import { resolveMetaConnectAuth } from './authz.js';

describe('resolveMetaConnectAuth (owner/admin estricto)', () => {
  it('owner: opera SU empresa e ignora el tenantId pedido (cross-tenant bloqueado)', () => {
    expect(resolveMetaConnectAuth({ role: 'TENANT_OWNER', tenantId: 'perfumeria' }, 'otra')).toEqual({ ok: true, tenantId: 'perfumeria' });
  });

  it('platform admin: opera la empresa pedida', () => {
    expect(resolveMetaConnectAuth({ role: 'PLATFORM_ADMIN' }, 'boutique')).toEqual({ ok: true, tenantId: 'boutique' });
  });

  it('platform admin SIN tenantId: invalid-argument', () => {
    const r = resolveMetaConnectAuth({ role: 'PLATFORM_ADMIN' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-argument');
  });

  it('MANAGER: DENEGADO (más estricto que el panel)', () => {
    const r = resolveMetaConnectAuth({ role: 'TENANT_MANAGER', tenantId: 'perfumeria' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('permission-denied');
  });

  it('seller / viewer / sin-rol: denegado', () => {
    expect(resolveMetaConnectAuth({ role: 'SELLER', tenantId: 'perfumeria' }).ok).toBe(false);
    expect(resolveMetaConnectAuth({ role: 'TENANT_VIEWER', tenantId: 'perfumeria' }).ok).toBe(false);
    expect(resolveMetaConnectAuth({}).ok).toBe(false);
  });

  it('owner sin empresa asignada: denegado', () => {
    expect(resolveMetaConnectAuth({ role: 'TENANT_OWNER' }).ok).toBe(false);
  });
});
