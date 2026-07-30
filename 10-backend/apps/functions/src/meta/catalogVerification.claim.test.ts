import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0015 §6 — CLAIM del run de reconciliación (hallazgo de revisión).
 *
 * Lo que se defiende acá: dos invocaciones simultáneas del mismo tenant (el panel impaciente
 * + la corrida programada, o dos pestañas) NO pueden crear dos corridas ni pisarse el cursor.
 * El read-then-create anterior no tenía exclusión mutua: los dos llamadores leían "no hay
 * corrida activa" antes de que ninguno escribiera, y los dos creaban la suya.
 *
 * El mundo en memoria SERIALIZA las transacciones igual que Firestore. Ese es justamente el
 * poder discriminante del test: si el claim vive fuera de la transacción, la serialización no
 * lo salva y aparecen dos runs; adentro, el segundo llamador ve el del primero.
 */
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Documentos por path. Es todo el "Firestore" que estos tests necesitan. */
const docs = new Map<string, Record<string, unknown>>();
/** Cola que serializa las transacciones (garantía real de Firestore, reproducida acá). */
let cola: Promise<unknown> = Promise.resolve();
let autoId = 0;

const idDe = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const snapDe = (path: string) => ({
  exists: docs.has(path),
  id: idDe(path),
  ref: refDe(path),
  data: () => docs.get(path),
});

function refDe(path: string) {
  return {
    path,
    id: idDe(path),
    async get() {
      return snapDe(path);
    },
    /** Solo `merge:true`: es la única forma que usa la campana agregada (nunca pisa el doc). */
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const actual = opts?.merge ? (docs.get(path) ?? {}) : {};
      docs.set(path, { ...actual, ...data });
    },
  };
}

interface Consulta {
  __coleccion: string;
  campo: string;
  op: string;
  valor: unknown;
}

/**
 * Reproduce la semántica REAL de Firestore, que es justamente donde vivía el bug:
 *  · `==` filtra por igualdad;
 *  · `!=` devuelve los documentos que TIENEN el campo y cuyo valor difiere — los que NO tienen
 *    el campo quedan AFUERA. Por eso `where('metaRetailerId','!=','')` nunca devolvía a un
 *    producto vinculado a mano solo por `metaProductItemId`.
 * Si el fake ignorara el operador, el test no discriminaría nada.
 */
function resolverConsulta(q: Consulta) {
  const prefijo = `${q.__coleccion}/`;
  const encontrados = [...docs.entries()]
    .filter(([p, d]) => {
      if (!p.startsWith(prefijo) || p.slice(prefijo.length).includes('/')) return false;
      if (q.op === '!=') return d[q.campo] !== undefined && d[q.campo] !== q.valor;
      return d[q.campo] === q.valor;
    })
    .map(([p]) => snapDe(p));
  return { docs: encontrados, size: encontrados.length, empty: !encontrados.length };
}

/** Consulta ordenada por id (lo único que usa el store real para paginar productos). */
function consultaOrdenada(path: string, cursor: string | null, limite: number) {
  const prefijo = `${path}/`;
  const api = {
    startAfter: (c: string) => consultaOrdenada(path, c, limite),
    limit: (n: number) => consultaOrdenada(path, cursor, n),
    async get() {
      const todos = [...docs.keys()]
        .filter((p) => p.startsWith(prefijo) && !p.slice(prefijo.length).includes('/'))
        .sort();
      const desde = cursor ? todos.findIndex((p) => idDe(p) === cursor) + 1 : 0;
      const page = todos.slice(desde, desde + limite).map(snapDe);
      return { docs: page, size: page.length, empty: !page.length };
    },
  };
  return api;
}

function coleccion(path: string) {
  const api = {
    doc: (id?: string) => refDe(`${path}/${id ?? `auto-${++autoId}`}`),
    orderBy: (_campo: unknown) => consultaOrdenada(path, null, 1000),
    where: (campo: string, op: string, valor: unknown) => ({
      limit: (_n: number) => ({ __coleccion: path, campo, op, valor }) as Consulta,
      async get() {
        return resolverConsulta({ __coleccion: path, campo, op, valor });
      },
    }),
    async get() {
      return { docs: [], size: 0, empty: true };
    },
  };
  return api;
}

