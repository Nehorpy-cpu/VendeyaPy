import { describe, it, expect } from 'vitest';
import type { Notification, TrialNotificationType } from '@vpw/shared';
import { selectUnreadSorted, notificationsScopeFor, notificationQuerySpecsFor } from './notifications';

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

describe('notificationsScopeFor — alcance de la campana por rol (COVERAGE-1C + QUALITY-1)', () => {
  it('owner y admin ven todo (incl. trial/billing)', () => {
    expect(notificationsScopeFor({ role: 'TENANT_OWNER', uid: 'u1' })).toEqual({ kind: 'all' });
    expect(notificationsScopeFor({ role: 'PLATFORM_ADMIN', uid: 'u1' })).toEqual({ kind: 'all' });
  });
  it('manager: handoff Y catalog_quality — EXACTAMENTE las categorías que permiten las rules', () => {
    expect(notificationsScopeFor({ role: 'TENANT_MANAGER', uid: 'u1' })).toEqual({
      kind: 'categories',
      categories: ['handoff', 'catalog_quality'],
    });
  });
  it('manager: NO se amplían billing/finanzas ni otras categorías', () => {
    const scope = notificationsScopeFor({ role: 'TENANT_MANAGER', uid: 'u1' });
    expect(scope.kind).toBe('categories');
    const cats = scope.kind === 'categories' ? scope.categories : [];
    expect(cats).not.toContain('trial');
    expect(cats).toHaveLength(2);
  });
  it('seller: SOLO handoff dirigidos a su uid; sin uid → nada', () => {
    expect(notificationsScopeFor({ role: 'SELLER', uid: 'seller-1' })).toEqual({ kind: 'handoff-target', uid: 'seller-1' });
    expect(notificationsScopeFor({ role: 'SELLER', uid: null })).toEqual({ kind: 'none' });
  });
  it('otros roles: nada', () => {
    expect(notificationsScopeFor({ role: 'TENANT_VIEWER', uid: 'u1' })).toEqual({ kind: 'none' });
  });
});

describe('notificationQuerySpecsFor — queries EXACTAS permitidas por las rules por rol', () => {
  it('owner/admin: una sola query sin filtros (lee todo lo del tenant)', () => {
    expect(notificationQuerySpecsFor(notificationsScopeFor({ role: 'TENANT_OWNER', uid: 'u1' }))).toEqual([
      { filters: [] },
    ]);
  });
  it('manager: una query de IGUALDAD por categoría (nunca `in`: una categoría denegada rompería TODA la lectura)', () => {
    const specs = notificationQuerySpecsFor(notificationsScopeFor({ role: 'TENANT_MANAGER', uid: 'u1' }));
    expect(specs).toEqual([
      { filters: [['category', 'handoff']] },
      { filters: [['category', 'catalog_quality']] },
    ]);
  });
  it('manager: la query de handoff NO filtra por targetUid (hoy lee también los dirigidos — las rules lo permiten; sin cambios)', () => {
    const specs = notificationQuerySpecsFor(notificationsScopeFor({ role: 'TENANT_MANAGER', uid: 'u1' }));
    const handoff = specs.find((s) => s.filters.some(([campo, valor]) => campo === 'category' && valor === 'handoff'));
    expect(handoff).toBeDefined();
    expect(handoff!.filters.some(([campo]) => campo === 'targetUid')).toBe(false);
  });
  it('manager: ninguna query pide categorías financieras/privadas ni queda sin acotar', () => {
    const specs = notificationQuerySpecsFor(notificationsScopeFor({ role: 'TENANT_MANAGER', uid: 'u1' }));
    for (const s of specs) {
      expect(s.filters.length).toBeGreaterThan(0); // jamás una query "todo" para manager
      const cat = s.filters.find(([campo]) => campo === 'category');
      expect(cat).toBeDefined();
      expect(['handoff', 'catalog_quality']).toContain(cat![1]);
    }
  });
  it('seller dirigido: UNA query handoff + targetUid == su uid (ve la suya, nada más)', () => {
    const specs = notificationQuerySpecsFor(notificationsScopeFor({ role: 'SELLER', uid: 'seller-1' }));
    expect(specs).toEqual([
      { filters: [['category', 'handoff'], ['targetUid', 'seller-1']] },
    ]);
  });
  it('seller: NO recibe catalog_quality ni ninguna otra ampliación', () => {
    const specs = notificationQuerySpecsFor(notificationsScopeFor({ role: 'SELLER', uid: 'seller-1' }));
    expect(specs.some((s) => s.filters.some(([, valor]) => valor === 'catalog_quality'))).toBe(false);
  });
  it('seller sin uid y roles sin acceso: cero queries', () => {
    expect(notificationQuerySpecsFor(notificationsScopeFor({ role: 'SELLER', uid: null }))).toEqual([]);
    expect(notificationQuerySpecsFor(notificationsScopeFor({ role: 'TENANT_VIEWER', uid: 'u1' }))).toEqual([]);
  });
});
