import { describe, it, expect } from 'vitest';
import type { MetaRemoteCatalogItem } from './catalogClient.js';
import { MetaCatalogApiError } from './catalogClient.js';
import {
  chunkJobsForBatch,
  classifySubmitError,
  intentKeyOfJobId,
  isTerminalOutboxStatus,
  outboxGate,
  outboxIntentKey,
  outboxJobId,
  productStatusForJob,
  stableHash,
  verifyJobOutcome,
  verifyManagedField,
  type MetaCatalogOutboxJob,
} from './catalogOutbox.js';
import { normalizeCatalogOwnership, WRITABLE_FIELDS } from './catalogOwnership.js';
import { ownershipFingerprint } from './catalogOwnershipGates.js';

/**
 * META-CATALOG-OUTBOX-1 — contrato del outbox persistido de escrituras VendeyaPy → Meta.
 *
 * Lo que estos tests fijan y hoy NO existe:
 *  - una identidad de job DETERMINÍSTICA e INYECTIVA (dos confirmaciones idénticas = un job);
 *  - una verificación de TRES estados (la actual solo sabe "igual" o "distinto", y trata la
 *    ausencia de `url` en el GET como IGUAL — un `synced` falso);
 *  - un gate puro que decide, ANTES de escribir en Meta, si el job todavía corresponde.
 */

const remoto = (over: Partial<MetaRemoteCatalogItem> = {}): MetaRemoteCatalogItem => ({
  id: 'itm-1',
  retailerId: 'ARM-744646-5202',
  name: 'Armaf Odyssey Mega',
  description: 'Perfume fresco para el día a día',
  availability: 'in stock',
  price: '₲250.000',
  imageUrl: 'https://cdn.test/odyssey.jpg',
  brand: 'Armaf',
  url: 'https://arfagi.com/p/1',
  condition: 'new',
  ...over,
});

const CLAVE = {
  tenantId: 'arfagi',
  catalogId: '1032991642570797',
  retailerId: 'ARM-744646-5202',
  action: 'update' as const,
  intendedContentHash: 'h1',
};

/**
 * (ADR-0015) Propiedad total de VendeYaPy: el escenario histórico de estos tests. El job
 * congela SU huella al encolarse y el gate la recalcula antes del POST.
 */
const PROPIEDAD_TOTAL = normalizeCatalogOwnership({ model: 'vendeyapy_managed', ownedFields: [...WRITABLE_FIELDS], external: null });

const job = (over: Partial<MetaCatalogOutboxJob> = {}): MetaCatalogOutboxJob =>
  ({
    id: 'mco_x',
    tenantId: 'arfagi',
    catalogId: '1032991642570797',
    productId: 'p1',
    retailerId: 'ARM-744646-5202',
    action: 'update',
    intendedPatch: { id: 'ARM-744646-5202', price: '250000 PYG' },
    intendedContentHash: 'h1',
    ownershipFingerprint: ownershipFingerprint(PROPIEDAD_TOTAL),
    ownedFields: [...PROPIEDAD_TOTAL.writable],
    productSnapshotHash: 'snap1',
    status: 'queued',
    attempts: 0,
    leaseOwner: null,
    batchHandle: null,
    error: '',
    ...over,
  }) as MetaCatalogOutboxJob;

// ---------------------------------------------------------------------------
// 1. Identidad del job: determinística e INYECTIVA
// ---------------------------------------------------------------------------

describe('outboxIntentKey — identidad de la INTENCIÓN', () => {
  it('la misma confirmación produce SIEMPRE la misma clave', () => {
    expect(outboxIntentKey(CLAVE)).toBe(outboxIntentKey({ ...CLAVE }));
  });

  it.each([
    ['tenant', { tenantId: 'otro' }],
    ['catálogo', { catalogId: '999' }],
    ['retailer', { retailerId: 'OTRO-1' }],
    ['acción', { action: 'disable' as const }],
    ['contenido', { intendedContentHash: 'h2' }],
  ])('cambiar el %s cambia la clave', (_l, over) => {
    expect(outboxIntentKey({ ...CLAVE, ...over })).not.toBe(outboxIntentKey(CLAVE));
  });

  it('NO es una concatenación ambigua: componentes que "se corren" dan claves distintas', () => {
    const a = outboxIntentKey({ ...CLAVE, tenantId: 'a|b', catalogId: 'c' });
    const b = outboxIntentKey({ ...CLAVE, tenantId: 'a', catalogId: 'b|c' });
    expect(a).not.toBe(b);
  });

  it('es un id de documento válido de Firestore', () => {
    const id = outboxIntentKey({ ...CLAVE, retailerId: 'ARM/744646#5202' });
    expect(id).not.toContain('/');
    expect(id).not.toContain('.');
    expect(id.length).toBeGreaterThan(8);
    expect(id.length).toBeLessThanOrEqual(120);
  });
});

