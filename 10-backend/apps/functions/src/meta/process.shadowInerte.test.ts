import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §1 — `shadow` TIENE QUE SER INERTE PARA EL NÚMERO QUE YA VENDE.
 * =======================================================================
 * El ADR §4 ya razonó esto para el historial importado: «escribir en `messages` mezclaría el
 * historial importado con el del número que ya vende». `shadow` es el mismo problema con otra
 * puerta — el mensaje llega en vivo, por el número en observación — y hasta este cambio escribía
 * derecho en la conversación del CLIENTE, que NO está particionada por canal.
 *
 * Las tres consecuencias, todas sobre el número que está vendiendo AHORA:
 *
 *  (a) `conversation.receivedVia` del doc del cliente quedaba con el PNID en observación, y el
 *      mensaje MANUAL del panel lo lee para elegir por qué número sale (`manualMessage.ts`:
 *      `const phoneNumberId = conv?.receivedVia ?? null`). El vendedor escribía creyendo que
 *      contestaba por el número de siempre y salía por el que debe estar callado.
 *  (b) `listRecentMessages` arma el prompt del modelo sin filtrar por canal: los mensajes del
 *      número en observación entraban al contexto de la IA del número que sí vende.
 *  (c) la conversación aparecía en la bandeja del panel; tomarla ahí silencia al bot en el
 *      número que vende.
 *
 * `shadow` sigue siendo OBSERVABLE —esa es toda su razón de ser— pero en una superficie propia,
 * cerrada al cliente y con TTL, igual que el historial.
 *
 * Y el segundo defecto de esta misma rama: «no pude AVERIGUAR el permiso» no es «este número no
 * tiene permiso». Lo primero es un hipo de Firestore y el mensaje de un cliente de un número
 * `live` no puede perderse para siempre por eso.
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

const yaExiste = () => Object.assign(new Error('already exists'), { code: 6 });

const refFor = (path: string) => ({
  id: path.split('/').pop() ?? '',
  path,
  get: async () => {
    if (lecturasRotas.has(path)) throw Object.assign(new Error('UNAVAILABLE'), { name: 'FirebaseError' });
    return { exists: docs.has(path), data: () => docs.get(path) };
  },
  set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => escribir(path, d, o?.merge === true),
  update: async (d: Record<string, unknown>) => escribir(path, d, true),
  create: async (d: Record<string, unknown>) => {
    if (docs.has(path)) throw yaExiste();
    escribir(path, d, false);
  },
});

/** Consulta mínima: alcanza para correr `listRecentMessages` DE VERDAD contra estos documentos. */
const colFor = (colPath: string) => {
  const query = (campo: string, dir: 'asc' | 'desc', limite: number | null) => ({
    orderBy: (c: string, d: 'asc' | 'desc' = 'asc') => query(c, d, limite),
    limit: (n: number) => query(campo, dir, n),
    get: async () => {
      const filas = [...docs.entries()]
        .filter(([k]) => k.startsWith(`${colPath}/`) && k.slice(colPath.length + 1).indexOf('/') === -1)
        .map(([, v]) => v)
        .sort((a, b) => {
          const va = Number((a[campo] as { toMillis?: () => number })?.toMillis?.() ?? 0);
          const vb = Number((b[campo] as { toMillis?: () => number })?.toMillis?.() ?? 0);
          return dir === 'asc' ? va - vb : vb - va;
        });
      const recortadas = limite === null ? filas : filas.slice(0, limite);
      return { docs: recortadas.map((v) => ({ data: () => v })) };
    },
  });
  return { doc: (id?: string) => refFor(`${colPath}/${id ?? 'auto'}`), ...query('createdAt', 'asc', null) };
};

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => refFor(path),
    collection: (path: string) => colFor(path),
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
const incrementMessageUsage = vi.fn(async () => undefined);
vi.mock('../tenants/lifecycle.js', () => ({
  checkTenantInboundGate: vi.fn(async () => ({ allowed: true })),
  incrementMessageUsage: (...a: unknown[]) => incrementMessageUsage(...(a as [])),
}));
vi.mock('../entitlements/entitlements.js', () => ({ resolveEntitlements: vi.fn(async () => ({ features: {} })) }));
vi.mock('../entitlements/decide.js', () => ({ isFeatureEnabled: vi.fn(() => true) }));

