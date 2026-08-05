import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §1 — «NO PUDE AVERIGUARLO» TIENE QUE TERMINAR EN UN REINTENTO DE VERDAD.
 * ================================================================================
 * Cuando la lectura del permiso del número se cae, el evento NO se cierra: el mensaje de un
 * cliente de un número `live` no puede perderse por un hipo de Firestore. Hasta este cambio eso se
 * implementaba escribiendo `processingStatus:'received'` y volviendo, confiando en que «la próxima
 * entrega o el rescate por antigüedad» lo retomaran. Ninguna de las dos existe:
 *
 *   · `onWebhookInbox` es `onDocumentCreated`. Reescribir un documento que YA EXISTE no vuelve a
 *     dispararlo, y sin que la corrida FALLE la plataforma no reentrega nada.
 *   · No hay ningún barrido programado sobre `metaWebhookInbox` (el job de retención toca otras
 *     colecciones).
 *
 * O sea: el evento quedaba en `received` y nadie lo miraba nunca más. Una pérdida silenciosa
 * cambiada por otra, sobre el número que está vendiendo.
 *
 * El reintento REAL es el de la plataforma: el handler LANZA, la corrida se marca fallida y
 * Eventarc vuelve a entregar el mismo evento (`retry` habilitado en el trigger). Lo que este
 * archivo exige no es que el documento quede en `received` —eso ya pasaba— sino que el evento
 * SE VUELVA A PROCESAR, y que el reintento tenga fin.
 */

const docs = new Map<string, Record<string, unknown>>();
const enviados: Array<{ to: string; text: string }> = [];
/** Paths cuya lectura EXPLOTA (para simular la intermitencia de Firestore). */
const lecturasRotas = new Set<string>();

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
}

const refFor = (path: string) => ({
  id: path.split('/').pop() ?? '',
  path,
  get: async () => {
    if (lecturasRotas.has(path)) throw Object.assign(new Error('UNAVAILABLE'), { name: 'FirebaseError' });
    return { exists: docs.has(path), data: () => docs.get(path) };
  },
  set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => escribir(path, d, o?.merge === true),
  update: async (d: Record<string, unknown>) => escribir(path, d, true),
  create: async (d: Record<string, unknown>) => { escribir(path, d, false); },
});

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => refFor(path),
    collection: (path: string) => ({ doc: (id?: string) => refFor(`${path}/${id ?? 'auto'}`) }),
    // Transacción de juguete: el claim del inbox (H4) lee y escribe en un acto. Acá alcanza con
    // ejecutarla secuencial — la CONTENCIÓN real se prueba en `process.claim.test.ts`.
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        update: (ref: { update: (d: Record<string, unknown>) => Promise<void> }, d: Record<string, unknown>) => void ref.update(d),
        set: (ref: { set: (d: Record<string, unknown>, o?: { merge?: boolean }) => Promise<void> }, d: Record<string, unknown>, o?: { merge?: boolean }) => void ref.set(d, o),
      }),
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
vi.mock('../conversation/coverage.js', () => ({
  procesarUbicacionEntrante: vi.fn(async () => ({ reply: '', inerte: true, coverageActivationId: null, outbound: null })),
  coberturaVigente: vi.fn(async () => true),
}));
vi.mock('../conversation/coverageTestHooks.js', () => ({ coverageHold: vi.fn(async () => undefined) }));
vi.mock('../messaging/whatsappClient.js', () => ({
  getWhatsAppClient: vi.fn(async () => ({
    sendText: vi.fn(async (to: string, text: string) => { enviados.push({ to, text }); return { ok: true }; }),
    sendLocationRequest: vi.fn(async () => ({ ok: true })),
  })),
}));
const consumirEcho = vi.fn(async () => ({ desenlace: 'procesado', motivo: '' }));
vi.mock('./echoConsumer.js', () => ({
  consumirEcho: (...a: unknown[]) => consumirEcho(...(a as [])),
  registrarObservacion: vi.fn(async () => undefined),
}));
const incrementMessageUsage = vi.fn(async () => undefined);
vi.mock('../tenants/lifecycle.js', () => ({
  checkTenantInboundGate: vi.fn(async () => ({ allowed: true })),
  incrementMessageUsage: (...a: unknown[]) => incrementMessageUsage(...(a as [])),
}));
vi.mock('../entitlements/entitlements.js', () => ({ resolveEntitlements: vi.fn(async () => ({ features: {} })) }));
vi.mock('../entitlements/decide.js', () => ({ isFeatureEnabled: vi.fn(() => true) }));

import { processWebhookEvent, esReintentoDeWebhook, WEBHOOK_RETRY_BUDGET_MS } from './process.js';

/** Multi-tenant: ningún tenant, número ni cliente real aparece acá. */
const TENANT = 'tnt_alpha';
const CLIENTE = '595991234567';
const PNID_QUE_VENDE = '111222333';
const EVENTO = 'whatsapp_wamid.RT1';

const assetPath = (pnid: string) => `tenants/${TENANT}/metaAssets/${pnid}`;
const evGuardado = (id = EVENTO) => docs.get(`metaWebhookInbox/${id}`) as Record<string, unknown>;
const marca = (ms: number) => ({ toMillis: () => ms });

interface OpcionesEvento {
  id?: string;
  kind?: string;
  /** Antigüedad del evento al momento de procesarlo (para probar el tope del reintento). */
  edadMs?: number;
}

