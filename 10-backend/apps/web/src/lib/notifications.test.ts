import { describe, it, expect } from 'vitest';
import type { Notification, TrialNotificationType } from '@vpw/shared';
import { selectUnreadSorted } from './notifications';

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
