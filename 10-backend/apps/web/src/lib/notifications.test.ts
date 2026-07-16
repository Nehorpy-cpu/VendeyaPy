import { describe, it, expect } from 'vitest';
import type { Notification, TrialNotificationType } from '@vpw/shared';
import { selectUnreadSorted, notificationsScopeFor } from './notifications';

// Objeto mínimo: selectUnreadSorted solo usa `id`, `type` y `read`.
const n = (type: TrialNotificationType, read = false): Notification => ({ id: type, type, read } as unknown as Notification);

describe('selectUnreadSorted', () => {
  it('filtra las leídas', () => {
    const out = selectUnreadSorted([n('trial_expired', true), n('trial_ending_soon', false)]);
    expect(out.map((x) => x.type)).toEqual(['trial_ending_soon']);
  });
  it('ordena por urgencia: vencido > hoy > por vencer', () => {
    const out = selectUnreadSorted([n('trial_ending_soon'), n('trial_expired'), n('trial_ending_today')]);
    expect(out.map((x) => x.type)).toEqual(['trial_expired', 'trial_ending_today', 'trial_ending_soon']);
  });
  it('lista vacía / todas leídas → []', () => {
    expect(selectUnreadSorted([])).toEqual([]);
    expect(selectUnreadSorted([n('trial_expired', true)])).toEqual([]);
  });
});

describe('notificationsScopeFor — alcance de la campana por rol (COVERAGE-1C)', () => {
  it('owner y admin ven todo (incl. trial/billing)', () => {
    expect(notificationsScopeFor({ role: 'TENANT_OWNER', uid: 'u1' })).toEqual({ kind: 'all' });
    expect(notificationsScopeFor({ role: 'PLATFORM_ADMIN', uid: 'u1' })).toEqual({ kind: 'all' });
  });
  it('manager: SOLO categoría handoff (no se amplía billing/finanzas)', () => {
    expect(notificationsScopeFor({ role: 'TENANT_MANAGER', uid: 'u1' })).toEqual({ kind: 'handoff' });
  });
  it('seller: SOLO handoff dirigidos a su uid; sin uid → nada', () => {
    expect(notificationsScopeFor({ role: 'SELLER', uid: 'seller-1' })).toEqual({ kind: 'handoff-target', uid: 'seller-1' });
    expect(notificationsScopeFor({ role: 'SELLER', uid: null })).toEqual({ kind: 'none' });
  });
  it('otros roles: nada', () => {
    expect(notificationsScopeFor({ role: 'TENANT_VIEWER', uid: 'u1' })).toEqual({ kind: 'none' });
  });
});
