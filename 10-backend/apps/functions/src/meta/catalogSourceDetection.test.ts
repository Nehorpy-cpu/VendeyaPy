import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * ADR-0015 §4 — DETECCIÓN SEGURA DE FUENTES EXTERNAS.
 *
 * La propiedad central que estos tests defienden: la URL del schedule de un feed lleva un
 * TOKEN en el query string (y a veces en el path). De esa URL solo puede sobrevivir el
 * hostname — ni en la salida del cliente, ni en la huella, ni en el documento persistido.
 * Lo segundo: la comparación observado-vs-reconocido tiene que ser fail-closed (un listado
 * que pudo quedar corto jamás puede leerse como "no hay fuente nueva").
 */

const store = new Map<string, Record<string, unknown>>();

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async (ref: { path: string }) => ({ exists: store.has(ref.path), data: () => store.get(ref.path) }),
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          store.set(ref.path, data);
        },
      }),
  }),
  paths: {
    metaCatalogSourceChecks: (t: string) => `tenants/${t}/metaCatalogSourceChecks`,
    metaCatalogSourceCheck: (t: string, id: string) => `tenants/${t}/metaCatalogSourceChecks/${id}`,
  },
}));

import { Timestamp } from 'firebase-admin/firestore';
import {
  assertSanitizedSource,
  FakeMetaCatalogClient,
  hostFromFeedUrl,
  inferFieldsFromColumns,
  sanitizeDataSource,
  sanitizeSourceName,
  sanitizeSourceSchedule,
  type CatalogSourcesObservation,
  type SanitizedCatalogSource,
} from './catalogClient.js';
import {
  buildCatalogSourceCheckDoc,
  catalogSourceCheckId,
  catalogSourceFingerprint,
  compareCatalogSources,
  recordCatalogSourceCheck,
  sourceCheckBlocksWrites,
} from './catalogSourceDetection.js';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const URL_FIRMADA = `https://tienda.ejemplo.com.py/feeds/products.csv?access_token=${TOKEN}&sig=deadbeef`;
const AHORA = '2026-07-30T09:00:00.000Z';

/** Feed CRUDO como lo devuelve el Graph, con la URL firmada entera. */
const feedCrudo = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '556677',
  name: 'Feed diario del sitio',
  file_name: 'products.csv',
  created_time: '2026-01-15T08:00:00+0000',
  ingestion_source_type: 'PRIMARY_FEED',
  schedule: { interval: 'DAILY', hour: '3', minute: '33', timezone: 'America/Asuncion', url: URL_FIRMADA },
  ...over,
});

const saneado = (over: Record<string, unknown> = {}): SanitizedCatalogSource => {
  const s = sanitizeDataSource(feedCrudo(over), AHORA);
  if (!s) throw new Error('fixture inválido');
  return s;
};

const observacion = (sources: SanitizedCatalogSource[], over: Partial<CatalogSourcesObservation> = {}): CatalogSourcesObservation => ({
  catalogId: 'CAT-1',
  sources,
  feedCount: sources.length,
  complete: true,
  detectedAt: AHORA,
  ...over,
});

beforeEach(() => store.clear());

// ---------------------------------------------------------------------------
// Saneamiento
// ---------------------------------------------------------------------------

