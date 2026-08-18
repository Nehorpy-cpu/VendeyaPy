import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0022 §3 — preview→apply de autoridad contra un Firestore EN MEMORIA. Lo que discrimina:
 *  · RBAC completo (manager/seller/viewer rechazados; PLATFORM_ADMIN exige tenantId);
 *  · cada bloqueo del preview con su detalle, y que un preview bloqueado NO emite planHash;
 *  · el apply con evidencia: replay ⇒ consumed, hash ajeno ⇒ mismatch, otro actor ⇒
 *    actor_mismatch, vencido ⇒ expired, run de otro tenant ⇒ not_found, config mutada ⇒
 *    concurrent_change, y trabajo aparecido a último momento ⇒ re-chequeo;
 *  · el UPDATE MASK: enabled/mode/catalogId/ownership quedan EXACTAMENTE iguales tras el
 *    apply (salvo ownership cuando la transición cambia de modelo), CERO deletes y CERO jobs;
 *  · el gate por relación (`requireCatalogRelationship`): mirror importa pero no escribe a
 *    Meta; none bloquea todo; managed pasa.
 */

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const auditadas: Array<Record<string, unknown>> = [];
vi.mock('../../audit/audit.js', () => ({
  AUDIT_ACTIONS: [],
  recordAudit: vi.fn(async (entry: Record<string, unknown>) => {
    auditadas.push(entry);
  }),
}));

// ── Firestore en memoria (documentos por path, transacciones serializadas) ──

const docs = new Map<string, Record<string, unknown>>();
let cola: Promise<unknown> = Promise.resolve();
let autoId = 0;

const idDe = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const millisDe = (v: unknown): number => {
  const t = v as { toMillis?: () => number } | number | null | undefined;
  if (t && typeof (t as { toMillis?: () => number }).toMillis === 'function') return (t as { toMillis: () => number }).toMillis();
  return typeof t === 'number' ? t : Number.NaN;
};

function esObjetoPlano(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { toMillis?: unknown }).toMillis !== 'function';
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = esObjetoPlano(v) && esObjetoPlano(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

/** `update('a.b', v)`: crea mapas intermedios, como Firestore. */
function setDotPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const partes = path.split('.');
  let nodo = doc;
  for (const p of partes.slice(0, -1)) {
    if (!esObjetoPlano(nodo[p])) nodo[p] = {};
    nodo = nodo[p] as Record<string, unknown>;
  }
  nodo[partes.at(-1)!] = value;
}

const snapDe = (path: string) => ({ exists: docs.has(path), id: idDe(path), data: () => docs.get(path) });

function aplicarUpdate(path: string, args: unknown[]): void {
  if (!docs.has(path)) throw new Error(`update sobre doc inexistente: ${path}`);
  const doc = { ...(docs.get(path) as Record<string, unknown>) };
  if (typeof args[0] === 'string') {
    for (let i = 0; i < args.length; i += 2) setDotPath(doc, args[i] as string, args[i + 1]);
  } else {
    for (const [k, v] of Object.entries(args[0] as Record<string, unknown>)) setDotPath(doc, k, v);
  }
  docs.set(path, doc);
}

function refDe(path: string) {
  return {
    path,
    id: idDe(path),
    async get() {
      return snapDe(path);
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      docs.set(path, opts?.merge ? deepMerge(docs.get(path) ?? {}, data) : { ...data });
    },
    async create(data: Record<string, unknown>) {
      if (docs.has(path)) throw new Error(`ALREADY_EXISTS: ${path}`);
      docs.set(path, { ...data });
    },
    async update(...args: unknown[]) {
      aplicarUpdate(path, args);
    },
  };
}

interface Filtro {
  campo: string;
  op: string;
  valor: unknown;
}

function consulta(path: string, filtros: Filtro[], limite: number) {
  const api = {
    where: (campo: string, op: string, valor: unknown) => consulta(path, [...filtros, { campo, op, valor }], limite),
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
            throw new Error(`operador no soportado en el fake: ${f.op}`);
          });
        })
        .slice(0, limite)
        .map(([p]) => snapDe(p));
      return { docs: encontrados, size: encontrados.length, empty: !encontrados.length };
    },
  };
  return api;
}