const db = () => ({
  doc: (path: string) => refDe(path),
  collection: (path: string) => coleccion(path),
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    // Serialización estricta: una transacción por vez, como en Firestore.
    const turno = cola.then(async () => {
      const escrituras: Array<() => void> = [];
      const tx = {
        async get(x: { path?: string } | Consulta) {
          if ((x as Consulta).__coleccion) return resolverConsulta(x as Consulta);
          return snapDe((x as { path: string }).path);
        },
        create(ref: { path: string }, data: Record<string, unknown>) {
          escrituras.push(() => docs.set(ref.path, { ...data }));
        },
        update(ref: { path: string }, patch: Record<string, unknown> | string, valor?: unknown) {
          escrituras.push(() => {
            const actual = docs.get(ref.path) ?? {};
            if (typeof patch === 'string') docs.set(ref.path, { ...actual, [patch]: valor });
            else docs.set(ref.path, { ...actual, ...patch });
          });
        },
      };
      const out = await fn(tx);
      for (const w of escrituras) w();
      return out;
    });
    cola = turno.catch(() => undefined);
    return turno;
  },
});

vi.mock('../lib/firebase.js', () => ({
  db: () => db(),
  paths: {
    products: (t: string) => `tenants/${t}/products`,
    product: (t: string, p: string) => `tenants/${t}/products/${p}`,
    metaCatalogVerificationRuns: (t: string) => `tenants/${t}/metaCatalogVerificationRuns`,
    metaCatalogVerificationRun: (t: string, r: string) => `tenants/${t}/metaCatalogVerificationRuns/${r}`,
    notifications: (t: string) => `tenants/${t}/notifications`,
    notification: (t: string, id: string) => `tenants/${t}/notifications/${id}`,
  },
}));

import {
  catalogVerificationNotificationId,
  CatalogVerificationAlreadyRunningError,
  CatalogVerificationBlockedError,
  CatalogVerificationUnavailableError,
  enqueueCatalogVerificationRun,
  firestoreVerificationStore,
  runCatalogVerificationForTenant,
  type MetaCatalogVerificationRunDoc,
} from './catalogVerification.js';
import { normalizeCatalogOwnership } from './catalogOwnership.js';
import type { MetaCatalogItemsPage } from './catalogClient.js';

const CONFIG = 'tenants/t1/config/meta';
const RUNS = 'tenants/t1/metaCatalogVerificationRuns';

const PROPIEDAD_EXTERNA = normalizeCatalogOwnership({
  model: 'external_managed',
  ownedFields: [],
  external: {
    kind: 'meta_feed',
    acknowledgedSourceIds: ['feed-1'],
    declaredFields: [],
    fingerprint: 'huella-saneada',
    acknowledgedByUid: 'uid-owner',
    acknowledgedAt: null,
  },
});

const configExterna = () =>
  docs.set(CONFIG, {
    catalogSync: {
      enabled: true,
      mode: 'dry_run',
      catalogId: 'CAT-1',
      ownership: {
        model: 'external_managed',
        ownedFields: [],
        external: {
          kind: 'meta_feed',
          acknowledgedSourceIds: ['feed-1'],
          declaredFields: [],
          fingerprint: 'huella-saneada',
          acknowledgedByUid: 'uid-owner',
          acknowledgedAt: null,
        },
        lastSourceCheckAt: null,
      },
    },
  });

const runsVivos = () => [...docs.entries()].filter(([p]) => p.startsWith(`${RUNS}/`));

/** Config con gobierno externo declarado pero NUESTRA sincronización APAGADA (caso B1). */
const configSyncApagada = (over: Record<string, unknown> = {}) =>
  docs.set(CONFIG, {
    catalogSync: {
      enabled: false, // el interruptor de ESCRITURA apagado…
      mode: 'off',
      catalogId: 'CAT-1',
      ownership: {
        model: 'external_managed', // …pero el feed del sitio sigue gobernando los campos públicos
        ownedFields: [],
        external: {
          kind: 'meta_feed',
          acknowledgedSourceIds: ['feed-1'],
          declaredFields: [],
          fingerprint: 'huella-saneada',
          acknowledgedByUid: 'uid-owner',
          acknowledgedAt: null,
        },
        lastSourceCheckAt: null,
      },
      ...over,
    },
  });

