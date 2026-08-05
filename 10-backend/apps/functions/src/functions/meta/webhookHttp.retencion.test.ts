/**
 * webhookHttp.retencion.test.ts — RETENCIÓN del historial importado (ADR-0017 §4)
 * ===============================================================================
 * El historial trae hasta 180 días de conversaciones privadas de los clientes de la perfumería.
 * El ADR pide tres cosas para poder guardarlo: TTL corto, anulación del payload al cerrar el
 * evento, y aislamiento por tenant verificable. Escribir `expiresAt` NO es tener TTL: sin una
 * política declarada, ese campo es una fecha decorativa y el archivo queda para siempre.
 *
 * Por eso el TTL se testea contra `firestore.indexes.json` (que es lo que se despliega) y no
 * contra la constante de milisegundos: la constante ya estaba y el material igual se retenía.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TENANT = 'empresa-de-prueba';

/** Firestore de mentira: registra escrituras y sirve el índice externo para resolver el tenant. */
const fake = vi.hoisted(() => {
  const escrituras: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
  const lecturas: string[] = [];
  const docs = new Map<string, Record<string, unknown> | undefined>();
  let seq = 0;
  const db = () => ({
    collection: (collection: string) => ({
      doc: (id?: string) => {
        const docId = id ?? `auto_${++seq}`;
        return {
          id: docId,
          create: async (data: Record<string, unknown>) => {
            escrituras.push({ collection, id: docId, data });
          },
        };
      },
    }),
    doc: (path: string) => ({
      get: async () => {
        lecturas.push(path);
        return { data: () => docs.get(path) };
      },
    }),
  });
  return {
    escrituras,
    lecturas,
    docs,
    db,
    reset: () => {
      escrituras.length = 0;
      lecturas.length = 0;
      docs.clear();
      seq = 0;
    },
  };
});

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('../../lib/firebase.js', () => ({
  db: fake.db,
  storage: () => ({}),
  paths: {
    metaWebhookInbox: () => 'metaWebhookInbox',
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));
vi.mock('../../lib/logger.js', () => ({ logger: log }));
vi.mock('../../middleware/webhookSignature.js', () => ({ verifyMetaSignature: () => undefined }));

import {
  metaWebhook,
  planWebhookWrites,
  COEXISTENCE_HISTORY_COLLECTION,
  COEXISTENCE_APP_STATE_COLLECTION,
} from './webhookHttp.js';
import { parseMetaWebhookPayload } from '../../meta/parseWebhook.js';

const NEGOCIO = '595990000001';
const CLIENTE = '595991234567';
const PNID = 'PNID_DEL_NUMERO_REAL';
const metadata = { display_phone_number: NEGOCIO, phone_number_id: PNID };

const cambio = (field: string, value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA_ID', changes: [{ field, value }] }],
});

const historyBody = () =>
  cambio('history', {
    metadata,
    history: [
      {
        metadata: { phase: 0, chunk_order: 3, progress: 70 },
        threads: [
          {
            id: CLIENTE,
            messages: [{ from: NEGOCIO, to: CLIENTE, id: 'wamid.H1', timestamp: '1754100000', type: 'text', text: { body: 'te aviso cuando llegue' } }],
          },
        ],
      },
    ],
  });

const appStateBody = () =>
  cambio('smb_app_state_sync', {
    metadata,
    state_sync: [{ type: 'contact', contact: { full_name: 'Pablo Morales', phone_number: '595981111111' }, action: 'add', metadata: { timestamp: '1754200500' } }],
  });

const mensajeBody = () =>
  cambio('messages', { metadata, messages: [{ from: CLIENTE, id: 'wamid.M1', timestamp: '1754200000', type: 'text', text: { body: 'hola' } }] });

const post = async (body: unknown) => {
  const res: Record<string, unknown> = {};
  const resDouble = {
    status(code: number) { res['code'] = code; return this; },
    json(payload: unknown) { res['body'] = payload; return this; },
    send(payload: unknown) { res['body'] = payload; return this; },
    on() { return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end() { return this; },
  };
  const req = { method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)), query: {}, get: () => 'sha256=x' };
  await (metaWebhook as unknown as (a: unknown, b: unknown) => Promise<void>)(req, resDouble);
  return res as { code: number; body: Record<string, unknown> };
};

// ---------------------------------------------------------------------------
// 1) TTL REAL: declarado en la IaC que se despliega, no solo un campo `expiresAt`
// ---------------------------------------------------------------------------