function coleccion(path: string) {
  return {
    doc: (id?: string) => refDe(`${path}/${id ?? `auto_${++autoId}`}`),
    where: (campo: string, op: string, valor: unknown) => consulta(path, [{ campo, op, valor }], 1000),
    limit: (n: number) => consulta(path, [], n),
    async get() {
      return consulta(path, [], 100000).get();
    },
  };
}

const fakeDb = {
  doc: (path: string) => refDe(path),
  collection: (path: string) => coleccion(path),
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const turno = cola.then(async () => {
      const escrituras: Array<() => void> = [];
      const tx = {
        async get(ref: { path: string }) {
          return snapDe(ref.path);
        },
        set(ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) {
          escrituras.push(() => {
            docs.set(ref.path, opts?.merge ? deepMerge(docs.get(ref.path) ?? {}, data) : { ...data });
          });
        },
        update(ref: { path: string }, ...args: unknown[]) {
          escrituras.push(() => aplicarUpdate(ref.path, args));
        },
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

vi.mock('../../lib/firebase.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/firebase.js')>();
  return { ...actual, db: () => fakeDb };
});

// Después de los mocks: el import arrastra lib/firebase mockeado.
const { metaCatalogAuthorityPreview, metaCatalogAuthorityApply } = await import('./catalogAuthorityCallables.js');
const { metaCatalogOutboxDiscard, metaCatalogOutboxReconcile } = await import('./catalogOutboxCallables.js');
const { metaCatalogVerificationRun } = await import('./catalogVerificationCallables.js');
const { requireCatalogRelationship } = await import('../../meta/catalogAuthority.js');
const { Timestamp } = await import('firebase-admin/firestore');

// ── Helpers ──

const T1 = 'tenant_uno';
const T2 = 'tenant_dos';

type Rol = 'TENANT_OWNER' | 'TENANT_MANAGER' | 'TENANT_SELLER' | 'TENANT_VIEWER' | 'PLATFORM_ADMIN';
const reqDe = (data: Record<string, unknown>, rol?: Rol, uid = 'uid_owner', tenantId: string | undefined = T1) => ({
  data,
  auth: rol ? { uid, token: { role: rol, ...(rol === 'PLATFORM_ADMIN' ? {} : { tenantId }) } } : undefined,
  rawRequest: {},
});

const preview = (data: Record<string, unknown>, rol?: Rol, uid?: string, tenantId?: string) =>
  (metaCatalogAuthorityPreview as unknown as { run: (r: unknown) => Promise<Record<string, unknown>> }).run(reqDe(data, rol, uid, tenantId));
const apply = (data: Record<string, unknown>, rol?: Rol, uid?: string, tenantId?: string) =>
  (metaCatalogAuthorityApply as unknown as { run: (r: unknown) => Promise<Record<string, unknown>> }).run(reqDe(data, rol, uid, tenantId));

const esperarError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; details?: { reason?: string; kind?: string; relationship?: string } };
  }
  throw new Error('se esperaba un error y la llamada resolvió');
};

const managedRaw = () => ({
  enabled: true,
  mode: 'live',
  catalogId: 'cat_managed',
  sourceOfTruth: 'vendeyapy',
  ownership: { model: 'vendeyapy_managed', ownedFields: ['title', 'price'], external: null, lastSourceCheckAt: null },
});

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

const seedConfig = (tenantId: string, catalogSync: unknown) => {
  docs.set(`tenants/${tenantId}/config/meta`, { catalogSync });
};
const seedConnection = (tenantId: string) => {
  docs.set(`tenants/${tenantId}/metaConnections/main`, { id: 'main', status: 'active', tokenSecretRef: 'secret://tok' });
};

const A = { authority: 'vendeyapy', relationship: 'none' };
const B = { authority: 'vendeyapy', relationship: 'managed' };
const D = { authority: 'external', relationship: 'mirror' };

beforeEach(() => {
  docs.clear();
  auditadas.length = 0;
  cola = Promise.resolve();
});