const AVISO = `tenants/t1/notifications/${catalogVerificationNotificationId('t1')}`;
const avisos = () => [...docs.keys()].filter((p) => p.startsWith('tenants/t1/notifications/'));

/** Producto MAPEADO mínimo (lo que mira la comparación campo por campo). */
const productoMapeado = () =>
  docs.set('tenants/t1/products/p-odyssey', {
    name: 'Odyssey Armani',
    description: 'Perfume Odyssey',
    price: 250000,
    currency: 'PYG',
    status: 'ACTIVE',
    inventory: { trackStock: true, stock: 3, sku: 'sku-ody' },
    images: ['https://cdn.test/ody.jpg'],
    productUrl: 'https://tienda.test/p/ody',
    brand: 'Armani',
    metaRetailerId: 'ODY-1',
    metaCatalogId: 'CAT-1',
  });

/** Cliente que solo LEE y que se puede frenar a voluntad para forzar el solapamiento. */
function clienteConCompuerta() {
  let abrir: (() => void) | null = null;
  const compuerta = new Promise<void>((r) => {
    abrir = r;
  });
  return {
    abrir: () => abrir?.(),
    async listItemsPage(): Promise<MetaCatalogItemsPage> {
      await compuerta;
      return { items: [], nextCursor: null };
    },
  };
}

beforeEach(() => {
  docs.clear();
  cola = Promise.resolve();
  autoId = 0;
});

describe('runCatalogVerificationForTenant — claim transaccional', () => {
  it('dos invocaciones simultáneas ⇒ UNA sola corrida y already_running para la segunda', async () => {
    configExterna();
    const cliente = clienteConCompuerta();

    // A arranca y queda frenada DENTRO del barrido, con el claim tomado.
    const a = runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente });
    await new Promise((r) => setTimeout(r, 0));

    // B llega mientras A sigue en vuelo. Con el bug creaba una SEGUNDA corrida del mismo tenant.
    await expect(runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente })).rejects.toBeInstanceOf(
      CatalogVerificationAlreadyRunningError,
    );
    expect(runsVivos()).toHaveLength(1);

    cliente.abrir();
    const res = await a;
    expect(res.status).toBe('completed');
    expect(runsVivos()).toHaveLength(1);
  });

  it('el error de already_running trae el ESTADO de la corrida en curso (no una excusa vacía)', async () => {
    configExterna();
    const cliente = clienteConCompuerta();
    const a = runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente });
    await new Promise((r) => setTimeout(r, 0));

    const err = await runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente }).catch((e) => e);
    expect(err).toBeInstanceOf(CatalogVerificationAlreadyRunningError);
    expect((err as CatalogVerificationAlreadyRunningError).run.status).toBe('running');
    expect((err as CatalogVerificationAlreadyRunningError).run.tenantId).toBe('t1');

    cliente.abrir();
    await a;
  });

  it('terminada la invocación el claim se LIBERA: la siguiente reanuda la misma corrida', async () => {
    configExterna();
    // Primera invocación con presupuesto 0: crea la corrida, no lee nada y la deja `running`.
    const r1 = await runCatalogVerificationForTenant({
      tenantId: 't1',
      maxPages: 0,
      client: { listItemsPage: async () => ({ items: [], nextCursor: null }) },
    });
    expect(r1.status).toBe('running');
    const doc = docs.get(`${RUNS}/${r1.runId}`) as MetaCatalogVerificationRunDoc;
    expect(doc.leaseUntilMs).toBe(0);

    const r2 = await runCatalogVerificationForTenant({
      tenantId: 't1',
      maxPages: 5,
      client: { listItemsPage: async () => ({ items: [], nextCursor: null }) },
    });
    expect(r2.runId).toBe(r1.runId); // reanuda, no crea otra
    expect(runsVivos()).toHaveLength(1);
  });

  it('un tenant SIN config de catálogo no crea corrida ni toca la red (nivel 1 intacto)', async () => {
    let llamadas = 0;
    await expect(
      runCatalogVerificationForTenant({
        tenantId: 't1',
        maxPages: 5,
        client: {
          listItemsPage: async () => {
            llamadas++;
            return { items: [], nextCursor: null };
          },
        },
      }),
    ).rejects.toBeInstanceOf(CatalogVerificationUnavailableError);
    expect(llamadas).toBe(0);
    expect(runsVivos()).toHaveLength(0);
  });
});

