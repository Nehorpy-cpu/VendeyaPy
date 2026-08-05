/**
 * webhookHttp.generaciones.test.ts — el webhook NO inventa generaciones (H11 + H9-webhook)
 * ========================================================================================
 * Dos defectos de la auditoría de seguridad, ambos sobre la FRONTERA proveedor→tenant:
 *
 *  · H11 — un chunk de historial cuyo PNID no está en `metaExternalIndex` se persistía con
 *    `tenantId: null`, generación 1 INVENTADA y ACK 200: el reintento de Meta se perdía para
 *    siempre y 180 días de PII quedaban clasificados bajo el ciclo equivocado. Sin saber NI el
 *    tenant no se puede persistir nada del archivo: la única red honesta es el 503 (el mismo
 *    mecanismo que ya existe para la lectura caída), que convierte el reintento de Meta en una
 *    cuarentena reanudable.
 *
 *  · H9 (mitad webhook) — los chunks no transportan generación y el webhook les asignaba LA
 *    VIGENTE al llegar. Una redelivery tardía de la generación N, llegando con la N+1 abierta
 *    pero SIN disparar, se etiquetaba (y se claveaba) como N+1: cuando el chunk real de N+1
 *    llegara después, moriría como falso duplicado. El material de otro ciclo se persiste
 *    MARCADO (`fueraDeCiclo: true`) y con clave propia (sufijo `_fdc`) que no colisiona ni con
 *    N ni con N+1.
 *
 * Todo corre contra el handler REAL con un Firestore de mentira (mismo doble que el test de
 * contrato): lo que se prueba es la decisión de persistencia, no helpers auxiliares.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fake = vi.hoisted(() => {
  const escrituras: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
  const docs = new Map<string, Record<string, unknown>>();
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
      },
      create: async (data: Record<string, unknown>) => {
        if (docs.has(path)) throw Object.assign(new Error('already exists'), { code: 6 });
        docs.set(path, { ...data });
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
    reset: () => { escrituras.length = 0; docs.clear(); existentes.clear(); seq = 0; },
  };
});

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

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
vi.mock('../../middleware/webhookSignature.js', () => ({ verifyMetaSignature: () => undefined }));

import { metaWebhook, COEXISTENCE_HISTORY_COLLECTION, COEXISTENCE_APP_STATE_COLLECTION } from './webhookHttp.js';
import { coexistenceHistorySyncPath } from '../../meta/historyCoordinator.js';

const TENANT = 'empresa-de-prueba';
const NEGOCIO = '595990000001';
const CLIENTE = '595991234567';
const PNID = 'PNID_DEL_NUMERO_REAL';
const metadata = { display_phone_number: NEGOCIO, phone_number_id: PNID };
const idxPath = `metaExternalIndex/whatsapp_${PNID}`;
const coordPath = coexistenceHistorySyncPath(TENANT, PNID);

const cambio = (field: string, value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA_ID', changes: [{ field, value }] }],
});

const historyValue = (phase = 0, chunkOrder = 3, progress = 70) => ({
  metadata,
  history: [{
    metadata: { phase, chunk_order: chunkOrder, progress },
    threads: [{ id: CLIENTE, messages: [{ from: NEGOCIO, to: CLIENTE, id: 'wamid.H1', timestamp: '1754100000', type: 'text', text: { body: 'te aviso cuando llegue' } }] }],
  }],
});
const historyBody = (phase = 0, chunkOrder = 3) => cambio('history', historyValue(phase, chunkOrder));

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
    on() { return this; }, setHeader() { return this; }, getHeader() { return undefined; }, end() { return this; },
  };
  const req = { method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)), query: {}, get: () => 'sha256=x' };
  await (metaWebhook as unknown as (a: unknown, b: unknown) => Promise<void>)(req, resDouble);
  return res as { code: number; body: Record<string, unknown> };
};

const sembrarIndice = (): void => {
  fake.docs.set(idxPath, { id: `whatsapp_${PNID}`, tenantId: TENANT, connectionId: `wa_${PNID}`, externalId: PNID, status: 'active' });
};

/** Coordinador con la GENERACIÓN NUEVA abierta pero sin disparo usado: todavía no recibe. */
const sembrarCoordinadorGen2SinDisparo = (): void => {
  fake.docs.set(coordPath, {
    id: PNID, tenantId: TENANT, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
    status: 'pending_request', syncGeneration: 2, generationClaimId: 'claim-2', claimsUsados: ['claim-1'],
    cierreAdministrativo: false, chunksFueraDeCiclo: 0, sharingDecision: null, requestedAt: null, deadlineAt: null,
  });
};