describe('RBAC — preview/apply son OWNER/PLATFORM_ADMIN', () => {
  it('manager, seller y viewer quedan DENEGADOS en ambos callables', async () => {
    for (const rol of ['TENANT_MANAGER', 'TENANT_SELLER', 'TENANT_VIEWER'] as const) {
      expect((await esperarError(preview({ target: A }, rol))).code).toBe('permission-denied');
      expect((await esperarError(apply({ runId: 'mca_x', planHash: 'a'.repeat(16) }, rol))).code).toBe('permission-denied');
    }
  });

  it('sin sesión ⇒ unauthenticated; PLATFORM_ADMIN sin tenantId ⇒ invalid-argument', async () => {
    expect((await esperarError(preview({ target: A }))).code).toBe('unauthenticated');
    expect((await esperarError(preview({ target: A }, 'PLATFORM_ADMIN', 'uid_admin'))).code).toBe('invalid-argument');
  });
});

describe('metaCatalogAuthorityPreview', () => {
  it('target fuera del vocabulario ⇒ invalid-argument (ni siquiera se lee estado)', async () => {
    expect((await esperarError(preview({ target: { authority: 'zzz', relationship: 'none' } }, 'TENANT_OWNER'))).code).toBe('invalid-argument');
  });

  it('external+managed (§2 inválida) ⇒ bloqueo invalid_target, sin planHash, run BLOQUEADO persistido', async () => {
    const res = await preview({ target: { authority: 'external', relationship: 'managed' } }, 'TENANT_OWNER');
    expect(res.bloqueos).toEqual([{ id: 'invalid_target' }]);
    expect(res.planHash).toBeUndefined();
    const run = docs.get(`tenants/${T1}/metaCatalogAuthorityRuns/${res.runId as string}`);
    expect(run).toMatchObject({ status: 'blocked', planHash: null, actorUid: 'uid_owner' });
  });

  it('camino feliz A (tenant sin config): planHash + expiresAt + run planned con actor', async () => {
    const res = await preview({ target: A }, 'TENANT_OWNER');
    expect(res.bloqueos).toEqual([]);
    expect(typeof res.planHash).toBe('string');
    expect(typeof res.expiresAt).toBe('number');
    expect(res.estadoEsperado).toMatchObject({ authority: 'vendeyapy', relationship: 'none', declared: true });
    const run = docs.get(`tenants/${T1}/metaCatalogAuthorityRuns/${res.runId as string}`);
    expect(run).toMatchObject({ status: 'planned', actorUid: 'uid_owner', consumedAt: null });
  });

  it('outbox NO terminal ⇒ bloqueo con conteo y SIN planHash', async () => {
    seedConfig(T1, arfagiRaw());
    docs.set(`tenants/${T1}/metaCatalogOutboxJobs/j1`, { status: 'queued', tenantId: T1 });
    docs.set(`tenants/${T1}/metaCatalogOutboxJobs/j2`, { status: 'succeeded', tenantId: T1 });
    const res = await preview({ target: D }, 'TENANT_OWNER');
    expect(res.bloqueos).toContainEqual({ id: 'outbox_not_terminal', count: 1 });
    expect(res.planHash).toBeUndefined();
  });

  it('preview de sync vigente (mcs_* planned sin consumir) ⇒ sync_run_in_flight', async () => {
    seedConfig(T1, arfagiRaw());
    docs.set(`tenants/${T1}/metaCatalogSyncRuns/mcs_1`, {
      requestedMode: 'dry_run',
      status: 'planned',
      planHash: 'a'.repeat(16),
      consumedAt: null,
      finishedAt: Timestamp.now(),
    });
    const res = await preview({ target: D }, 'TENANT_OWNER');
    expect((res.bloqueos as Array<{ id: string }>).map((b) => b.id)).toContain('sync_run_in_flight');
  });

  it('import run activo ⇒ import_run_in_flight; locks ambiguos ⇒ mapping_ambiguous', async () => {
    seedConfig(T1, arfagiRaw());
    docs.set(`tenants/${T1}/metaCatalogImportState/current`, { activeRunId: 'r1' });
    docs.set(`tenants/${T1}/metaCatalogImportRuns/r1`, { status: 'running' });
    docs.set(`tenants/${T1}/metaRetailerLocks/l1`, { tenantId: T1, productId: 'p1', retailerId: 'r1' });
    docs.set(`tenants/${T1}/metaRetailerLocks/l2`, { tenantId: T1, productId: 'p1', retailerId: 'r2' });
    const res = await preview({ target: D }, 'TENANT_OWNER');
    const idsBloq = (res.bloqueos as Array<{ id: string }>).map((b) => b.id);
    expect(idsBloq).toEqual(expect.arrayContaining(['import_run_in_flight', 'mapping_ambiguous']));
  });

  it('la respuesta y el run persistido NO llevan secretos (ni token ni URLs)', async () => {
    seedConfig(T1, arfagiRaw());
    seedConnection(T1);
    const res = await preview({ target: D }, 'TENANT_OWNER');
    const todo = JSON.stringify(res) + JSON.stringify(docs.get(`tenants/${T1}/metaCatalogAuthorityRuns/${res.runId as string}`));
    expect(todo).not.toContain('secret://');
    expect(todo).not.toContain('tokenSecretRef');
    expect(todo).not.toContain('https://');
  });
});

