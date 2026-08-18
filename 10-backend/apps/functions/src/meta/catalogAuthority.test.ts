import { describe, it, expect } from 'vitest';

/**
 * ADR-0022 §1 — derivación PURA de autoridad/relación. Lo que discrimina esta batería:
 *  · la tabla completa (A/B/C/D + degradaciones nivel 2 + legacy sin declarar);
 *  · el fail-closed de la declaración: un `relationship` incoherente JAMÁS se cree;
 *  · determinismo y pureza (mismo input ⇒ mismo output; el input no se muta).
 */
import { deriveCatalogAuthority, declaredRelationship } from './catalogAuthority.js';

// ── Fixtures (formas REALES de `catalogSync`, espejo de los tenants vivos) ──

/** arfagi: feed diario del sitio reconocido (ADR-0015 §9) ⇒ external + mirror. */
const arfagiRaw = () => ({
  enabled: true,
  mode: 'dry_run',
  catalogId: 'cat_arfagi',
  sourceOfTruth: 'vendeyapy',
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
});

const commerceRaw = () => {
  const r = arfagiRaw();
  r.ownership.external.kind = 'commerce_manager';
  return r;
};

/** Tenant que publica (B de facto): vendeyapy_managed sano + gates completos. */
const managedRaw = () => ({
  enabled: true,
  mode: 'live',
  catalogId: 'cat_managed',
  sourceOfTruth: 'vendeyapy',
  ownership: { model: 'vendeyapy_managed', ownedFields: ['title', 'price'], external: null, lastSourceCheckAt: null },
});

const hybridRaw = () => ({
  enabled: true,
  mode: 'live',
  catalogId: 'cat_hybrid',
  ownership: {
    model: 'hybrid',
    ownedFields: ['price'],
    external: {
      kind: 'meta_feed',
      acknowledgedSourceIds: ['feed_h'],
      declaredFields: ['title'],
      fingerprint: 'fp_h',
      acknowledgedAt: null,
      acknowledgedByUid: 'uid_owner',
    },
    lastSourceCheckAt: null,
  },
});

/** Legacy nivel 2: config válida pero ownership ausente (solo sourceOfTruth). */
const degradedLegacyRaw = () => ({ enabled: true, mode: 'dry_run', catalogId: 'cat_legacy', sourceOfTruth: 'vendeyapy' });

