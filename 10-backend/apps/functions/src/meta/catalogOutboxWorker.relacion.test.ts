import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Review ADR-0022 — A1/A2: el outbox bajo mirror/none.
 *
 * A1: gatear el mantenimiento ENTERO dejaba jobs no-terminales ZOMBIS (nadie los normalizaba)
 * que además bloqueaban el REGRESO a managed (`outbox_not_terminal`) — deadlock. El contrato
 * correcto: el SWEEP y la CONFIRMACIÓN corren SIEMPRE (ninguno escribe a Meta; confirmar solo
 * LEE), y lo único gateado por relación es el DRENAJE (la escritura).
 *
 * A2: `enqueueCatalogPlan` usaba la config de ARRANQUE del apply (hasta 300 s viejo): una
 * transición de autoridad en el medio dejaba jobs encolados bajo `none`. La relación se
 * re-deriva DENTRO de la transacción de encolado (misma filosofía que la re-validación de
 * ownership ADR-0015 §7): si ya no es `managed`, CERO jobs.
 */

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../entitlements/entitlements.js', () => ({
  resolveEntitlements: vi.fn(async () => ({ features: { marketingAutomation: true } })),
  isFeatureEnabled: (f: Record<string, boolean>, k: string) => f[k] === true,
  assertFeatureEnabled: vi.fn(async () => {}),
  assertWithinLimit: vi.fn(async () => {}),
}));

// ── Firestore en memoria (subset: docs por path, queries encadenadas, tx serializadas) ──
const docs = new Map<string, Record<string, unknown>>();
let cola: Promise<unknown> = Promise.resolve();

const idDe = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const millisDe = (v: unknown): number => {
  const t = v as { toMillis?: () => number } | number | null | undefined;
  if (t && typeof (t as { toMillis?: () => number }).toMillis === 'function') return (t as { toMillis: () => number }).toMillis();
  return typeof t === 'number' ? t : Number.NaN;
};
const snapDe = (path: string) => ({ exists: docs.has(path), id: idDe(path), ref: refDe(path), data: () => docs.get(path) });

function setDotPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const partes = path.split('.');
  let nodo = doc;
  for (const p of partes.slice(0, -1)) {
    if (typeof nodo[p] !== 'object' || nodo[p] === null) nodo[p] = {};
    nodo = nodo[p] as Record<string, unknown>;
  }
  nodo[partes.at(-1)!] = value;
}
function aplicarUpdate(path: string, args: unknown[]): void {
  const doc = { ...(docs.get(path) as Record<string, unknown>) };
  if (typeof args[0] === 'string') {
    for (let i = 0; i < args.length; i += 2) setDotPath(doc, args[i] as string, args[i + 1]);
  } else {
    for (const [k, v] of Object.entries(args[0] as Record<string, unknown>)) setDotPath(doc, k, v);
  }
  docs.set(path, doc);
}

function refDe(path: string): Record<string, unknown> {
  return {
    path,
    id: idDe(path),
    async get() { return snapDe(path); },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
    },
    async update(...args: unknown[]) { aplicarUpdate(path, args); },
    async create(data: Record<string, unknown>) {
      if (docs.has(path)) throw new Error(`ALREADY_EXISTS: ${path}`);
      docs.set(path, { ...data });
    },
  };
}

interface Filtro { campo: string; op: string; valor: unknown }
function consulta(path: string, filtros: Filtro[], limite: number) {
  return {
    where: (campo: string, op: string, valor: unknown) => consulta(path, [...filtros, { campo, op, valor }], limite),
    orderBy: () => consulta(path, filtros, limite),
    limit: (n: number) => consulta(path, filtros, n),
    async get() {
      const prefijo = `${path}/`;
      const encontrados = [...docs.entries()]
        .filter(([p, d]) => {
          if (!p.startsWith(prefijo) || p.slice(prefijo.length).includes('/')) return false;
          return filtros.every((f) => {
            const v = d[f.campo];
            if (f.op === '==') return v === f.valor;
            if (f.op === 'in') return Array.isArray(f.valor) && (f.valor as unknown[]).includes(v);
            if (f.op === '>=') return millisDe(v) >= millisDe(f.valor);
            if (f.op === '<=') return millisDe(v) <= millisDe(f.valor);
            throw new Error(`op no soportado: ${f.op}`);
          });
        })
        .slice(0, limite)
        .map(([p]) => snapDe(p));
      return { docs: encontrados, size: encontrados.length, empty: !encontrados.length };
    },
  };
}

