import { describe, it, expect } from 'vitest';
import { getTrialState, isTrialExpired, trialDaysLeft, formatTrialStatus, toMillis } from './trial';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

describe('toMillis — normaliza formatos de fecha', () => {
  it('number(ms) / Date / ISO string', () => {
    expect(toMillis(NOW)).toBe(NOW);
    expect(toMillis(new Date(NOW))).toBe(NOW);
    expect(toMillis(new Date(NOW).toISOString())).toBe(NOW);
  });
  it('Firestore Timestamp (toMillis y {seconds})', () => {
    expect(toMillis({ toMillis: () => NOW })).toBe(NOW);
    expect(toMillis({ seconds: NOW / 1000, nanoseconds: 0 })).toBe(NOW);
    expect(toMillis({ _seconds: NOW / 1000 })).toBe(NOW);
  });
  it('valores inválidos → null', () => {
    expect(toMillis(null)).toBeNull();
    expect(toMillis(undefined)).toBeNull();
    expect(toMillis('no-fecha')).toBeNull();
    expect(toMillis({})).toBeNull();
  });
});

describe('getTrialState — edge cases', () => {
  it('plan pago → no es trial', () => {
    expect(getTrialState({ planId: 'growth', trialEndsAt: NOW + 5 * DAY }, NOW).isTrial).toBe(false);
  });
  it('demo → no es trial', () => {
    expect(getTrialState({ planId: 'free', isDemo: true, trialEndsAt: NOW + 5 * DAY }, NOW).isTrial).toBe(false);
  });
  it('legacy free sin trialEndsAt → no es trial (no bloquea)', () => {
    expect(getTrialState({ planId: 'free' }, NOW)).toMatchObject({ isTrial: false, expired: false });
  });
  it('free con trial futuro → activo, daysLeft redondea hacia arriba', () => {
    const s = getTrialState({ planId: 'free', trialEndsAt: NOW + 7 * DAY }, NOW);
    expect(s).toMatchObject({ isTrial: true, expired: false, daysLeft: 7 });
    expect(s.endsAt).toBeInstanceOf(Date);
  });
  it('menos de un día restante → daysLeft 1 (último día)', () => {
    expect(getTrialState({ planId: 'free', trialEndsAt: NOW + 0.5 * DAY }, NOW).daysLeft).toBe(1);
  });
  it('free con trial vencido → expired, daysLeft 0', () => {
    expect(getTrialState({ planId: 'free', trialEndsAt: NOW - DAY }, NOW)).toMatchObject({ isTrial: true, expired: true, daysLeft: 0 });
  });
});

describe('isTrialExpired / trialDaysLeft', () => {
  it('reflejan el estado', () => {
    expect(isTrialExpired({ planId: 'free', trialEndsAt: NOW - DAY }, NOW)).toBe(true);
    expect(isTrialExpired({ planId: 'free', trialEndsAt: NOW + DAY }, NOW)).toBe(false);
    expect(isTrialExpired({ planId: 'growth', trialEndsAt: NOW - DAY }, NOW)).toBe(false);
    expect(trialDaysLeft({ planId: 'free', trialEndsAt: NOW + 3 * DAY }, NOW)).toBe(3);
  });
});

describe('formatTrialStatus — textos para el owner', () => {
  it('plan pago / legacy → null (sin banner)', () => {
    expect(formatTrialStatus({ planId: 'growth' }, NOW)).toBeNull();
    expect(formatTrialStatus({ planId: 'free' }, NOW)).toBeNull();
  });
  it('activo (varios días)', () => {
    expect(formatTrialStatus({ planId: 'free', trialEndsAt: NOW + 5 * DAY }, NOW)).toBe('Tu prueba gratis termina en 5 días.');
  });
  it('último día', () => {
    expect(formatTrialStatus({ planId: 'free', trialEndsAt: NOW + 0.5 * DAY }, NOW)).toBe('Tu prueba gratis termina hoy.');
  });
  it('vencido', () => {
    expect(formatTrialStatus({ planId: 'free', trialEndsAt: NOW - DAY }, NOW)).toBe('Tu prueba gratis terminó. Activá un plan para seguir usando la plataforma.');
  });
});