describe('TTL declarado (firestore.indexes.json)', () => {
  const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
  const spec = JSON.parse(readFileSync(join(raiz, 'firestore.indexes.json'), 'utf8')) as {
    fieldOverrides?: Array<{ collectionGroup: string; fieldPath: string; ttl?: boolean; indexes?: unknown[] }>;
  };
  const override = (coleccion: string) => (spec.fieldOverrides ?? []).find((f) => f.collectionGroup === coleccion);

  for (const coleccion of [COEXISTENCE_HISTORY_COLLECTION, COEXISTENCE_APP_STATE_COLLECTION]) {
    it(`${coleccion}: política TTL sobre expiresAt, versionada en el repo`, () => {
      const f = override(coleccion);
      expect(f, `falta el fieldOverride de ${coleccion}: sin política, expiresAt es una fecha decorativa`).toBeTruthy();
      expect(f!.fieldPath).toBe('expiresAt');
      expect(f!.ttl).toBe(true);
    });

    it(`${coleccion}: conserva los índices de un solo campo (la purga consulta por expiresAt)`, () => {
      // `patchField` reescribe `indexConfig` con lo declarado: con `indexes: []` se DESACTIVARÍA el
      // índice por defecto de `expiresAt` y la consulta de la purga dejaría de resolver.
      const modos = (override(coleccion)!.indexes ?? []) as Array<{ order?: string; arrayConfig?: string }>;
      expect(modos.some((i) => i.order === 'ASCENDING')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 2) tenantId en el documento: el aislamiento por tenant tiene que ser verificable
// ---------------------------------------------------------------------------

describe('tenantId en el archivo de Coexistence', () => {
  beforeEach(() => { fake.reset(); log.warn.mockClear(); log.info.mockClear(); });

  it('planWebhookWrites estampa el tenant que resolvió el llamador (history y app_state)', () => {
    const mapa = new Map<string, string | null>([[PNID, TENANT]]);
    const plan = planWebhookWrites(parseMetaWebhookPayload(historyBody()), 1_754_200_000_000, mapa)
      .concat(planWebhookWrites(parseMetaWebhookPayload(appStateBody()), 1_754_200_000_000, mapa));
    expect(plan).toHaveLength(2);
    for (const w of plan) expect(w.event.tenantId).toBe(TENANT);
  });

  it('el handler resuelve el tenant por metaExternalIndex y lo escribe en el documento', async () => {
    fake.docs.set(`metaExternalIndex/whatsapp_${PNID}`, { tenantId: TENANT });
    await post(historyBody());
    expect(fake.escrituras).toHaveLength(1);
    expect(fake.escrituras[0]!.collection).toBe(COEXISTENCE_HISTORY_COLLECTION);
    expect(fake.escrituras[0]!.data['tenantId']).toBe(TENANT);
  });

  it('índice sin entrada: el chunk NO se persiste sin tenant — 503 y reintento de Meta (H11)', async () => {
    // Antes esto era fail-soft (`tenantId: null` + 200) y quemaba el reintento de Meta para
    // siempre, con la generación 1 inventada. Sin saber NI el tenant no hay aislamiento
    // verificable: el chunk no se pierde porque el 503 hace que Meta lo traiga de vuelta cuando
    // el binding exista.
    const r = await post(historyBody());
    expect(r.code).toBe(503);
    expect((r.body as Record<string, unknown>)['retry']).toBe(true);
    expect(fake.escrituras).toHaveLength(0);
  });

  it('SIN REGRESIÓN DE COSTO: un `messages` normal no paga ninguna lectura extra', async () => {
    await post(mensajeBody());
    expect(fake.escrituras).toHaveLength(1);
    expect(fake.lecturas).toHaveLength(0);
  });

  it('varios chunks del MISMO número pagan UNA sola resolución (índice + coordinador)', async () => {
    fake.docs.set(`metaExternalIndex/whatsapp_${PNID}`, { tenantId: TENANT });
    await post({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA_ID', changes: [
        { field: 'history', value: (historyBody().entry[0]!.changes[0]!.value as Record<string, unknown>) },
        { field: 'smb_app_state_sync', value: (appStateBody().entry[0]!.changes[0]!.value as Record<string, unknown>) },
      ] }],
    });
    expect(fake.escrituras).toHaveLength(2);
    // DOS lecturas por PNID DISTINTO, no por chunk: el índice (qué empresa) y el coordinador
    // durable (qué GENERACIÓN de sincronización). La generación entra en la clave de idempotencia
    // porque una segunda sincronización trae los mismos `phase`/`chunk_order` y sin ella el resync
    // entero se descartaría como duplicado. La ruta caliente (`messages`) sigue pagando cero.
    expect(fake.lecturas).toHaveLength(2);
    for (const e of fake.escrituras) expect(e.data['tenantId']).toBe(TENANT);
  });
});
