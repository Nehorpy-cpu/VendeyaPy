/**
 * viewerAuth.test.ts — Quién puede pedir el archivo de un adjunto (área C, ADR-0016 §6).
 * Cubre: anónimo denegado, cross-tenant imposible, roles REALES del sistema.
 */
import { describe, it, expect } from 'vitest';
import { resolveAttachmentViewerAuth } from './viewerAuth.js';

const T = 'arfagi';
const OTRO = 'credipower';

describe('resolveAttachmentViewerAuth', () => {
  it('anónimo (sin token) → unauthenticated', () => {
    expect(resolveAttachmentViewerAuth(null)).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(resolveAttachmentViewerAuth(undefined, T)).toMatchObject({ ok: false, code: 'unauthenticated' });
  });

  it('staff del tenant (owner/manager/seller) puede', () => {
    for (const role of ['TENANT_OWNER', 'TENANT_MANAGER', 'SELLER']) {
      expect(resolveAttachmentViewerAuth({ role, tenantId: T })).toEqual({ ok: true, tenantId: T, role });
    }
  });

  it('TENANT_VIEWER y roles desconocidos NO pueden abrir archivos de clientes', () => {
    for (const role of ['TENANT_VIEWER', 'DELIVERY_PERSON', 'ADMIN', '', 'tenant_owner']) {
      expect(resolveAttachmentViewerAuth({ role, tenantId: T })).toMatchObject({
        ok: false,
        code: 'permission-denied',
      });
    }
  });

  it('cross-tenant: el tenantId pedido se IGNORA y manda el del claim', () => {
    const r = resolveAttachmentViewerAuth({ role: 'SELLER', tenantId: T }, OTRO);
    expect(r).toEqual({ ok: true, tenantId: T, role: 'SELLER' });
  });

  it('staff sin empresa asignada → permission-denied', () => {
    expect(resolveAttachmentViewerAuth({ role: 'TENANT_OWNER' })).toMatchObject({
      ok: false,
      code: 'permission-denied',
    });
  });

  it('PLATFORM_ADMIN necesita indicar la empresa explícitamente', () => {
    expect(resolveAttachmentViewerAuth({ role: 'PLATFORM_ADMIN' })).toMatchObject({
      ok: false,
      code: 'invalid-argument',
    });
    expect(resolveAttachmentViewerAuth({ role: 'PLATFORM_ADMIN' }, '   ')).toMatchObject({
      ok: false,
      code: 'invalid-argument',
    });
    expect(resolveAttachmentViewerAuth({ role: 'PLATFORM_ADMIN' }, OTRO)).toEqual({
      ok: true,
      tenantId: OTRO,
      role: 'PLATFORM_ADMIN',
    });
  });
});
