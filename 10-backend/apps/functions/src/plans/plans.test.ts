import { describe, it, expect } from 'vitest';
import type { PlanFeatures } from '@vpw/shared';
import { DEFAULT_PLANS } from './plans.js';

const byId = Object.fromEntries(DEFAULT_PLANS.map((p) => [p.id, p]));

describe('plans/DEFAULT_PLANS — matriz oficial congelada (PLAN-LIMITS-2)', () => {
  it('mantiene los IDs internos (no romper billing/webhooks/tenants)', () => {
    expect(DEFAULT_PLANS.map((p) => p.id)).toEqual(['free', 'starter', 'growth', 'pro', 'enterprise']);
  });

  it('etiquetas comerciales: free=Prueba gratis · starter=Básico · growth=Pro · pro=Max · enterprise=Enterprise', () => {
    expect(byId.free.name).toBe('Prueba gratis');
    expect(byId.starter.name).toBe('Básico');
    expect(byId.growth.name).toBe('Pro');
    expect(byId.pro.name).toBe('Max');
    expect(byId.enterprise.name).toBe('Enterprise');
  });

  it('precios comerciales en guaraníes (pricePygPerMonth)', () => {
    expect(byId.free.pricePygPerMonth).toBe(0);
    expect(byId.starter.pricePygPerMonth).toBe(150_000);
    expect(byId.growth.pricePygPerMonth).toBe(350_000);
    expect(byId.pro.pricePygPerMonth).toBe(650_000);
    expect(byId.enterprise.pricePygPerMonth).toBe(0);
  });

  it('solo se prenden las features REALMENTE enforceadas; pago/facturación/multicanal/priority quedan false (no se venden como disponibles)', () => {
    expect(byId.free.features.aiAssistant).toBe(false);
    expect(byId.starter.features.aiAssistant).toBe(true); // Básico+
    expect(byId.starter.features.marketingAutomation).toBe(false);
    expect(byId.growth.features.aiAssistant).toBe(true);
    expect(byId.growth.features.marketingAutomation).toBe(true); // Pro+
    expect(byId.pro.features.marketingAutomation).toBe(true);
    expect(byId.enterprise.features.marketingAutomation).toBe(true);
    // Features aún sin gate funcional (PLAN-LIMITS-3): false en TODOS los planes.
    const NOT_YET: (keyof PlanFeatures)[] = ['bancard', 'stripe', 'localWallets', 'electronicInvoicing', 'multiChannel', 'prioritySupport'];
    for (const p of DEFAULT_PLANS) for (const f of NOT_YET) expect(p.features[f]).toBe(false);
  });

  it('los límites NO cambian respecto a la auditoría (solo nombres/precios/features)', () => {
    expect(byId.starter.limits.maxAiTokensPerMonth).toBe(50_000);
    expect(byId.growth.limits.maxWhatsappMessagesPerMonth).toBe(20_000);
    expect(byId.pro.limits.maxProducts).toBe(10_000);
    expect(byId.free.limits.maxAiTokensPerMonth).toBe(0);
  });
});