describe('metaCatalogAuthorityApply — camino feliz y update mask', () => {
  it('A sobre tenant sin config: crea SOLO catalogSync.relationship; cero deletes; cero jobs; audita', async () => {
    docs.set(`tenants/${T1}/products/p1`, { name: 'perfume' }); // testigo de que nada se borra
    const antes = new Set(docs.keys());
    const res = await preview({ target: A }, 'TENANT_OWNER');
    const out = await apply({ runId: res.runId, planHash: res.planHash }, 'TENANT_OWNER');
    expect(out).toMatchObject({ ok: true, despues: { authority: 'vendeyapy', relationship: 'none' }, cambiaModelo: false });

    expect(docs.get(`tenants/${T1}/config/meta`)).toEqual({ catalogSync: { relationship: 'none' } });
    for (const k of antes) expect(docs.has(k)).toBe(true); // CERO deletes
    expect([...docs.keys()].filter((k) => k.includes('metaCatalogOutboxJobs'))).toEqual([]); // CERO jobs
    const run = docs.get(`tenants/${T1}/metaCatalogAuthorityRuns/${res.runId as string}`)!;
    // Mismo contrato que el preview de sync: el status queda 'planned' y `consumedAt` sella el
    // uso único — así el replay se distingue como `consumed`, no como `not_usable` genérico.
    expect(run.consumedAt).toBeTruthy();
    expect(run.status).toBe('planned');
    expect(auditadas).toContainEqual(expect.objectContaining({ action: 'meta.catalog_authority_changed', tenantId: T1 }));
  });

  it('B: escribe relationship y deja enabled/mode/catalogId/ownership EXACTAMENTE iguales', async () => {
    seedConfig(T1, managedRaw());
    seedConnection(T1);
    const res = await preview({ target: B }, 'TENANT_OWNER');
    expect(res.bloqueos).toEqual([]);
    await apply({ runId: res.runId, planHash: res.planHash }, 'TENANT_OWNER');
    const cfg = (docs.get(`tenants/${T1}/config/meta`) as { catalogSync: Record<string, unknown> }).catalogSync;
    expect(cfg).toEqual({ ...managedRaw(), relationship: 'managed' });
  });

  it('hybrid → D (cambio de modelo): escribe ownership external_managed CONSERVANDO el reconocimiento; el resto intacto', async () => {
    seedConfig(T1, hybridRaw());
    const res = await preview({ target: D }, 'TENANT_OWNER');
    expect(res.bloqueos).toEqual([]);
    const out = await apply({ runId: res.runId, planHash: res.planHash }, 'TENANT_OWNER');
    expect(out.cambiaModelo).toBe(true);
    const cfg = (docs.get(`tenants/${T1}/config/meta`) as { catalogSync: Record<string, unknown> }).catalogSync;
    expect(cfg.enabled).toBe(true);
    expect(cfg.mode).toBe('live');
    expect(cfg.catalogId).toBe('cat_hybrid');
    expect(cfg.relationship).toBe('mirror');
    expect(cfg.ownership).toMatchObject({
      model: 'external_managed',
      ownedFields: [],
      external: { kind: 'meta_feed', acknowledgedSourceIds: ['feed_h'], acknowledgedByUid: 'uid_owner', fingerprint: 'fp_h' },
    });
  });
});

