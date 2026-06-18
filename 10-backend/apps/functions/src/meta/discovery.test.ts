import { describe, it, expect } from 'vitest';
import { buildMetaAssets } from './discovery.js';
import type { MetaPhoneNumber } from './graphClient.js';

const phone = (id: string): MetaPhoneNumber => ({ id, displayPhoneNumber: `+595 ${id}`, verifiedName: 'X', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED' });

describe('buildMetaAssets', () => {
  it('crea business + waba + un asset por número, con el seleccionado marcado', () => {
    const assets = buildMetaAssets({ businessId: 'biz-1', businessName: 'Mi Negocio', wabaId: 'waba-1', phones: [phone('wa-1'), phone('wa-2')], selectedPhoneNumberId: 'wa-2' });
    expect(assets).toHaveLength(4);
    const phones = assets.filter((a) => a.assetType === 'whatsapp_phone_number');
    expect(phones.find((p) => p.externalId === 'wa-2')?.selected).toBe(true);
    expect(phones.find((p) => p.externalId === 'wa-1')?.selected).toBe(false);
    expect(assets.some((a) => a.assetType === 'business' && a.externalId === 'biz-1')).toBe(true);
    expect(assets.some((a) => a.assetType === 'whatsapp_business_account' && a.externalId === 'waba-1')).toBe(true);
  });

  it('sin businessId → no agrega asset business', () => {
    const assets = buildMetaAssets({ wabaId: 'waba-1', phones: [phone('wa-1')], selectedPhoneNumberId: 'wa-1' });
    expect(assets.some((a) => a.assetType === 'business')).toBe(false);
    expect(assets).toHaveLength(2); // waba + 1 phone
  });
});
