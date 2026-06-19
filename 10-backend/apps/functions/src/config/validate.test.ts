import { describe, it, expect } from 'vitest';
import { validateAgentConfigPatch, validateCheckoutConfig, validateChannelConfig } from './validate.js';

describe('validateAgentConfigPatch', () => {
  it('acepta solo campos permitidos (whitelist) y descarta los demás', () => {
    const r = validateAgentConfigPatch({ agentName: 'Sofía', botEnabled: false, planId: 'pro', limits: { x: 1 } });
    expect(r).toEqual({ agentName: 'Sofía', botEnabled: false });
    expect(r).not.toHaveProperty('planId');
    expect(r).not.toHaveProperty('limits');
  });
  it('valida tipos y faq', () => {
    expect(validateAgentConfigPatch({ faq: [{ q: 'a', a: 'b' }] })).toEqual({ faq: [{ q: 'a', a: 'b' }] });
    expect(() => validateAgentConfigPatch({ botEnabled: 'no' })).toThrow();
    expect(() => validateAgentConfigPatch({ faq: [{ q: 'a' }] })).toThrow();
  });
  it('rechaza payload sin campos válidos', () => {
    expect(() => validateAgentConfigPatch({})).toThrow();
    expect(() => validateAgentConfigPatch({ noExiste: 1 })).toThrow();
  });
});

describe('validateCheckoutConfig', () => {
  it('valida estructura de bancos y vendedores', () => {
    const r = validateCheckoutConfig({
      bankAccounts: [{ bank: 'Itaú', accountNumber: '123', holder: 'Marco', document: '111', alias: 'mi-alias' }],
      sellers: [{ name: 'Ana', whatsapp: '+595981111111', active: true }],
    });
    expect(r.bankAccounts).toHaveLength(1);
    expect(r.bankAccounts[0]).toMatchObject({ bank: 'Itaú', alias: 'mi-alias' });
    expect(r.sellers[0]).toMatchObject({ name: 'Ana', active: true });
  });
  it('defaults a [] si faltan listas; rechaza estructuras inválidas', () => {
    expect(validateCheckoutConfig({})).toEqual({ bankAccounts: [], sellers: [] });
    expect(() => validateCheckoutConfig({ bankAccounts: [{ bank: 'X' }] })).toThrow();
    expect(() => validateCheckoutConfig({ sellers: [{ name: 'Ana', whatsapp: '1', active: 'si' }] })).toThrow();
  });
});

describe('validateChannelConfig', () => {
  it("acepta 'mock' o 'live'", () => {
    expect(validateChannelConfig({ whatsappSendMode: 'mock' })).toEqual({ whatsappSendMode: 'mock' });
    expect(validateChannelConfig({ whatsappSendMode: 'live' })).toEqual({ whatsappSendMode: 'live' });
  });
  it('rechaza valores inválidos', () => {
    expect(() => validateChannelConfig({ whatsappSendMode: 'on' })).toThrow();
    expect(() => validateChannelConfig({})).toThrow();
  });
});
