import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * H4 (Codex Security, MEDIUM) — EL CLAIM DEL INBOX TIENE QUE SER UN SOLO ACTO.
 * ============================================================================
 * `processWebhookEvent` hacía `get` y después `update({processing})` SIN transacción. La entrega
 * de Eventarc es at-least-once: dos invocaciones concurrentes del MISMO evento podían leer
 * `received` las dos, marcarse dueñas las dos y ejecutar motor y outbound las dos — el cliente
 * recibía la respuesta duplicada, sobre el número que vende.
 *
 * Lo que este archivo exige:
 *  · dos entregas CONCURRENTES ⇒ el motor corre UNA vez y sale UN solo mensaje;
 *  · el claim deja un dueño registrado (`claimOwner`) en el MISMO acto que `processing`;
 *  · el RESCATE por antigüedad (`WEBHOOK_STUCK_MS`) sigue existiendo, y también es de un solo
 *    dueño: dos rescatadores concurrentes de un adjunto clavado ingestan UNA vez.
 *
 * El doble de Firestore tiene CONTENCIÓN real (versión por documento, mismo patrón que
 * `historyCoordinator.test.ts`): sin eso, «dos claims concurrentes» sería un test que siempre
 * pasa y la garantía estaría escrita pero no probada.
 */

const docs = new Map<string, Record<string, unknown>>();
/** Versión por documento: es lo que le da CONTENCIÓN real al doble de transacción. */
const versiones = new Map<string, number>();
const enviados: Array<{ to: string; text: string }> = [];
let autoId = 0;

const bump = (path: string) => versiones.set(path, (versiones.get(path) ?? 0) + 1);

