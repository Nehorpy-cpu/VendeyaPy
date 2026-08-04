import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §3 — EL ECHO TIENE QUE TENER CONSUMIDOR.
 * =================================================
 * «`smb_message_echoes` es el evento que hace posible Coexistence: avisa que el vendedor contestó
 * desde su teléfono. Sin consumirlo, el sistema no se entera y el bot le habla encima al vendedor
 * delante del cliente.»
 *
 * El productor ya existe (`webhookHttp.ts` escribe el evento con `kind:'echo'` y el payload bajo
 * `payload.echo.*`, sin `payload.from`), pero `processWebhookEvent` lo mataba en el guard de
 * `payload.from` y lo cerraba como `ignored`. `readWebhookEventKind` estaba exportado y no lo
 * llamaba nadie: `ARCHITECTURE.md` §12 afirmaba «activa el silencio» y era una garantía declarada
 * que el código no tenía.
 *
 * Las cuatro reglas que este archivo fija, todas del ADR:
 *   1. el cliente sale de `to` (`payload.echo.customerWaId`) — el `from` de un echo es el NEGOCIO;
 *   2. se persiste como outbound HUMANO con origen `whatsapp_business_app`, idempotente por wamid;
 *   3. JAMÁS se reenvía por Cloud API, ni cuesta metering, ni abre turno del motor;
 *   4. activa o extiende el control humano con la semántica CANÓNICA de HANDOFF-2, sobre la
 *      sesión de ESE canal.
 * Y el gate por PNID le aplica igual que a un inbound.
 */

const docs = new Map<string, Record<string, unknown>>();
const enviados: Array<{ to: string; text: string }> = [];
const clientesResueltos: string[] = [];
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

/** Transacción de juguete: alcanza para correr `executeHandoff` DE VERDAD (lee, después escribe). */
const runTransaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
  fn({
    get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
    set: (ref: { path: string }, d: Record<string, unknown>) => escribir(ref.path, d, false),
    update: (ref: { path: string }, d: Record<string, unknown>) => escribir(ref.path, d, true),
  });

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => refFor(path),
    collection: (path: string) => ({ doc: (id?: string) => refFor(`${path}/${id ?? 'auto'}`) }),
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
    notifications: (t: string) => `tenants/${t}/notifications`,
  },
}));

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../lib/logger.js', () => ({ logger }));

const handleMessage = vi.fn(async () => ({ reply: 'respuesta del bot', state: 'IDLE', handledByHuman: false, coverageActivationId: null }));
vi.mock('../conversation/engine.js', () => ({ handleMessage: (...a: unknown[]) => handleMessage(...(a as [])) }));

// `conversation/silencio.js` NO se mockea: la regla que decide el silencio es la REAL, leyendo la
// sesión que el echo dejó. Es la única forma de probar que el bot efectivamente se calla.
vi.mock('../conversation/coverage.js', () => ({
  procesarUbicacionEntrante: vi.fn(async () => ({ reply: '', inerte: true, coverageActivationId: null, outbound: null })),
  coberturaVigente: vi.fn(async () => true),
}));
vi.mock('../conversation/coverageTestHooks.js', () => ({ coverageHold: vi.fn(async () => undefined) }));
vi.mock('../messaging/whatsappClient.js', () => ({
  getWhatsAppClient: vi.fn(async (t: string, _c: unknown, pnid?: string | null) => {
    clientesResueltos.push(String(pnid ?? ''));
    return {
      sendText: vi.fn(async (to: string, text: string) => { enviados.push({ to, text }); return { ok: true, outcome: 'accepted', id: 'wamid.out' }; }),
      sendLocationRequest: vi.fn(async () => ({ ok: true })),
    };
  }),
}));
const incrementMessageUsage = vi.fn(async () => undefined);
const checkTenantInboundGate = vi.fn(async () => ({ allowed: true }));
vi.mock('../tenants/lifecycle.js', () => ({
  checkTenantInboundGate: (...a: unknown[]) => checkTenantInboundGate(...(a as [])),
  incrementMessageUsage: (...a: unknown[]) => incrementMessageUsage(...(a as [])),
}));
vi.mock('../entitlements/entitlements.js', () => ({ resolveEntitlements: vi.fn(async () => ({ features: {} })) }));
vi.mock('../entitlements/decide.js', () => ({ isFeatureEnabled: vi.fn(() => true) }));
const ingestInboundAttachment = vi.fn(async () => ({ attachmentId: 'att_x', messageId: 'pmid_x', ingestState: 'stored' as const, duplicate: false, reply: '', reason: null, attachment: null }));
vi.mock('./attachmentIngest.js', () => ({
  ingestInboundAttachment: (...a: unknown[]) => ingestInboundAttachment(...(a as [])),
  recordUnsupportedInbound: vi.fn(async () => ({ messageId: 'pmid_u', reply: '' })),
  recordAttachmentIngestDisabled: vi.fn(async () => ({ messageId: 'pmid_off', reply: '' })),
}));