describe('outboxJobId — una EJECUCIÓN de la intención', () => {
  const intent = outboxIntentKey(CLAVE);

  it('cada ciclo tiene su propio id: la historia no se pisa', () => {
    expect(outboxJobId(intent, 1)).not.toBe(outboxJobId(intent, 2));
    expect(outboxJobId(intent, 2)).not.toBe(outboxJobId(intent, 3));
  });

  it('el mismo ciclo de la misma intención es siempre el mismo id', () => {
    expect(outboxJobId(intent, 7)).toBe(outboxJobId(intent, 7));
  });

  it('el orden lexicográfico coincide con el cronológico (Firestore ordena por id)', () => {
    const ids = [outboxJobId(intent, 10), outboxJobId(intent, 2), outboxJobId(intent, 1)];
    expect([...ids].sort()).toEqual([outboxJobId(intent, 1), outboxJobId(intent, 2), outboxJobId(intent, 10)]);
  });

  it('se puede volver de un job a su intención', () => {
    expect(intentKeyOfJobId(outboxJobId(intent, 42))).toBe(intent);
    expect(intentKeyOfJobId(outboxJobId(intent, 1))).toBe(intent);
  });

  it('intenciones distintas jamás comparten id de job', () => {
    const otra = outboxIntentKey({ ...CLAVE, intendedContentHash: 'h2' });
    expect(outboxJobId(otra, 1)).not.toBe(outboxJobId(intent, 1));
  });

  it('sigue siendo un id de documento válido', () => {
    const id = outboxJobId(outboxIntentKey({ ...CLAVE, retailerId: 'ARM/744646#5202' }), 3);
    expect(id).not.toContain('/');
    expect(id.length).toBeLessThanOrEqual(120);
  });
});

