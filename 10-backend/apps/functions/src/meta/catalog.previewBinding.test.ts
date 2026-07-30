import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import {
  evaluatePreviewBinding,
  normalizePreviewEvidence,
  planFingerprint,
  PREVIEW_TTL_MS,
  type CatalogSyncPlan,
  type PreviewDocData,
} from './catalog.js';

/**
 * META-CATALOG-PREVIEW-BINDING-1 — huella del plan y validación de la evidencia:
 *  - la huella es determinística e insensible al ORDEN, pero sensible a CUALQUIER cambio
 *    de contenido (entrada de más/menos, acción, request, changedFields, bloqueos);
 *  - `remoteOnly` NO participa: un alta externa sin acción no invalida el plan;
 *  - la evidencia se normaliza estricta (el runId viaja a una ruta de doc);
 *  - el validador cubre vigencia (TTL), pertenencia (catálogo/actor), estado y consumo.
 */

type Entry = CatalogSyncPlan['entries'][number];

const remoteSnap = (productId: string, over: Partial<NonNullable<Entry['remoteSnapshot']>> = {}): Entry['remoteSnapshot'] => ({
  remoteItemId: `itm-${productId}`,
  name: `Producto ${productId}`,
  description: 'desc remota',
  availability: 'in stock',
  price: '₲900',
  currency: 'PYG',
  imageUrl: 'https://ejemplo.com/img.jpg',
  url: 'https://ejemplo.com/p/1',
  brand: 'Marca',
  ...over,
});

const entry = (over: Partial<Entry> & { productId: string }): Entry =>
  ({
    sku: `SKU-${over.productId}`,
    internalSku: `sku-${over.productId}`,
    mapped: true,
    productName: `Producto ${over.productId}`,
    action: 'update',
    changedFields: ['price'],
    payload: { retailer_id: `SKU-${over.productId}`, price: '1000 PYG' },
    request: { method: 'UPDATE', data: { id: `SKU-${over.productId}`, price: '1000 PYG' } },
    remoteItemId: `itm-${over.productId}`,
    remoteSnapshot: remoteSnap(over.productId),
    ...over,
  }) as Entry;

/** Propiedad SANEADA del plan (ADR-0015): participa de la huella. */
const propiedad = (over: Partial<CatalogSyncPlan['ownership']> = {}): CatalogSyncPlan['ownership'] => ({
  model: 'vendeyapy_managed',
  fingerprint: 'own_aaaaaaaa',
  ownedFields: ['price', 'title'],
  externalFields: [],
  degraded: false,
  reasons: [],
  blockedActions: 0,
  ...over,
});

const plan = (entries: Entry[], over: Partial<CatalogSyncPlan> = {}): CatalogSyncPlan => ({
  entries,
  remoteOnly: [],
  ignoredArchived: 0,
  excludedNotManaged: 0,
  summary: { create: 0, update: entries.length, disable: 0, unchanged: 0, blocked: 0, remoteOnly: 0 },
  ownership: propiedad(),
  ...over,
});