/**
 * HALLAZGO B1 — El refresco NO puede apagarse mientras el guard sigue prendido.
 *
 * El guard del bot lee la propiedad DECLARADA sin pasar por el interruptor de sync (así se
 * corrigió antes): con `enabled:false` / `mode:'off'` y gobierno externo declarado, el guard
 * sigue ACTIVO. Pero la reconciliación —único camino que escribe `metaVerifiedAt`— exigía
 * `cfg.enabled && cfg.catalogId` y se negaba a correr. A las 24 h TODOS los mapeados caducaban a
 * `stale` (bloqueante) y la venta automática del catálogo entero se apagaba en silencio y para
 * siempre. Regla que defienden estos tests: si el guard está activo, lo que refresca la evidencia
 * también tiene que poder correr.
 */
describe('runCatalogVerificationForTenant — verificar NO depende del interruptor de escritura (B1)', () => {
  it('sync APAGADO + gobierno externo declarado ⇒ la corrida CORRE y refresca `metaVerifiedAt`', async () => {
    configSyncApagada();
    productoMapeado();
    let llamadas = 0;

    const res = await runCatalogVerificationForTenant({
      tenantId: 't1',
      maxPages: 5,
      trigger: 'scheduler',
      client: {
        listItemsPage: async (): Promise<MetaCatalogItemsPage> => {
          llamadas++;
          return {
            items: [
              {
                id: 'item-1',
                retailerId: 'ODY-1',
                name: 'Odyssey Armani',
                description: 'Perfume Odyssey',
                // El caso real: el feed del sitio publica ₲130.000 y el precio local es ₲250.000.
                price: '130000 PYG',
                currency: 'PYG',
                availability: 'in stock',
                brand: 'Armani',
                imageUrl: 'https://cdn.test/ody.jpg',
                url: 'https://tienda.test/p/ody',
              },
            ],
            nextCursor: null,
          };
        },
      },
    });

    // Con el bug esto tiraba `CatalogVerificationUnavailableError` y nunca llegaba a leer nada.
    expect(llamadas).toBe(1);
    expect(res.status).toBe('completed');
    const p = docs.get('tenants/t1/products/p-odyssey') as { metaVerifiedAt?: { toMillis(): number }; metaSyncState?: string };
    expect(p.metaVerifiedAt).toBeTruthy(); // la evidencia se REFRESCÓ: nada caduca a `stale`
    expect(p.metaSyncState).toBe('drifted_external'); // …y se dice la verdad sobre quién difiere
    expect(avisos()).toEqual([]); // no hay contradicción: ni un aviso
  });

  it('un tenant SIN NINGUNA config no gasta llamadas, no crea corrida y no genera avisos', async () => {
    // credipower: el nivel 1 sigue exactamente igual. Nadie declaró gobierno externo ⇒ el guard
    // está inerte ⇒ no hay nada que refrescar y no hay nada que avisar.
    let llamadas = 0;
    await expect(
      runCatalogVerificationForTenant({
        tenantId: 't1',
        maxPages: 5,
        client: {
          listItemsPage: async () => {
            llamadas++;
            return { items: [], nextCursor: null };
          },
        },
      }),
    ).rejects.toBeInstanceOf(CatalogVerificationUnavailableError);
    expect(llamadas).toBe(0);
    expect(runsVivos()).toHaveLength(0);
    expect(avisos()).toEqual([]);
    expect(docs.size).toBe(0); // ni una escritura de ningún tipo
  });

  it('config LEGACY con la sync apagada ⇒ salteada silenciosa (el guard está inerte), sin avisos', async () => {
    docs.set(CONFIG, { catalogSync: { enabled: false, mode: 'off', catalogId: 'CAT-1', sourceOfTruth: 'vendeyapy' } });
    let llamadas = 0;
    await expect(
      runCatalogVerificationForTenant({
        tenantId: 't1',
        maxPages: 5,
        client: {
          listItemsPage: async () => {
            llamadas++;
            return { items: [], nextCursor: null };
          },
        },
      }),
    ).rejects.toBeInstanceOf(CatalogVerificationUnavailableError);
    expect(llamadas).toBe(0);
    expect(avisos()).toEqual([]); // sin aviso previo no se crea uno vacío
  });

  it('gobierno externo SIN catalogId ⇒ bloqueo TIPADO y avisado, jamás un apagado silencioso', async () => {
    // Config CONTRADICTORIA: alguien declaró que un sistema externo gobierna los campos públicos
    // (el guard bloquea) y no hay catálogo remoto que leer (nada puede desbloquearlo).
    configSyncApagada({ catalogId: '' });
    let llamadas = 0;
    const cliente = {
      listItemsPage: async () => {
        llamadas++;
        return { items: [], nextCursor: null };
      },
    };

    const err = await runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente }).catch((e) => e);

    expect(err).toBeInstanceOf(CatalogVerificationBlockedError);
    expect((err as CatalogVerificationBlockedError).reason).toBe('external_without_catalog');
    expect(llamadas).toBe(0); // no hay catálogo que leer: no se gasta una sola llamada
    expect(runsVivos()).toHaveLength(0); // ni se abre una corrida que jamás podría avanzar
    const aviso = docs.get(AVISO) as { type?: string; read?: boolean; resolvedAt?: unknown; body?: string };
    expect(aviso.type).toBe('catalog_verification_blocked');
    expect(aviso.read).toBe(false);
    expect(aviso.resolvedAt).toBeNull();
    expect(aviso.body).toContain('no cierran venta automática'); // le dice a la persona QUÉ se rompió
  });

  it('el aviso del bloqueo es IDEMPOTENTE: dos corridas no lo duplican ni lo re-abren si ya lo leyeron', async () => {
    configSyncApagada({ catalogId: '' });
    const cliente = { listItemsPage: async () => ({ items: [], nextCursor: null }) };
    await runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente }).catch(() => undefined);
    // El owner lo lee desde el panel.
    docs.set(AVISO, { ...(docs.get(AVISO) as Record<string, unknown>), read: true });

    await runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente }).catch(() => undefined);

    expect(avisos()).toHaveLength(1);
    expect((docs.get(AVISO) as { read?: boolean }).read).toBe(true); // el MISMO hallazgo no vuelve a saltar
  });

  it('corregida la config, el aviso se AUTOCIERRA en la corrida siguiente', async () => {
    configSyncApagada({ catalogId: '' });
    const cliente = { listItemsPage: async () => ({ items: [], nextCursor: null }) };
    await runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente }).catch(() => undefined);
    expect((docs.get(AVISO) as { resolvedAt?: unknown }).resolvedAt).toBeNull();

    configSyncApagada(); // el humano configura el catálogo (la sync sigue apagada: no hace falta)
    const res = await runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente });

    expect(res.status).toBe('completed');
    expect((docs.get(AVISO) as { resolvedAt?: unknown }).resolvedAt).toBeTruthy();
    expect(avisos()).toHaveLength(1); // se cierra el mismo, no se crea otro
  });

  it('BORRAR `catalogSync` entero (desconectarse) también cierra el aviso: nunca queda huérfano', async () => {
    // Hallazgo del review adversarial: la salida por desconexión no cerraba nada. El tenant
    // quedaba en `no_catalog_sync` —una razón de salteo que no pasaba por el cierre— y el aviso
    // "No podemos verificar tu catálogo" se quedaba abierto para siempre, sobre una empresa que
    // ya ni siquiera tiene config de catálogo. Un aviso que nadie puede cerrar es ruido eterno.
    configSyncApagada({ catalogId: '' });
    const cliente = { listItemsPage: async () => ({ items: [], nextCursor: null }) };
    await runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente }).catch(() => undefined);
    expect((docs.get(AVISO) as { resolvedAt?: unknown }).resolvedAt).toBeNull();

    docs.delete(CONFIG); // el owner se desconecta borrando `catalogSync` entero
    await expect(runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente })).rejects.toBeInstanceOf(
      CatalogVerificationUnavailableError,
    );

    expect((docs.get(AVISO) as { resolvedAt?: unknown }).resolvedAt).toBeTruthy();
    expect(avisos()).toHaveLength(1); // se cierra el mismo, no se crea otro
  });

  it('gobierno externo SOLO COSMÉTICO ⇒ ni una llamada a Meta: el guard está inerte, no hay evidencia que refrescar', async () => {
    // Hallazgo del review adversarial: alcanzaba con declarar CUALQUIER campo externo para que el
    // scheduler paginara el catálogo remoto dos veces por día. Con el feed publicando solo título
    // e imagen, el guard del bot NO bloquea nada (exige un campo comercial), así que ese barrido
    // era gasto contra Meta sin nadie que use su resultado. Las dos condiciones ahora usan el
    // mismo contrato de campos comerciales.
    docs.set(CONFIG, {
      catalogSync: {
        enabled: false,
        mode: 'off',
        catalogId: 'CAT-1',
        ownership: {
          model: 'hybrid',
          ownedFields: ['price', 'currency', 'availability', 'inventory'], // lo comercial es NUESTRO
          external: {
            kind: 'meta_feed',
            acknowledgedSourceIds: ['feed-1'],
            declaredFields: ['title', 'image'], // el feed solo publica lo descriptivo
            fingerprint: 'huella-saneada',
            acknowledgedByUid: 'uid-owner',
            acknowledgedAt: null,
          },
          lastSourceCheckAt: null,
        },
      },
    });
    let llamadas = 0;
    await expect(
      runCatalogVerificationForTenant({
        tenantId: 't1',
        maxPages: 5,
        client: { listItemsPage: async () => { llamadas++; return { items: [], nextCursor: null }; } },
      }),
    ).rejects.toBeInstanceOf(CatalogVerificationUnavailableError);
    expect(llamadas).toBe(0);
    expect(runsVivos()).toHaveLength(0);
    expect(avisos()).toEqual([]); // tampoco se le grita a nadie: no hay nada roto
  });

  it('retirada la declaración externa, el aviso también se cierra (la otra salida honesta)', async () => {
    configSyncApagada({ catalogId: '' });
    const cliente = { listItemsPage: async () => ({ items: [], nextCursor: null }) };
    await runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente }).catch(() => undefined);

    // Segunda salida: nadie gobierna de afuera ⇒ el guard queda inerte ⇒ ya no hay bloqueo.
    docs.set(CONFIG, { catalogSync: { enabled: false, mode: 'off', catalogId: '' } });
    await expect(runCatalogVerificationForTenant({ tenantId: 't1', maxPages: 5, client: cliente })).rejects.toBeInstanceOf(
      CatalogVerificationUnavailableError,
    );

    expect((docs.get(AVISO) as { resolvedAt?: unknown }).resolvedAt).toBeTruthy();
  });

  it('el run creado con la sync apagada usa el catálogo declarado y la propiedad EXTERNA real', async () => {
    configSyncApagada();
    const res = await runCatalogVerificationForTenant({
      tenantId: 't1',
      maxPages: 5,
      client: { listItemsPage: async () => ({ items: [], nextCursor: null }) },
    });
    const doc = docs.get(`${RUNS}/${res.runId}`) as MetaCatalogVerificationRunDoc;
    expect(doc.catalogId).toBe('CAT-1'); // con el bug la config apagada lo dejaba en ''
    expect(doc.ownership.model).toBe('external_managed');
    expect(doc.ownership.degraded).toBe(false); // la propiedad NO se degrada por apagar la sync
    expect(doc.ownership.writable).toEqual([]); // …y sigue sin habilitar ni una escritura
    expect(doc.ownership.modeCeiling).toBe('dry_run');
  });
});

