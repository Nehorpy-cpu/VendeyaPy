import { describe, it, expect } from 'vitest';
import { resolvePanelAuth } from './auth.js';

describe('resolvePanelAuth (rol + tenant)', () => {
  it('owner: usa su propia empresa e IGNORA el tenantId pedido', () => {
    expect(resolvePanelAuth({ role: 'TENANT_OWNER', tenantId: 'perfumeria' }, 'otra-empresa')).toEqual({
      ok: true,
      tenantId: 'perfumeria',
    });
  });

  it('manager: su empresa', () => {
    expect(resolvePanelAuth({ role: 'TENANT_MANAGER', tenantId: 'perfumeria' })).toEqual({ ok: true, tenantId: 'perfumeria' });
  });

  it('platform admin: opera la empresa pedida', () => {
    expect(resolvePanelAuth({ role: 'PLATFORM_ADMIN' }, 'boutique')).toEqual({ ok: true, tenantId: 'boutique' });
  });

  it('platform admin SIN tenantId: invalid-argument', () => {
    const r = resolvePanelAuth({ role: 'PLATFORM_ADMIN' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-argument');
  });

  it('vendedor: denegado', () => {
    const r = resolvePanelAuth({ role: 'SELLER', tenantId: 'perfumeria' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('permission-denied');
  });

  it('lector: denegado', () => {
    expect(resolvePanelAuth({ role: 'TENANT_VIEWER', tenantId: 'perfumeria' }).ok).toBe(false);
  });

  it('owner sin empresa asignada: denegado', () => {
    expect(resolvePanelAuth({ role: 'TENANT_OWNER' }).ok).toBe(false);
  });

  it('sin rol: denegado', () => {
    expect(resolvePanelAuth({}).ok).toBe(false);
  });
});