import { processWebhookEvent, esReintentoDeWebhook } from './process.js';
import { listRecentMessages } from '../conversation/messages.js';

/** Ningún tenant, número ni cliente real aparece acá. */
const TENANT = 'tnt_alpha';
const CLIENTE = '595991234567';
const PNID_QUE_VENDE = '111222333';
const PNID_EN_OBSERVACION = '444555666';
const EVENTO = 'whatsapp_wamid.SH1';
const P_EVENTO = `metaWebhookInbox/${EVENTO}`;

/**
 * CONTRATO DE DESTINO. El nombre de la colección se escribe LITERAL a propósito: lo que este test
 * protege no es "que exista un destino" sino que sea uno FUERA de la conversación del cliente y
 * fuera de la bandeja que dispara el motor. Si alguien lo cambia, tiene que venir a cambiarlo acá.
 */
const COLECCION_OBSERVACION = 'metaWebhookShadow';

const assetPath = (pnid: string) => `tenants/${TENANT}/metaAssets/${pnid}`;
const mensajes = () => [...docs.entries()].filter(([k]) => k.includes('/messages/')).map(([, v]) => v);
const observaciones = () =>
  [...docs.entries()].filter(([k]) => k.startsWith(`${COLECCION_OBSERVACION}/`)).map(([, v]) => v as Record<string, unknown>);
const evGuardado = () => docs.get(P_EVENTO) as Record<string, unknown>;

const evento = (payload: Record<string, unknown>, pnid: string, id = EVENTO): string => {
  docs.set(`metaWebhookInbox/${id}`, {
    id, platform: 'whatsapp', externalId: pnid, tenantId: TENANT, processingStatus: 'received',
    // El reintento tiene presupuesto contado desde acá: un evento recién llegado todavía lo tiene.
    receivedAt: { toMillis: () => Date.now() },
    payload,
  });
  return id;
};

/**
 * Una entrega de la PLATAFORMA. Cuando el permiso no se puede resolver, el handler LANZA a
 * propósito: es lo único que hace que Eventarc vuelva a entregar el evento (el trigger es
 * `onDocumentCreated`, así que reescribir el documento no lo redispara). Acá se replica ese ciclo.
 */
const entregar = async (id = EVENTO): Promise<'procesada' | 'reentrega'> => {
  try {
    await processWebhookEvent(id);
    return 'procesada';
  } catch (e) {
    if (!esReintentoDeWebhook(e)) throw e;
    return 'reentrega';
  }
};
const texto = (t = 'hola, tenés stock?', messageId = 'wamid.SH1') => ({ from: CLIENTE, text: t, messageId });