describe('enqueueCatalogVerificationRun — la migración deja la primera lectura en camino', () => {
  it('crea la corrida sin leer Meta y con el claim LIBRE para que otro la tome', async () => {
    const r = await enqueueCatalogVerificationRun({
      tenantId: 't1',
      catalogId: 'CAT-1',
      ownership: PROPIEDAD_EXTERNA,
      actorUid: 'uid-owner',
    });
    expect(r.created).toBe(true);
    const doc = docs.get(`${RUNS}/${r.runId}`) as MetaCatalogVerificationRunDoc;
    expect(doc.status).toBe('running');
    expect(doc.phase).toBe('remote');
    expect(doc.trigger).toBe('migration');
    expect(doc.leaseUntilMs).toBe(0);
    expect(doc.pagesDone).toBe(0);
  });

  it('es idempotente: con una corrida activa devuelve esa y NO crea otra', async () => {
    const a = await enqueueCatalogVerificationRun({ tenantId: 't1', catalogId: 'CAT-1', ownership: PROPIEDAD_EXTERNA });
    const b = await enqueueCatalogVerificationRun({ tenantId: 't1', catalogId: 'CAT-1', ownership: PROPIEDAD_EXTERNA });
    expect(b.created).toBe(false);
    expect(b.runId).toBe(a.runId);
    expect(runsVivos()).toHaveLength(1);
  });

  it('la corrida encolada es la que reanuda la próxima verificación (no nace una nueva)', async () => {
    configExterna();
    const q = await enqueueCatalogVerificationRun({ tenantId: 't1', catalogId: 'CAT-1', ownership: PROPIEDAD_EXTERNA });
    const res = await runCatalogVerificationForTenant({
      tenantId: 't1',
      maxPages: 5,
      trigger: 'scheduler',
      client: { listItemsPage: async () => ({ items: [], nextCursor: null }) },
    });
    expect(res.runId).toBe(q.runId);
    expect(res.status).toBe('completed');
    expect(runsVivos()).toHaveLength(1);
  });
});