const evento = (payload: Record<string, unknown>, o: OpcionesEvento = {}): string => {
  const id = o.id ?? EVENTO;
  docs.set(`metaWebhookInbox/${id}`, {
    id,
    platform: 'whatsapp',
    externalId: PNID_QUE_VENDE,
    tenantId: TENANT,
    processingStatus: 'received',
    ...(o.kind ? { kind: o.kind } : {}),
    receivedAt: marca(Date.now() - (o.edadMs ?? 0)),
    payload,
  });
  return id;
};

const texto = (t = 'hola, tenés stock?', messageId = 'wamid.RT1') => ({ from: CLIENTE, text: t, messageId });

/** El ciclo de la PLATAFORMA: una entrega que falla es una entrega que se vuelve a hacer. */
async function entregar(id = EVENTO): Promise<'procesada' | 'reentrega'> {
  try {
    await processWebhookEvent(id);
    return 'procesada';
  } catch (e) {
    // El trigger solo deja escapar el error REINTENTABLE; cualquier otro sería un defecto acá.
    if (!esReintentoDeWebhook(e)) throw e;
    return 'reentrega';
  }
}

beforeEach(() => {
  docs.clear();
  lecturasRotas.clear();
  enviados.length = 0;
  handleMessage.mockClear();
  consumirEcho.mockClear();
  incrementMessageUsage.mockClear();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
  docs.set(assetPath(PNID_QUE_VENDE), { automationMode: 'live' });
  lecturasRotas.add(assetPath(PNID_QUE_VENDE));
});

describe('el evento devuelto a la cola SE VUELVE A PROCESAR de verdad', () => {
  it('la corrida FALLA: es la única forma de que la plataforma reentregue el evento', async () => {
    evento(texto());
    const error = await processWebhookEvent(EVENTO).then(() => null, (e: unknown) => e);
    expect(error, 'sin una corrida fallida la plataforma no reentrega nada').not.toBeNull();
    expect(esReintentoDeWebhook(error), 'y tiene que ser el error TIPADO, no uno cualquiera').toBe(true);
  });

  it('y cuando Firestore se recupera, la reentrega atiende al cliente', async () => {
    evento(texto());

    expect(await entregar(), 'la primera entrega no puede darse por buena').toBe('reentrega');
    lecturasRotas.clear();
    expect(await entregar(), 'la reentrega tiene que poder tomar el evento').toBe('procesada');

    expect(handleMessage, 'el mensaje del cliente llega al motor').toHaveBeenCalledTimes(1);
    expect(enviados, 'y la respuesta sale, una sola vez').toHaveLength(1);
    expect(evGuardado()['processingStatus']).toBe('processed');
  });

  it('entre una entrega y la otra el evento queda TOMABLE, no clavado en `processing`', async () => {
    evento(texto());
    await entregar();

    const ev = evGuardado();
    expect(ev['processingStatus']).toBe('received');
    expect(ev['processingStartedAt'] ?? null).toBeNull();
    expect(ev['processedAt'] ?? null).toBeNull();
    expect(ev['automationOrigin']).toBe('error_lectura');
  });

  it('el intento fallido no manda nada, no cuesta metering y no deja rastro conversacional', async () => {
    evento(texto());
    await entregar();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(enviados).toEqual([]);
    expect(incrementMessageUsage).not.toHaveBeenCalled();
    expect([...docs.keys()].filter((k) => k.includes('/messages/'))).toEqual([]);
  });

  it('hace RUIDO: se loguea como error, no como info', async () => {
    evento(texto());
    await entregar();
    expect(logger.error).toHaveBeenCalled();
  });

  it('un ECHO del vendedor con el permiso indeterminado también se reentrega', async () => {
    evento({ direction: 'outbound', echo: { customerWaId: CLIENTE, messageId: 'wamid.ECHO1', echoType: 'text', text: 'ya te paso el precio' } }, { kind: 'echo' });

    expect(await entregar()).toBe('reentrega');
    expect(consumirEcho, 'no se consume un echo cuyo permiso no se pudo leer').not.toHaveBeenCalled();
    expect(evGuardado()['processingStatus']).toBe('received');
  });
});

/**
 * Un reintento sin fin es otra forma de romperse: el evento volvería a entregarse para siempre
 * contra un problema que no se va a resolver solo. Pasado el presupuesto se CIERRA, y se cierra
 * como `failed` —no como `ignored`— porque nadie decidió ignorarlo: se agotó el reintento.
 */
describe('el reintento tiene fin', () => {
  it('pasado el presupuesto el evento se cierra en vez de volver a entregarse', async () => {
    evento(texto(), { edadMs: WEBHOOK_RETRY_BUDGET_MS + 60_000 });

    await expect(processWebhookEvent(EVENTO), 'ya no se le pide reentrega a la plataforma').resolves.toBeUndefined();

    const ev = evGuardado();
    expect(ev['processingStatus']).toBe('failed');
    expect(ev['processedAt'] ?? null).not.toBeNull();
    expect(String(ev['errorMessage'])).not.toBe('');
  });

  it('un evento todavía dentro del presupuesto sigue reintentándose', async () => {
    evento(texto(), { edadMs: Math.floor(WEBHOOK_RETRY_BUDGET_MS / 2) });
    expect(await entregar()).toBe('reentrega');
  });

  it('el presupuesto es un número acotado, no "para siempre"', () => {
    expect(WEBHOOK_RETRY_BUDGET_MS).toBeGreaterThan(60_000);
    expect(WEBHOOK_RETRY_BUDGET_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});