describe('metaCatalogAuthorityApply — evidencia y precondiciones (fail-closed)', () => {
  it('evidencia ausente o malformada ⇒ preview_required', async () => {
    for (const data of [{}, { runId: 'mca_x' }, { runId: 'no-formato', planHash: 'a'.repeat(16) }, { runId: 'mca_x', planHash: 'ZZZ' }]) {
      const e = await esperarError(apply(data, 'TENANT_OWNER'));
      expect(e.code).toBe('failed-precondition');
      expect(e.details?.reason).toBe('preview_required');
    }
  });

  it('runId inexistente ⇒ not_found; run de OTRO tenant ⇒ not_found (aislamiento)', async () => {
    const e = await esperarError(apply({ runId: 'mca_zz', planHash: 'a'.repeat(16) }, 'TENANT_OWNER'));
    expect(e.details?.reason).toBe('not_found');

    const res = await preview({ tenantId: T1, target: A }, 'PLATFORM_ADMIN', 'uid_admin');
    const cruzado = await esperarError(apply({ tenantId: T2, runId: res.runId, planHash: res.planHash }, 'PLATFORM_ADMIN', 'uid_admin'));
    expect(cruzado.details?.reason).toBe('not_found');
  });

  it('planHash ajeno ⇒ mismatch; otro actor ⇒ actor_mismatch; vencido ⇒ expired', async () => {
    const res = await preview({ target: A }, 'TENANT_OWNER');
    expect((await esperarError(apply({ runId: res.runId, planHash: 'f'.repeat(16) }, 'TENANT_OWNER'))).details?.reason).toBe('mismatch');
    expect(
      (await esperarError(apply({ tenantId: T1, runId: res.runId, planHash: res.planHash }, 'PLATFORM_ADMIN', 'uid_admin'))).details?.reason,
    ).toBe('actor_mismatch');

    const runPath = `tenants/${T1}/metaCatalogAuthorityRuns/${res.runId as string}`;
    docs.set(runPath, { ...docs.get(runPath)!, expiresAtMs: Date.now() - 1 });
    expect((await esperarError(apply({ runId: res.runId, planHash: res.planHash }, 'TENANT_OWNER'))).details?.reason).toBe('expired');
  });

  it('replay del MISMO runId ⇒ consumed (idempotencia del apply)', async () => {
    const res = await preview({ target: A }, 'TENANT_OWNER');
    await apply({ runId: res.runId, planHash: res.planHash }, 'TENANT_OWNER');
    const e = await esperarError(apply({ runId: res.runId, planHash: res.planHash }, 'TENANT_OWNER'));
    expect(e.details?.reason).toBe('consumed');
  });

  it('config mutada entre preview y apply ⇒ concurrent_change y CERO escrituras', async () => {
    seedConfig(T1, managedRaw());
    seedConnection(T1);
    const res = await preview({ target: B }, 'TENANT_OWNER');
    seedConfig(T1, { ...managedRaw(), catalogId: 'cat_OTRO' });
    const e = await esperarError(apply({ runId: res.runId, planHash: res.planHash }, 'TENANT_OWNER'));
    expect(e.details?.reason).toBe('concurrent_change');
    const cfg = (docs.get(`tenants/${T1}/config/meta`) as { catalogSync: Record<string, unknown> }).catalogSync;
    expect(cfg.relationship).toBeUndefined(); // nada se escribió
  });

  it('run BLOQUEADO jamás se aplica ⇒ not_usable', async () => {
    seedConfig(T1, arfagiRaw());
    docs.set(`tenants/${T1}/metaCatalogOutboxJobs/j1`, { status: 'queued', tenantId: T1 });
    const res = await preview({ target: D }, 'TENANT_OWNER');
    const e = await esperarError(apply({ runId: res.runId, planHash: 'a'.repeat(16) }, 'TENANT_OWNER'));
    expect(e.details?.reason).toBe('not_usable');
  });

  it('preview de sync (mcs_*) aparecido DESPUÉS del preview de autoridad ⇒ apply sync_run_in_flight (carrera A2)', async () => {
    seedConfig(T1, arfagiRaw());
    const res = await preview({ target: D }, 'TENANT_OWNER');
    // Un dry-run de sync quedó planned sin consumir: su apply podría aterrizar jobs bajo el
    // modo nuevo. El apply de autoridad lo re-chequea igual que el preview.
    docs.set(`tenants/${T1}/metaCatalogSyncRuns/mcs_carrera`, {
      requestedMode: 'dry_run',
      status: 'planned',
      planHash: 'b'.repeat(16),
      consumedAt: null,
      finishedAt: Timestamp.now(),
    });
    const e = await esperarError(apply({ runId: res.runId, planHash: res.planHash }, 'TENANT_OWNER'));
    expect(e.details?.reason).toBe('sync_run_in_flight');
  });

  it('conexión desaparecida entre preview y apply de un destino que la exige ⇒ connection_missing (B4)', async () => {
    seedConfig(T1, managedRaw());
    seedConnection(T1);
    const res = await preview({ target: B }, 'TENANT_OWNER');
    expect(res.bloqueos).toEqual([]);
    // Desconexión dentro de la ventana de 10 min: el preview la habría bloqueado.
    docs.set(`tenants/${T1}/metaConnections/main`, { id: 'main', status: 'disconnected', tokenSecretRef: '' });
    const e = await esperarError(apply({ runId: res.runId, planHash: res.planHash }, 'TENANT_OWNER'));
    expect(e.details?.reason).toBe('connection_missing');
  });

  it('trabajo aparecido DESPUÉS del preview ⇒ el re-chequeo corta (outbox e import)', async () => {
    seedConfig(T1, arfagiRaw());
    const res = await preview({ target: D }, 'TENANT_OWNER');

    docs.set(`tenants/${T1}/metaCatalogOutboxJobs/j9`, { status: 'queued', tenantId: T1 });
    expect((await esperarError(apply({ runId: res.runId, planHash: res.planHash }, 'TENANT_OWNER'))).details?.reason).toBe('outbox_not_terminal');
    docs.delete(`tenants/${T1}/metaCatalogOutboxJobs/j9`);

    docs.set(`tenants/${T1}/metaCatalogImportState/current`, { activeRunId: 'r9' });
    docs.set(`tenants/${T1}/metaCatalogImportRuns/r9`, { status: 'running' });
    expect((await esperarError(apply({ runId: res.runId, planHash: res.planHash }, 'TENANT_OWNER'))).details?.reason).toBe('import_run_in_flight');
  });
});