describe('stableHash — hash de contenido', () => {
  it('no depende del orden de las claves', () => {
    expect(stableHash({ a: 1, b: { c: 2, d: 3 } })).toBe(stableHash({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('cambia si cambia cualquier valor', () => {
    expect(stableHash({ price: '250000 PYG' })).not.toBe(stableHash({ price: '130000 PYG' }));
  });

  it('distingue un valor ausente de uno vacío', () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 1, b: '' }));
  });

  it('distingue tipos: "1" no es 1', () => {
    expect(stableHash({ a: '1' })).not.toBe(stableHash({ a: 1 }));
  });
});

// ---------------------------------------------------------------------------
// 2. Verificación de TRES estados
// ---------------------------------------------------------------------------

describe('verifyManagedField — confirmed_equal | confirmed_different | unverifiable', () => {
  it('EL FIX: hay link local pero Meta no devuelve `url` ⇒ unverifiable, JAMÁS equal', () => {
    expect(verifyManagedField('link', 'https://arfagi.com/p/1', remoto({ url: '' }))).toBe('unverifiable');
    expect(verifyManagedField('link', 'https://arfagi.com/p/1', remoto({ url: undefined }))).toBe('unverifiable');
  });

  it('el link coincide tras normalizar (Meta agrega barra, baja el host)', () => {
    expect(verifyManagedField('link', 'https://arfagi.com/', remoto({ url: 'https://ARFAGI.com' }))).toBe('confirmed_equal');
  });

  it('un link distinto es confirmed_different', () => {
    expect(verifyManagedField('link', 'https://arfagi.com/p/1', remoto({ url: 'https://otro.com/x' }))).toBe('confirmed_different');
  });

  it('el precio se compara por dígitos (Meta lo formatea)', () => {
    expect(verifyManagedField('price', '250000 PYG', remoto({ price: '₲250.000' }))).toBe('confirmed_equal');
    expect(verifyManagedField('price', '250000 PYG', remoto({ price: '₲130.000' }))).toBe('confirmed_different');
    expect(verifyManagedField('price', '250000 PYG', remoto({ price: '' }))).toBe('unverifiable');
  });

  it('los decimales del formateo de Meta no inventan divergencias (misma regla que el plan)', () => {
    // PYG no lleva decimales: "₲250.000,00" y "PYG250,000.00" son el mismo precio que
    // "250000 PYG". Sin esta regla el plan decía "sin cambios" y la verificación "distinto".
    expect(verifyManagedField('price', '250000 PYG', remoto({ price: '₲250.000,00' }))).toBe('confirmed_equal');
    expect(verifyManagedField('price', '250000 PYG', remoto({ price: 'PYG250,000.00' }))).toBe('confirmed_equal');
    // Un decimal REAL (no ,00) sigue siendo una diferencia.
    expect(verifyManagedField('price', '250000 PYG', remoto({ price: '₲250.000,50' }))).toBe('confirmed_different');
  });

  it('la MONEDA declarada manda sobre los dígitos', () => {
    // Mismos dígitos, otra moneda: el precio NO está confirmado, está confirmadamente distinto.
    expect(verifyManagedField('price', '250000 PYG', remoto({ price: '250,000', currency: 'USD' }))).toBe('confirmed_different');
    expect(verifyManagedField('price', '250000 PYG', remoto({ price: '₲250.000', currency: 'PYG' }))).toBe('confirmed_equal');
    // Sin moneda remota no se inventa una divergencia: se compara por dígitos como siempre.
    expect(verifyManagedField('price', '250000 PYG', remoto({ price: '₲250.000', currency: '' }))).toBe('confirmed_equal');
  });

  it('el artículo no aparece en el GET ⇒ TODO es unverifiable', () => {
    for (const f of ['title', 'description', 'link', 'price', 'availability', 'brand', 'image', 'condition']) {
      expect(verifyManagedField(f, 'lo que sea', null)).toBe('unverifiable');
    }
  });

  it('la imagen viaja como array y vuelve como string', () => {
    expect(verifyManagedField('image', [{ url: 'https://cdn.test/odyssey.jpg' }], remoto())).toBe('confirmed_equal');
    expect(verifyManagedField('image', [{ url: 'https://cdn.test/otra.jpg' }], remoto())).toBe('confirmed_different');
    expect(verifyManagedField('image', [{ url: 'https://cdn.test/odyssey.jpg' }], remoto({ imageUrl: '' }))).toBe('unverifiable');
  });

  it.each([
    ['title', 'Armaf Odyssey Mega', 'name'],
    ['description', 'Perfume fresco para el día a día', 'description'],
    ['availability', 'in stock', 'availability'],
    ['brand', 'Armaf', 'brand'],
    ['condition', 'new', 'condition'],
  ])('%s se confirma contra `%s` del contrato de lectura', (campo, valor, remoteKey) => {
    expect(verifyManagedField(campo, valor, remoto())).toBe('confirmed_equal');
    expect(verifyManagedField(campo, `${valor} X`, remoto())).toBe('confirmed_different');
    expect(verifyManagedField(campo, valor, remoto({ [remoteKey]: '' } as Partial<MetaRemoteCatalogItem>))).toBe('unverifiable');
  });
});

describe('verifyJobOutcome — solo los campos del patch', () => {
  it('un UPDATE de SOLO precio se confirma con el precio (no exige el resto)', () => {
    const r = verifyJobOutcome({ id: 'ARM-744646-5202', price: '250000 PYG' }, remoto({ name: 'otro nombre en Meta', url: '' }));
    expect(r.outcome).toBe('confirmed_equal');
    expect(Object.keys(r.verdicts)).toEqual(['price']);
  });

  it('un CREATE exige los nueve obligatorios', () => {
    const patch = {
      id: 'ARM-744646-5202',
      title: 'Armaf Odyssey Mega',
      description: 'Perfume fresco para el día a día',
      link: 'https://arfagi.com/p/1',
      price: '250000 PYG',
      availability: 'in stock',
      condition: 'new',
      brand: 'Armaf',
      image: [{ url: 'https://cdn.test/odyssey.jpg' }],
    };
    expect(verifyJobOutcome(patch, remoto()).outcome).toBe('confirmed_equal');
    // Sin `url` en el GET, el CREATE NO puede declararse confirmado.
    expect(verifyJobOutcome(patch, remoto({ url: '' })).outcome).toBe('unverifiable');
  });

  it('un solo campo distinto manda: el resultado es confirmed_different', () => {
    const r = verifyJobOutcome({ id: 'X', price: '250000 PYG', brand: 'Otra' }, remoto());
    expect(r.outcome).toBe('confirmed_different');
  });

  it('different gana sobre unverifiable (hay evidencia de divergencia)', () => {
    const r = verifyJobOutcome({ id: 'X', price: '130000 PYG', link: 'https://arfagi.com/p/1' }, remoto({ url: '' }));
    expect(r.outcome).toBe('confirmed_different');
  });

  it('la identidad no es un campo a verificar', () => {
    expect(Object.keys(verifyJobOutcome({ id: 'X', price: '250000 PYG' }, remoto()).verdicts)).not.toContain('id');
  });
});

// ---------------------------------------------------------------------------
// 3. Gate del worker: qué se decide ANTES de tocar Meta
// ---------------------------------------------------------------------------

const CTX_OK = {
  tenantId: 'arfagi',
  config: { enabled: true, mode: 'live' as const, catalogId: '1032991642570797' },
  ownership: PROPIEDAD_TOTAL,
  product: { exists: true, syncToMeta: true, stockPendingReview: false, snapshotHash: 'snap1' },
};

describe('outboxGate — fail-closed antes de escribir', () => {
  it('con todo en orden, autoriza el envío', () => {
    expect(outboxGate(job(), CTX_OK)).toEqual({ go: true });
  });

  it.each([
    ['config apagada', { config: { ...CTX_OK.config, enabled: false } }, 'held', 'config_disabled'],
    ['dry_run', { config: { ...CTX_OK.config, mode: 'dry_run' as const } }, 'held', 'mode_not_live'],
    ['off explícito', { config: { ...CTX_OK.config, mode: 'off' as const } }, 'held', 'mode_not_live'],
    ['otro catálogo', { config: { ...CTX_OK.config, catalogId: '999' } }, 'needs_action', 'catalog_mismatch'],
    ['producto borrado', { product: null }, 'cancelled', 'product_missing'],
    ['sync apagada', { product: { ...CTX_OK.product, syncToMeta: false } }, 'cancelled', 'sync_disabled'],
    ['stock sin revisar', { product: { ...CTX_OK.product, stockPendingReview: true } }, 'cancelled', 'stock_pending_review'],
    ['producto editado', { product: { ...CTX_OK.product, snapshotHash: 'snap2' } }, 'stale', 'product_changed'],
  ])('%s ⇒ %s', (_l, over, status, reason) => {
    const r = outboxGate(job(), { ...CTX_OK, ...over });
    expect(r).toEqual({ go: false, status, reason });
  });

  it('la configuración apagada gana sobre cualquier otro motivo (cero escrituras)', () => {
    const r = outboxGate(job(), { tenantId: 'arfagi', config: { enabled: false, mode: 'live', catalogId: '999' }, ownership: PROPIEDAD_TOTAL, product: null });
    expect(r).toEqual({ go: false, status: 'held', reason: 'config_disabled' });
  });

  it('un job de OTRO tenant nunca se autoriza', () => {
    expect(outboxGate(job({ tenantId: 'credipower' }), CTX_OK)).toEqual({ go: false, status: 'needs_action', reason: 'tenant_mismatch' });
  });
});

// ---------------------------------------------------------------------------
// 4. Clasificación del error de envío: la ambigüedad NUNCA se reintenta a ciegas
// ---------------------------------------------------------------------------

describe('classifySubmitError', () => {
  it('4xx funcional ⇒ confirmado NO aplicado', () => {
    expect(classifySubmitError(new MetaCatalogApiError('400', 'http', 400, 100, false))).toBe('confirmed_not_applied');
  });

  it('429 agotado ⇒ rate limit (no se aplicó: se puede reencolar sin GET)', () => {
    expect(classifySubmitError(new MetaCatalogApiError('429', 'http', 429, 4, true))).toBe('rate_limited');
  });

  it('5xx o red agotados ⇒ AMBIGUO (pudo haberse aplicado)', () => {
    expect(classifySubmitError(new MetaCatalogApiError('500', 'http', 500, null, true))).toBe('ambiguous');
    expect(classifySubmitError(new MetaCatalogApiError('red', 'http', null, null, true))).toBe('ambiguous');
  });

  it('cualquier excepción desconocida es AMBIGUA, nunca "no aplicado"', () => {
    expect(classifySubmitError(new Error('boom'))).toBe('ambiguous');
  });
});

// ---------------------------------------------------------------------------
// 5. Chunking por cantidad Y por tamaño serializado
// ---------------------------------------------------------------------------

describe('chunkJobsForBatch', () => {
  const conPatch = (n: number, relleno = 10) =>
    Array.from({ length: n }, (_, i) => job({ id: `j${i}`, intendedPatch: { id: `R${i}`, description: 'x'.repeat(relleno) } }));

  it('respeta el tope de cantidad', () => {
    const { chunk, resto } = chunkJobsForBatch(conPatch(10), { maxJobs: 4, maxBytes: 1_000_000 });
    expect(chunk).toHaveLength(4);
    expect(resto).toHaveLength(6);
  });

  it('respeta el tope de bytes serializados', () => {
    const { chunk } = chunkJobsForBatch(conPatch(10, 500), { maxJobs: 100, maxBytes: 1200 });
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThan(10);
  });

  it('un job que por sí solo excede el tope viaja SOLO (nunca queda atascado para siempre)', () => {
    const grande = job({ id: 'grande', intendedPatch: { id: 'R', description: 'x'.repeat(5000) } });
    const { chunk, resto } = chunkJobsForBatch([grande, ...conPatch(3)], { maxJobs: 100, maxBytes: 1000 });
    expect(chunk).toHaveLength(1);
    expect(chunk[0]!.id).toBe('grande');
    expect(resto).toHaveLength(3);
  });

  it('lista vacía ⇒ chunk vacío', () => {
    expect(chunkJobsForBatch([], { maxJobs: 10, maxBytes: 100 })).toEqual({ chunk: [], resto: [] });
  });
});

// ---------------------------------------------------------------------------
// 6. Estados
// ---------------------------------------------------------------------------

describe('estados del job', () => {
  it.each([
    ['succeeded', true],
    ['failed', true],
    ['cancelled', true],
    ['stale', true],
    ['queued', false],
    ['processing', false],
    ['submitted', false],
    ['held', false],
    ['needs_action', false],
    ['needs_reconciliation', false],
  ])('%s terminal=%s', (s, esperado) => {
    expect(isTerminalOutboxStatus(s as MetaCatalogOutboxJob['status'])).toBe(esperado);
  });

  it.each([
    ['queued', 'queued'],
    ['processing', 'processing'],
    ['submitted', 'processing'],
    ['succeeded', 'synced'],
    ['failed', 'failed'],
    ['needs_action', 'needs_review'],
    ['needs_reconciliation', 'needs_review'],
    ['stale', 'needs_review'],
    ['held', 'queued'],
  ])('el job %s se le muestra al usuario como %s', (s, esperado) => {
    expect(productStatusForJob(job({ status: s as MetaCatalogOutboxJob['status'] }))).toBe(esperado);
  });

  it('un disable confirmado se muestra como `disabled`, no como `synced`', () => {
    expect(productStatusForJob(job({ status: 'succeeded', action: 'disable' }))).toBe('disabled');
  });

  it('un job cancelado devuelve el producto a `not_synced` (no es un error del usuario)', () => {
    expect(productStatusForJob(job({ status: 'cancelled' }))).toBe('not_synced');
  });
});