describe('planFingerprint — determinística, sensible al contenido, insensible al orden', () => {
  it('mismo plan ⇒ misma huella; orden de entradas y de changedFields irrelevante', () => {
    const a = plan([entry({ productId: 'a', changedFields: ['price', 'name'] }), entry({ productId: 'b' })]);
    const b = plan([entry({ productId: 'b' }), entry({ productId: 'a', changedFields: ['name', 'price'] })]);
    expect(planFingerprint('t1', 'cat1', a)).toBe(planFingerprint('t1', 'cat1', b));
  });

  it('tenant o catálogo distinto ⇒ huella distinta (la evidencia no viaja entre empresas)', () => {
    const p = plan([entry({ productId: 'a' })]);
    const base = planFingerprint('t1', 'cat1', p);
    expect(planFingerprint('t2', 'cat1', p)).not.toBe(base);
    expect(planFingerprint('t1', 'cat2', p)).not.toBe(base);
  });

  it('cambio en el request congelado ⇒ huella distinta (es LO QUE SE ENVIARÍA)', () => {
    const a = plan([entry({ productId: 'a' })]);
    const b = plan([entry({ productId: 'a', request: { method: 'UPDATE', data: { id: 'SKU-a', price: '2000 PYG' } } as Entry['request'] })]);
    expect(planFingerprint('t1', 'cat1', a)).not.toBe(planFingerprint('t1', 'cat1', b));
  });

  it('acción distinta, entrada extra o bloqueo nuevo ⇒ huella distinta', () => {
    const base = planFingerprint('t1', 'cat1', plan([entry({ productId: 'a' })]));
    expect(planFingerprint('t1', 'cat1', plan([entry({ productId: 'a', action: 'disable' })]))).not.toBe(base);
    expect(planFingerprint('t1', 'cat1', plan([entry({ productId: 'a' }), entry({ productId: 'b' })]))).not.toBe(base);
    expect(
      planFingerprint('t1', 'cat1', plan([entry({ productId: 'a', action: 'blocked', blockedReasons: ['price_invalid'] as Entry['blockedReasons'] })])),
    ).not.toBe(base);
  });

  it('un `unchanged` que aparece también cambia la huella (el plan es OTRO)', () => {
    const base = planFingerprint('t1', 'cat1', plan([entry({ productId: 'a' })]));
    const conUnchanged = plan([entry({ productId: 'a' }), entry({ productId: 'b', action: 'unchanged', changedFields: undefined, request: undefined })]);
    expect(planFingerprint('t1', 'cat1', conUnchanged)).not.toBe(base);
  });

  it('el snapshot REMOTO participa: Meta modificado invalida aunque el request no cambie', () => {
    // Mismo request congelado, mismos changedFields (price ya difería): solo cambió el valor
    // remoto (alguien tocó Commerce Manager). El plan "a enviar" es idéntico — la huella NO.
    const a = plan([entry({ productId: 'a' })]);
    const b = plan([entry({ productId: 'a', remoteSnapshot: remoteSnap('a', { price: '₲950' }) })]);
    expect(planFingerprint('t1', 'cat1', a)).not.toBe(planFingerprint('t1', 'cat1', b));
  });

  it('una entrada create (sin item remoto) lleva snapshot null y es estable', () => {
    const c = () => plan([entry({ productId: 'a', action: 'create', remoteItemId: null, remoteSnapshot: null, changedFields: undefined })]);
    expect(planFingerprint('t1', 'cat1', c())).toBe(planFingerprint('t1', 'cat1', c()));
  });

  it('remoteOnly NO participa: candidatos informativos no invalidan la evidencia', () => {
    const a = plan([entry({ productId: 'a' })]);
    const b = plan([entry({ productId: 'a' })], { remoteOnly: [{ retailerId: 'EXTERNO', name: 'Alta externa' }] });
    expect(planFingerprint('t1', 'cat1', a)).toBe(planFingerprint('t1', 'cat1', b));
  });

  it('la PROPIEDAD participa: el mismo plan bajo otros permisos es otra huella (ADR-0015)', () => {
    // Un preview se aprueba bajo permisos concretos. Si entre la previsualización y el apply
    // alguien cambia quién gobierna qué, encolar sería ejecutar con permisos que nadie aprobó.
    const a = plan([entry({ productId: 'a' })]);
    const b = plan([entry({ productId: 'a' })], { ownership: propiedad({ fingerprint: 'own_bbbbbbbb' }) });
    expect(planFingerprint('t1', 'cat1', a)).not.toBe(planFingerprint('t1', 'cat1', b));
  });

  it('los campos que quedaron AFUERA por propiedad son parte del plan aprobado', () => {
    const a = plan([entry({ productId: 'a' })]);
    const b = plan([entry({ productId: 'a', notOwnedFields: ['title'] })]);
    expect(planFingerprint('t1', 'cat1', a)).not.toBe(planFingerprint('t1', 'cat1', b));
  });
});

describe('normalizePreviewEvidence — estricta (el runId es parte de una ruta de doc)', () => {
  it('acepta el formato real y normaliza el hash a minúsculas', () => {
    const ev = normalizePreviewEvidence({ runId: 'mcs_abc123_x1y2z3', planHash: 'ABCDEF0123456789' });
    expect(ev).toEqual({ runId: 'mcs_abc123_x1y2z3', planHash: 'abcdef0123456789' });
  });

  it('rechaza runId con separadores de ruta, prefijo ajeno, hash no-hex o evidencia ausente', () => {
    expect(normalizePreviewEvidence({ runId: 'mcs_a/b', planHash: 'a'.repeat(40) })).toBeNull();
    expect(normalizePreviewEvidence({ runId: 'otra_cosa', planHash: 'a'.repeat(40) })).toBeNull();
    expect(normalizePreviewEvidence({ runId: 'mcs_abc', planHash: 'zzzz' })).toBeNull();
    expect(normalizePreviewEvidence({ runId: 'mcs_abc' })).toBeNull();
    expect(normalizePreviewEvidence(null)).toBeNull();
    expect(normalizePreviewEvidence('mcs_abc')).toBeNull();
  });
});

