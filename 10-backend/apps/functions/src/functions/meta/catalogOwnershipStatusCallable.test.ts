import { describe, it, expect, vi } from 'vitest';

/**
 * ADR-0015 §1/§2 — Contrato del callable `metaCatalogOwnershipStatus` (hallazgo de revisión).
 *
 * El panel ya llamaba a este nombre, pero el callable NO existía: toda invocación fallaba, la
 * tarjeta de propiedad quedaba en error permanente y el bloqueo del opt-in que se apoya en ella
 * quedaba FAIL-OPEN ("no pude leer la propiedad" se comportaba igual que "está todo bien").
 *
 * Estos tests fijan el contrato exacto que consume el panel y la regla de higiene: lo que sale
 * es metadata SANEADA — jamás la URL del feed, su query string ni un token.
 */
vi.mock('../../lib/firebase.js', () => ({ db: () => ({}), paths: {} }));

import { buildCatalogOwnershipStatus } from './catalogOwnershipStatusCallable.js';
import { WRITABLE_FIELDS } from '../../meta/catalogOwnership.js';

/** Config real de arfagi después de la migración: el feed del sitio gobierna todo, dry_run. */
const externaValida = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  mode: 'dry_run',
  catalogId: 'CAT-1',
  ownership: {
    model: 'external_managed',
    ownedFields: [],
    external: {
      kind: 'meta_feed',
      acknowledgedSourceIds: ['ds-1'],
      declaredFields: [],
      fingerprint: 'meta_feed:ds-1|tienda.test|03:33',
      acknowledgedByUid: 'uid-owner',
      acknowledgedAt: { seconds: 1_700_000_000, nanoseconds: 0 },
    },
    lastSourceCheckAt: { seconds: 1_700_000_100, nanoseconds: 0 },
  },
  ...over,
});

describe('buildCatalogOwnershipStatus — contrato del panel', () => {
  it('external_managed reconocido: cero campos escribibles, techo dry_run y la fuente saneada', () => {
    const r = buildCatalogOwnershipStatus(externaValida());
    expect(r.ok).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.configMode).toBe('dry_run');
    expect(r.effectiveMode).toBe('dry_run');
    expect(r.ownership.model).toBe('external_managed');
    expect(r.ownership.degraded).toBe(false);
    expect(r.ownership.writable).toEqual([]);
    // Bajo este modelo el gobierno externo abarca TODOS los campos públicos.
    expect(r.ownership.external).toEqual([...WRITABLE_FIELDS]);
    expect(r.ownership.externalSource?.acknowledgedSourceIds).toEqual(['ds-1']);
    expect(r.hasWritableFields).toBe(false);
    expect(r.lastSourceCheckAt).toBe(1_700_000_100_000);
    // El status NO dispara la detección: no gasta una sola llamada a Graph.
    expect(r.detectedSources).toEqual([]);
  });

  it('mode:live con techo dry_run ⇒ el modo EFECTIVO que ve el panel es dry_run', () => {
    const r = buildCatalogOwnershipStatus(externaValida({ mode: 'live' }));
    expect(r.configMode).toBe('live');
    expect(r.effectiveMode).toBe('dry_run');
  });

  it('documento LEGACY (solo sourceOfTruth) ⇒ degradado, cero escribibles y el motivo visible', () => {
    // Sin este callable el panel no podía distinguir esto de "todo bien": el bloqueo del opt-in
    // se apoya justamente en ver `degraded` y `hasWritableFields:false`.
    const r = buildCatalogOwnershipStatus({ enabled: true, mode: 'live', catalogId: 'CAT-1', sourceOfTruth: 'vendeyapy' });
    expect(r.ownership.degraded).toBe(true);
    expect(r.ownership.reasons).toContain('ownership_missing');
    expect(r.ownership.writable).toEqual([]);
    expect(r.hasWritableFields).toBe(false);
    expect(r.effectiveMode).toBe('dry_run');
  });

  it('tenant SIN config de catálogo (credipower) ⇒ apagado, sin propiedad y sin escribibles', () => {
    for (const raw of [undefined, null, {}, 'texto', { enabled: false }]) {
      const r = buildCatalogOwnershipStatus(raw);
      expect(r.enabled).toBe(false);
      expect(r.configMode).toBe('off');
      expect(r.effectiveMode).toBe('off');
      expect(r.ownership.degraded).toBe(true);
      expect(r.hasWritableFields).toBe(false);
      expect(r.lastSourceCheckAt).toBeNull();
    }
  });

  it('vendeyapy_managed declarado ⇒ campos escribibles y techo live', () => {
    const r = buildCatalogOwnershipStatus({
      enabled: true,
      mode: 'live',
      catalogId: 'CAT-1',
      ownership: { model: 'vendeyapy_managed', ownedFields: ['price', 'title'], external: null },
    });
    expect(r.ownership.model).toBe('vendeyapy_managed');
    expect(r.ownership.writable).toEqual(['title', 'price']);
    expect(r.hasWritableFields).toBe(true);
    expect(r.effectiveMode).toBe('live');
  });

  it('nunca devuelve URL firmada, query string ni token, aunque la config traiga basura', () => {
    const sucio = externaValida();
    (sucio.ownership.external as Record<string, unknown>).fingerprint = 'meta_feed:ds-1|tienda.test/feed.csv';
    const serializado = JSON.stringify(buildCatalogOwnershipStatus(sucio));
    expect(serializado).not.toContain('access_token');
    expect(serializado).not.toContain('https://');
    expect(serializado).not.toContain('?');
  });

  it('la respuesta no arrastra campos internos del producto ni del tenant', () => {
    const r = buildCatalogOwnershipStatus(externaValida());
    expect(Object.keys(r).sort()).toEqual([
      'authority', // ADR-0022: bloque ADITIVO — todo lo demás quedó idéntico
      'configMode',
      'declared',
      'detectedSources',
      'effectiveMode',
      'enabled',
      'hasWritableFields',
      'lastSourceCheckAt',
      'ok',
      'ownership',
    ]);
  });
});

