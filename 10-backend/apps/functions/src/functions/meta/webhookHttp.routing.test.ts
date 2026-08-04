/**
 * webhookHttp.routing.test.ts — DESTINOS SEPARADOS por tipo de evento (ADR-0017 §12)
 * ==================================================================================
 * `onWebhookInbox` dispara sobre TODO documento de `metaWebhookInbox`: esa colección **es** el
 * disparador del motor. Por eso el historial (hasta 180 días de conversaciones privadas del
 * tenant) y la agenda del vendedor no pueden pasar por ahí — ni siquiera "marcados": un `if` se
 * borra en un refactor, una colección distinta no.
 *
 * Y hay una segunda razón, de aislamiento: `metaWebhookInbox` la lee `isPlatformAdmin()`. Mandar
 * el historial ahí convertiría esa regla en acceso de plataforma al historial completo de los
 * clientes de la perfumería. De ahí que las colecciones nuevas sean `read: if false`.
 *
 * Los tests corren contra el plan de escritura PURO y contra el handler REAL con un Firestore de
 * mentira: el plan prueba la decisión, el handler prueba que la decisión efectivamente se ejecuta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Firestore de mentira: registra en qué colección y con qué id se escribió cada documento. */
const fake = vi.hoisted(() => {
  const escrituras: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
  const existentes = new Set<string>();
  let seq = 0;
  const db = () => ({
    collection: (collection: string) => ({
      doc: (id?: string) => {
        const docId = id ?? `auto_${++seq}`;
        return {
          id: docId,
          create: async (data: Record<string, unknown>) => {
            const clave = `${collection}/${docId}`;
            if (existentes.has(clave)) throw Object.assign(new Error('already exists'), { code: 6 });
            existentes.add(clave);
            escrituras.push({ collection, id: docId, data });
          },
        };
      },
    }),
  });
  return { escrituras, existentes, db, reset: () => { escrituras.length = 0; existentes.clear(); seq = 0; } };
});

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('../../lib/firebase.js', () => ({
  db: fake.db,
  storage: () => ({}),
  paths: { metaWebhookInbox: () => 'metaWebhookInbox' },
}));
vi.mock('../../lib/logger.js', () => ({ logger: log }));
// La firma ya tiene su propio test; acá lo que se prueba es el RUTEO.
vi.mock('../../middleware/webhookSignature.js', () => ({ verifyMetaSignature: () => undefined }));