describe('saneamiento de la metadata de una fuente', () => {
  it('EL TOKEN NO SALE: de la URL firmada solo sobrevive el hostname', () => {
    const s = saneado();
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(JSON.stringify(s)).not.toContain('access_token');
    expect(JSON.stringify(s)).not.toContain('products.csv');
    expect(s.host).toBe('tienda.ejemplo.com.py');
    expect(s.schedule).toEqual({ interval: 'DAILY', hour: 3, minute: 33, timezone: 'America/Asuncion' });
    expect(s.fileExtension).toBe('csv');
  });

  it('EL TOKEN NO ENTRA EN LA HUELLA: dos URLs que solo difieren en el token dan la MISMA huella', () => {
    const conToken = saneado();
    const conOtroToken = saneado({
      schedule: { interval: 'DAILY', hour: '3', minute: '33', timezone: 'America/Asuncion', url: 'https://tienda.ejemplo.com.py/feeds/products.csv?access_token=OTRO-TOKEN-DISTINTO-999' },
    });
    const huella = catalogSourceFingerprint([conToken]);
    expect(huella).toBe(catalogSourceFingerprint([conOtroToken]));
    expect(huella).not.toContain(TOKEN);
    expect(huella).toMatch(/^[0-9a-f]{64}$/);
  });

  it('un nombre que pegó la URL firmada entera queda limpio', () => {
    expect(sanitizeSourceName(`Feed ${URL_FIRMADA}`)).toBe('Feed');
    expect(sanitizeSourceName(`sync ?token=${TOKEN}`)).toBe('sync');
    expect(sanitizeSourceName(`backup ${TOKEN}`)).toBe('backup');
    expect(sanitizeSourceName('feed con secret y password adentro')).toBe('feed con y adentro');
    expect(sanitizeSourceName('  Feed   Diario  ')).toBe('Feed Diario');
    expect(sanitizeSourceName('Feed '.repeat(40)).length).toBeLessThanOrEqual(60);
    expect(sanitizeSourceName(42)).toBe('');
  });

  it('del host no sobrevive ni el path, ni el puerto, ni el userinfo, ni el query', () => {
    expect(hostFromFeedUrl('https://user:pass@Tienda.EJEMPLO.com.py:8443/feeds/xyz/f.csv?t=1')).toBe('tienda.ejemplo.com.py');
    expect(hostFromFeedUrl('sftp://archivos.ejemplo.com.py/salida/f.xml')).toBe('archivos.ejemplo.com.py');
    expect(hostFromFeedUrl('no-es-una-url')).toBeNull();
    expect(hostFromFeedUrl('')).toBeNull();
    expect(hostFromFeedUrl(undefined)).toBeNull();
  });

  it('el horario se normaliza y lo dudoso queda en null (no se inventa)', () => {
    const { schedule } = sanitizeSourceSchedule({ interval: 'daily', hour: '25', minute: 'x', timezone: 'zona rara', url: 'https://h.py/f' });
    expect(schedule).toEqual({ interval: 'DAILY', hour: null, minute: null, timezone: null });
    expect(sanitizeSourceSchedule({ interval: 'CADA_RATO' }).schedule?.interval).toBe('UNKNOWN');
    expect(sanitizeSourceSchedule(null)).toEqual({ schedule: null, host: null });
  });

  it('los campos se infieren SOLO de columnas declaradas; sin columnas la lista queda vacía', () => {
    expect(inferFieldsFromColumns(['price', 'title', 'availability', 'image_link', 'link', 'inexistente', 7])).toEqual([
      'title',
      'price',
      'availability',
      'image',
      'url',
    ]);
    expect(inferFieldsFromColumns(undefined)).toEqual([]);
    expect(saneado().detectedFields).toEqual([]);
  });

  it('una entrada sin identificador usable se descarta (no se cuenta como fuente)', () => {
    expect(sanitizeDataSource({ name: 'sin id' }, AHORA)).toBeNull();
    expect(sanitizeDataSource({ id: 'con/barra' }, AHORA)).toBeNull();
    expect(sanitizeDataSource(null, AHORA)).toBeNull();
    expect(sanitizeDataSource({ id: 998877 }, AHORA)?.sourceId).toBe('998877');
  });

  it('la barrera de saneamiento lanza si alguien arma metadata con una URL adentro', () => {
    const sucio = { ...saneado(), host: 'https://tienda.ejemplo.com.py/f.csv?token=x' };
    expect(() => assertSanitizedSource(sucio)).toThrow(/sin sanear/);
    const conCredencial = { ...saneado(), nombreSaneado: 'feed token' };
    expect(() => assertSanitizedSource(conCredencial)).toThrow(/credencial/);
    expect(() => assertSanitizedSource(saneado())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Huella
// ---------------------------------------------------------------------------

describe('catalogSourceFingerprint', () => {
  it('no depende del orden en que Meta devuelva las fuentes', () => {
    const a = saneado({ id: '111' });
    const b = saneado({ id: '222' });
    expect(catalogSourceFingerprint([a, b])).toBe(catalogSourceFingerprint([b, a]));
  });

  it('cambia si cambia el host, el horario o las columnas declaradas', () => {
    const base = catalogSourceFingerprint([saneado()]);
    const otroHost = saneado({ schedule: { interval: 'DAILY', hour: '3', minute: '33', timezone: 'America/Asuncion', url: 'https://otro-sitio.com.py/f.csv' } });
    const otraHora = saneado({ schedule: { interval: 'DAILY', hour: '5', minute: '33', timezone: 'America/Asuncion', url: URL_FIRMADA } });
    const otrasColumnas = saneado({ columns: ['title', 'price'] });
    expect(catalogSourceFingerprint([otroHost])).not.toBe(base);
    expect(catalogSourceFingerprint([otraHora])).not.toBe(base);
    expect(catalogSourceFingerprint([otrasColumnas])).not.toBe(base);
  });

  it('NO cambia por el nombre, la fecha de creación ni el momento de la verificación', () => {
    const base = catalogSourceFingerprint([saneado()]);
    expect(catalogSourceFingerprint([saneado({ name: 'Feed renombrado por el owner' })])).toBe(base);
    expect(catalogSourceFingerprint([saneado({ created_time: '2020-01-01T00:00:00+0000' })])).toBe(base);
    const otroMomento = sanitizeDataSource(feedCrudo(), '2027-01-01T00:00:00.000Z');
    expect(catalogSourceFingerprint([otroMomento!])).toBe(base);
  });

  it('cero fuentes tiene huella propia y estable', () => {
    expect(catalogSourceFingerprint([])).toBe(catalogSourceFingerprint([]));
    expect(catalogSourceFingerprint([])).not.toBe(catalogSourceFingerprint([saneado()]));
  });
});

// ---------------------------------------------------------------------------
// Comparación observado vs reconocido
// ---------------------------------------------------------------------------

describe('compareCatalogSources', () => {
  it('sin fuentes y sin reconocimiento ⇒ sin_cambios (un tenant sin feed no queda bloqueado)', () => {
    const r = compareCatalogSources(observacion([]), null);
    expect(r.status).toBe('sin_cambios');
    expect(r.affectedSourceIds).toEqual([]);
    expect(sourceCheckBlocksWrites(r.status)).toBe(false);
  });

  it('una fuente que nadie reconoció ⇒ fuente_nueva con su id', () => {
    const r = compareCatalogSources(observacion([saneado({ id: '556677' })]), null);
    expect(r.status).toBe('fuente_nueva');
    expect(r.newSourceIds).toEqual(['556677']);
    expect(r.acknowledgedFingerprint).toBeNull();
    expect(sourceCheckBlocksWrites(r.status)).toBe(true);
  });

  it('la fuente reconocida, igual que ayer ⇒ sin_cambios', () => {
    const s = saneado();
    const r = compareCatalogSources(observacion([s]), { acknowledgedSourceIds: [s.sourceId], fingerprint: catalogSourceFingerprint([s]) });
    expect(r.status).toBe('sin_cambios');
    expect(r.affectedSourceIds).toEqual([]);
  });

  it('un feed NUEVO junto al reconocido ⇒ fuente_nueva SOLO con el id nuevo', () => {
    const viejo = saneado({ id: '111' });
    const nuevo = saneado({ id: '222' });
    const r = compareCatalogSources(observacion([viejo, nuevo]), {
      acknowledgedSourceIds: ['111'],
      fingerprint: catalogSourceFingerprint([viejo]),
      sources: [viejo],
    });
    expect(r.status).toBe('fuente_nueva');
    expect(r.newSourceIds).toEqual(['222']);
    expect(r.changedSourceIds).toEqual([]);
  });

  it('el schedule del feed reconocido cambió ⇒ fingerprint_cambiado señalando ese id', () => {
    const antes = saneado({ id: '111' });
    const despues = saneado({ id: '111', schedule: { interval: 'HOURLY', hour: '1', minute: '0', timezone: 'America/Asuncion', url: URL_FIRMADA } });
    const r = compareCatalogSources(observacion([despues]), {
      acknowledgedSourceIds: ['111'],
      fingerprint: catalogSourceFingerprint([antes]),
      sources: [antes],
    });
    expect(r.status).toBe('fingerprint_cambiado');
    expect(r.changedSourceIds).toEqual(['111']);
    expect(r.affectedSourceIds).toEqual(['111']);
  });

  it('sin metadata previa, un cambio de huella marca los ids comunes (impreciso pero nunca silencioso)', () => {
    const antes = saneado({ id: '111' });
    const despues = saneado({ id: '111', schedule: { interval: 'DAILY', hour: '9', minute: '0', timezone: 'America/Asuncion', url: URL_FIRMADA } });
    const r = compareCatalogSources(observacion([despues]), { acknowledgedSourceIds: ['111'], fingerprint: catalogSourceFingerprint([antes]) });
    expect(r.status).toBe('fingerprint_cambiado');
    expect(r.changedSourceIds).toEqual(['111']);
  });

  it('el feed reconocido desapareció ⇒ fingerprint_cambiado con el id faltante', () => {
    const s = saneado({ id: '111' });
    const r = compareCatalogSources(observacion([]), { acknowledgedSourceIds: ['111'], fingerprint: catalogSourceFingerprint([s]), sources: [s] });
    expect(r.status).toBe('fingerprint_cambiado');
    expect(r.missingSourceIds).toEqual(['111']);
  });

  it('FAIL-CLOSED: un listado INCOMPLETO nunca puede leerse como "sin cambios"', () => {
    const s = saneado();
    const r = compareCatalogSources(observacion([s], { complete: false }), {
      acknowledgedSourceIds: [s.sourceId],
      fingerprint: catalogSourceFingerprint([s]),
      sources: [s],
    });
    expect(r.status).toBe('fuente_nueva');
    expect(r.incompleteListing).toBe(true);
    expect(sourceCheckBlocksWrites(r.status)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fake del emulador
// ---------------------------------------------------------------------------

describe('FakeMetaCatalogClient.listDataSources', () => {
  it('cero feeds ⇒ observación vacía y completa', async () => {
    const obs = await new FakeMetaCatalogClient({ dataSourcesDetectedAt: AHORA }).listDataSources('CAT-1');
    expect(obs.sources).toEqual([]);
    expect(obs.complete).toBe(true);
    expect(compareCatalogSources(obs, null).status).toBe('sin_cambios');
  });

  it('un feed ⇒ saneado con la MISMA función que el cliente real (el token no sale)', async () => {
    const fake = new FakeMetaCatalogClient({ dataSources: [feedCrudo()], dataSourcesDetectedAt: AHORA });
    const obs = await fake.listDataSources('CAT-1');
    expect(JSON.stringify(obs)).not.toContain(TOKEN);
    expect(obs.sources[0].host).toBe('tienda.ejemplo.com.py');
    expect(obs.catalogId).toBe('CAT-1');
    // Una llamada por el listado + una por feed_count, igual que el cliente real.
    expect(fake.callsMade).toBe(2);
  });

  it('feed NUEVO y feed con SCHEDULE cambiado se simulan desde el fixture', async () => {
    const base = await new FakeMetaCatalogClient({ dataSources: [feedCrudo({ id: '111' })], dataSourcesDetectedAt: AHORA }).listDataSources('CAT-1');
    const reconocido = { acknowledgedSourceIds: ['111'], fingerprint: catalogSourceFingerprint(base.sources), sources: base.sources };

    const conNuevo = await new FakeMetaCatalogClient({
      dataSources: [feedCrudo({ id: '111' }), feedCrudo({ id: '222', name: 'Feed de promos' })],
      dataSourcesDetectedAt: AHORA,
    }).listDataSources('CAT-1');
    expect(compareCatalogSources(conNuevo, reconocido)).toMatchObject({ status: 'fuente_nueva', newSourceIds: ['222'] });

    const conHorarioNuevo = await new FakeMetaCatalogClient({
      dataSources: [feedCrudo({ id: '111', schedule: { interval: 'HOURLY', hour: '6', minute: '0', timezone: 'America/Asuncion', url: URL_FIRMADA } })],
      dataSourcesDetectedAt: AHORA,
    }).listDataSources('CAT-1');
    expect(compareCatalogSources(conHorarioNuevo, reconocido)).toMatchObject({ status: 'fingerprint_cambiado', changedSourceIds: ['111'] });
  });

  it('feed_count mayor que lo listado ⇒ observación incompleta', async () => {
    const obs = await new FakeMetaCatalogClient({ dataSources: [feedCrudo()], feedCount: 4, dataSourcesDetectedAt: AHORA }).listDataSources('CAT-1');
    expect(obs.complete).toBe(false);
  });

  it('failWith listDataSources ⇒ propaga el error del fixture', async () => {
    const fake = new FakeMetaCatalogClient({ failWith: { op: 'listDataSources', status: 403, code: 200, message: 'sin permiso' } });
    await expect(fake.listDataSources('CAT-1')).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

describe('metaCatalogSourceChecks — persistencia saneada e idempotente', () => {
  const T0 = Timestamp.fromMillis(1_800_000_000_000);
  const T1 = Timestamp.fromMillis(1_800_000_600_000);

  it('el id del check deriva del catálogo + la huella (misma observación ⇒ mismo doc)', () => {
    const h = catalogSourceFingerprint([saneado()]);
    expect(catalogSourceCheckId('CAT-1', h)).toBe(catalogSourceCheckId('CAT-1', h));
    expect(catalogSourceCheckId('CAT-2', h)).not.toBe(catalogSourceCheckId('CAT-1', h));
    expect(catalogSourceCheckId('CAT-1', h)).toMatch(/^chk_[0-9a-f]{32}$/);
  });

  it('persiste metadata SANEADA: ni token, ni URL, ni query string en el documento', async () => {
    const obs = observacion([saneado()]);
    const cmp = compareCatalogSources(obs, null);
    const { checkId, created } = await recordCatalogSourceCheck({ tenantId: 't1', observation: obs, comparison: cmp, now: () => T0 });
    expect(created).toBe(true);
    const doc = store.get(`tenants/t1/metaCatalogSourceChecks/${checkId}`)!;
    const json = JSON.stringify(doc);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain('access_token');
    expect(json).not.toContain('://');
    expect(doc.status).toBe('fuente_nueva');
    expect(doc.sourceIds).toEqual(['556677']);
    expect(doc.catalogId).toBe('CAT-1');
  });

  it('repetir la MISMA verificación no duplica: actualiza lastCheckAt y el contador', async () => {
    const obs = observacion([saneado()]);
    const cmp = compareCatalogSources(obs, null);
    const a = await recordCatalogSourceCheck({ tenantId: 't1', observation: obs, comparison: cmp, now: () => T0 });
    const b = await recordCatalogSourceCheck({ tenantId: 't1', observation: obs, comparison: cmp, now: () => T1 });
    expect(b.checkId).toBe(a.checkId);
    expect(b.created).toBe(false);
    expect(b.checkCount).toBe(2);
    expect(store.size).toBe(1);
    const doc = store.get(`tenants/t1/metaCatalogSourceChecks/${a.checkId}`)!;
    expect((doc.firstCheckAt as Timestamp).toMillis()).toBe(T0.toMillis());
    expect((doc.lastCheckAt as Timestamp).toMillis()).toBe(T1.toMillis());
  });

  it('una huella distinta abre un documento NUEVO (queda la historia del cambio de fuente)', async () => {
    const obs1 = observacion([saneado({ id: '111' })]);
    const obs2 = observacion([saneado({ id: '111', schedule: { interval: 'HOURLY', hour: '6', minute: '0', timezone: 'America/Asuncion', url: URL_FIRMADA } })]);
    await recordCatalogSourceCheck({ tenantId: 't1', observation: obs1, comparison: compareCatalogSources(obs1, null), now: () => T0 });
    await recordCatalogSourceCheck({ tenantId: 't1', observation: obs2, comparison: compareCatalogSources(obs2, null), now: () => T1 });
    expect(store.size).toBe(2);
  });

  it('cada tenant escribe en su propia ruta (aislamiento)', async () => {
    const obs = observacion([saneado()]);
    const cmp = compareCatalogSources(obs, null);
    await recordCatalogSourceCheck({ tenantId: 't1', observation: obs, comparison: cmp, now: () => T0 });
    await recordCatalogSourceCheck({ tenantId: 't2', observation: obs, comparison: cmp, now: () => T0 });
    expect([...store.keys()].every((k) => k.startsWith('tenants/t1/') || k.startsWith('tenants/t2/'))).toBe(true);
    expect(store.size).toBe(2);
  });

  it('ÚLTIMA BARRERA: metadata sin sanear NO se escribe (lanza antes de tocar Firestore)', async () => {
    const sucio = { ...saneado(), host: `https://tienda.ejemplo.com.py/f.csv?access_token=${TOKEN}` };
    const obs = observacion([sucio]);
    await expect(
      recordCatalogSourceCheck({ tenantId: 't1', observation: obs, comparison: compareCatalogSources(obs, null), now: () => T0 }),
    ).rejects.toThrow(/sin sanear/);
    expect(store.size).toBe(0);
  });

  it('buildCatalogSourceCheckDoc es puro: sin doc previo arranca en 1 y fija firstCheckAt', () => {
    const obs = observacion([saneado()]);
    const doc = buildCatalogSourceCheckDoc(obs, compareCatalogSources(obs, null), T0, null);
    expect(doc.checkCount).toBe(1);
    expect(doc.firstCheckAt).toBe(T0);
    expect(doc.lastCheckAt).toBe(T0);
  });
});