/**
 * ADR-0022 §5 — bloque `authority` ADITIVO: `{authority, relationship, declared, reasons,
 * staleness}` es EXACTAMENTE el shape que consume el selector del panel. Nada de lo anterior
 * cambia de forma ni de valor.
 */
describe('buildCatalogOwnershipStatus — bloque authority (ADR-0022, aditivo)', () => {
  it('arfagi-like ⇒ external + mirror, con la frescura juntada aparte', () => {
    const r = buildCatalogOwnershipStatus(externaValida(), { metaVerifiedAt: 123, lastImportFinishedAt: 456 });
    expect(r.authority).toEqual({
      authority: 'external',
      relationship: 'mirror',
      declared: false,
      reasons: [],
      botCatalog: 'local_mirror',
      staleness: { metaVerifiedAt: 123, lastSourceCheckAt: 1_700_000_100_000, lastImportFinishedAt: 456 },
    });
  });

  it('sin staleness juntada ⇒ nulls honestos («nunca»), jamás un verde inventado', () => {
    const r = buildCatalogOwnershipStatus(externaValida());
    expect(r.authority.staleness.metaVerifiedAt).toBeNull();
    expect(r.authority.staleness.lastImportFinishedAt).toBeNull();
    expect(r.authority.staleness.lastSourceCheckAt).toBe(1_700_000_100_000);
  });

  it('credipower (sin config) ⇒ vendeyapy + none; relationship declarado ⇒ declared:true', () => {
    expect(buildCatalogOwnershipStatus(undefined).authority).toMatchObject({
      authority: 'vendeyapy',
      relationship: 'none',
      declared: false,
    });
    expect(buildCatalogOwnershipStatus({ relationship: 'none' }).authority).toMatchObject({
      relationship: 'none',
      declared: true,
    });
  });

  it('los campos preexistentes NO cambian de valor con el bloque nuevo presente', () => {
    const conBloque = buildCatalogOwnershipStatus(externaValida(), { metaVerifiedAt: 1 });
    const { authority: _a, ...resto } = conBloque;
    const { authority: _b, ...restoSin } = buildCatalogOwnershipStatus(externaValida());
    expect(resto).toEqual(restoSin);
  });
});

