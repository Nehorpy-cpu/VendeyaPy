import { describe, it, expect } from 'vitest';

/**
 * ADR-0022 §4 — gate por RELACIÓN sobre la elegibilidad de la verificación. Lo que discrimina:
 *  · SOLO el opt-out EXPLÍCITO (`relationship: 'none'` declarado y honrado) saltea;
 *  · un `none` meramente DERIVADO (hybrid con la sync apagada) NO saltea — ese tenant tiene el
 *    guard activo y esta corrida es lo único que refresca su evidencia (hallazgo B1, ADR-0015);
 *  · TODOS los desenlaces legacy quedan idénticos (arfagi corre, credipower saltea, la config
 *    contradictoria sigue bloqueando con alerta).
 */
import { catalogVerificationEligibility } from './catalogVerification.js';

const arfagiRaw = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  mode: 'dry_run',
  catalogId: 'cat_arfagi',
  ownership: {
    model: 'external_managed',
    ownedFields: [],
    external: {
      kind: 'meta_feed',
      acknowledgedSourceIds: ['feed_1'],
      declaredFields: ['title', 'price', 'availability'],
      fingerprint: 'fp_feed_1',
      acknowledgedAt: null,
      acknowledgedByUid: 'uid_owner',
    },
    lastSourceCheckAt: null,
  },
  ...over,
});

const hybridRaw = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  mode: 'live',
  catalogId: 'cat_hybrid',
  ownership: {
    model: 'hybrid',
    ownedFields: ['title'],
    external: {
      kind: 'meta_feed',
      acknowledgedSourceIds: ['feed_h'],
      // Gobierna un campo COMERCIAL: el guard del bot está ACTIVO para este tenant.
      declaredFields: ['price'],
      fingerprint: 'fp_h',
      acknowledgedAt: null,
      acknowledgedByUid: 'uid_owner',
    },
    lastSourceCheckAt: null,
  },
  ...over,
});

describe('catalogVerificationEligibility — relación declarada (ADR-0022)', () => {
  it("opt-out explícito con sync encendida ⇒ skip 'relationship_none'", () => {
    const managed = {
      enabled: true,
      mode: 'live',
      catalogId: 'cat_m',
      ownership: { model: 'vendeyapy_managed', ownedFields: ['title', 'price'], external: null, lastSourceCheckAt: null },
      relationship: 'none',
    };
    expect(catalogVerificationEligibility(managed)).toEqual({ can: 'skip', reason: 'relationship_none' });
  });

  it('B1: el opt-out NO se honra con una fuente externa COMERCIAL declarada — el guard sigue activo y el refresco también', () => {
    // hybrid sano cuya fuente publica `price` (comercial) + `relationship:'none'` sembrado a
    // mano (la transición bloquea hybrid→A, pero la elegibilidad no puede depender de eso):
    // saltear acá dejaría el guard de deriva activo SIN nada que refresque su evidencia ⇒
    // stale a las 24 h y venta apagada en silencio — el modo de falla que ADR-0015 §6 prohíbe.
    for (const raw of [hybridRaw({ relationship: 'none' }), hybridRaw({ enabled: false, relationship: 'none' })]) {
      expect(catalogVerificationEligibility(raw).can).toBe('run');
    }
  });

  it("opt-out con fuente externa SOLO COSMÉTICA sí se honra (el guard está inerte) ⇒ skip 'relationship_none'", () => {
    // hybrid válido con la partición invertida: lo comercial es propio, la fuente publica solo
    // `title` (cosmético) ⇒ el guard queda inerte y el opt-out declarado es seguro.
    const cosmetica = hybridRaw({ relationship: 'none' });
    (cosmetica.ownership as unknown as { ownedFields: string[] }).ownedFields = ['price'];
    (cosmetica.ownership.external as { declaredFields: string[] }).declaredFields = ['title'];
    expect(catalogVerificationEligibility(cosmetica)).toEqual({ can: 'skip', reason: 'relationship_none' });
  });

  it('REGRESIÓN B1: hybrid con la sync APAGADA y SIN declaración sigue corriendo (guard activo ⇒ hay que refrescar)', () => {
    const r = catalogVerificationEligibility(hybridRaw({ enabled: false }));
    expect(r.can).toBe('run');
    expect((r as { via: string }).via).toBe('external_governance');
  });

  it('no-regresión legacy: arfagi corre (mirror), con la sync encendida o apagada', () => {
    expect(catalogVerificationEligibility(arfagiRaw()).can).toBe('run');
    expect(catalogVerificationEligibility(arfagiRaw({ enabled: false })).can).toBe('run');
  });

  it("no-regresión legacy: arfagi + declarado 'none' (incoherente) NO saltea — la declaración no se cree", () => {
    // La derivación fail-closed deja mirror (declared:false): el refresco sigue corriendo.
    expect(catalogVerificationEligibility(arfagiRaw({ relationship: 'none' })).can).toBe('run');
  });

  it('no-regresión legacy: credipower (sin config) y config sin gobierno comercial conservan sus skips', () => {
    expect(catalogVerificationEligibility(undefined)).toEqual({ can: 'skip', reason: 'no_catalog_sync' });
    expect(
      catalogVerificationEligibility({ enabled: false, mode: 'off', catalogId: '', ownership: undefined }),
    ).toEqual({ can: 'skip', reason: 'no_external_governance' });
  });

  it('no-regresión legacy: config contradictoria (gobierno externo sin catálogo) sigue BLOQUEADA', () => {
    const r = catalogVerificationEligibility(arfagiRaw({ enabled: false, catalogId: '' }));
    expect(r.can).toBe('blocked');
    expect((r as { reason: string }).reason).toBe('external_without_catalog');
  });
});