const fakeDb = {
  doc: (path: string) => refDe(path),
  collection: (path: string) => ({
    doc: (id: string) => refDe(`${path}/${id}`),
    where: (campo: string, op: string, valor: unknown) => consulta(path, [{ campo, op, valor }], 1000),
    limit: (n: number) => consulta(path, [], n),
  }),
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const turno = cola.then(async () => {
      const escrituras: Array<() => void> = [];
      const tx = {
        async get(x: { path?: string; get?: () => Promise<unknown> }) {
          if (typeof x.path === 'string') return snapDe(x.path);
          return (x as { get: () => Promise<unknown> }).get();
        },
        set(ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) {
          escrituras.push(() => { docs.set(ref.path, opts?.merge ? { ...(docs.get(ref.path) ?? {}), ...data } : { ...data }); });
        },
        update(ref: { path: string }, ...args: unknown[]) { escrituras.push(() => aplicarUpdate(ref.path, args)); },
        create(ref: { path: string }, data: Record<string, unknown>) {
          escrituras.push(() => {
            if (docs.has(ref.path)) throw new Error(`ALREADY_EXISTS: ${ref.path}`);
            docs.set(ref.path, { ...data });
          });
        },
      };
      const r = await fn(tx);
      for (const w of escrituras) w();
      return r;
    });
    cola = turno.catch(() => {});
    return turno as Promise<T>;
  },
};

vi.mock('../lib/firebase.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/firebase.js')>();
  return { ...actual, db: () => fakeDb };
});

const { runCatalogOutboxForTenant, enqueueCatalogPlan } = await import('./catalogOutboxWorker.js');
const { normalizeCatalogOwnership } = await import('./catalogOwnership.js');
const { Timestamp } = await import('firebase-admin/firestore');

const T = 'tenant_mirror';

const arfagiRaw = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  mode: 'dry_run',
  catalogId: 'cat_a',
  ownership: {
    model: 'external_managed',
    ownedFields: [],
    external: {
      kind: 'meta_feed', acknowledgedSourceIds: ['f1'], declaredFields: ['price'],
      fingerprint: 'fp', acknowledgedAt: null, acknowledgedByUid: 'u',
    },
    lastSourceCheckAt: null,
  },
  ...over,
});

const managedRaw = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  mode: 'live',
  catalogId: 'cat_m',
  ownership: { model: 'vendeyapy_managed', ownedFields: ['title', 'price'], external: null, lastSourceCheckAt: null },
  ...over,
});

const jobDoc = (id: string, over: Record<string, unknown> = {}) => ({
  id, intentKey: `int_${id}`, cycle: 1, tenantId: T, catalogId: 'cat_a', productId: `p_${id}`,
  retailerId: `SKU-${id}`, action: 'update', intendedPatch: { id: `SKU-${id}`, price: '100 PYG' },
  intendedContentHash: 'h', ownershipFingerprint: 'own_x', ownedFields: ['price'],
  productSnapshotHash: 's', runId: 'mcs_x', requestedByUid: 'u', requestedByRole: 'TENANT_OWNER',
  status: 'queued', attempts: 1, leaseOwner: null, leaseUntil: null, batchHandle: null,
  reason: null, error: '', attentionRequired: false, reviewedAt: null, reviewedReason: null,
  createdAt: Timestamp.now(), updatedAt: Timestamp.now(), submittedAt: null, reconciledAt: null,
  ...over,
});

beforeEach(() => {
  docs.clear();
  cola = Promise.resolve();
});