describe('firestoreVerificationStore.loadMappedIndex — las DOS identidades contra el `!=` real', () => {
  it('indexa también al vinculado SOLO por item id, que la consulta `!=` deja afuera', async () => {
    // El bug B1 en su lugar de origen: una sola consulta `where('metaRetailerId','!=','')`.
    // Firestore EXCLUYE los documentos que no tienen el campo, así que el vínculo manual legacy
    // (solo `metaProductItemId`) no entraba al índice, la fase remota no lo comparaba y la de
    // faltantes lo salteaba: `unverifiable` permanente y venta automática apagada.
    docs.set('tenants/t1/products/p-rid', { metaRetailerId: 'ODY-1', metaProductItemId: 'item-1' });
    docs.set('tenants/t1/products/p-item', { metaProductItemId: 'item-9' }); // SIN campo metaRetailerId
    docs.set('tenants/t1/products/p-local', { name: 'sin identidad remota' });
    docs.set('tenants/t2/products/p-ajeno', { metaRetailerId: 'AJENO-1', metaProductItemId: 'item-x' });

    const idx = await firestoreVerificationStore({ tenantId: 't1', runId: 'r1' }).loadMappedIndex();

    expect([...idx.byRetailerId.keys()]).toEqual(['ODY-1']);
    expect([...idx.byItemId.keys()]).toEqual(['item-9']); // con el bug quedaba VACÍO
    expect(idx.byItemId.get('item-9')?.id).toBe('p-item');
    // Disjuntos: el que ya entró por retailer id NO se repite por item id.
    expect(idx.byItemId.has('item-1')).toBe(false);
    // Aislamiento por tenant: la colección misma es el límite, en las DOS consultas.
    expect(idx.byRetailerId.has('AJENO-1')).toBe(false);
    expect(idx.byItemId.has('item-x')).toBe(false);
  });

  it('un producto sin ninguna identidad no entra a ningún mapa', async () => {
    docs.set('tenants/t1/products/p-local', { name: 'solo local' });
    const idx = await firestoreVerificationStore({ tenantId: 't1', runId: 'r1' }).loadMappedIndex();
    expect(idx.byRetailerId.size).toBe(0);
    expect(idx.byItemId.size).toBe(0);
  });
});

describe('el registro del run no filtra secretos', () => {
  it('ni el doc del run ni el estado devuelto contienen URLs, query strings ni tokens', async () => {
    configExterna();
    const res = await runCatalogVerificationForTenant({
      tenantId: 't1',
      maxPages: 5,
      client: { listItemsPage: async () => ({ items: [], nextCursor: null }) },
    });
    const serializado = JSON.stringify([...docs.entries()]) + JSON.stringify(res);
    expect(serializado).not.toContain('access_token');
    expect(serializado).not.toContain('https://');
    expect(serializado).not.toContain('?sig=');
  });

  it('el estado del run guarda la propiedad EFECTIVA con la que se evalúa toda la corrida', async () => {
    configExterna();
    const res = await runCatalogVerificationForTenant({
      tenantId: 't1',
      maxPages: 5,
      client: { listItemsPage: async () => ({ items: [], nextCursor: null }) },
    });
    const doc = docs.get(`${RUNS}/${res.runId}`) as MetaCatalogVerificationRunDoc;
    expect(doc.ownership.model).toBe('external_managed');
    expect(doc.ownership.writable).toEqual([]);
    expect(doc.ownership.modeCeiling).toBe('dry_run');
  });
});