describe('requireCatalogRelationship — gate por relación contra la config real', () => {
  it('mirror (arfagi legacy) PUEDE importar/verificar y NUNCA escribir a Meta', async () => {
    seedConfig(T1, arfagiRaw());
    await expect(requireCatalogRelationship(T1, 'mirror', 'managed')).resolves.toMatchObject({ relationship: 'mirror' });
    const e = await esperarError(requireCatalogRelationship(T1, 'managed'));
    expect(e.code).toBe('failed-precondition');
    expect(e.details).toMatchObject({ kind: 'authority_relationship_blocked', relationship: 'mirror' });
  });

  it('none (declarado) bloquea TODO el ciclo Meta', async () => {
    seedConfig(T1, { ...managedRaw(), relationship: 'none' });
    for (const permitidas of [['mirror', 'managed'], ['managed']] as const) {
      const e = await esperarError(requireCatalogRelationship(T1, ...permitidas));
      expect(e.details).toMatchObject({ kind: 'authority_relationship_blocked', relationship: 'none' });
    }
  });

  it('managed (tenant que publica hoy) pasa todos los gates — no-regresión', async () => {
    seedConfig(T1, managedRaw());
    await expect(requireCatalogRelationship(T1, 'managed')).resolves.toMatchObject({ relationship: 'managed' });
    await expect(requireCatalogRelationship(T1, 'mirror', 'managed')).resolves.toMatchObject({ relationship: 'managed' });
  });

  it('sin config (credipower) ⇒ none: el ciclo Meta queda bloqueado, el CRUD local no pasa por acá', async () => {
    const e = await esperarError(requireCatalogRelationship(T1, 'mirror', 'managed'));
    expect(e.details).toMatchObject({ kind: 'authority_relationship_blocked', relationship: 'none' });
  });
});