describe('evaluatePreviewBinding — vigencia, pertenencia, estado y consumo', () => {
  const HASH = 'a'.repeat(40);
  const now = Timestamp.fromMillis(1_800_000_000_000);
  const doc = (over: Partial<PreviewDocData> = {}): PreviewDocData => ({
    requestedMode: 'dry_run',
    status: 'planned',
    planHash: HASH,
    catalogId: 'cat1',
    actorUid: 'user-1',
    finishedAt: Timestamp.fromMillis(now.toMillis() - 60_000),
    startedAt: Timestamp.fromMillis(now.toMillis() - 61_000),
    consumedAt: null,
    ...over,
  });
  const ctx = { evidence: { runId: 'mcs_abc_123', planHash: HASH }, catalogId: 'cat1', actorUid: 'user-1', now };

  it('preview sano y fresco ⇒ utilizable (null)', () => {
    expect(evaluatePreviewBinding(doc(), ctx)).toBeNull();
  });

  it('doc ausente ⇒ preview_not_found (cubre evidencia de otro tenant: la ruta es del propio)', () => {
    expect(evaluatePreviewBinding(null, ctx)).toBe('preview_not_found');
  });

  it('no es un dry_run planned con planHash ⇒ preview_not_usable', () => {
    expect(evaluatePreviewBinding(doc({ requestedMode: 'apply' }), ctx)).toBe('preview_not_usable');
    expect(evaluatePreviewBinding(doc({ status: 'queued' }), ctx)).toBe('preview_not_usable');
    expect(evaluatePreviewBinding(doc({ planHash: undefined }), ctx)).toBe('preview_not_usable');
    expect(evaluatePreviewBinding(doc({ finishedAt: null, startedAt: null }), ctx)).toBe('preview_not_usable');
  });

  it('hash provisto ≠ almacenado ⇒ preview_mismatch (y gana sobre el consumo: evidencia inválida primero)', () => {
    expect(evaluatePreviewBinding(doc({ planHash: 'b'.repeat(40), consumedAt: now }), ctx)).toBe('preview_mismatch');
  });

  it('catálogo distinto ⇒ preview_wrong_catalog', () => {
    expect(evaluatePreviewBinding(doc({ catalogId: 'cat2' }), ctx)).toBe('preview_wrong_catalog');
  });

  it('actor distinto o ausente (de cualquiera de los dos lados) ⇒ preview_actor_mismatch', () => {
    expect(evaluatePreviewBinding(doc({ actorUid: 'user-2' }), ctx)).toBe('preview_actor_mismatch');
    expect(evaluatePreviewBinding(doc({ actorUid: null }), ctx)).toBe('preview_actor_mismatch');
    expect(evaluatePreviewBinding(doc(), { ...ctx, actorUid: null })).toBe('preview_actor_mismatch');
  });

  it('ya consumido ⇒ preview_consumed (anti-replay)', () => {
    expect(evaluatePreviewBinding(doc({ consumedAt: now }), ctx)).toBe('preview_consumed');
  });

  it('TTL: exactamente en el límite sigue vigente; un milisegundo después vence', () => {
    const enElLimite = doc({ finishedAt: Timestamp.fromMillis(now.toMillis() - PREVIEW_TTL_MS) });
    const vencido = doc({ finishedAt: Timestamp.fromMillis(now.toMillis() - PREVIEW_TTL_MS - 1) });
    expect(evaluatePreviewBinding(enElLimite, ctx)).toBeNull();
    expect(evaluatePreviewBinding(vencido, ctx)).toBe('preview_expired');
  });

  it('sin finishedAt usa startedAt como ancla del TTL', () => {
    const soloStarted = doc({ finishedAt: null, startedAt: Timestamp.fromMillis(now.toMillis() - PREVIEW_TTL_MS - 1) });
    expect(evaluatePreviewBinding(soloStarted, ctx)).toBe('preview_expired');
  });
});