import {
  metaWebhook,
  planWebhookWrites,
  COEXISTENCE_HISTORY_COLLECTION,
  COEXISTENCE_APP_STATE_COLLECTION,
  HISTORY_TTL_MS,
  APP_STATE_TTL_MS,
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

const echoBody = (over: Record<string, unknown> = {}) =>
  cambio('smb_message_echoes', {
    metadata,
    message_echoes: [{ from: NEGOCIO, to: CLIENTE, id: 'wamid.ECHO1', timestamp: '1754200000', type: 'text', text: { body: 'ya te lo mando' }, ...over }],
  });

const historyBody = () =>
  cambio('history', {
    metadata,
    history: [{
      metadata: { phase: 0, chunk_order: 3, progress: 70 },
      threads: [{ id: CLIENTE, messages: [{ from: NEGOCIO, to: CLIENTE, id: 'wamid.H1', timestamp: '1754100000', type: 'text', text: { body: 'te aviso cuando llegue' } }] }],
    }],
  });

const appStateBody = () =>
  cambio('smb_app_state_sync', {
    metadata,
    state_sync: [{ type: 'contact', contact: { full_name: 'Pablo Morales', phone_number: '595981111111' }, action: 'add', metadata: { timestamp: '1754200500' } }],
  });

const mensajeBody = () =>
  cambio('messages', { metadata, messages: [{ from: CLIENTE, id: 'wamid.M1', timestamp: '1754200000', type: 'text', text: { body: 'hola' } }] });

const plan = (body: unknown, nowMs = 1_754_200_000_000) => planWebhookWrites(parseMetaWebhookPayload(body), nowMs);

describe('planWebhookWrites — cada tipo a su destino', () => {
  it('`messages` sigue yendo a metaWebhookInbox, marcado con su tipo', () => {
    const [w] = plan(mensajeBody());
    expect(w!.collection).toBe('metaWebhookInbox');
    expect(w!.kind).toBe('message');
    expect(w!.event.kind).toBe('message');
    expect((w!.event.payload as Record<string, unknown>)['from']).toBe(CLIENTE);
  });

  it('un ECHO va a metaWebhookInbox marcado como outbound HUMANO, y sin `payload.from`', () => {
    const [w] = plan(echoBody());
    expect(w!.collection).toBe('metaWebhookInbox');
    expect(w!.kind).toBe('echo');
    expect(w!.event.kind).toBe('echo');
    const payload = w!.event.payload as Record<string, unknown>;
    // FAIL-SAFE PASIVO: `process.ts` exige `payload.from` para procesar un inbound. Al no existir,
    // aunque alguien borrara el gate por tipo, un echo jamás se convertiría en mensaje del cliente.
    expect('from' in payload).toBe(false);
    expect(payload['direction']).toBe('outbound');
    expect(payload['origin']).toBe('whatsapp_business_app');
    expect((payload['echo'] as Record<string, unknown>)['customerWaId']).toBe(CLIENTE);
    expect(w!.event.automationEligible).toBe(false);
    expect(JSON.stringify(w!.event)).not.toContain(NEGOCIO);
  });

  it('la clave del echo lleva prefijo propio: no pisa ni es pisada por un mensaje vivo', () => {
    const [echo] = plan(echoBody());
    const [mensaje] = plan(cambio('messages', { metadata, messages: [{ from: CLIENTE, id: 'wamid.ECHO1', timestamp: '1', type: 'text', text: { body: 'x' } }] }));
    expect(echo!.docId).not.toBe(mensaje!.docId);
    expect(echo!.docId).toContain('echo');
  });

  it('HISTORY va a una colección PROPIA, inerte y con TTL corto', () => {
    const [w] = plan(historyBody());
    expect(w!.collection).toBe(COEXISTENCE_HISTORY_COLLECTION);
    expect(w!.collection).not.toBe('metaWebhookInbox'); // …o el motor lo procesaría
    expect(w!.kind).toBe('history');
    expect(w!.event.historical).toBe(true);
    expect(w!.event.automationEligible).toBe(false);
    expect(w!.event.unread).toBe(false);
    expect(HISTORY_TTL_MS).toBe(48 * 3_600_000);
    expect(w!.event.expiresAt!.toMillis() - 1_754_200_000_000).toBe(HISTORY_TTL_MS);
  });

  it('APP STATE va a otra colección propia, con TTL de 7 días y sin crear clientes', () => {
    const [w] = plan(appStateBody());
    expect(w!.collection).toBe(COEXISTENCE_APP_STATE_COLLECTION);
    expect(w!.collection).not.toBe('metaWebhookInbox');
    expect(w!.kind).toBe('app_state');
    expect(w!.event.automationEligible).toBe(false);
    expect(APP_STATE_TTL_MS).toBe(7 * 86_400_000);
    expect(w!.event.expiresAt!.toMillis() - 1_754_200_000_000).toBe(APP_STATE_TTL_MS);
    expect(JSON.stringify(w!.event.payload)).toContain('595981111111');
  });

  it('las tres colecciones son DISTINTAS entre sí', () => {
    expect(new Set(['metaWebhookInbox', COEXISTENCE_HISTORY_COLLECTION, COEXISTENCE_APP_STATE_COLLECTION]).size).toBe(3);
  });

  it('campo desconocido → CERO escrituras (se audita, no se persiste)', () => {
    expect(plan(cambio('flows_beta_v9', { metadata, token: 'EAAG-secreto' }))).toHaveLength(0);
  });
});

describe('metaWebhook (handler real, Firestore de mentira)', () => {
  const post = async (body: unknown) => {
    const res: Record<string, unknown> = {};
    // Doble mínimo de la respuesta de express: `onRequest` engancha listeners antes de delegar.
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

  beforeEach(() => { fake.reset(); log.warn.mockClear(); log.info.mockClear(); });

  it('un echo NO aterriza como mensaje: mismo inbox, otro id, otro tipo', async () => {
    const r = await post(echoBody());
    expect(r.code).toBe(200);
    expect(fake.escrituras).toHaveLength(1);
    expect(fake.escrituras[0]!.collection).toBe('metaWebhookInbox');
    expect(fake.escrituras[0]!.data['kind']).toBe('echo');
    expect(JSON.stringify(fake.escrituras[0]!.data)).not.toContain(NEGOCIO);
  });

  it('un echo repetido NO se duplica (idempotencia por wamid)', async () => {
    await post(echoBody());
    const r = await post(echoBody());
    expect(fake.escrituras).toHaveLength(1);
    expect(r.body['duplicates']).toBe(1);
  });

  it('el historial NO toca metaWebhookInbox', async () => {
    await post(historyBody());
    expect(fake.escrituras.map((e) => e.collection)).toEqual([COEXISTENCE_HISTORY_COLLECTION]);
    expect(fake.escrituras.some((e) => e.collection === 'metaWebhookInbox')).toBe(false);
  });

  it('B8: un chunk de historial duplicado sube a WARN y tiene contador propio', async () => {
    await post(historyBody());
    log.warn.mockClear();
    const r = await post(historyBody());
    // Meta da 24 h para sincronizar el historial: un chunk perdido con log `info` se descubre tarde.
    expect(log.warn).toHaveBeenCalled();
    expect(r.body['historyDuplicates']).toBe(1);
    expect(fake.escrituras).toHaveLength(1);
  });

  it('la agenda del vendedor no crea nada en el inbox', async () => {
    await post(appStateBody());
    expect(fake.escrituras.map((e) => e.collection)).toEqual([COEXISTENCE_APP_STATE_COLLECTION]);
  });

  it('campo desconocido → ACK 200, cero escrituras, auditoría saneada', async () => {
    const r = await post(cambio('flows_beta_v9', { metadata, token: 'EAAG-secreto', telefono: NEGOCIO }));
    expect(r.code).toBe(200);
    expect(r.body['ok']).toBe(true);
    expect(fake.escrituras).toHaveLength(0);
    const auditado = JSON.stringify(log.warn.mock.calls);
    expect(auditado).toContain('flows_beta_v9');
    expect(auditado).not.toContain('EAAG-secreto');
    expect(auditado).not.toContain(NEGOCIO);
  });

  it('SIN REGRESIONES: un mensaje normal sigue escribiéndose igual en el inbox', async () => {
    const r = await post(mensajeBody());
    expect(fake.escrituras).toHaveLength(1);
    expect(fake.escrituras[0]!.collection).toBe('metaWebhookInbox');
    expect((fake.escrituras[0]!.data['payload'] as Record<string, unknown>)['from']).toBe(CLIENTE);
    expect(r.body['written']).toBe(1);
  });
});

describe('firestore.rules — el historial no puede quedar bajo la regla del inbox', () => {
  const rules = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'firestore.rules'),
    'utf8',
  );
  const bloque = (coleccion: string): string => {
    const i = rules.indexOf(`match /${coleccion}/`);
    expect(i, `falta la regla de ${coleccion}`).toBeGreaterThan(-1);
    return rules.slice(i, i + 260);
  };

  for (const coleccion of [COEXISTENCE_HISTORY_COLLECTION, COEXISTENCE_APP_STATE_COLLECTION]) {
    it(`${coleccion}: cerrada al cliente (read y write en false, solo Admin SDK)`, () => {
      const b = bloque(coleccion);
      expect(b).toMatch(/allow read(, write)?: if false;/);
      expect(b).toMatch(/allow (read, )?write: if false;/);
      // El historial son 180 días de chats privados del tenant: ni siquiera el admin de plataforma.
      expect(b).not.toContain('isPlatformAdmin');
    });
  }

  it('el inbox conserva su regla actual (esta superficie no la afloja ni la endurece)', () => {
    expect(bloque('metaWebhookInbox')).toContain('allow read: if isPlatformAdmin();');
  });
});
