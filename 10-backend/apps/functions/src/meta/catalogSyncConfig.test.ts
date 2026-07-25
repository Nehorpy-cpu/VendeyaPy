import { describe, it, expect } from 'vitest';
import { normalizeCatalogSyncConfig, CATALOG_SYNC_DISABLED } from './catalogSyncConfig.js';

/**
 * META-CATALOG-LIVE-1 — la config es FAIL-CLOSED: cualquier forma inválida, parcial o
 * ausente ⇒ apagada. Un tenant sin config (credipower) JAMÁS sincroniza.
 */
describe('normalizeCatalogSyncConfig (fail-closed)', () => {
  const VALID = { enabled: true, mode: 'dry_run', catalogId: '123456789', sourceOfTruth: 'vendeyapy' };

  it('config válida en dry_run pasa tal cual', () => {
    expect(normalizeCatalogSyncConfig(VALID)).toEqual({ enabled: true, mode: 'dry_run', catalogId: '123456789', sourceOfTruth: 'vendeyapy' });
  });

  it('config válida en live pasa tal cual (y recorta espacios del catalogId)', () => {
    expect(normalizeCatalogSyncConfig({ ...VALID, mode: 'live', catalogId: ' 123456789 ' })).toEqual({ enabled: true, mode: 'live', catalogId: '123456789', sourceOfTruth: 'vendeyapy' });
  });

  it.each([
    ['undefined (tenant sin config, ej. credipower)', undefined],
    ['null', null],
    ['string', 'enabled'],
    ['array', [1]],
    ['objeto vacío', {}],
    ['enabled ausente', { mode: 'dry_run', catalogId: '1', sourceOfTruth: 'vendeyapy' }],
    ['enabled false', { ...VALID, enabled: false }],
    ['enabled truthy no booleano', { ...VALID, enabled: 'true' }],
    ['mode off explícito', { ...VALID, mode: 'off' }],
    ['mode inválido', { ...VALID, mode: 'apply' }],
    ['mode ausente', { enabled: true, catalogId: '1', sourceOfTruth: 'vendeyapy' }],
    ['sourceOfTruth ausente', { enabled: true, mode: 'dry_run', catalogId: '1' }],
    ['sourceOfTruth invertida (meta)', { ...VALID, sourceOfTruth: 'meta' }],
    ['catalogId ausente', { enabled: true, mode: 'dry_run', sourceOfTruth: 'vendeyapy' }],
    ['catalogId vacío', { ...VALID, catalogId: '' }],
    ['catalogId solo espacios', { ...VALID, catalogId: '   ' }],
    ['catalogId con slash (rompería la URL del Graph)', { ...VALID, catalogId: '123/456' }],
    ['catalogId con espacios internos', { ...VALID, catalogId: '123 456' }],
    ['catalogId demasiado largo', { ...VALID, catalogId: 'x'.repeat(65) }],
    ['catalogId numérico (no string)', { ...VALID, catalogId: 123456789 }],
  ])('%s ⇒ apagada', (_label, raw) => {
    expect(normalizeCatalogSyncConfig(raw)).toEqual(CATALOG_SYNC_DISABLED);
  });

  it('la config apagada canónica queda con mode off y sin catalogId', () => {
    expect(CATALOG_SYNC_DISABLED).toEqual({ enabled: false, mode: 'off', catalogId: '', sourceOfTruth: 'vendeyapy' });
  });
});