import { processWebhookEvent, esReintentoDeWebhook } from './process.js';

/** Ningún tenant, número ni cliente real aparece acá. */
const TENANT = 'tnt_alpha';
const CLIENTE = '595991234567';
/** El número del NEGOCIO. Si alguna vez aparece como `customerId`, el sistema se habla solo. */
const TEL_DEL_NEGOCIO = '595990000000';
const PNID_QUE_VENDE = '111222333';
const PNID_COEXISTENCE = '444555666';
const CLAVE_COEXISTENCE = `wa_${PNID_COEXISTENCE}`;

/** Mismo contrato de destino que `process.shadowInerte.test.ts`. */
const COLECCION_OBSERVACION = 'metaWebhookShadow';

const assetPath = (pnid: string) => `tenants/${TENANT}/metaAssets/${pnid}`;
const mensajes = () => [...docs.entries()].filter(([k]) => k.includes('/messages/')).map(([, v]) => v as Record<string, unknown>);
const observaciones = () => [...docs.entries()].filter(([k]) => k.startsWith(`${COLECCION_OBSERVACION}/`)).map(([, v]) => v as Record<string, unknown>);
const sesion = (clave: string) => docs.get(`tenants/${TENANT}/customers/${CLIENTE}/sessions/${clave}`) as Record<string, unknown> | undefined;
const evGuardado = (id: string) => docs.get(`metaWebhookInbox/${id}`) as Record<string, unknown>;

interface OpcionesEcho {
  pnid?: string;
  id?: string;
  echoType?: string;
  text?: string;
  customerWaId?: string | null;
  messageId?: string;
  /** Contaminación deliberada: el `from` del NEGOCIO colado en el payload de un echo. */
  from?: string;
}

const echo = (o: OpcionesEcho = {}): string => {
  const messageId = o.messageId ?? 'wamid.ECHO1';
  const id = o.id ?? `whatsapp_echo_${messageId}`;
  docs.set(`metaWebhookInbox/${id}`, {
    id,
    platform: 'whatsapp',
    externalId: o.pnid ?? PNID_COEXISTENCE,
    tenantId: TENANT,
    processingStatus: 'received',
    kind: 'echo',
    automationEligible: false,
    // El reintento tiene presupuesto contado desde acá: un evento recién llegado todavía lo tiene.
    receivedAt: { toMillis: () => Date.now() },
    payload: {
      direction: 'outbound',
      origin: 'whatsapp_business_app',
      automationEligible: false,
      ...(o.from ? { from: o.from } : {}),
      echo: {
        customerWaId: o.customerWaId === null ? undefined : (o.customerWaId ?? CLIENTE),
        messageId,
        timestamp: 1_770_000_000,
        echoType: o.echoType ?? 'text',
        text: o.text ?? 'te lo reservo, paso el precio en un rato',
        mediaKind: null,
        originalMessageId: null,
      },
    },
  });
  return id;
};

/** Un mensaje NORMAL del cliente, para probar que después del echo el bot se calla. */
const inbound = (id: string, pnid: string, texto = 'seguís ahí?'): string => {
  docs.set(`metaWebhookInbox/${id}`, {
    id, platform: 'whatsapp', externalId: pnid, tenantId: TENANT, processingStatus: 'received',
    kind: 'message', automationEligible: true,
    payload: { from: CLIENTE, text: texto, messageId: `wamid.${id}` },
  });
  return id;
};