beforeEach(() => {
  docs.clear();
  lecturasRotas.clear();
  enviados.length = 0;
  handleMessage.mockClear();
  incrementMessageUsage.mockClear();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('`shadow` no toca NADA de la conversación del cliente', () => {
  beforeEach(() => {
    docs.set(assetPath(PNID_EN_OBSERVACION), { automationMode: 'shadow', sessionKey: `wa_${PNID_EN_OBSERVACION}` });
    docs.set(assetPath(PNID_QUE_VENDE), { automationMode: 'live' });
  });

  it('no escribe una sola burbuja en `messages` (la subcolección NO está particionada por canal)', async () => {
    evento(texto(), PNID_EN_OBSERVACION);
    await processWebhookEvent(EVENTO);
    expect(mensajes()).toEqual([]);
  });

  /**
   * (a) `manualMessage.ts` elige el número de salida así:
   *     `const phoneNumberId = conv?.receivedVia ?? null` → `deps.getClient(tenantId, phoneNumberId)`.
   * Si `shadow` deja ahí su PNID, el mensaje que el vendedor escribe desde el panel sale por el
   * número que tiene que estar callado, a un cliente vivo. Es el desenlace prohibido (b) del programa.
   */
  it('(a) NO deja `conversation.receivedVia` apuntando al número en observación', async () => {
    evento(texto(), PNID_EN_OBSERVACION);
    await processWebhookEvent(EVENTO);

    const cliente = docs.get(`tenants/${TENANT}/customers/${CLIENTE}`) as Record<string, unknown> | undefined;
    const conv = (cliente?.['conversation'] ?? {}) as Record<string, unknown>;
    expect(conv['receivedVia']).not.toBe(PNID_EN_OBSERVACION);
  });

  /**
   * (b) `engine.ts` arma el prompt del modelo con `listRecentMessages`, que lee la subcolección
   * ENTERA del cliente sin filtrar por canal. Acá se corre la función REAL: si `shadow` escribió
   * ahí, el mensaje del número en observación es parte del contexto de la IA del número que vende.
   */
  it('(b) lo que llega en `shadow` NO entra al historial que alimenta el prompt de la IA', async () => {
    evento(texto('mi número secreto es tal', 'wamid.SH_IA'), PNID_EN_OBSERVACION);
    await processWebhookEvent(EVENTO);

    const historialDelModelo = await listRecentMessages(TENANT, CLIENTE, 6);
    expect(historialDelModelo).toEqual([]);
  });

  /**
   * (c) La bandeja del panel se arma con el resumen denormalizado del doc del cliente. Sin resumen
   * la conversación del número en observación no aparece, y nadie puede "tomarla" desde ahí —que
   * es lo que silenciaría al bot en el número que vende (`sessions/active`).
   */
  it('(c) no crea ni actualiza el resumen del cliente, así que no aparece en la bandeja', async () => {
    evento(texto(), PNID_EN_OBSERVACION);
    await processWebhookEvent(EVENTO);
    expect(docs.get(`tenants/${TENANT}/customers/${CLIENTE}`)).toBeUndefined();
  });

  it('sigue sin responder, sin motor y sin metering', async () => {
    evento(texto(), PNID_EN_OBSERVACION);
    await processWebhookEvent(EVENTO);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(enviados).toEqual([]);
    expect(incrementMessageUsage).not.toHaveBeenCalled();
  });
});

describe('`shadow` SÍ se puede mirar: la superficie de observación', () => {
  beforeEach(() => {
    docs.set(assetPath(PNID_EN_OBSERVACION), { automationMode: 'shadow', sessionKey: `wa_${PNID_EN_OBSERVACION}` });
  });

  it('deja un registro propio, atribuido al canal, fuera de la conversación y del inbox', async () => {
    evento(texto(), PNID_EN_OBSERVACION);
    await processWebhookEvent(EVENTO);

    const obs = observaciones();
    expect(obs).toHaveLength(1);
    expect(obs[0]!['tenantId']).toBe(TENANT);
    expect(obs[0]!['phoneNumberId']).toBe(PNID_EN_OBSERVACION);
    expect(obs[0]!['sessionKey']).toBe(`wa_${PNID_EN_OBSERVACION}`);
    expect(obs[0]!['direction']).toBe('in');
    expect(obs[0]!['author']).toBe('customer');
    expect(String(obs[0]!['text'])).toContain('tenés stock');
    // Marca dura: esto no es una bandeja de entrada y nunca puede disparar negocio.
    expect(obs[0]!['automationEligible']).toBe(false);
    // TTL: el material del número en observación no se queda para siempre.
    expect(obs[0]!['expiresAt']).toBeDefined();
  });

  it('el registro NO vive en `metaWebhookInbox` (esa colección ES el disparador del motor)', async () => {
    evento(texto(), PNID_EN_OBSERVACION);
    await processWebhookEvent(EVENTO);
    const enElInbox = [...docs.keys()].filter((k) => k.startsWith('metaWebhookInbox/') && k !== P_EVENTO);
    expect(enElInbox).toEqual([]);
  });

  it('un reintento del webhook no duplica la observación', async () => {
    evento(texto(), PNID_EN_OBSERVACION);
    await processWebhookEvent(EVENTO);
    docs.set(P_EVENTO, { ...docs.get(P_EVENTO)!, processingStatus: 'received' });
    await processWebhookEvent(EVENTO);
    expect(observaciones()).toHaveLength(1);
  });

  /** ADR-0016 §9: el caption del cliente no se persiste ni siquiera acá. */
  it('un adjunto deja el marcador del SISTEMA, nunca el caption del cliente', async () => {
    docs.set(`tenants/${TENANT}/config/attachments`, { ingest: { enabled: true } });
    evento(
      { from: CLIENTE, text: '', messageId: 'wamid.SH_IMG', attachment: { kind: 'image', mediaId: 'MEDIA_1', declaredMime: 'image/jpeg', filename: null, caption: 'cuánto sale?', sha256: null } },
      PNID_EN_OBSERVACION,
    );
    await processWebhookEvent(EVENTO);

    const obs = observaciones();
    expect(obs).toHaveLength(1);
    expect(String(obs[0]!['text'])).not.toContain('cuánto sale');
  });

  it('`inactive` no deja rastro NI en la superficie de observación', async () => {
    docs.set(assetPath(PNID_EN_OBSERVACION), { automationMode: 'inactive' });
    evento(texto(), PNID_EN_OBSERVACION);
    await processWebhookEvent(EVENTO);
    expect(observaciones()).toEqual([]);
    expect(mensajes()).toEqual([]);
  });
});

/**
 * ADR-0017 §1 — «no pude AVERIGUARLO» ≠ «no tiene permiso».
 * `resolveAutomationMode` falla cerrado y devuelve `inactive` con `origen: 'error_lectura'`, que
 * es lo correcto para el ENVÍO. Pero el evento se marcaba TERMINAL (`ignored`) con log `info`: el
 * mensaje de un cliente de un número `live` se perdía para siempre por un hipo de Firestore y
 * nadie se enteraba.
 *
 * El reintento es de la PLATAFORMA y por eso el handler LANZA: `onWebhookInbox` es
 * `onDocumentCreated`, así que dejar el documento en `received` no lo redispara. El ciclo completo
 * —incluido el tope del reintento— vive en `process.reintento.test.ts`; acá se sostiene lo que este
 * archivo compara: el evento no se cierra y el mensaje del cliente no se tira.
 */
describe('lectura del permiso INTERMITENTE — el mensaje del cliente no se tira', () => {
  beforeEach(() => {
    docs.set(assetPath(PNID_QUE_VENDE), { automationMode: 'live' });
    lecturasRotas.add(assetPath(PNID_QUE_VENDE));
  });

  it('fail-closed en el ENVÍO: no automatiza nada mientras no se sepa', async () => {
    evento(texto(), PNID_QUE_VENDE);
    await entregar();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(enviados).toEqual([]);
    expect(incrementMessageUsage).not.toHaveBeenCalled();
    expect(mensajes()).toEqual([]);
  });

  it('el evento queda REINTENTABLE, no terminal', async () => {
    evento(texto(), PNID_QUE_VENDE);
    expect(await entregar(), 'la corrida falla: es lo que provoca la reentrega').toBe('reentrega');

    const ev = evGuardado();
    expect(ev['processingStatus'], 'un hipo de infraestructura no cierra el evento').not.toBe('ignored');
    expect(ev['processingStatus']).toBe('received');
    expect(ev['processedAt'] ?? null).toBeNull();
    expect(ev['automationOrigin']).toBe('error_lectura');
  });

  it('hace RUIDO: se loguea como error, no como info', async () => {
    evento(texto(), PNID_QUE_VENDE);
    await entregar();
    expect(logger.error).toHaveBeenCalled();
  });

  it('cuando Firestore se recupera, el reintento procesa el mensaje normalmente', async () => {
    evento(texto(), PNID_QUE_VENDE);
    await entregar();
    lecturasRotas.clear();
    await entregar();

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(evGuardado()['processingStatus']).toBe('processed');
  });

  /** El fail-closed de siempre no se toca: «no tiene permiso» SIGUE siendo terminal. */
  it('un número declarado `inactive` sigue cerrándose como `ignored`', async () => {
    docs.set(assetPath(PNID_EN_OBSERVACION), { automationMode: 'inactive' });
    evento(texto(), PNID_EN_OBSERVACION);
    await processWebhookEvent(EVENTO);
    expect(evGuardado()['processingStatus']).toBe('ignored');
  });
});