/** Coordinador SELLADO administrativamente (offboarding): el ciclo 1 quedó cerrado. */
const sembrarCoordinadorSellado = (): void => {
  fake.docs.set(coordPath, {
    id: PNID, tenantId: TENANT, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
    status: 'failed', syncGeneration: 1, generationClaimId: 'claim-1', claimsUsadas: [],
    cierreAdministrativo: true, chunksFueraDeCiclo: 0, sharingDecision: 'share', requestedAt: { toMillis: () => 1 }, deadlineAt: null,
  });
};

beforeEach(() => { fake.reset(); vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// H11 — sin índice no se sabe NI el tenant: cuarentena reanudable, no generación inventada
// ---------------------------------------------------------------------------

describe('H11 — un chunk de historial SIN índice PNID no se persiste como generación 1', () => {
  it('índice ausente ⇒ 503 y CERO escrituras (el reintento de Meta es la cuarentena)', async () => {
    // Sin sembrar el índice: el PNID no rutea a ninguna empresa. Persistir acá sería guardar PII
    // sin poder verificar el aislamiento por tenant, bajo una generación que nadie resolvió.
    const r = await post(historyBody());

    expect(r.code).toBe(503);
    expect((r.body as Record<string, unknown>)['retry']).toBe(true);
    expect(fake.escrituras).toHaveLength(0);
    expect(fake.docs.has(coordPath)).toBe(false);
  });

  it('la agenda del vendedor sin índice tampoco se persiste: mismo 503', async () => {
    const r = await post(appStateBody());

    expect(r.code).toBe(503);
    expect(fake.escrituras).toHaveLength(0);
  });

  it('tras sembrar el índice, el retry del MISMO evento persiste con la generación correcta y 200', async () => {
    // Primer intento: sin binding ⇒ nada persistido.
    await post(historyBody());
    expect(fake.escrituras).toHaveLength(0);

    // Se repara el binding (índice + coordinador en generación 2, RECIBIENDO).
    sembrarIndice();
    fake.docs.set(coordPath, {
      id: PNID, tenantId: TENANT, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
      status: 'receiving', syncGeneration: 2, generationClaimId: 'claim-2', claimsUsados: ['claim-1'],
      cierreAdministrativo: false, chunksFueraDeCiclo: 0, sharingDecision: 'share', requestedAt: { toMillis: () => 1 }, deadlineAt: null,
    });

    const r = await post(historyBody());

    expect(r.code).toBe(200);
    // UNA sola escritura en total: la del retry, con SU tenant y SU generación — no quedó ningún
    // documento previo con `tenantId: null` ni con la clave de la generación 1 inventada.
    expect(fake.escrituras).toHaveLength(1);
    expect(fake.escrituras[0]!.collection).toBe(COEXISTENCE_HISTORY_COLLECTION);
    expect(fake.escrituras[0]!.data['tenantId']).toBe(TENANT);
    expect(fake.escrituras[0]!.id).toContain('_g2');
  });

  it('lote MIXTO (mensaje vivo + historial) sin índice ⇒ 503, pero el MENSAJE VIVO se persiste', async () => {
    /**
     * Meta batchea varias `entry` en un POST: el mismo cuerpo puede traer mensajes de clientes del
     * número que VENDE junto a un chunk de archivo de otro número. Descartar el lote entero solo
     * sería seguro si el binding ausente fuera siempre transitorio — y no lo es:
     * `deactivateWhatsappNumber` borra la entrada del índice a propósito, así que la redelivery
     * podría fallar para siempre y esos mensajes se perderían.
     *
     * El contrato correcto: se escribe el tráfico vivo (idempotente por wamid — la redelivery lo
     * reencuentra como duplicado inocuo) y se pide el reintento SOLO por el archivo, que es lo
     * único que no se puede recuperar de otra forma.
     */
    const r = await post({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA_ID', changes: [
        { field: 'messages', value: (mensajeBody().entry[0]!.changes[0]!.value as Record<string, unknown>) },
        { field: 'history', value: historyValue() },
      ] }],
    });

    expect(r.code).toBe(503);
    // El mensaje vivo SÍ quedó (una sola escritura, la del inbox).
    expect(fake.escrituras.map((e) => e.collection)).toEqual(['metaWebhookInbox']);
    // Y del archivo no se persistió nada: sin tenant no se inventa la generación.
    expect(fake.escrituras.some((e) => e.collection === COEXISTENCE_HISTORY_COLLECTION)).toBe(false);
  });

  it('COMPATIBILIDAD: tenant resuelto pero SIN coordinador sigue siendo legítimo (huérfano a propósito)', async () => {
    sembrarIndice();

    const r = await post(historyBody());

    expect(r.code).toBe(200);
    expect(fake.escrituras).toHaveLength(1);
    expect(fake.escrituras[0]!.data['tenantId']).toBe(TENANT);
    // El coordinador huérfano existe a propósito: la anomalía queda visible, no rechazada.
    expect(fake.docs.get(coordPath)!['errorMessage']).toBe('llegó historial sin coordinador previo');
  });

  it('COMPATIBILIDAD: un mensaje vivo sin índice sigue su camino actual (200 al inbox)', async () => {
    const r = await post(mensajeBody());

    expect(r.code).toBe(200);
    expect(fake.escrituras).toHaveLength(1);
    expect(fake.escrituras[0]!.collection).toBe('metaWebhookInbox');
  });
});