/**
 * ADR-0015 §8 — APAGAR LA SINCRONIZACIÓN NO APAGA LA HONESTIDAD.
 * ==============================================================
 * Misma familia que el hallazgo ya corregido en la proyección de deriva, pero en la VISTA:
 * `normalizeCatalogSyncConfig` es el gate de NUESTRA escritura y ante `enabled:false`,
 * `mode:'off'` o un `catalogId` inválido devuelve la config apagada entera, con la propiedad
 * DEGRADADA. Construir la tarjeta solo con eso hacía que apagar el sync borrara de pantalla al
 * feed que una persona ya había reconocido: el panel decía "todavía nadie declaró quién
 * administra el catálogo" mientras el sitio del tenant seguía publicando los 181 artículos cada
 * madrugada — le mentía al owner justo sobre el hecho que motivó todo el ADR.
 *
 * Los dos ejes se verifican por separado en cada caso: PERMISO cerrado (no escribimos ni una
 * coma) y REALIDAD reportada (quién gobierna afuera).
 */
describe('buildCatalogOwnershipStatus — sync APAGADA con gobierno externo reconocido', () => {
  const apagados: Array<[string, Record<string, unknown>]> = [
    ['enabled:false', { enabled: false }],
    ["mode:'off'", { mode: 'off' }],
    ['catalogId inválido', { catalogId: 'no/es/válido' }],
  ];

  it.each(apagados)('%s ⇒ el permiso queda CERRADO (fail-closed intacto)', (_l, over) => {
    const r = buildCatalogOwnershipStatus(externaValida(over));
    expect(r.enabled).toBe(false);
    expect(r.configMode).toBe('off');
    expect(r.effectiveMode).toBe('off');
    expect(r.ownership.writable).toEqual([]);
    expect(r.hasWritableFields).toBe(false);
  });

  it.each(apagados)('%s ⇒ la REALIDAD sigue reportada: el feed reconocido gobierna el catálogo', (_l, over) => {
    const r = buildCatalogOwnershipStatus(externaValida(over));
    // Bajo `external_managed` el gobierno externo abarca TODOS los campos públicos.
    expect(r.declared.externalFields).toEqual([...WRITABLE_FIELDS]);
    expect(r.declared.externalSource?.kind).toBe('meta_feed');
    expect(r.declared.externalSource?.acknowledgedSourceIds).toEqual(['ds-1']);
    expect(r.declared.externalSource?.acknowledgedByUid).toBe('uid-owner');
  });

  it('con la sync ENCENDIDA los dos ejes coinciden (la realidad no contradice al permiso)', () => {
    const r = buildCatalogOwnershipStatus(externaValida());
    expect(r.declared.externalFields).toEqual(r.ownership.external);
    expect(r.declared.externalSource?.acknowledgedSourceIds).toEqual(
      r.ownership.externalSource?.acknowledgedSourceIds,
    );
  });

  it('sync apagada y NADIE declaró nada ⇒ la realidad también viaja vacía (no se inventa un dueño)', () => {
    for (const raw of [undefined, null, {}, 'texto', { enabled: false }, { enabled: true, mode: 'dry_run', catalogId: 'CAT-1', sourceOfTruth: 'vendeyapy' }]) {
      const r = buildCatalogOwnershipStatus(raw);
      expect(r.declared.externalFields).toEqual([]);
      expect(r.declared.externalSource).toBeNull();
    }
  });

  it('una declaración externa INVÁLIDA no cuenta como gobierno externo, ni con la sync apagada', () => {
    // Feed "reconocido" sin ids ni huella: una promesa vacía, no un reconocimiento humano.
    const r = buildCatalogOwnershipStatus(
      externaValida({ enabled: false, ownership: { model: 'external_managed', ownedFields: [], external: { kind: 'meta_feed', acknowledgedSourceIds: [] } } }),
    );
    expect(r.declared.externalFields).toEqual([]);
    expect(r.declared.externalSource).toBeNull();
  });

  it('el eje REALIDAD tampoco filtra URL firmada, query string ni token', () => {
    const sucio = externaValida({ enabled: false });
    (sucio.ownership.external as Record<string, unknown>).fingerprint = 'meta_feed:ds-1|tienda.test|03:33';
    const serializado = JSON.stringify(buildCatalogOwnershipStatus(sucio).declared);
    expect(serializado).not.toContain('access_token');
    expect(serializado).not.toContain('https://');
    expect(serializado).not.toContain('?');
  });
});
