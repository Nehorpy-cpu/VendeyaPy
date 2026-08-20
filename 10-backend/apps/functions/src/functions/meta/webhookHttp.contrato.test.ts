/**
 * webhookHttp.contrato.test.ts — el webhook contra el CONTRATO OFICIAL (ADR-0017 §5 y §6)
 * ========================================================================================
 * Los agujeros del parser sólo valen algo si el webhook hace con ellos lo correcto. Acá se prueba
 * el handler REAL, de punta a punta, sobre un Firestore de mentira:
 *
 *  1. los ADJUNTOS del historial (`field:"history"` + `value.messages[]`) se persisten en el
 *     archivo CERRADO y jamás en `metaWebhookInbox` (que ES el disparador del motor);
 *  2. «el negocio no compartió» (2593109), que llega SIN envelope, deja el coordinador `declined`
 *     en vez de esperar hasta quemar la ventana de 24 h;
 *  3. un chunk que NO se pudo persistir devuelve un código que hace REINTENTAR a Meta: es la única
 *     red que existe para material que no se puede volver a pedir;
 *  4. un `ACCOUNT_OFFBOARDED` degrada ese PNID a `inactive` sin tocar nada más;
 *  5. el `131060` esperado tras el onboarding no ensucia la auditoría;
 *  6. y NADA de esto cambia el camino de un `messages` normal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fake = vi.hoisted(() => {
  const escrituras: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
  const docs = new Map<string, Record<string, unknown>>();
  const versiones = new Map<string, number>();
  const existentes = new Set<string>();
  /** Colección cuyas escrituras fallan (para ejercitar el fallo de persistencia del archivo). */
  let coleccionQueFalla = '';
  let seq = 0;

  const db = () => ({
    collection: (collection: string) => ({
      doc: (id?: string) => {
        const docId = id ?? `auto_${++seq}`;
        return {
          id: docId,
          create: async (data: Record<string, unknown>) => {
            if (collection === coleccionQueFalla) throw new Error('firestore caído');
            const clave = `${collection}/${docId}`;
            if (existentes.has(clave)) throw Object.assign(new Error('already exists'), { code: 6 });
            existentes.add(clave);
            docs.set(clave, data);
            escrituras.push({ collection, id: docId, data });
          },
        };
      },
    }),
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
        versiones.set(path, (versiones.get(path) ?? 0) + 1);
      },
      // El dedup de `account_update` (correctivo, MEDIO 17) usa `create`: primera vez escribe,
      // reentrega (mismo id) lanza already-exists — igual que Firestore.
      create: async (data: Record<string, unknown>) => {
        if (docs.has(path)) throw Object.assign(new Error('already exists'), { code: 6 });
        docs.set(path, { ...data });
        versiones.set(path, (versiones.get(path) ?? 0) + 1);
      },
    }),
    batch: () => {
      const ops: Array<{ path: string; data: Record<string, unknown>; merge?: boolean }> = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => ops.push({ path: ref.path, data, merge: opts?.merge }),
        commit: async () => { for (const o of ops) docs.set(o.path, o.merge ? { ...(docs.get(o.path) ?? {}), ...o.data } : { ...o.data }); },
      };
    },
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const ops: Array<{ path: string; data: Record<string, unknown>; merge?: boolean }> = [];
      const tx = {
        get: async (ref: { path: string }) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => ops.push({ path: ref.path, data, merge: opts?.merge }),
      };
      const r = await fn(tx);
      for (const o of ops) docs.set(o.path, o.merge ? { ...(docs.get(o.path) ?? {}), ...o.data } : { ...o.data });
      return r;
    },
  });

  return {
    escrituras, docs, existentes, db,
    fallar: (c: string) => { coleccionQueFalla = c; },
    reset: () => { escrituras.length = 0; docs.clear(); versiones.clear(); existentes.clear(); coleccionQueFalla = ''; seq = 0; },
  };
});

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const auditorias = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../../lib/firebase.js', () => ({
  db: fake.db,
  storage: () => ({}),
  paths: {
    metaWebhookInbox: () => 'metaWebhookInbox',
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
  },
}));
vi.mock('../../lib/logger.js', () => ({ logger: log }));
vi.mock('../../audit/audit.js', () => ({ recordAudit: async (e: Record<string, unknown>) => { auditorias.push(e); } }));
vi.mock('../../middleware/webhookSignature.js', () => ({ verifyMetaSignature: () => undefined }));

