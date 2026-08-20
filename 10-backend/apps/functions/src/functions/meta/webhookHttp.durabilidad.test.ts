/**
 * webhookHttp.durabilidad.test.ts — H-01: el mensaje del cliente NO se pierde en silencio
 * ========================================================================================
 * Defecto auditado (`docs/system-audit-2026-08.md` §H-01): cuando la escritura de un evento VIVO
 * al inbox fallaba por un error transitorio de Firestore (UNAVAILABLE, timeout, contención), el
 * handler igual respondía `200 {ok:true}`. Un 200 le dice a Meta «lo tengo» ⇒ no hay redelivery ⇒
 * el mensaje del cliente no existe en ningún lado: sin burbuja, sin no-leído, sin lead. Y el
 * resumen (`written:0`) era indistinguible del de un lote vacío.
 *
 * Lo que fija esta suite:
 *  1. un fallo real de escritura de tráfico vivo NO puede responder 200;
 *  2. un DUPLICADO sigue siendo 200 (si esto se rompe, el webhook entra en loop con Meta);
 *  3. lo ya persistido sobrevive al reintento — la redelivery es idempotente por clave
 *     determinística, que es la razón por la que pedir el reintento es seguro;
 *  4. el resumen distingue «no había nada» de «no pude»;
 *  5. una excepción a mitad del lote con tráfico vivo pendiente también pide reintento;
 *  6. el camino de Coexistence (503 del archivo) queda igual;
 *  7. el log del fallo permite rastrear a quién se le perdió, SIN el teléfono entero.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Firestore de mentira con fallos inyectables por colección (modelado sobre `routing.test.ts`). */
