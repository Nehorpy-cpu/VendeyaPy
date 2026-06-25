import { describe, it, expect } from 'vitest';
import { computeTrialNotificationState, buildTrialNotificationContent } from './trialNotifications.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const ts = (ms: number) => ({ toMillis: () => ms }); // simula Firestore Timestamp
const freeTrial = (endsMs: number, over = {}) => ({ planId: 'free', subscription: { status: 'none' }, trial: { endsAt: ts(endsMs) }, ...over });

describe('computeTrialNotificationState — umbrales', () => {
  it('5 días restantes → ninguna notificación', () => {
    expect(computeTrialNotificationState(freeTrial(NOW + 5 * DAY), NOW)).toBeNull();
  });
  it('3 días restantes → trial_ending_soon', () => {
    expect(computeTrialNotificationState(freeTrial(NOW + 3 * DAY), NOW)).toMatchObject({ type: 'trial_ending_soon', daysLeft: 3 });
  });
  it('2 días restantes → trial_ending_soon', () => {
    expect(computeTrialNotificationState(freeTrial(NOW + 2 * DAY), NOW)?.type).toBe('trial_ending_soon');
  });
  it('menos de un día (termina hoy) → trial_ending_today', () => {
    expect(computeTrialNotificationState(freeTrial(NOW + 0.5 * DAY), NOW)).toMatchObject({ type: 'trial_ending_today', daysLeft: 1 });
  });
  it('vencido → trial_expired', () => {
    expect(computeTrialNotificationState(freeTrial(NOW - DAY), NOW)).toMatchObject({ type: 'trial_expired', daysLeft: 0 });
  });
});

describe('computeTrialNotificationState — exclusiones', () => {
  it('plan pago → ninguna', () => {
    expect(computeTrialNotificationState({ planId: 'growth', trial: { endsAt: ts(NOW - DAY) } }, NOW)).toBeNull();
  });
  it('demo → ninguna', () => {
    expect(computeTrialNotificationState(freeTrial(NOW - DAY, { isDemo: true }), NOW)).toBeNull();
  });
  it('suspendido / borrado → ninguna', () => {
    expect(computeTrialNotificationState(freeTrial(NOW - DAY, { status: 'SUSPENDED' }), NOW)).toBeNull();
    expect(computeTrialNotificationState(freeTrial(NOW - DAY, { deletedAt: ts(NOW) }), NOW)).toBeNull();
  });
  it('con suscripción (active/canceled) → ninguna', () => {
    expect(computeTrialNotificationState(freeTrial(NOW - DAY, { subscription: { status: 'active' } }), NOW)).toBeNull();
    expect(computeTrialNotificationState(freeTrial(NOW - DAY, { subscription: { status: 'canceled' } }), NOW)).toBeNull();
  });
  it('free legacy sin trial → ninguna', () => {
    expect(computeTrialNotificationState({ planId: 'free', subscription: { status: 'none' } }, NOW)).toBeNull();
  });
  it('endsAt como number también funciona', () => {
    expect(computeTrialNotificationState({ planId: 'free', trial: { endsAt: NOW - DAY } }, NOW)?.type).toBe('trial_expired');
  });
});

describe('buildTrialNotificationContent — sin tecnicismos ni PII', () => {
  it('soon incluye los días', () => {
    expect(buildTrialNotificationContent({ type: 'trial_ending_soon', daysLeft: 3 }).body).toContain('3 días');
  });
  it('today / expired tienen título claro y CTA', () => {
    expect(buildTrialNotificationContent({ type: 'trial_ending_today', daysLeft: 1 }).title).toMatch(/termina hoy/i);
    expect(buildTrialNotificationContent({ type: 'trial_expired', daysLeft: 0 }).title).toMatch(/terminó/i);
  });
  it('ningún texto filtra detalles técnicos', () => {
    for (const t of ['trial_ending_soon', 'trial_ending_today', 'trial_expired']) {
      const c = buildTrialNotificationContent({ type: t, daysLeft: 2 });
      expect(`${c.title} ${c.body}`).not.toMatch(/trialExpired|quota|failed-precondition|resource-exhausted/i);
    }
  });
});