describe('deriveCatalogAuthority — derivación legacy (sin relationship declarado)', () => {
  it.each([undefined, null, 'texto', 42, []])('sin config (%s) ⇒ vendeyapy + none (credipower)', (raw) => {
    expect(deriveCatalogAuthority(raw)).toEqual({
      authority: 'vendeyapy',
      relationship: 'none',
      declared: false,
      reasons: [],
      botCatalog: 'local_mirror',
    });
  });

  it('objeto vacío (config local pura) ⇒ vendeyapy + none sin ruido de motivos', () => {
    const d = deriveCatalogAuthority({});
    expect(d.authority).toBe('vendeyapy');
    expect(d.relationship).toBe('none');
    expect(d.declared).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it('arfagi (external_managed + meta_feed) ⇒ external + mirror', () => {
    const d = deriveCatalogAuthority(arfagiRaw());
    expect(d).toMatchObject({ authority: 'external', relationship: 'mirror', declared: false, reasons: [] });
  });

  it('external_managed + commerce_manager ⇒ meta + mirror', () => {
    expect(deriveCatalogAuthority(commerceRaw())).toMatchObject({ authority: 'meta', relationship: 'mirror' });
  });

  it('external_managed con la sync APAGADA sigue siendo mirror (la relación no es el interruptor)', () => {
    const raw = arfagiRaw();
    raw.enabled = false;
    expect(deriveCatalogAuthority(raw)).toMatchObject({ authority: 'external', relationship: 'mirror' });
  });

  it('vendeyapy_managed con gates completos ⇒ managed (el tenant que publica sigue publicando)', () => {
    expect(deriveCatalogAuthority(managedRaw())).toMatchObject({
      authority: 'vendeyapy',
      relationship: 'managed',
      declared: false,
      reasons: [],
    });
  });

  it('hybrid sano con gates completos ⇒ managed', () => {
    expect(deriveCatalogAuthority(hybridRaw())).toMatchObject({ authority: 'vendeyapy', relationship: 'managed' });
  });

  it.each([
    ['enabled:false', (r: ReturnType<typeof managedRaw>) => ({ ...r, enabled: false }), 'sync_disabled'],
    ["enabled:'true' (truthy NO booleano)", (r: ReturnType<typeof managedRaw>) => ({ ...r, enabled: 'true' }), 'sync_disabled'],
    ['catalogId inválido', (r: ReturnType<typeof managedRaw>) => ({ ...r, catalogId: 'con espacios /' }), 'catalog_id_missing'],
  ])('vendeyapy_managed con %s ⇒ none CON el motivo (%s)', (_n, mut, reason) => {
    const d = deriveCatalogAuthority(mut(managedRaw()));
    expect(d.relationship).toBe('none');
    expect(d.authority).toBe('vendeyapy');
    expect(d.reasons).toContain(reason);
  });

  it("mode:'off' con enabled:true sigue siendo MANAGED: el modo es el interruptor de EJECUCIÓN, no la relación", () => {
    // La tabla del ADR-0022 §1 exige `enabled && catalogId && writable>0` — `mode` no está.
    // Un tenant con el envío apagado conserva sus rieles: el run de sync le responde
    // `disabled` (nivel 1, intacto) en vez de expulsarlo del ciclo con el gate de relación.
    const d = deriveCatalogAuthority({ ...managedRaw(), mode: 'off' });
    expect(d).toMatchObject({ authority: 'vendeyapy', relationship: 'managed', reasons: [] });
  });

  it('degradación nivel 2 CON plomería Meta ⇒ external + mirror + ownership_degraded (conserva leer/diagnosticar)', () => {
    for (const raw of [
      degradedLegacyRaw(), // ownership ausente
      { ...degradedLegacyRaw(), ownership: { model: 'desconocido' } }, // malformed
      { ...degradedLegacyRaw(), ownership: { model: 'vendeyapy_managed', ownedFields: ['cost'] } }, // never_publishable
      {
        ...degradedLegacyRaw(),
        // conflicto: modelo external_managed con campos propios declarados
        ownership: { model: 'external_managed', ownedFields: ['title'], external: arfagiRaw().ownership.external },
      },
    ]) {
      const d = deriveCatalogAuthority(raw);
      expect(d.authority).toBe('external');
      expect(d.relationship).toBe('mirror');
      expect(d.reasons).toContain('ownership_degraded');
    }
  });

  it('botCatalog es SIEMPRE local_mirror (invariante: el bot solo consume Firestore)', () => {
    for (const raw of [undefined, {}, arfagiRaw(), managedRaw(), hybridRaw(), degradedLegacyRaw()]) {
      expect(deriveCatalogAuthority(raw).botCatalog).toBe('local_mirror');
    }
  });
});

describe('deriveCatalogAuthority — relationship declarado', () => {
  it("declarado 'none' sin plomería ⇒ A declarado (declared:true)", () => {
    expect(deriveCatalogAuthority({ relationship: 'none' })).toMatchObject({
      authority: 'vendeyapy',
      relationship: 'none',
      declared: true,
      reasons: [],
    });
  });

  it('declarado fuera del vocabulario ⇒ relationship_invalid y manda el derivado', () => {
    const d = deriveCatalogAuthority({ ...managedRaw(), relationship: 'cualquiera' });
    expect(d.reasons).toContain('relationship_invalid');
    expect(d.relationship).toBe('managed'); // el derivado
    expect(d.declared).toBe(false);
  });

  it("declarado 'managed' sobre config completa ⇒ B declarado", () => {
    expect(deriveCatalogAuthority({ ...managedRaw(), relationship: 'managed' })).toMatchObject({
      relationship: 'managed',
      declared: true,
    });
  });

  it("B→A: declarado 'none' sobre config completa ⇒ none declarado SIN ruido (la plomería queda)", () => {
    expect(deriveCatalogAuthority({ ...managedRaw(), relationship: 'none' })).toMatchObject({
      authority: 'vendeyapy',
      relationship: 'none',
      declared: true,
      reasons: [],
    });
  });

  it("declarado 'managed' sin gates ⇒ fail-closed a none CON motivo (jamás se cree la declaración)", () => {
    const d = deriveCatalogAuthority({ ...managedRaw(), enabled: false, relationship: 'managed' });
    expect(d.relationship).toBe('none');
    expect(d.declared).toBe(false); // el efectivo NO es lo declarado
    expect(d.reasons).toContain('sync_disabled');
  });

  it("declarado 'mirror' bajo autoridad propia ⇒ relationship_conflict y manda el derivado", () => {
    const d = deriveCatalogAuthority({ ...managedRaw(), relationship: 'mirror' });
    expect(d.reasons).toContain('relationship_conflict');
    expect(d.relationship).toBe('managed');
    expect(d.declared).toBe(false);
  });

  it("declarado 'none'/'managed' sobre external_managed ⇒ relationship_conflict, sigue mirror", () => {
    for (const rel of ['none', 'managed']) {
      const d = deriveCatalogAuthority({ ...arfagiRaw(), relationship: rel });
      expect(d.relationship).toBe('mirror');
      expect(d.declared).toBe(false);
      expect(d.reasons).toContain('relationship_conflict');
    }
  });

  it("D declarado: arfagi + relationship 'mirror' ⇒ mirror declarado", () => {
    expect(deriveCatalogAuthority({ ...arfagiRaw(), relationship: 'mirror' })).toMatchObject({
      authority: 'external',
      relationship: 'mirror',
      declared: true,
      reasons: [],
    });
  });

  it("declarado 'managed' sin config alguna ⇒ none con ownership_degraded (fail-closed)", () => {
    const d = deriveCatalogAuthority({ relationship: 'managed' });
    expect(d.relationship).toBe('none');
    expect(d.reasons).toContain('ownership_degraded');
  });
});

describe('deriveCatalogAuthority — pureza y determinismo', () => {
  it('mismo input ⇒ exactamente el mismo output (determinística)', () => {
    const raw = arfagiRaw();
    expect(deriveCatalogAuthority(raw)).toEqual(deriveCatalogAuthority(raw));
  });

  it('no muta el input (cero escrituras, ni siquiera en memoria ajena)', () => {
    const raw = managedRaw();
    const antes = JSON.stringify(raw);
    deriveCatalogAuthority(raw);
    expect(JSON.stringify(raw)).toBe(antes);
  });
});

describe('declaredRelationship — lectura cruda', () => {
  it('ausente ⇒ null sin invalidez; basura ⇒ invalid', () => {
    expect(declaredRelationship({})).toEqual({ value: null, invalid: false });
    expect(declaredRelationship({ relationship: null })).toEqual({ value: null, invalid: false });
    expect(declaredRelationship({ relationship: 'mirror' })).toEqual({ value: 'mirror', invalid: false });
    expect(declaredRelationship({ relationship: 'x' })).toEqual({ value: null, invalid: true });
    expect(declaredRelationship({ relationship: 7 })).toEqual({ value: null, invalid: true });
    expect(declaredRelationship('no-objeto')).toEqual({ value: null, invalid: false });
  });
});