const fake = vi.hoisted(() => {
  const escrituras: Array<{ collection: string; id: string }> = [];
  const existentes = new Set<string>();
  const legibles = new Map<string, Record<string, unknown>>();
  const estado = {
    /** Colecciones cuyo `create` lanza un error TRANSITORIO (no ALREADY_EXISTS). */
    escrituraRota: new Set<string>(),
    /** Ids cuyo `create` lanza; permite romper UNA escritura de un lote y dejar pasar la otra. */
    idsRotos: new Set<string>(),
    /** true ⇒ `db().collection()` lanza: excepción a mitad del handler, fuera del try interno. */
    collectionRota: false,
    /** Código gRPC del fallo inyectado. 14 = UNAVAILABLE (transitorio); 7 = PERMISSION_DENIED. */
    codigoDeFallo: 14,
  };
  let seq = 0;
  const db = () => ({
    collection: (collection: string) => {
      if (estado.collectionRota) throw new Error('firestore caído a mitad del lote (simulado)');
      return {
        doc: (id?: string) => {
          const docId = id ?? `auto_${++seq}`;
          return {
            id: docId,
            create: async () => {
              const clave = `${collection}/${docId}`;
              if (existentes.has(clave)) throw Object.assign(new Error('already exists'), { code: 6 });
              if (estado.escrituraRota.has(collection) || estado.idsRotos.has(docId)) {
                // Código gRPC inyectable: 14 UNAVAILABLE (transitorio) o 7 PERMISSION_DENIED (permanente).
                throw Object.assign(new Error('fallo de escritura simulado'), { code: estado.codigoDeFallo });
              }
              existentes.add(clave);
              escrituras.push({ collection, id: docId });
            },
          };
        },
      };
    },
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: legibles.has(path), data: () => legibles.get(path) }),
    }),
  });
  return {
    escrituras, existentes, legibles, estado, db,
    reset: () => {
      escrituras.length = 0; existentes.clear(); legibles.clear();
      estado.escrituraRota.clear(); estado.idsRotos.clear(); estado.collectionRota = false; estado.codigoDeFallo = 14; seq = 0;
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

import { metaWebhook, traeTraficoVivoCrudo, COEXISTENCE_HISTORY_COLLECTION } from './webhookHttp.js';

const NEGOCIO = '595990000001';
const CLIENTE = '595991234567';
const PNID = 'PNID_DEL_NUMERO_REAL';
const metadata = { display_phone_number: NEGOCIO, phone_number_id: PNID };
const WAMID = 'wamid.HBgMNTk1OTkxMjM0NTY3';

const cambio = (field: string, value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA_ID', changes: [{ field, value }] }],
});

const mensajeBody = (id = WAMID, texto = 'hola, quiero un perfume') =>
  cambio('messages', { metadata, messages: [{ from: CLIENTE, id, timestamp: '1754200000', type: 'text', text: { body: texto } }] });

/** Dos mensajes vivos en el MISMO POST: Meta batchea, y ese es el caso que más duele. */
const loteDeDos = () =>
  cambio('messages', {
    metadata,
    messages: [
      { from: CLIENTE, id: `${WAMID}_A`, timestamp: '1754200000', type: 'text', text: { body: 'primero' } },
      { from: CLIENTE, id: `${WAMID}_B`, timestamp: '1754200001', type: 'text', text: { body: 'segundo' } },
    ],
  });

const historyBody = () =>
  cambio('history', {
    metadata,
    history: [{
      metadata: { phase: 0, chunk_order: 3, progress: 70 },
      threads: [{ id: CLIENTE, messages: [{ from: NEGOCIO, to: CLIENTE, id: 'wamid.H1', timestamp: '1754100000', type: 'text', text: { body: 'hola' } }] }],
    }],
  });

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

const sembrarIndice = () => fake.legibles.set(`metaExternalIndex/whatsapp_${PNID}`, { tenantId: 'empresa-de-prueba' });

beforeEach(() => { fake.reset(); log.error.mockClear(); log.info.mockClear(); log.warn.mockClear(); });

describe('H-01 · un mensaje vivo que no se persistió JAMÁS responde 200', () => {
  it('fallo transitorio del inbox ⇒ NO 200, con retry y el contador de perdidos', async () => {
    fake.estado.escrituraRota.add('metaWebhookInbox');
    const r = await post(mensajeBody());
    // Lo esencial: Meta tiene que reintentar. Un 200 acá borra el mensaje del cliente para siempre.
    expect(r.code).not.toBe(200);
    expect(r.code).toBe(503);
    expect(r.body['retry']).toBe(true);
    expect(r.body['liveWriteFailures']).toBe(1);
    expect(fake.escrituras).toHaveLength(0);
  });

  it('el resumen distingue «no pude» de «no había nada»: lote vacío ⇒ 200 y cero fallos', async () => {
    const vacio = await post(cambio('messages', { metadata, messages: [] }));
    expect(vacio.code).toBe(200);
    expect(vacio.body['written']).toBe(0);
    expect(vacio.body['liveWriteFailures']).toBe(0);

    fake.estado.escrituraRota.add('metaWebhookInbox');
    const roto = await post(mensajeBody());
    // Mismo `written:0` que el lote vacío — lo que los separa es el contador nuevo y el código.
    expect(roto.body['written']).toBe(0);
    expect(roto.body['liveWriteFailures']).toBe(1);
    expect(roto.code).not.toBe(vacio.code);
  });

  it('un DUPLICADO no es un fallo: sigue respondiendo 200 (si no, loop de reintentos con Meta)', async () => {
    const primero = await post(mensajeBody());
    expect(primero.code).toBe(200);
    expect(primero.body['written']).toBe(1);

    const redelivery = await post(mensajeBody());
    expect(redelivery.code).toBe(200);
    expect(redelivery.body['duplicates']).toBe(1);
    expect(redelivery.body['liveWriteFailures']).toBe(0);
    expect(fake.escrituras).toHaveLength(1); // la redelivery no escribió NADA nuevo
  });

  it('lote mixto: lo que se persistió queda, se pide reintento, y el reintento no duplica', async () => {
    fake.estado.idsRotos.add(`whatsapp_${WAMID}_B`);
    const primera = await post(loteDeDos());
    expect(primera.code).toBe(503);
    expect(primera.body['written']).toBe(1);
    expect(primera.body['liveWriteFailures']).toBe(1);
    expect(fake.escrituras).toHaveLength(1);

    // Redelivery de Meta con el MISMO cuerpo, ya sin la falla: A vuelve como duplicado inocuo y B
    // recién ahí se persiste. Esto es lo que hace SEGURO pedir el reintento.
    fake.estado.idsRotos.clear();
    const segunda = await post(loteDeDos());
    expect(segunda.code).toBe(200);
    expect(segunda.body['duplicates']).toBe(1);
    expect(segunda.body['written']).toBe(1);
    expect(fake.escrituras).toHaveLength(2); // exactamente dos documentos, no tres
  });

  it('excepción a mitad del lote con tráfico vivo pendiente ⇒ reintento, no 200 silencioso', async () => {
    fake.estado.collectionRota = true;
    const r = await post(mensajeBody());
    expect(r.code).toBe(503);
    expect(r.body['retry']).toBe(true);
    expect(fake.escrituras).toHaveLength(0);
  });

  /**
   * CORREGIDO en la review de este programa. La versión anterior exigía el wamid COMPLETO
   * ("no es PII") y assertaba que el log no contuviera el teléfono — las dos cosas a la vez solo
   * se sostenían por accidente: el wamid de la Cloud API LLEVA el teléfono en base64
   * (`Buffer.from('HBgMNTk1OTkxMjM0NTY3','base64')` ⇒ `\x1c\x18\x0c595991234567`), así que el
   * test se certificaba a sí mismo. Ahora se exige enmascarado y se verifica contra la forma
   * codificada, que es la que realmente filtraba.
   */
  it('el log del fallo permite rastrear, con el wamid ENMASCARADO (lleva el teléfono en base64)', async () => {
    sembrarIndice();
    fake.estado.escrituraRota.add('metaWebhookInbox');
    await post(mensajeBody());
    const entrada = log.error.mock.calls.find((c) => String(c[0]).includes('no se pudo escribir'));
    expect(entrada).toBeDefined();
    const meta = entrada![2] as Record<string, unknown>;
    const serializado = JSON.stringify(meta);
    expect(String(meta['wamid'])).toMatch(/^…/);            // enmascarado, no completo
    expect(String(meta['phoneNumberId'])).toContain('…');   // el PNID también
    expect(serializado).not.toContain(CLIENTE);             // el teléfono en claro
    expect(serializado).not.toContain('NTk1OTkxMjM0NTY3');  // y el teléfono en base64
    expect(serializado).not.toContain(WAMID);               // el wamid entero jamás
  });
});

describe('H-01 · lo que NO puede cambiar', () => {
  it('regresión: el 503 del archivo de Coexistence sigue funcionando igual', async () => {
    sembrarIndice();
    fake.estado.escrituraRota.add(COEXISTENCE_HISTORY_COLLECTION);
    const r = await post(historyBody());
    expect(r.code).toBe(503);
    expect(r.body['retry']).toBe(true);
  });

  it('un POST sano de tráfico vivo sigue respondiendo 200 con su resumen', async () => {
    const r = await post(mensajeBody());
    expect(r.code).toBe(200);
    expect(r.body['ok']).toBe(true);
    expect(r.body['written']).toBe(1);
    expect(r.body['liveWriteFailures']).toBe(0);
  });
});

describe('H-01 · endurecimientos de la review adversarial', () => {
  it('un fallo NO transitorio (IAM roto) NO pide reintento: insistir no lo arregla y Meta castiga el bucle', async () => {
    fake.estado.escrituraRota.add('metaWebhookInbox');
    fake.estado.codigoDeFallo = 7; // PERMISSION_DENIED
    const r = await post(mensajeBody());
    expect(r.code).toBe(200);
    expect(r.body['liveWriteFailures']).toBe(1); // se declara la pérdida igual
    const grito = log.error.mock.calls.find((c) => String(c[0]).includes('requiere intervención'));
    expect(grito).toBeDefined(); // no se pierde en silencio: queda un incidente operativo
  });

  it('un fallo transitorio SÍ pide reintento (contraste del caso anterior)', async () => {
    fake.estado.escrituraRota.add('metaWebhookInbox');
    fake.estado.codigoDeFallo = 14; // UNAVAILABLE
    const r = await post(mensajeBody());
    expect(r.code).toBe(503);
  });

  it('un entrante SIN wamid recibe clave estable: la redelivery NO lo duplica', async () => {
    const sinWamid = () => cambio('messages', { metadata, messages: [{ from: CLIENTE, timestamp: '1754200000', type: 'text', text: { body: 'sin id' } }] });
    const primera = await post(sinWamid());
    expect(primera.code).toBe(200);
    expect(fake.escrituras).toHaveLength(1);
    const segunda = await post(sinWamid());
    expect(segunda.body['duplicates']).toBe(1);
    expect(fake.escrituras).toHaveLength(1); // sin id determinístico serían DOS documentos
  });

  it('excepción con el ARCHIVO en riesgo también pide reintento (el historial no se puede re-pedir)', async () => {
    sembrarIndice();
    fake.estado.collectionRota = true;
    const r = await post(historyBody());
    expect(r.code).toBe(503);
    expect(r.body['retry']).toBe(true);
  });
});

describe('traeTraficoVivoCrudo — detector defensivo para la excepción temprana', () => {
  it('reconoce el tráfico vivo de Instagram/Messenger (viaja en entry[].messaging)', () => {
    const igBody = { object: 'instagram', entry: [{ id: 'IG', messaging: [{ sender: { id: '123' }, message: { mid: 'm1', text: 'hola' } }] }] };
    expect(traeTraficoVivoCrudo(igBody)).toBe(true);
  });

  it('un history con adjuntos en value.messages NO cuenta como tráfico vivo (tiene su propio 503)', () => {
    const historyMedia = cambio('history', { metadata, messages: [{ id: 'x' }] });
    expect(traeTraficoVivoCrudo(historyMedia)).toBe(false);
  });
});

describe('traeTraficoVivoCrudo — casos base', () => {
  it('reconoce un lote con mensajes aunque el parser no haya corrido', () => {
    expect(traeTraficoVivoCrudo(mensajeBody())).toBe(true);
    expect(traeTraficoVivoCrudo(cambio('smb_message_echoes', { metadata, message_echoes: [{ id: 'wamid.E1' }] }))).toBe(true);
  });

  it('un cuerpo sin tráfico vivo (o basura) NO pide reintento: evita el loop con payloads inválidos', () => {
    expect(traeTraficoVivoCrudo(historyBody())).toBe(false);
    expect(traeTraficoVivoCrudo(cambio('messages', { metadata, messages: [] }))).toBe(false);
    expect(traeTraficoVivoCrudo({ object: 'x' })).toBe(false);
    expect(traeTraficoVivoCrudo(null)).toBe(false);
    expect(traeTraficoVivoCrudo('no soy un objeto')).toBe(false);
  });
});