function escribir(path: string, data: Record<string, unknown>, merge: boolean): void {
  const base: Record<string, unknown> = merge ? { ...(docs.get(path) ?? {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (k.includes('.')) {
      const partes = k.split('.');
      let cur = base;
      for (const p of partes.slice(0, -1)) {
        cur[p] = { ...((cur[p] as Record<string, unknown>) ?? {}) };
        cur = cur[p] as Record<string, unknown>;
      }
      cur[partes[partes.length - 1]!] = v;
    } else {
      base[k] = v;
    }
  }
  docs.set(path, base);
  bump(path);
}

const refFor = (path: string) => ({
  id: path.split('/').pop() ?? '',
  path,
  // El snapshot captura el dato AL MOMENTO de la lectura (como el SDK real): con un `data()`
  // perezoso sobre el Map, la carrera quedaba linealizada por accidente y el test mentía verde.
  get: async () => {
    const d = docs.get(path);
    return { exists: d !== undefined, data: () => d };
  },
  set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => escribir(path, d, o?.merge === true),
  update: async (d: Record<string, unknown>) => escribir(path, d, true),
  create: async (d: Record<string, unknown>) => {
    if (docs.has(path)) throw Object.assign(new Error('already exists'), { code: 6 });
    escribir(path, d, false);
  },
});

interface Op { path: string; data: Record<string, unknown>; merge: boolean }

/**
 * El doble de transacción CON contención: si un documento leído cambió antes del commit, el
 * cuerpo se reintenta con la lectura fresca — exactamente lo que hace el SDK real, y lo único
 * que puede demostrar que el segundo claim VE al primero.
 */
const runTransaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
  for (let intento = 0; intento < 5; intento++) {
    const leidos = new Map<string, number>();
    const ops: Op[] = [];
    const tx = {
      get: async (ref: { path: string }) => {
        leidos.set(ref.path, versiones.get(ref.path) ?? 0);
        const d = docs.get(ref.path);
        return { exists: d !== undefined, data: () => d };
      },
      set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) =>
        ops.push({ path: ref.path, data, merge: opts?.merge === true }),
      update: (ref: { path: string }, data: Record<string, unknown>) => ops.push({ path: ref.path, data, merge: true }),
    };
    const r = await fn(tx);
    const chocó = [...leidos].some(([p, v]) => (versiones.get(p) ?? 0) !== v);
    if (chocó) continue; // el SDK real reintenta el cuerpo con la lectura fresca
    for (const op of ops) escribir(op.path, op.data, op.merge);
    return r;
  }
  throw new Error('transacción abortada por contención');
};

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => refFor(path),
    collection: (path: string) => ({ doc: (id?: string) => refFor(`${path}/${id ?? `auto${++autoId}`}`) }),
    runTransaction,
  }),
  storage: () => ({ bucket: () => ({ file: () => ({ save: async () => undefined }) }) }),
  paths: {
    metaWebhookEvent: (id: string) => `metaWebhookInbox/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    messages: (t: string, c: string) => `tenants/${t}/customers/${c}/messages`,
    session: (t: string, c: string, k = 'active') => `tenants/${t}/customers/${c}/sessions/${k}`,
  },
}));

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../lib/logger.js', () => ({ logger }));

const handleMessage = vi.fn(async () => ({ reply: 'respuesta del bot', state: 'IDLE', handledByHuman: false, coverageActivationId: null }));
vi.mock('../conversation/engine.js', () => ({ handleMessage: (...a: unknown[]) => handleMessage(...(a as [])) }));
vi.mock('../conversation/silencio.js', () => ({
  botSilenciadoEnChat: vi.fn(async () => false),
  evaluarSilencioPreEnvio: vi.fn(async () => 'libre'),
  EXIGE_SILENCIO_LIBRE: { modo: 'requiere_silencio_libre' },
}));
const appendMessage = vi.fn(async () => undefined);
vi.mock('../conversation/messages.js', () => ({ appendMessage: (...a: unknown[]) => appendMessage(...(a as [])) }));
vi.mock('../conversation/coverage.js', () => ({
  procesarUbicacionEntrante: vi.fn(async () => ({ reply: '', inerte: true, coverageActivationId: null, outbound: null })),
  coberturaVigente: vi.fn(async () => true),
}));
vi.mock('../conversation/coverageTestHooks.js', () => ({ coverageHold: vi.fn(async () => undefined) }));
vi.mock('../messaging/whatsappClient.js', () => ({
  getWhatsAppClient: vi.fn(async () => ({
    sendText: vi.fn(async (to: string, text: string) => { enviados.push({ to, text }); return { ok: true, outcome: 'accepted', id: 'wamid.out' }; }),
    sendLocationRequest: vi.fn(async () => ({ ok: true })),
  })),
}));
vi.mock('./echoConsumer.js', () => ({
  consumirEcho: vi.fn(async () => ({ desenlace: 'procesado', motivo: '' })),
  registrarObservacion: vi.fn(async () => undefined),
}));
const incrementMessageUsage = vi.fn(async () => undefined);
vi.mock('../tenants/lifecycle.js', () => ({
  checkTenantInboundGate: vi.fn(async () => ({ allowed: true })),
  incrementMessageUsage: (...a: unknown[]) => incrementMessageUsage(...(a as [])),
}));
vi.mock('../entitlements/entitlements.js', () => ({ resolveEntitlements: vi.fn(async () => ({ features: {} })) }));
vi.mock('../entitlements/decide.js', () => ({ isFeatureEnabled: vi.fn(() => true) }));
const ingestInboundAttachment = vi.fn(async () => ({
  attachmentId: 'att_claim',
  messageId: 'pmid_claim',
  ingestState: 'stored' as const,
  duplicate: false,
  reply: '',
  reason: null,
  attachment: null,
}));
vi.mock('./attachmentIngest.js', () => ({
  ingestInboundAttachment: (...a: unknown[]) => ingestInboundAttachment(...(a as [])),
  recordUnsupportedInbound: vi.fn(async () => ({ messageId: 'pmid_u', reply: '' })),
  recordAttachmentIngestDisabled: vi.fn(async () => ({ messageId: 'pmid_off', reply: '' })),
}));
vi.mock('./attachmentGate.js', () => ({
  getAttachmentGate: () => vi.fn(async () => ({ reply: '', reason: null, classification: 'generic_media' })),
}));

import { Timestamp } from 'firebase-admin/firestore';
import { processWebhookEvent, WEBHOOK_STUCK_MS } from './process.js';

/** Multi-tenant: ningún tenant, número ni cliente real aparece acá. */
const TENANT = 'tnt_alpha';
const CLIENTE = '595991234567';
const PNID_QUE_VENDE = '111222333';
const EVENTO = 'whatsapp_wamid.CL1';
const P_EVENTO = `metaWebhookInbox/${EVENTO}`;

const evGuardado = () => docs.get(P_EVENTO) as Record<string, unknown>;

const evento = (payload: Record<string, unknown>, over: Record<string, unknown> = {}): void => {
  docs.set(P_EVENTO, {
    id: EVENTO,
    platform: 'whatsapp',
    externalId: PNID_QUE_VENDE,
    tenantId: TENANT,
    processingStatus: 'received',
    receivedAt: Timestamp.fromMillis(Date.now()),
    payload,
    ...over,
  });
  bump(P_EVENTO);
};

const texto = { from: CLIENTE, text: 'hola, tenés stock?', messageId: 'wamid.CL1' };
const adjuntoImagen = {
  from: CLIENTE,
  text: '',
  messageId: 'wamid.CL1',
  attachment: { kind: 'image', mediaId: 'MEDIA_CL', declaredMime: 'image/jpeg', filename: null, caption: '', sha256: null },
};

beforeEach(() => {
  docs.clear();
  versiones.clear();
  enviados.length = 0;
  autoId = 0;
  handleMessage.mockClear();
  ingestInboundAttachment.mockClear();
  appendMessage.mockClear();
  incrementMessageUsage.mockClear();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
  // ADR-0016 §10: ingesta encendida para el tenant (el rescate solo aplica a adjuntos).
  docs.set(`tenants/${TENANT}/config/attachments`, { ingest: { enabled: true } });
  // ADR-0017 §1: permiso explícito del número, como en producción tras la migración.
  docs.set(assetPath(), { automationMode: 'live' });
});

function assetPath(): string {
  return `tenants/${TENANT}/metaAssets/${PNID_QUE_VENDE}`;
}

describe('el claim del inbox es de UN solo dueño (H4)', () => {
  it('dos entregas CONCURRENTES del mismo evento: el motor corre UNA sola vez', async () => {
    evento(texto);

    await Promise.all([processWebhookEvent(EVENTO), processWebhookEvent(EVENTO)]);

    expect(handleMessage, 'el motor no puede correr dos veces por un mismo evento').toHaveBeenCalledTimes(1);
    expect(enviados, 'y al cliente le llega UNA sola respuesta').toHaveLength(1);
    expect(evGuardado()['processingStatus']).toBe('processed');
    // El metering tampoco se duplica: el evento se cobró una vez.
    expect(incrementMessageUsage).toHaveBeenCalledTimes(1);
  });

  it('el claim deja registrado el dueño en el MISMO acto que `processing`', async () => {
    evento(texto);

    await processWebhookEvent(EVENTO);

    // Sin dueño registrado no hay lease: nadie puede distinguir «lo está procesando alguien»
    // de «quedó clavado» sin mirar solo el reloj.
    expect(typeof evGuardado()['claimOwner'], 'el claim escribe quién tomó el evento').toBe('string');
    expect(String(evGuardado()['claimOwner'])).not.toBe('');
  });

  it('un claim VIVO (processing reciente) no se pisa: la segunda entrega corta sin efectos', async () => {
    evento(texto, {
      processingStatus: 'processing',
      processingStartedAt: Timestamp.fromMillis(Date.now() - 5_000),
      claimOwner: 'otra-invocacion',
    });

    await processWebhookEvent(EVENTO);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(enviados).toEqual([]);
    // Y el claim del dueño original queda intacto.
    expect(evGuardado()['claimOwner']).toBe('otra-invocacion');
    expect(evGuardado()['processingStatus']).toBe('processing');
  });

  it('el RESCATE del adjunto clavado sigue vivo, y también es de un solo dueño', async () => {
    evento(adjuntoImagen, {
      processingStatus: 'processing',
      processingStartedAt: Timestamp.fromMillis(Date.now() - WEBHOOK_STUCK_MS - 60_000),
    });

    await Promise.all([processWebhookEvent(EVENTO), processWebhookEvent(EVENTO)]);

    expect(ingestInboundAttachment, 'dos rescatadores concurrentes: ingesta UNA sola vez').toHaveBeenCalledTimes(1);
    expect(evGuardado()['processingStatus']).toBe('processed');
  });

  it('un turno de TEXTO clavado sigue sin retomarse: su burbuja no es idempotente', async () => {
    evento(texto, {
      processingStatus: 'processing',
      processingStartedAt: Timestamp.fromMillis(Date.now() - WEBHOOK_STUCK_MS * 10),
    });

    await processWebhookEvent(EVENTO);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(evGuardado()['processingStatus']).toBe('processing');
  });
});