describe('outbox bajo mirror/none — A1: el descarte es CANCELACIÓN LOCAL y no puede quedar gateado', () => {
  const jobQueued = (tenantId: string, id: string) => {
    docs.set(`tenants/${tenantId}/metaCatalogOutboxJobs/${id}`, {
      id,
      tenantId,
      intentKey: '',
      cycle: 1,
      catalogId: 'cat_x',
      productId: 'p1',
      retailerId: 'SKU-1',
      action: 'update',
      intendedPatch: { id: 'SKU-1' },
      status: 'queued',
      attempts: 0,
      leaseOwner: null,
      leaseUntil: null,
      batchHandle: null,
      submittedAt: null,
      attentionRequired: false,
      updatedAt: Timestamp.now(),
    });
  };
  const discard = (data: Record<string, unknown>) =>
    (metaCatalogOutboxDiscard as unknown as { run: (r: unknown) => Promise<Record<string, unknown>> }).run(reqDe(data, 'TENANT_OWNER'));
  const reconcile = (data: Record<string, unknown>) =>
    (metaCatalogOutboxReconcile as unknown as { run: (r: unknown) => Promise<Record<string, unknown>> }).run(reqDe(data, 'TENANT_OWNER'));

  it('discard funciona bajo mirror y bajo none: un job legacy no queda zombi ni bloquea el regreso a managed', async () => {
    for (const cfg of [arfagiRaw(), { ...managedRaw(), relationship: 'none' }]) {
      docs.clear();
      seedConfig(T1, cfg);
      jobQueued(T1, 'j_legacy');
      const r = await discard({ jobId: 'j_legacy', reason: 'limpieza del modo espejo' });
      expect(r.ok).toBe(true);
      expect((docs.get(`tenants/${T1}/metaCatalogOutboxJobs/j_legacy`) as { status: string }).status).toBe('cancelled');
    }
  });

  it('un aviso de verificación huérfano se CIERRA aunque la relación bloquee la corrida (none y sin-config)', async () => {
    // Misma familia que A1: el gate de relación bloquea ACCIONES hacia Meta, jamás la limpieza
    // local. Los caminos de skip de `runCatalogVerificationForTenant` son los ÚNICOS que
    // cierran el aviso «no podemos verificar tu catálogo»: si el callable cortara ANTES por
    // relación, retirar la declaración externa o borrar `catalogSync` entero dejaría el aviso
    // abierto PARA SIEMPRE en una empresa que ya se desconectó (hallazgo OW-20m/20o).
    const verifRun = (data: Record<string, unknown>) =>
      (metaCatalogVerificationRun as unknown as { run: (r: unknown) => Promise<Record<string, unknown>> }).run(reqDe(data, 'TENANT_OWNER'));
    const avisoAbierto = () => {
      docs.set(`tenants/${T1}/notifications/catalog-verification-${T1}`, {
        id: `catalog-verification-${T1}`,
        tenantId: T1,
        category: 'catalog_verification',
        resolvedAt: null,
        createdAt: Timestamp.now(),
        read: false,
      });
    };

    // (a) Desconectado del todo: sin `catalogSync` (relación derivada none).
    avisoAbierto();
    const e1 = await esperarError(verifRun({}));
    expect(e1.code).toBe('failed-precondition');
    expect((docs.get(`tenants/${T1}/notifications/catalog-verification-${T1}`) as { resolvedAt: unknown }).resolvedAt).toBeTruthy();

    // (b) Opt-out declarado (`relationship:'none'` sobre propiedad propia sin fuente externa).
    seedConfig(T1, { ...managedRaw(), relationship: 'none' });
    avisoAbierto();
    const e2 = await esperarError(verifRun({}));
    expect(e2.code).toBe('failed-precondition');
    expect((docs.get(`tenants/${T1}/notifications/catalog-verification-${T1}`) as { resolvedAt: unknown }).resolvedAt).toBeTruthy();
  });

  it('reconcile manual sigue managed-only (puede RE-ENCOLAR un envío) y conserva el not-found cross-tenant primero', async () => {
    seedConfig(T1, arfagiRaw());
    jobQueued(T1, 'j_mirror');
    const bloqueado = await esperarError(reconcile({ jobId: 'j_mirror' }));
    expect(bloqueado.code).toBe('failed-precondition');
    expect(bloqueado.details).toMatchObject({ kind: 'authority_relationship_blocked', relationship: 'mirror' });
    // Sondeo de un job inexistente: not-found ANTES que cualquier precondición de relación.
    const ajeno = await esperarError(reconcile({ jobId: 'j_de_otro' }));
    expect(ajeno.code).toBe('not-found');
  });
});