beforeEach(() => {
  docs.clear();
  lecturasRotas.clear();
  enviados.length = 0;
  clientesResueltos.length = 0;
  handleMessage.mockClear();
  incrementMessageUsage.mockClear();
  checkTenantInboundGate.mockClear();
  ingestInboundAttachment.mockClear();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('echo en un número `live` — el vendedor contestó desde su teléfono', () => {
  beforeEach(() => {
    docs.set(assetPath(PNID_COEXISTENCE), { automationMode: 'live', sessionKey: CLAVE_COEXISTENCE });
  });

  it('se persiste como outbound HUMANO, con origen `whatsapp_business_app` y por su canal', async () => {
    const id = echo();
    await processWebhookEvent(id);

    const salientes = mensajes().filter((m) => m['direction'] === 'out');
    expect(salientes).toHaveLength(1);
    expect(salientes[0]!['author']).toBe('seller');
    expect(salientes[0]!['origin']).toBe('whatsapp_business_app');
    expect(salientes[0]!['receivedVia']).toBe(PNID_COEXISTENCE);
    expect(String(salientes[0]!['text'])).toContain('te lo reservo');
  });

  it('JAMÁS se reenvía por Cloud API (el cliente ya lo recibió del teléfono del vendedor)', async () => {
    const id = echo();
    await processWebhookEvent(id);
    expect(enviados).toEqual([]);
    expect(clientesResueltos, 'ni siquiera se resuelven credenciales de envío').toEqual([]);
  });

  it('no abre turno del motor, no cuesta metering y no ingesta adjuntos', async () => {
    const id = echo();
    await processWebhookEvent(id);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(incrementMessageUsage).not.toHaveBeenCalled();
    expect(ingestInboundAttachment).not.toHaveBeenCalled();
  });

  it('activa el control humano con la semántica CANÓNICA de HANDOFF-2, en la sesión de ESE canal', async () => {
    const id = echo();
    await processWebhookEvent(id);

    const ctx = (sesion(CLAVE_COEXISTENCE)?.['context'] ?? {}) as Record<string, unknown>;
    expect(ctx['humanTakeover']).toBe(true);
    expect(ctx['handoffReason']).toBe('seller_manual');
    // La oferta pendiente del bot muere al entrar un humano (F3), igual que en todo handoff.
    expect(ctx['pendingCartConfirmation']).toBeNull();
    // Y NO se toca la sesión del canal heredado — el número que ya vende sigue como estaba.
    expect(sesion('active')).toBeUndefined();
  });

  /** La razón de ser de Coexistence: después del echo, el bot NO le habla encima al vendedor. */
  it('el próximo mensaje del cliente por ese canal ya NO recibe respuesta automática', async () => {
    await processWebhookEvent(echo());
    await processWebhookEvent(inbound('ev_post_echo', PNID_COEXISTENCE));

    expect(enviados, 'el bot se queda callado delante del cliente').toEqual([]);
  });

  it('es idempotente por wamid: reprocesar el mismo echo no duplica la burbuja', async () => {
    const id = echo();
    await processWebhookEvent(id);
    docs.set(`metaWebhookInbox/${id}`, { ...docs.get(`metaWebhookInbox/${id}`)!, processingStatus: 'received' });
    await processWebhookEvent(id);

    expect(mensajes().filter((m) => m['direction'] === 'out')).toHaveLength(1);
  });

  it('un echo `revoke` o de media deja rastro sin inventar contenido del vendedor', async () => {
    await processWebhookEvent(echo({ echoType: 'revoke', text: '', messageId: 'wamid.REV1' }));
    const salientes = mensajes().filter((m) => m['direction'] === 'out');
    expect(salientes).toHaveLength(1);
    expect(String(salientes[0]!['text']).trim()).not.toBe('');
  });

  it('el evento queda `processed` y marcado con su modo', async () => {
    const id = echo();
    await processWebhookEvent(id);
    expect(evGuardado(id)['processingStatus']).toBe('processed');
    expect(evGuardado(id)['automationMode']).toBe('live');
  });

  it('en el canal HEREDADO el echo toma `sessions/active` (es el número que ya vende)', async () => {
    docs.set(assetPath(PNID_QUE_VENDE), { automationMode: 'live' });
    await processWebhookEvent(echo({ pnid: PNID_QUE_VENDE, messageId: 'wamid.LEG1' }));
    expect(((sesion('active')?.['context'] ?? {}) as Record<string, unknown>)['humanTakeover']).toBe(true);
  });
});

/**
 * ADR-0017 §3: «en un echo `from` es el número del NEGOCIO y `to` el del cliente… si se
 * transportara, el sistema abriría una conversación consigo mismo y el bot se respondería a sí
 * mismo, sobre el número real y consumiendo cuota».
 */
describe('el cliente sale de `to`, nunca del `from` del negocio', () => {
  beforeEach(() => {
    docs.set(assetPath(PNID_COEXISTENCE), { automationMode: 'live', sessionKey: CLAVE_COEXISTENCE });
  });

  it('la conversación es la del CLIENTE', async () => {
    await processWebhookEvent(echo());
    expect(mensajes()).toHaveLength(1);
    expect([...docs.keys()].some((k) => k.startsWith(`tenants/${TENANT}/customers/${CLIENTE}/`))).toBe(true);
  });

  it('un `from` del negocio colado en el payload NO abre una conversación consigo mismo', async () => {
    await processWebhookEvent(echo({ from: TEL_DEL_NEGOCIO }));
    expect(docs.get(`tenants/${TENANT}/customers/${TEL_DEL_NEGOCIO}`)).toBeUndefined();
    expect([...docs.keys()].filter((k) => k.includes(`/customers/${TEL_DEL_NEGOCIO}`))).toEqual([]);
  });

  it('un echo sin `to` no se persiste en ningún lado y se cierra como ignorado', async () => {
    const id = echo({ customerWaId: null });
    await processWebhookEvent(id);
    expect(mensajes()).toEqual([]);
    expect(observaciones()).toEqual([]);
    expect(evGuardado(id)['processingStatus']).toBe('ignored');
  });
});

describe('el gate por PNID le aplica igual al echo', () => {
  it('`inactive`: no persiste, no toma el chat, no observa', async () => {
    docs.set(assetPath(PNID_COEXISTENCE), { status: 'active' });
    const id = echo();
    await processWebhookEvent(id);

    expect(mensajes()).toEqual([]);
    expect(observaciones()).toEqual([]);
    expect(sesion(CLAVE_COEXISTENCE)).toBeUndefined();
    expect(evGuardado(id)['processingStatus']).toBe('ignored');
  });

  /**
   * `shadow` es el modo en el que el vendedor atiende A MANO y el sistema MIRA: ver el echo es
   * justamente el punto. Pero mirar no puede escribir en la conversación del cliente (que es
   * compartida con el número que vende) ni tocar el control humano de una sesión que el gate ya
   * mantiene muda de todos modos.
   */
  it('`shadow`: se observa, pero no toca la conversación ni el control humano', async () => {
    docs.set(assetPath(PNID_COEXISTENCE), { automationMode: 'shadow', sessionKey: CLAVE_COEXISTENCE });
    const id = echo();
    await processWebhookEvent(id);

    expect(observaciones()).toHaveLength(1);
    expect(observaciones()[0]!['direction']).toBe('out');
    expect(observaciones()[0]!['author']).toBe('seller');
    expect(mensajes()).toEqual([]);
    expect(docs.get(`tenants/${TENANT}/customers/${CLIENTE}`)).toBeUndefined();
    expect(sesion(CLAVE_COEXISTENCE)).toBeUndefined();
  });

  it('si no se pudo AVERIGUAR el permiso, el echo queda reintentable y hace ruido', async () => {
    docs.set(assetPath(PNID_COEXISTENCE), { automationMode: 'live' });
    lecturasRotas.add(assetPath(PNID_COEXISTENCE));
    const id = echo();
    // La corrida FALLA a propósito: es lo único que hace que la plataforma reentregue el evento.
    const error = await processWebhookEvent(id).then(() => null, (e: unknown) => e);
    expect(esReintentoDeWebhook(error)).toBe(true);

    expect(evGuardado(id)['processingStatus']).toBe('received');
    expect(mensajes()).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });
});

/**
 * Defensa por TIPO: la bandeja dispara el motor sobre TODO documento. Un evento cuyo `kind` este
 * despliegue no entiende (una versión futura, un dato corrupto) jamás puede degradarse a mensaje
 * vivo del cliente — `readWebhookEventKind` ya lo lleva a `unknown`, acá se exige el desenlace.
 */
describe('tipos que no son un mensaje vivo', () => {
  it('un `kind` desconocido no llega al motor', async () => {
    docs.set(assetPath(PNID_QUE_VENDE), { automationMode: 'live' });
    docs.set('metaWebhookInbox/ev_raro', {
      id: 'ev_raro', platform: 'whatsapp', externalId: PNID_QUE_VENDE, tenantId: TENANT,
      processingStatus: 'received', kind: 'lo_que_venga_manana',
      payload: { from: CLIENTE, text: 'hola', messageId: 'wamid.RARO' },
    });
    await processWebhookEvent('ev_raro');

    expect(handleMessage).not.toHaveBeenCalled();
    expect(enviados).toEqual([]);
    expect(evGuardado('ev_raro')['processingStatus']).toBe('ignored');
  });

  it('los eventos SIN `kind` (escritos antes de Coexistence) siguen siendo mensajes vivos', async () => {
    docs.set(assetPath(PNID_QUE_VENDE), { automationMode: 'live' });
    docs.set('metaWebhookInbox/ev_legacy', {
      id: 'ev_legacy', platform: 'whatsapp', externalId: PNID_QUE_VENDE, tenantId: TENANT,
      processingStatus: 'received', payload: { from: CLIENTE, text: 'hola', messageId: 'wamid.LEGACY' },
    });
    await processWebhookEvent('ev_legacy');

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(enviados).toHaveLength(1);
  });
});
