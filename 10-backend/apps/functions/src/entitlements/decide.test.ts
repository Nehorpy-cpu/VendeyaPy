import { describe, it, expect } from 'vitest';
import { UNLIMITED, isUnlimited, effectiveLimit, effectiveLimits, isFeatureEnabled, decideQuota, billingPosture, GRACE_MS } from './decide.js';
import type { PlanLimits, PlanFeatures } from '@vpw/shared';

const LIMITS: PlanLimits = { maxProducts: 20, maxOrdersPerMonth: 50, maxWhatsappMessagesPerMonth: 500, maxDeliveryPersons: 2, maxUsers: 2, maxWhatsappNumbers: 1, maxAdSyncsPerMonth: 0, maxAiTokensPerMonth: 0 };
const FEATURES: PlanFeatures = { bancard: false, stripe: false, localWallets: false, electronicInvoicing: false, marketingAutomation: false, multiChannel: false, prioritySupport: false, aiAssistant: false };

describe('límites efectivos', () => {
  it('isUnlimited', () => {
    expect(isUnlimited(UNLIMITED)).toBe(true);
    expect(isUnlimited(20)).toBe(false);
  });
  it('effectiveLimit usa el override si es número (incluido 0)', () => {
    expect(effectiveLimit(20)).toBe(20);
    expect(effectiveLimit(20, 999)).toBe(999);
    expect(effectiveLimit(20, 0)).toBe(0);
  });
  it('effectiveLimits aplica overrides parciales', () => {
    const r = effectiveLimits(LIMITS, { maxProducts: 5, maxUsers: 99 });
    expect(r.maxProducts).toBe(5);
    expect(r.maxUsers).toBe(99);
    expect(r.maxOrdersPerMonth).toBe(50);
  });
});

describe('decideQuota', () => {
  it('permite por debajo del límite y bloquea al alcanzarlo', () => {
    expect(decideQuota(19, 20, 1).allowed).toBe(true);
    expect(decideQuota(20, 20, 1)).toMatchObject({ allowed: false, reason: 'quota_exceeded' });
  });
  it('ilimitado siempre permite', () => {
    expect(decideQuota(5_000, UNLIMITED, 100)).toMatchObject({ allowed: true, unlimited: true });
  });
  it('delta 0 cabe en el borde', () => {
    expect(decideQuota(5, 5, 0).allowed).toBe(true);
  });
});

describe('billingPosture', () => {
  it('active/trialing/none → opera y premium', () => {
    for (const s of ['active', 'trialing', 'none', undefined] as const) {
      expect(billingPosture(s, false)).toMatchObject({ operational: true, premiumAllowed: true });
    }
  });
  it('past_due → opera básico, premium bloqueado (gracia)', () => {
    expect(billingPosture('past_due', false)).toMatchObject({ operational: true, premiumAllowed: false });
  });
  it('canceled / incomplete → premium suspendido, datos preservados (opera)', () => {
    expect(billingPosture('canceled', false)).toMatchObject({ operational: true, premiumAllowed: false });
    expect(billingPosture('incomplete', false)).toMatchObject({ operational: true, premiumAllowed: false });
  });
  it('demo → todo permitido sin importar el estado', () => {
    expect(billingPosture('canceled', true)).toMatchObject({ operational: true, premiumAllowed: true, reason: 'demo' });
  });
});

describe('billingPosture — gracia de past_due (5B)', () => {
  const NOW = 1_700_000_000_000;
  it('sin info de gracia (5A) → premium bloqueado (conservador)', () => {
    expect(billingPosture('past_due', false)).toMatchObject({ premiumAllowed: false, reason: 'past_due' });
  });
  it('past_due DENTRO de la gracia → premium permitido', () => {
    const r = billingPosture('past_due', false, { nowMs: NOW, pastDueSinceMs: NOW - 2 * 86_400_000 });
    expect(r).toMatchObject({ operational: true, premiumAllowed: true, reason: 'past_due_grace' });
  });
  it('past_due FUERA de la gracia (>7 días) → premium bloqueado, cuenta operativa', () => {
    const r = billingPosture('past_due', false, { nowMs: NOW, pastDueSinceMs: NOW - GRACE_MS - 1000 });
    expect(r).toMatchObject({ operational: true, premiumAllowed: false, reason: 'past_due_expired' });
  });
});

describe('isFeatureEnabled', () => {
  it('refleja el flag del plan', () => {
    expect(isFeatureEnabled(FEATURES, 'aiAssistant')).toBe(false);
    expect(isFeatureEnabled({ ...FEATURES, marketingAutomation: true }, 'marketingAutomation')).toBe(true);
  });
});