import { metaWebhook, COEXISTENCE_HISTORY_COLLECTION } from './webhookHttp.js';
import { coexistenceHistorySyncPath } from '../../meta/historyCoordinator.js';

const TENANT = 'empresa-de-prueba';
const NEGOCIO = '595990000001';
const CLIENTE = '595991234567';
const PNID = 'PNID_DEL_NUMERO_REAL';
const metadata = { display_phone_number: NEGOCIO, phone_number_id: PNID };
const idxPath = `metaExternalIndex/whatsapp_${PNID}`;
const assetPath = `tenants/${TENANT}/metaAssets/${PNID}`;
const coordPath = coexistenceHistorySyncPath(TENANT, PNID);

const cambio = (field: string, value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA_ID', changes: [{ field, value }] }],
});

const post = async (body: unknown) => {
  const res: Record<string, unknown> = {};
  const resDouble = {
    status(code: number) { res['code'] = code; return this; },
    json(payload: unknown) { res['body'] = payload; return this; },
    send(payload: unknown) { res['body'] = payload; return this; },
    on() { return this; }, setHeader() { return this; }, getHeader() { return undefined; }, end() { return this; },
  };
  const req = { method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)), query: {}, get: () => 'sha256=x' };
  await (metaWebhook as unknown as (a: unknown, b: unknown) => Promise<void>)(req, resDouble);
  return res as { code: number; body: Record<string, unknown> };
};

const sembrarNumeroConectado = (): void => {
  fake.docs.set(idxPath, { id: `whatsapp_${PNID}`, tenantId: TENANT, connectionId: `wa_${PNID}`, externalId: PNID, status: 'active' });
  fake.docs.set(assetPath, { id: PNID, tenantId: TENANT, connectionId: `wa_${PNID}`, assetType: 'whatsapp_phone_number', externalId: PNID, status: 'active', selected: false, automationMode: 'live' });
};