describe('A1 — runCatalogOutboxForTenant con el drenaje gateado por relación', () => {
  it('skipDrain: el SWEEP normaliza un processing con lease vencida y el DRENAJE no corre (mirror sin zombis)', async () => {
    docs.set(`tenants/${T}/config/meta`, { catalogSync: arfagiRaw() });
    docs.set(`tenants/${T}/metaCatalogOutboxJobs/j_zombi`, jobDoc('j_zombi', {
      status: 'processing',
      leaseOwner: 'worker_muerto',
      leaseUntil: Timestamp.fromMillis(Date.now() - 60_000), // lease VENCIDA
    }));
    docs.set(`tenants/${T}/metaCatalogOutboxJobs/j_cola`, jobDoc('j_cola', { status: 'queued' }));

    const publicView = vi.fn();
    const r = await runCatalogOutboxForTenant(T, publicView, { skipDrain: true });

    // El zombi ESCALÓ (deja de ser invisible y de bloquear el regreso a managed para siempre).
    expect(r.sweep.normalized).toBe(1);
    expect((docs.get(`tenants/${T}/metaCatalogOutboxJobs/j_zombi`) as { status: string }).status).toBe('needs_reconciliation');
    // El drenaje NO corrió: el queued sigue queued, nada se reclamó y la vista pública ni se pidió.
    expect(r.drain).toMatchObject({ claimed: 0, submitted: 0, skipped: 'relationship_not_managed' });
    expect((docs.get(`tenants/${T}/metaCatalogOutboxJobs/j_cola`) as { status: string }).status).toBe('queued');
    expect(publicView).not.toHaveBeenCalled();
    // La confirmación SÍ corrió (es lectura): sin cliente de Meta reporta unreachable, sin crash.
    expect(r.reconcile.checked).toBe(0);
  });

  it('sin skipDrain el drenaje corre como siempre (no-regresión del tenant managed)', async () => {
    docs.set(`tenants/${T}/config/meta`, { catalogSync: managedRaw({ mode: 'dry_run' }) });
    const r = await runCatalogOutboxForTenant(T, vi.fn(), {});
    // dry_run ⇒ el drenaje llegó a SU gate de siempre (mode_not_live), no al de relación.
    expect(r.drain.skipped).toBe('mode_not_live');
  });
});

describe('A2 — enqueueCatalogPlan re-deriva la relación DENTRO del encolado', () => {
  const entry = () => ({
    productId: 'p1',
    sku: 'SKU-1',
    action: 'update' as const,
    request: { method: 'UPDATE' as const, data: { id: 'SKU-1', price: '250000 PYG' } },
    payload: { id: 'SKU-1', price: '250000 PYG' },
    remoteItemId: null,
  });
  const cfgDe = (raw: unknown) => ({ catalogId: 'cat_m', ownership: normalizeCatalogOwnership((raw as { ownership: unknown }).ownership) });

  it('la relación cambió a none entre el gate del apply y el encolado ⇒ CERO jobs (carrera cerrada)', async () => {
    // La config del ARRANQUE del apply era managed…
    const cfgArranque = cfgDe(managedRaw());
    // …pero una transición de autoridad aterrizó `relationship:'none'` antes del encolado.
    docs.set(`tenants/${T}/config/meta`, { catalogSync: managedRaw({ relationship: 'none' }) });

    const r = await enqueueCatalogPlan(T, 'mcs_run', [entry()], cfgArranque, { uid: 'u', role: 'TENANT_OWNER' });
    expect(r.queued).toBe(0);
    expect(r.relationshipBlocked).toBe(1);
    expect([...docs.keys()].filter((k) => k.includes('metaCatalogOutboxJobs'))).toEqual([]);
    expect([...docs.keys()].filter((k) => k.includes('metaCatalogOutboxIntents'))).toEqual([]);
  });

  it('con la relación managed vigente el encolado sigue funcionando (no-regresión)', async () => {
    docs.set(`tenants/${T}/config/meta`, { catalogSync: managedRaw() });
    const r = await enqueueCatalogPlan(T, 'mcs_run', [entry()], cfgDe(managedRaw()), { uid: 'u', role: 'TENANT_OWNER' });
    expect(r.queued).toBe(1);
    expect([...docs.keys()].filter((k) => k.includes('metaCatalogOutboxJobs'))).toHaveLength(1);
  });
});
