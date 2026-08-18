import { describe, it, expect } from 'vitest';

/**
 * ADR-0022 §2/§3 — plan PURO de la transición de autoridad + huellas + binding de evidencia.
 * Discrimina: las 4 combinaciones válidas contra TODAS las inválidas; cada bloqueo del
 * vocabulario cerrado; el cambio de modelo SOLO desde una fuente ya reconocida; y que un plan
 * con bloqueos jamás tiene estado esperado (⇒ el preview no emite planHash).
 */
import type { CatalogAuthorityTarget } from '@vpw/shared';
import {
  authorityConfigFingerprint,
  authorityPlanHash,
  evaluateAuthorityRunBinding,
  isValidAuthorityTarget,
  planAuthorityTransition,
  type AuthorityTransitionSignals,
} from './catalogAuthority.js';

const señales = (over: Partial<AuthorityTransitionSignals> = {}): AuthorityTransitionSignals => ({
  connectionOk: true,
  outboxNotTerminal: 0,
  importRunInFlight: false,
  syncRunInFlight: false,
  mappingAmbiguous: false,
  ...over,
});

const A: CatalogAuthorityTarget = { authority: 'vendeyapy', relationship: 'none' };
const B: CatalogAuthorityTarget = { authority: 'vendeyapy', relationship: 'managed' };
const C: CatalogAuthorityTarget = { authority: 'meta', relationship: 'mirror' };
const D: CatalogAuthorityTarget = { authority: 'external', relationship: 'mirror' };

const arfagiRaw = () => ({
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
});

const commerceRaw = () => {
  const r = arfagiRaw();
  r.ownership.external.kind = 'commerce_manager';
  return r;
};

