import { describe, it, expect } from 'vitest';
import { normalizeCatalogSyncConfig, CATALOG_SYNC_DISABLED } from './catalogSyncConfig.js';
import { OWNERSHIP_DEGRADED } from './catalogOwnership.js';

/**
 * META-CATALOG-LIVE-1 — la config es FAIL-CLOSED: cualquier forma inválida, parcial o
 * ausente ⇒ apagada. Un tenant sin config (credipower) JAMÁS sincroniza.
 *
 * (ADR-0015) La config normalizada ahora TRAE la propiedad por campos ya normalizada. Son dos
 * niveles independientes: el de acá (nivel 1) apaga la sincronización entera; el de `ownership`
 * (nivel 2) deja leer y diagnosticar pero no escribir. `sourceOfTruth` quedó como literal
 * LEGACY sin efecto: era decorativo y su valor "legal" era falso para arfagi.
 */
describe('normalizeCatalogSyncConfig (fail-closed)', () => {
  const VALID = { enabled: true, mode: 'dry_run', catalogId: '123456789', sourceOfTruth: 'vendeyapy' };

  it('config válida en dry_run pasa tal cual, con la propiedad degradada mientras nadie la declare', () => {
    expect(normalizeCatalogSyncConfig(VALID)).toEqual({
      enabled: true,
      mode: 'dry_run',
      catalogId: '123456789',
      sourceOfTruth: 'vendeyapy',
      ownership: { ...OWNERSHIP_DEGRADED, writable: [], external: [], reasons: ['ownership_missing'] },
    });
  });

  it('config válida en live pasa tal cual (y recorta espacios del catalogId)', () => {
    const r = normalizeCatalogSyncConfig({ ...VALID, mode: 'live', catalogId: ' 123456789 ' });
    expect(r.enabled).toBe(true);
    expect(r.mode).toBe('live');
    expect(r.catalogId).toBe('123456789');
    // Nivel 2: sin `ownership` declarada NO hay un solo campo escribible, aunque diga 'live'.
    expect(r.ownership.degraded).toBe(true);
    expect(r.ownership.writable).toEqual([]);
    expect(r.ownership.modeCeiling).toBe('dry_run');
  });

  it('con `ownership` declarada y válida, la config la trae normalizada', () => {
    const r = normalizeCatalogSyncConfig({
      ...VALID,
      ownership: { model: 'vendeyapy_managed', ownedFields: ['price', 'title'], external: null },
    });
    expect(r.enabled).toBe(true);
    expect(r.ownership.degraded).toBe(false);
    expect(r.ownership.model).toBe('vendeyapy_managed');
    expect(r.ownership.writable).toEqual(['title', 'price']); // canónica, en el orden del contrato
    expect(r.ownership.modeCeiling).toBe('live');
  });

  it.each([
    ['sourceOfTruth ausente (documento legacy)', { enabled: true, mode: 'dry_run', catalogId: '1' }],
    ['sourceOfTruth invertida (meta)', { ...VALID, sourceOfTruth: 'meta' }],
  ])('%s: la sync sigue ENCENDIDA pero sin permiso de escritura (el literal ya no gobierna)', (_label, raw) => {
    // Antes, cualquier `sourceOfTruth` distinto de 'vendeyapy' apagaba la sync entera y el
    // valor "correcto" habilitaba escrituras que nadie había autorizado. Ahora el literal no
    // decide nada: la autoridad vive en `ownership`, que sin declarar deja cero campos.
    const r = normalizeCatalogSyncConfig(raw);
    expect(r.enabled).toBe(true);
    expect(r.ownership.degraded).toBe(true);
    expect(r.ownership.writable).toEqual([]);
    expect(r.ownership.reasons).toEqual(['ownership_missing']);
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

  it('la config apagada canónica queda con mode off, sin catalogId y sin propiedad', () => {
    expect(CATALOG_SYNC_DISABLED).toEqual({
      enabled: false,
      mode: 'off',
      catalogId: '',
      sourceOfTruth: 'vendeyapy',
      ownership: OWNERSHIP_DEGRADED,
    });
  });
});