// ---------------------------------------------------------------------------
// H9 (mitad webhook) — la generación no se etiqueta "al recibir": material de otro ciclo
// se persiste marcado y con clave propia
// ---------------------------------------------------------------------------

describe('H9 — material tardío con la generación nueva abierta pero SIN disparar', () => {
  it('queda MARCADO fuera-de-ciclo y con clave propia (no la de la generación vigente)', async () => {
    sembrarIndice();
    sembrarCoordinadorGen2SinDisparo();

    const r = await post(historyBody());

    // Se persiste (cuarentena, no pérdida)…
    expect(r.code).toBe(200);
    expect(fake.escrituras).toHaveLength(1);
    const escritura = fake.escrituras[0]!;
    expect(escritura.collection).toBe(COEXISTENCE_HISTORY_COLLECTION);
    // …pero declarando que NO es material del ciclo vigente: campo explícito + clave con sufijo
    // propio que no colisiona ni con la generación 1 (sin sufijo) ni con la 2 (`_g2`).
    expect(escritura.data['fueraDeCiclo']).toBe(true);
    expect(escritura.id.endsWith('_fdc')).toBe(true);
    // Y el coordinador lo CUENTA sin que gobierne su estado.
    expect(fake.docs.get(coordPath)!['chunksFueraDeCiclo']).toBe(1);
    expect(fake.docs.get(coordPath)!['status']).toBe('pending_request');
  });

  it('la clave del ciclo nuevo queda LIBRE: el chunk real de la generación 2 no muere como falso duplicado', async () => {
    sembrarIndice();
    sembrarCoordinadorGen2SinDisparo();

    // 1) Redelivery tardía de la generación anterior, con la 2 abierta pero sin disparo usado.
    await post(historyBody());

    // 2) El disparo de la generación 2 se usa: ahora SÍ está recibiendo.
    fake.docs.set(coordPath, { ...fake.docs.get(coordPath)!, status: 'requested', requestedAt: { toMillis: () => 1_754_200_000_000 } });

    // 3) Llega el chunk REAL de la generación 2, con los MISMOS phase/chunk_order (el contrato de
    //    Meta los repite entre sincronizaciones). Tiene que persistirse como NUEVO.
    const r = await post(historyBody());

    expect((r.body as Record<string, unknown>)['written']).toBe(1);
    expect((r.body as Record<string, unknown>)['historyDuplicates']).toBe(0);
    const enCiclo = fake.escrituras[fake.escrituras.length - 1]!;
    expect(enCiclo.id).toContain('_g2');
    expect(enCiclo.id.endsWith('_fdc')).toBe(false);
    expect('fueraDeCiclo' in enCiclo.data).toBe(false);
  });

  it('cierre ADMINISTRATIVO: el material tardío no se traga como duplicado del ciclo sellado', async () => {
    sembrarIndice();
    sembrarCoordinadorSellado();
    // El chunk p0c3 de la generación 1 YA se había persistido durante el ciclo (clave histórica,
    // sin sufijo). Una redelivery después del sello no puede ni pisarlo ni morir contra él.
    fake.existentes.add(`${COEXISTENCE_HISTORY_COLLECTION}/whatsapp_history_${PNID}_0_3`);

    const r = await post(historyBody());

    expect(r.code).toBe(200);
    expect((r.body as Record<string, unknown>)['written']).toBe(1);
    const escritura = fake.escrituras[0]!;
    expect(escritura.data['fueraDeCiclo']).toBe(true);
    expect(escritura.id.endsWith('_fdc')).toBe(true);
  });

  it('la agenda también queda fuera de ciclo cuando el receptor está cerrado', async () => {
    sembrarIndice();
    sembrarCoordinadorGen2SinDisparo();

    const r = await post(appStateBody());

    expect(r.code).toBe(200);
    expect(fake.escrituras).toHaveLength(1);
    expect(fake.escrituras[0]!.collection).toBe(COEXISTENCE_APP_STATE_COLLECTION);
    expect(fake.escrituras[0]!.data['fueraDeCiclo']).toBe(true);
    expect(fake.escrituras[0]!.id.endsWith('_fdc')).toBe(true);
  });

  it('el material fuera de ciclo es idempotente contra SU propia clave (redelivery del mismo chunk)', async () => {
    sembrarIndice();
    sembrarCoordinadorGen2SinDisparo();

    await post(historyBody());
    const r = await post(historyBody());

    expect(fake.escrituras).toHaveLength(1);
    expect((r.body as Record<string, unknown>)['historyDuplicates']).toBe(1);
  });

  it('SIN REGRESIÓN: con el coordinador RECIBIENDO, la clave y la idempotencia no cambian', async () => {
    sembrarIndice();
    fake.docs.set(coordPath, {
      id: PNID, tenantId: TENANT, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
      status: 'receiving', syncGeneration: 2, generationClaimId: 'claim-2', claimsUsados: ['claim-1'],
      cierreAdministrativo: false, chunksFueraDeCiclo: 0, sharingDecision: 'share', requestedAt: { toMillis: () => 1 }, deadlineAt: null,
    });

    const r1 = await post(historyBody());
    const r2 = await post(historyBody());

    expect(fake.escrituras).toHaveLength(1);
    expect(fake.escrituras[0]!.id).toContain('_g2');
    expect(fake.escrituras[0]!.id.endsWith('_fdc')).toBe(false);
    expect('fueraDeCiclo' in fake.escrituras[0]!.data).toBe(false);
    expect((r1.body as Record<string, unknown>)['written']).toBe(1);
    expect((r2.body as Record<string, unknown>)['historyDuplicates']).toBe(1);
  });
});