const managedRaw = () => ({
  enabled: true,
  mode: 'live',
  catalogId: 'cat_managed',
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

const ids = (plan: ReturnType<typeof planAuthorityTransition>) => plan.bloqueos.map((b) => b.id);

describe('isValidAuthorityTarget — §2: solo A/B/C/D', () => {
  it('acepta las cuatro válidas y rechaza todas las demás', () => {
    expect([A, B, C, D].every(isValidAuthorityTarget)).toBe(true);
    const invalidas: CatalogAuthorityTarget[] = [
      { authority: 'external', relationship: 'managed' },
      { authority: 'external', relationship: 'none' },
      { authority: 'meta', relationship: 'none' },
      { authority: 'meta', relationship: 'managed' },
      { authority: 'vendeyapy', relationship: 'mirror' },
    ];
    for (const t of invalidas) expect(isValidAuthorityTarget(t)).toBe(false);
  });
});

describe('planAuthorityTransition — combinaciones válidas (camino feliz)', () => {
  it('A desde un tenant sin config (credipower) ⇒ sin bloqueos, estado esperado = A declarado', () => {
    const plan = planAuthorityTransition({ target: A, rawCatalogSync: undefined, signals: señales({ connectionOk: false }) });
    expect(plan.bloqueos).toEqual([]);
    expect(plan.modelChange).toBe(false);
    expect(plan.proposal).toBeNull();
    expect(plan.estadoEsperado).toMatchObject({ authority: 'vendeyapy', relationship: 'none', declared: true });
  });

  it('B desde vendeyapy_managed completo ⇒ sin bloqueos; estado esperado = B declarado', () => {
    const plan = planAuthorityTransition({ target: B, rawCatalogSync: managedRaw(), signals: señales() });
    expect(plan.bloqueos).toEqual([]);
    expect(plan.estadoEsperado).toMatchObject({ authority: 'vendeyapy', relationship: 'managed', declared: true });
    // Ya estaba en managed derivado: el apply solo DECLARA.
    expect(plan.advertencias).toContain('already_in_target');
  });

  it('B→A: relationship none sobre config completa, sin tocar plomería ni modelo', () => {
    const plan = planAuthorityTransition({ target: A, rawCatalogSync: managedRaw(), signals: señales() });
    expect(plan.bloqueos).toEqual([]);
    expect(plan.modelChange).toBe(false);
    expect(plan.estadoEsperado).toMatchObject({ authority: 'vendeyapy', relationship: 'none', declared: true });
  });

  it('C desde commerce_manager reconocido ⇒ sin cambio de modelo', () => {
    const plan = planAuthorityTransition({ target: C, rawCatalogSync: commerceRaw(), signals: señales() });
    expect(plan.bloqueos).toEqual([]);
    expect(plan.modelChange).toBe(false);
    expect(plan.estadoEsperado).toMatchObject({ authority: 'meta', relationship: 'mirror', declared: true });
  });

  it('D desde arfagi ⇒ declara mirror sobre lo que ya es (advertencia already_in_target)', () => {
    const plan = planAuthorityTransition({ target: D, rawCatalogSync: arfagiRaw(), signals: señales({ connectionOk: false }) });
    expect(plan.bloqueos).toEqual([]); // D no exige conexión: la fuente ya fue reconocida
    expect(plan.advertencias).toContain('already_in_target');
    expect(plan.estadoEsperado).toMatchObject({ authority: 'external', relationship: 'mirror', declared: true });
  });

  it('hybrid → D: cambio de modelo construido desde la fuente YA reconocida', () => {
    const plan = planAuthorityTransition({ target: D, rawCatalogSync: hybridRaw(), signals: señales() });
    expect(plan.bloqueos).toEqual([]);
    expect(plan.modelChange).toBe(true);
    expect(plan.proposal).toMatchObject({
      model: 'external_managed',
      ownedFields: [],
      external: { kind: 'meta_feed', acknowledgedSourceIds: ['feed_h'], acknowledgedByUid: 'uid_owner' },
    });
    expect(plan.estadoEsperado).toMatchObject({ authority: 'external', relationship: 'mirror', declared: true });
  });

  it('B con el interruptor apagado ⇒ NO bloquea pero avisa y el estado esperado es HONESTO (none)', () => {
    const raw = { ...managedRaw(), enabled: false };
    const plan = planAuthorityTransition({ target: B, rawCatalogSync: raw, signals: señales() });
    expect(plan.bloqueos).toEqual([]);
    expect(plan.advertencias).toContain('sync_disabled');
    expect(plan.estadoEsperado).toMatchObject({ relationship: 'none' });
  });

  it("B con mode:'off' (enabled:true) ⇒ avisa sync_disabled pero la relación resultante ES managed", () => {
    // El modo es el interruptor de EJECUCIÓN (nivel 1): apagar el envío no borra la relación.
    const plan = planAuthorityTransition({ target: B, rawCatalogSync: { ...managedRaw(), mode: 'off' }, signals: señales() });
    expect(plan.bloqueos).toEqual([]);
    expect(plan.advertencias).toContain('sync_disabled');
    expect(plan.estadoEsperado).toMatchObject({ authority: 'vendeyapy', relationship: 'managed', declared: true });
  });
});

describe('planAuthorityTransition — bloqueos (fail-closed, vocabulario cerrado)', () => {
  it('objetivo inválido ⇒ invalid_target inmediato, sin estado esperado', () => {
    const plan = planAuthorityTransition({
      target: { authority: 'external', relationship: 'managed' },
      rawCatalogSync: managedRaw(),
      signals: señales(),
    });
    expect(plan.bloqueos).toEqual([{ id: 'invalid_target' }]);
    expect(plan.estadoEsperado).toBeNull();
  });

  it('A/B desde external_managed ⇒ external_conflict (la fuente reconocida gobierna)', () => {
    for (const target of [A, B]) {
      expect(ids(planAuthorityTransition({ target, rawCatalogSync: arfagiRaw(), signals: señales() }))).toContain('external_conflict');
    }
  });

  it('hybrid → A ⇒ external_conflict (apagaría el refresco con el guard activo); hybrid → B sigue permitido', () => {
    expect(ids(planAuthorityTransition({ target: A, rawCatalogSync: hybridRaw(), signals: señales() }))).toContain('external_conflict');
    expect(planAuthorityTransition({ target: B, rawCatalogSync: hybridRaw(), signals: señales() }).bloqueos).toEqual([]);
  });

  it('C/D desde vendeyapy_managed (sin fuente reconocida) ⇒ ownership_incompatible external_required', () => {
    for (const target of [C, D]) {
      const plan = planAuthorityTransition({ target, rawCatalogSync: managedRaw(), signals: señales() });
      expect(plan.bloqueos).toContainEqual({ id: 'ownership_incompatible', reasons: ['external_required'] });
    }
  });

  it('kind incompatible: C desde meta_feed y D desde commerce_manager ⇒ external_kind_mismatch', () => {
    expect(planAuthorityTransition({ target: C, rawCatalogSync: arfagiRaw(), signals: señales() }).bloqueos).toContainEqual({
      id: 'ownership_incompatible',
      reasons: ['external_kind_mismatch'],
    });
    expect(planAuthorityTransition({ target: D, rawCatalogSync: commerceRaw(), signals: señales() }).bloqueos).toContainEqual({
      id: 'ownership_incompatible',
      reasons: ['external_kind_mismatch'],
    });
  });

  it('propiedad degradada (nivel 2 con plomería) ⇒ ownership_incompatible con los reasons de nivel 2, en TODO destino', () => {
    const degraded = { enabled: true, mode: 'dry_run', catalogId: 'cat_x', sourceOfTruth: 'vendeyapy' };
    for (const target of [A, B, C, D]) {
      const plan = planAuthorityTransition({ target, rawCatalogSync: degraded, signals: señales() });
      expect(plan.bloqueos).toContainEqual({ id: 'ownership_incompatible', reasons: ['ownership_missing'] });
      expect(plan.estadoEsperado).toBeNull();
    }
  });

  it('conexión: B y C la exigen; A y D no', () => {
    const sin = señales({ connectionOk: false });
    expect(ids(planAuthorityTransition({ target: B, rawCatalogSync: managedRaw(), signals: sin }))).toContain('connection_missing');
    expect(ids(planAuthorityTransition({ target: C, rawCatalogSync: commerceRaw(), signals: sin }))).toContain('connection_missing');
    expect(ids(planAuthorityTransition({ target: A, rawCatalogSync: managedRaw(), signals: sin }))).not.toContain('connection_missing');
    expect(ids(planAuthorityTransition({ target: D, rawCatalogSync: arfagiRaw(), signals: sin }))).not.toContain('connection_missing');
  });

  it('catalogId: B/C/D lo exigen (bloqueo honesto de la deuda del selector)', () => {
    for (const [target, raw] of [
      [B, { ...managedRaw(), catalogId: '' }],
      [C, { ...commerceRaw(), catalogId: '' }],
      [D, { ...arfagiRaw(), catalogId: '' }],
    ] as const) {
      expect(ids(planAuthorityTransition({ target, rawCatalogSync: raw, signals: señales() }))).toContain('catalog_id_missing');
    }
  });

  it('trabajo en vuelo ⇒ bloqueos con su detalle (conteo del outbox incluido)', () => {
    const plan = planAuthorityTransition({
      target: D,
      rawCatalogSync: arfagiRaw(),
      signals: señales({ outboxNotTerminal: 3, importRunInFlight: true, syncRunInFlight: true, mappingAmbiguous: true }),
    });
    expect(plan.bloqueos).toContainEqual({ id: 'outbox_not_terminal', count: 3 });
    expect(ids(plan)).toEqual(expect.arrayContaining(['import_run_in_flight', 'sync_run_in_flight', 'mapping_ambiguous']));
    expect(plan.estadoEsperado).toBeNull();
    expect(plan.proposal).toBeNull();
  });
});

describe('huellas — planHash y fingerprint de config', () => {
  const base = { target: D, rawCatalogSync: arfagiRaw(), signals: señales() };
  const hashDe = (over: Partial<Parameters<typeof authorityPlanHash>[0]> = {}) =>
    authorityPlanHash({ tenantId: 't1', target: base.target, rawCatalogSync: base.rawCatalogSync, signals: base.signals, proposal: null, modelChange: false, ...over });

  it('planHash: determinístico, y cambia con tenant/target/config/señales', () => {
    expect(hashDe()).toBe(hashDe());
    expect(hashDe({ tenantId: 't2' })).not.toBe(hashDe());
    expect(hashDe({ target: C })).not.toBe(hashDe());
    expect(hashDe({ rawCatalogSync: managedRaw() })).not.toBe(hashDe());
    expect(hashDe({ signals: señales({ outboxNotTerminal: 1 }) })).not.toBe(hashDe());
  });

  it('fingerprint de config: estable ante el MISMO contenido y sensible a cualquier mutación (Timestamps incluidos)', () => {
    const conTs = { ...arfagiRaw(), ownership: { ...arfagiRaw().ownership, lastSourceCheckAt: { toMillis: () => 111 } } };
    const igual = { ...arfagiRaw(), ownership: { ...arfagiRaw().ownership, lastSourceCheckAt: { toMillis: () => 111 } } };
    const distinto = { ...arfagiRaw(), ownership: { ...arfagiRaw().ownership, lastSourceCheckAt: { toMillis: () => 222 } } };
    expect(authorityConfigFingerprint(conTs)).toBe(authorityConfigFingerprint(igual));
    expect(authorityConfigFingerprint(conTs)).not.toBe(authorityConfigFingerprint(distinto));
    expect(authorityConfigFingerprint(undefined)).toBe(authorityConfigFingerprint(undefined));
    expect(authorityConfigFingerprint(undefined)).not.toBe(authorityConfigFingerprint({}));
  });
});

describe('evaluateAuthorityRunBinding — evidencia del apply (mismos motivos que el patrón real)', () => {
  const now = 1_000_000;
  const runOk = () => ({
    kind: 'authority',
    status: 'planned',
    planHash: 'abc123'.padEnd(16, '0'),
    actorUid: 'uid_1',
    consumedAt: null,
    expiresAtMs: now + 60_000,
  });
  const ctx = (over: Partial<{ planHash: string; actorUid: string | null; nowMs: number }> = {}) => ({
    evidence: { runId: 'mca_x', planHash: over.planHash ?? runOk().planHash },
    actorUid: over.actorUid !== undefined ? over.actorUid : 'uid_1',
    nowMs: over.nowMs ?? now,
  });

  it('run utilizable ⇒ null', () => {
    expect(evaluateAuthorityRunBinding(runOk(), ctx())).toBeNull();
  });
  it('inexistente ⇒ not_found', () => {
    expect(evaluateAuthorityRunBinding(null, ctx())).toBe('not_found');
  });
  it('bloqueado (sin planHash) o de otro tipo ⇒ not_usable', () => {
    expect(evaluateAuthorityRunBinding({ ...runOk(), status: 'blocked', planHash: null }, ctx())).toBe('not_usable');
    expect(evaluateAuthorityRunBinding({ ...runOk(), kind: 'otro' }, ctx())).toBe('not_usable');
  });
  it('hash distinto ⇒ mismatch', () => {
    expect(evaluateAuthorityRunBinding(runOk(), ctx({ planHash: 'f'.repeat(16) }))).toBe('mismatch');
  });
  it('otro actor (o sin uid) ⇒ actor_mismatch', () => {
    expect(evaluateAuthorityRunBinding(runOk(), ctx({ actorUid: 'uid_2' }))).toBe('actor_mismatch');
    expect(evaluateAuthorityRunBinding(runOk(), ctx({ actorUid: null }))).toBe('actor_mismatch');
  });
  it('ya consumido ⇒ consumed (replay imposible)', () => {
    expect(evaluateAuthorityRunBinding({ ...runOk(), consumedAt: { seconds: 1 } }, ctx())).toBe('consumed');
  });
  it('vencido ⇒ expired', () => {
    expect(evaluateAuthorityRunBinding(runOk(), ctx({ nowMs: now + 61_000 }))).toBe('expired');
  });
});