beforeEach(() => { fake.reset(); auditorias.length = 0; vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// 1) Adjuntos del historial
// ---------------------------------------------------------------------------

describe('los adjuntos del historial van al archivo CERRADO, nunca al inbox', () => {
  const cuerpo = () =>
    cambio('history', {
      metadata,
      messages: [{ id: 'wamid.HM1', from: CLIENTE, timestamp: '1754100000', type: 'image', image: { id: 'MEDIA_1', mime_type: 'image/jpeg' } }],
    });

  it('se persisten en metaWebhookHistory con su tipo propio', async () => {
    sembrarNumeroConectado();

    const r = await post(cuerpo());

    expect(r.code).toBe(200);
    expect(fake.escrituras).toHaveLength(1);
    expect(fake.escrituras[0]!.collection).toBe(COEXISTENCE_HISTORY_COLLECTION);
    expect(fake.escrituras[0]!.data['eventType']).toBe('history_media');
    expect(fake.escrituras[0]!.data['automationEligible']).toBe(false);
    expect(fake.escrituras[0]!.data['tenantId']).toBe(TENANT);
  });

  it('ni un solo documento cae en metaWebhookInbox', async () => {
    sembrarNumeroConectado();
    await post(cuerpo());
    expect(fake.escrituras.filter((e) => e.collection === 'metaWebhookInbox')).toEqual([]);
  });

  it('reenviarlo no duplica: la clave es por wamid', async () => {
    sembrarNumeroConectado();
    await post(cuerpo());
    await post(cuerpo());
    expect(fake.escrituras).toHaveLength(1);
  });

  it('se cuentan en el coordinador, sin tocar el conteo de chunks', async () => {
    sembrarNumeroConectado();
    await post(cuerpo());
    const coord = fake.docs.get(coordPath)!;
    expect(coord['mediaObservados']).toBe(1);
    expect(coord['chunksObservadosCount']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2) «No compartió», sin envelope
// ---------------------------------------------------------------------------

describe('«el negocio no compartió el historial» es un desenlace, no un silencio', () => {
  const rechazo = () => ({
    metadata,
    history: [{ metadata: { phase: 0, chunk_order: 0, progress: 0 }, errors: [{ code: 2593109, title: 'Business did not share history' }] }],
  });

  it('el payload SIN envelope llega al coordinador y lo deja `declined`', async () => {
    sembrarNumeroConectado();

    const r = await post(rechazo());

    expect(r.code).toBe(200);
    const coord = fake.docs.get(coordPath)!;
    expect(coord['status']).toBe('declined');
    expect(coord['declineCode']).toBe(2593109);
  });

  it('y la evidencia queda persistida en el archivo cerrado', async () => {
    sembrarNumeroConectado();
    await post(rechazo());
    expect(fake.escrituras[0]!.collection).toBe(COEXISTENCE_HISTORY_COLLECTION);
    expect(fake.escrituras[0]!.data['tenantId']).toBe(TENANT);
  });
});

// ---------------------------------------------------------------------------
// 3) Semántica de reintento: un chunk perdido no se recupera de ninguna otra forma
// ---------------------------------------------------------------------------

describe('un chunk del historial que no se pudo persistir hace REINTENTAR a Meta', () => {
  const historyBody = () =>
    cambio('history', {
      metadata,
      history: [{ metadata: { phase: 0, chunk_order: 3, progress: 70 }, threads: [{ id: CLIENTE, messages: [{ from: NEGOCIO, id: 'wamid.H1', type: 'text', text: { body: 'hola' } }] }] }],
    });

  it('responde 5xx en vez de tragarse el chunk con un 200', async () => {
    sembrarNumeroConectado();
    fake.fallar(COEXISTENCE_HISTORY_COLLECTION);

    const r = await post(historyBody());

    expect(r.code).toBeGreaterThanOrEqual(500);
    expect(r.body['retry']).toBe(true);
  });

  it('y el coordinador NO lo cuenta como recibido: nunca podrá decir `completed`', async () => {
    sembrarNumeroConectado();
    fake.fallar(COEXISTENCE_HISTORY_COLLECTION);

    await post(historyBody());

    const coord = fake.docs.get(coordPath)!;
    expect(coord['chunksFallidosPendientes']).toEqual(['p0c3']);
    expect(coord['status']).not.toBe('completed');
  });

  /**
   * ACTUALIZADO por H-01 (auditoría 2026-08-19, `docs/system-audit-2026-08.md`).
   *
   * Este test fijaba lo contrario: que un `messages` fallido conservaba el 200 «para no forzar
   * redelivery del canal del número que vende». La auditoría refutó las dos premisas de esa
   * decisión — no existe ninguna vía de recuperación para un evento vivo que no se escribió, y la
   * redelivery es inocua porque la clave del inbox es determinística por wamid (el reintento
   * escribe cero: ver `webhookHttp.durabilidad.test.ts`, «lote mixto»). El 200 no protegía el
   * canal: borraba el mensaje del cliente sin dejar rastro.
   *
   * La aserción no se debilita, se invierte y se refuerza: además del código, ahora se exige que
   * el resumen declare el evento perdido (antes `written:0` era indistinguible de un lote vacío).
   */
  it('un `messages` que falla PIDE REINTENTO y lo declara en el resumen (H-01)', async () => {
    fake.fallar('metaWebhookInbox');

    const r = await post(cambio('messages', { metadata, messages: [{ from: CLIENTE, id: 'wamid.M1', timestamp: '1754200000', type: 'text', text: { body: 'hola' } }] }));

    expect(r.code).toBe(503);
    expect(r.body['retry']).toBe(true);
    expect(r.body['liveWriteFailures']).toBe(1);
  });

  it('un chunk que ya existía (redelivery) NO se toma como fallo', async () => {
    sembrarNumeroConectado();
    await post(historyBody());

    const r = await post(historyBody());

    expect(r.code).toBe(200);
    expect(fake.docs.get(coordPath)!['chunksFallidosPendientes']).toEqual([]);
    expect(fake.docs.get(coordPath)!['chunksDuplicados']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4) account_update
// ---------------------------------------------------------------------------

describe('account_update — Meta desconecta y el número deja de automatizar', () => {
  it('ACCOUNT_OFFBOARDED degrada ese PNID a `inactive`', async () => {
    sembrarNumeroConectado();

    const r = await post(cambio('account_update', { metadata, event: 'ACCOUNT_OFFBOARDED' }));

    expect(r.code).toBe(200);
    expect(fake.docs.get(assetPath)!['automationMode']).toBe('inactive');
    expect(fake.docs.get(idxPath)!['automationMode']).toBe('inactive');
    expect(auditorias).toHaveLength(1);
  });

  it('no genera ningún documento en la bandeja ni en el archivo', async () => {
    sembrarNumeroConectado();
    await post(cambio('account_update', { metadata, event: 'ACCOUNT_OFFBOARDED' }));
    expect(fake.escrituras).toEqual([]);
  });

  it('ya no se audita como «campo desconocido»', async () => {
    sembrarNumeroConectado();
    await post(cambio('account_update', { metadata, event: 'ACCOUNT_OFFBOARDED' }));
    const desconocidos = log.warn.mock.calls.filter((c) => String(c[0]).includes('DESCONOCIDO'));
    expect(desconocidos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5) 131060 y 6) sin regresión
// ---------------------------------------------------------------------------

describe('131060 es esperado tras el onboarding', () => {
  it('se registra como información, no como advertencia', async () => {
    await post(cambio('messages', { metadata, errors: [{ code: 131060, title: 'Unsupported message type' }] }));

    const advertencias = log.warn.mock.calls.filter((c) => String(c[0]).includes('error declarado por Meta'));
    const informativos = log.info.mock.calls.filter((c) => String(c[0]).includes('error declarado por Meta'));
    expect(advertencias).toEqual([]);
    expect(informativos).toHaveLength(1);
    expect(informativos[0]![1]).toMatchObject({ code: 131060, esperado: true });
  });

  it('cualquier otro código SÍ es advertencia: no se esconde', async () => {
    await post(cambio('messages', { metadata, errors: [{ code: 131000, title: 'Falla real' }] }));

    const advertencias = log.warn.mock.calls.filter((c) => String(c[0]).includes('error declarado por Meta'));
    expect(advertencias).toHaveLength(1);
  });
});

describe('SIN REGRESIÓN — el camino del número que vende', () => {
  it('un `messages` normal sigue yendo al inbox, con 200 y sin lecturas de archivo', async () => {
    const r = await post(cambio('messages', { metadata, messages: [{ from: CLIENTE, id: 'wamid.M1', timestamp: '1754200000', type: 'text', text: { body: 'hola' } }] }));

    expect(r.code).toBe(200);
    expect(fake.escrituras).toHaveLength(1);
    expect(fake.escrituras[0]!.collection).toBe('metaWebhookInbox');
    expect(fake.escrituras[0]!.data['automationEligible']).toBe(true);
    // Un mensaje vivo no crea ni toca coordinadores de historial.
    expect(fake.docs.has(coordPath)).toBe(false);
  });
});
