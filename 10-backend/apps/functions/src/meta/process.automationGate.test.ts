import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §1 — EL GATE POR PNID, ANTES DE CUALQUIER CONSUMIDOR DE NEGOCIO.
 * =========================================================================
 * «El sistema no tiene el concepto de "este número todavía no manda". Todo lo que existe hoy es
 * binario y por tenant: un número está conectado o no, y si lo está, el bot contesta.»
 *
 * Este archivo prueba el desenlace OBSERVABLE de los tres modos sobre el MISMO webhook:
 *
 *   · `inactive` — ACK y nada más: ni metering, ni motor, ni adjunto, ni un solo outbound. Ni
 *     siquiera se consulta el gate de empresa, porque el gate del número va ANTES.
 *   · `shadow`   — el entrante se persiste para poder mirarlo, y nada más.
 *   · `live`     — exactamente el comportamiento de hoy (si esto se rompe, se rompió el número
 *     que está vendiendo ahora mismo).
 *
 * Va aparte de `process.rollout.test.ts` a propósito: aquel prueba el interruptor de ADJUNTOS por
 * tenant; este prueba el permiso de AUTOMATIZACIÓN por número.
 */

const docs = new Map<string, Record<string, unknown>>();
const enviados: Array<{ to: string; text: string }> = [];
/** Toda salida al mundo del camino de adjuntos (credenciales + descarga). */
const graph: string[] = [];
const bytesGuardados: string[] = [];

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
  get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
  set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => escribir(path, d, o?.merge === true),
  update: async (d: Record<string, unknown>) => escribir(path, d, true),
  create: async (d: Record<string, unknown>) => {
    if (docs.has(path)) throw yaExiste();
    escribir(path, d, false);
  },
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
  storage: () => ({
    bucket: () => ({ file: (path: string) => ({ save: async () => { bytesGuardados.push(path); } }) }),
  }),
  paths: {
    metaWebhookEvent: (id: string) => `metaWebhookInbox/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    messages: (t: string, c: string) => `tenants/${t}/customers/${c}/messages`,
    session: (t: string, c: string, k = 'active') => `tenants/${t}/customers/${c}/sessions/${k}`,
  },
}));

const handleMessage = vi.fn(async () => ({ reply: 'respuesta del bot', state: 'IDLE', handledByHuman: false, coverageActivationId: null }));
vi.mock('../conversation/engine.js', () => ({ handleMessage: (...a: unknown[]) => handleMessage(...(a as [])) }));

const botSilenciadoEnChat = vi.fn(async () => false);
const evaluarSilencioPreEnvio = vi.fn(async () => 'libre');
vi.mock('../conversation/silencio.js', () => ({
  botSilenciadoEnChat: (...a: unknown[]) => botSilenciadoEnChat(...(a as [])),
  evaluarSilencioPreEnvio: (...a: unknown[]) => evaluarSilencioPreEnvio(...(a as [])),
  EXIGE_SILENCIO_LIBRE: { modo: 'requiere_silencio_libre' },
}));

const procesarUbicacionEntrante = vi.fn(async () => ({ reply: 'gracias', inerte: false, coverageActivationId: null, outbound: null }));
vi.mock('../conversation/coverage.js', () => ({
  procesarUbicacionEntrante: (...a: unknown[]) => procesarUbicacionEntrante(...(a as [])),
  coberturaVigente: vi.fn(async () => true),
}));
vi.mock('../conversation/coverageTestHooks.js', () => ({ coverageHold: vi.fn(async () => undefined) }));
vi.mock('../messaging/whatsappClient.js', () => ({
  getWhatsAppClient: vi.fn(async () => ({
    sendText: vi.fn(async (to: string, text: string) => { enviados.push({ to, text }); return { ok: true }; }),
    sendLocationRequest: vi.fn(async () => ({ ok: true })),
  })),
}));

const checkTenantInboundGate = vi.fn(async () => ({ allowed: true }));
const incrementMessageUsage = vi.fn(async () => undefined);
vi.mock('../tenants/lifecycle.js', () => ({
  checkTenantInboundGate: (...a: unknown[]) => checkTenantInboundGate(...(a as [])),
  incrementMessageUsage: (...a: unknown[]) => incrementMessageUsage(...(a as [])),
}));
vi.mock('../entitlements/entitlements.js', () => ({ resolveEntitlements: vi.fn(async () => ({ features: { multiChannel: true } })) }));
vi.mock('../entitlements/decide.js', () => ({ isFeatureEnabled: vi.fn(() => true) }));

// La ingesta corre DE VERDAD: se instrumentan sus dos salidas al mundo, que con el número
// gateado no pueden ocurrir NI UNA VEZ (aunque el rollout de adjuntos esté ENCENDIDO).
vi.mock('../messaging/resolveWhatsappCreds.js', () => ({
  resolveTenantWhatsappCreds: vi.fn(async () => { graph.push('creds'); return { ok: true, accessToken: 'TOKEN_TEST', phoneNumberId: 'PNID', mode: 'live' }; }),
}));
vi.mock('./mediaClient.js', () => ({
  MAX_MEDIA_BYTES: 10 * 1024 * 1024,
  downloadWhatsappAttachment: vi.fn(async () => { graph.push('download'); return { ok: false, reason: 'fetch_failed', detail: 'la red no se toca en tests' }; }),
}));

import { processWebhookEvent } from './process.js';

/** Multi-tenant y multi-vertical: ningún tenant real aparece acá. */
const TENANT = 'tnt_alpha';
const TEL = '595991234567';
const PNID_ACTUAL = '111222333';
const PNID_NUEVO = '444555666';
const EVENTO = 'whatsapp_wamid.TXT1';
const P_EVENTO = `metaWebhookInbox/${EVENTO}`;

const assetPath = (pnid: string) => `tenants/${TENANT}/metaAssets/${pnid}`;
const mensajes = () =>
  [...docs.entries()].filter(([k]) => k.includes('/messages/')).map(([, v]) => v as Record<string, unknown>);
const evGuardado = () => docs.get(P_EVENTO) as Record<string, unknown>;

interface OpcionesEvento {
  pnid?: string;
  platform?: string;
  conTenant?: boolean;
  id?: string;
}

const evento = (payload: Record<string, unknown>, o: OpcionesEvento = {}): string => {
  const id = o.id ?? EVENTO;
  docs.set(`metaWebhookInbox/${id}`, {
    id,
    platform: o.platform ?? 'whatsapp',
    externalId: o.pnid ?? PNID_ACTUAL,
    tenantId: o.conTenant === false ? null : TENANT,
    processingStatus: 'received',
    payload,
  });
  return id;
};

const texto = (t = 'hola, tenés stock?', messageId = 'wamid.TXT1') => ({ from: TEL, text: t, messageId });
const adjunto = {
  from: TEL,
  text: '',
  messageId: 'wamid.IMG1',
  attachment: { kind: 'image', mediaId: 'MEDIA_1', declaredMime: 'image/jpeg', filename: null, caption: 'cuánto sale?', sha256: null },
};

/** El rollout de adjuntos ENCENDIDO: si el gate del número faltara, habría descarga real. */
const encenderAdjuntos = () => docs.set(`tenants/${TENANT}/config/attachments`, { ingest: { enabled: true } });

beforeEach(() => {
  docs.clear();
  enviados.length = 0;
  graph.length = 0;
  bytesGuardados.length = 0;
  handleMessage.mockClear();
  botSilenciadoEnChat.mockClear();
  evaluarSilencioPreEnvio.mockClear();
  checkTenantInboundGate.mockClear();
  incrementMessageUsage.mockClear();
  procesarUbicacionEntrante.mockClear();
});

/**
 * El desenlace del día del alta: `multiNumber` escribe el asset `status:'active'` y el índice en
 * el acto. Sin este gate, ese instante es el instante en el que el bot empieza a contestarle a
 * los clientes del vendedor desde un número que nadie probó.
 */
describe('`inactive` (asset sin el campo: el estado del número recién dado de alta)', () => {
  beforeEach(() => {
    docs.set(assetPath(PNID_ACTUAL), { externalId: PNID_ACTUAL, status: 'active', selected: false });
  });

  it('un texto NO llega al motor, no cuesta metering y no produce outbound', async () => {
    evento(texto());
    await processWebhookEvent(EVENTO);

    expect(handleMessage, 'el motor no corre').not.toHaveBeenCalled();
    expect(incrementMessageUsage, 'no se contabiliza consumo').not.toHaveBeenCalled();
    expect(enviados, 'no sale un solo mensaje').toEqual([]);
  });

  it('el gate del NÚMERO va antes que el gate de empresa (no se consulta nada de negocio)', async () => {
    evento(texto());
    await processWebhookEvent(EVENTO);
    expect(checkTenantInboundGate).not.toHaveBeenCalled();
  });

  it('no deja rastro conversacional: ni burbuja ni resumen del cliente', async () => {
    evento(texto());
    await processWebhookEvent(EVENTO);
    expect(mensajes()).toEqual([]);
    expect(docs.get(`tenants/${TENANT}/customers/${TEL}`)).toBeUndefined();
  });

  it('un ADJUNTO no se descarga aunque el rollout de adjuntos esté encendido', async () => {
    encenderAdjuntos();
    evento(adjunto);
    await processWebhookEvent(EVENTO);

    expect(graph, 'cero Graph').toEqual([]);
    expect(bytesGuardados, 'cero bytes en Storage').toEqual([]);
    expect([...docs.keys()].filter((k) => k.startsWith(`tenants/${TENANT}/attachments/`))).toEqual([]);
    expect(enviados).toEqual([]);
  });

  it('una UBICACIÓN nativa tampoco abre el camino de cobertura', async () => {
    evento({ from: TEL, messageId: 'wamid.LOC1', location: { latitude: -25.3, longitude: -57.6, name: null, address: null, contextMessageId: null } });
    await processWebhookEvent(EVENTO);
    expect(procesarUbicacionEntrante).not.toHaveBeenCalled();
    expect(enviados).toEqual([]);
  });

  it('el evento queda ACKeado y OBSERVABLE (se ve por qué no se hizo nada)', async () => {
    evento(texto());
    await processWebhookEvent(EVENTO);
    const ev = evGuardado();
    expect(ev['processingStatus']).toBe('ignored');
    expect(ev['automationMode']).toBe('inactive');
    expect(ev['tenantId']).toBe(TENANT);
    expect(String(ev['errorMessage'])).not.toBe('');
  });

  it('la ubicación exacta NO queda retenida en el inbox al cortar', async () => {
    evento({ from: TEL, messageId: 'wamid.LOC1', location: { latitude: -25.3, longitude: -57.6, name: null, address: null, contextMessageId: null } });
    await processWebhookEvent(EVENTO);
    expect((evGuardado()['payload'] as Record<string, unknown>)['location']).toBeNull();
  });

  it('un asset con un valor irreconocible tampoco automatiza', async () => {
    docs.set(assetPath(PNID_ACTUAL), { automationMode: 'LIVE' });
    evento(texto());
    await processWebhookEvent(EVENTO);
    expect(handleMessage).not.toHaveBeenCalled();
  });
});

/**
 * `shadow` se persiste para poder MIRARLO, pero en una SUPERFICIE PROPIA: escribir en la
 * conversación del cliente movía el `receivedVia` del mensaje manual del panel, metía mensajes
 * ajenos al prompt de la IA y publicaba la conversación en la bandeja del número que ya vende.
 * El detalle de esas tres consecuencias vive en `process.shadowInerte.test.ts`; acá se sostiene
 * lo que este archivo compara entre los tres modos.
 */
describe('`shadow` — se observa aparte, y nada más', () => {
  const observaciones = () =>
    [...docs.entries()].filter(([k]) => k.startsWith('metaWebhookShadow/')).map(([, v]) => v as Record<string, unknown>);

  beforeEach(() => {
    docs.set(assetPath(PNID_NUEVO), { automationMode: 'shadow', sessionKey: `wa_${PNID_NUEVO}` });
  });

  it('el entrante queda OBSERVABLE, atribuido a su canal, fuera de la conversación del cliente', async () => {
    evento(texto(), { pnid: PNID_NUEVO });
    await processWebhookEvent(EVENTO);

    const obs = observaciones();
    expect(obs).toHaveLength(1);
    expect(obs[0]!['author']).toBe('customer');
    expect(String(obs[0]!['text'])).toContain('tenés stock');
    expect(obs[0]!['phoneNumberId']).toBe(PNID_NUEVO);
    expect(obs[0]!['sessionKey']).toBe(`wa_${PNID_NUEVO}`);
    expect(mensajes(), 'la conversación del cliente no se toca').toEqual([]);
  });

  it('NO responde, NO abre turno del motor y NO cuesta metering', async () => {
    evento(texto(), { pnid: PNID_NUEVO });
    await processWebhookEvent(EVENTO);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(enviados).toEqual([]);
    expect(mensajes().filter((m) => m['direction'] === 'out')).toEqual([]);
    expect(incrementMessageUsage).not.toHaveBeenCalled();
  });

  it('un adjunto se observa sin bajar un solo byte', async () => {
    encenderAdjuntos();
    evento(adjunto, { pnid: PNID_NUEVO });
    await processWebhookEvent(EVENTO);

    expect(graph).toEqual([]);
    expect(bytesGuardados).toEqual([]);
    expect(observaciones()).toHaveLength(1);
    expect(enviados).toEqual([]);
  });

  it('el marcador de la observación NUNCA es el caption del cliente (no puede entrar al prompt)', async () => {
    encenderAdjuntos();
    evento(adjunto, { pnid: PNID_NUEVO });
    await processWebhookEvent(EVENTO);
    expect(String(observaciones()[0]!['text'])).not.toContain('cuánto sale');
  });

  /**
   * ADR-0016 §9 + ADR-0017: en la forma LEGACY el caption venía PROMOVIDO a `text`. Persistirlo
   * lo metería en el historial y de ahí al prompt del modelo en el turno siguiente. La marca
   * depende de que HAYA adjunto, no de dónde vino el texto — mismo criterio que el rollout.
   */
  it('evento LEGACY con el caption promovido a `text` tampoco persiste el caption', async () => {
    encenderAdjuntos();
    evento(
      { from: TEL, text: 'cuánto sale este?', messageId: 'wamid.LEG1', image: { mediaId: 'MEDIA_LEG', mimeType: 'image/jpeg', caption: 'cuánto sale este?' } },
      { pnid: PNID_NUEVO },
    );
    await processWebhookEvent(EVENTO);

    const obs = observaciones()[0];
    expect(obs).toBeDefined();
    expect(String(obs!['text'])).not.toContain('cuánto sale');
    expect(graph).toEqual([]);
  });

  it('un reintento del webhook no duplica la observación', async () => {
    evento(texto(), { pnid: PNID_NUEVO });
    await processWebhookEvent(EVENTO);
    docs.set(P_EVENTO, { ...docs.get(P_EVENTO)!, processingStatus: 'received' });
    await processWebhookEvent(EVENTO);
    expect(observaciones()).toHaveLength(1);
  });

  it('el evento queda marcado como `shadow` para poder auditarlo', async () => {
    evento(texto(), { pnid: PNID_NUEVO });
    await processWebhookEvent(EVENTO);
    expect(evGuardado()['automationMode']).toBe('shadow');
  });
});

describe('`live` — el número que ya vende sigue funcionando EXACTAMENTE igual', () => {
  beforeEach(() => {
    docs.set(assetPath(PNID_ACTUAL), { automationMode: 'live' });
  });

  it('el texto llega al motor y la respuesta sale', async () => {
    evento(texto());
    await processWebhookEvent(EVENTO);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.text).toBe('respuesta del bot');
    expect(incrementMessageUsage).toHaveBeenCalled();
    expect(checkTenantInboundGate).toHaveBeenCalled();
    expect(evGuardado()['processingStatus']).toBe('processed');
  });

  it('conserva el canal HEREDADO: el asset sin `sessionKey` sigue hablando de `sessions/active`', async () => {
    evento(texto());
    await processWebhookEvent(EVENTO);
    expect((handleMessage.mock.calls[0]![0] as { sessionKey?: string }).sessionKey).toBe('active');
  });

  it('el adjunto vuelve a descargarse (el gate no rompió la fundación de medios)', async () => {
    encenderAdjuntos();
    evento(adjunto);
    await processWebhookEvent(EVENTO);
    expect(graph).toContain('download');
  });

  it('la ubicación nativa sigue su camino propio', async () => {
    evento({ from: TEL, messageId: 'wamid.LOC1', location: { latitude: -25.3, longitude: -57.6, name: null, address: null, contextMessageId: null } });
    await processWebhookEvent(EVENTO);
    expect(procesarUbicacionEntrante).toHaveBeenCalledTimes(1);
  });
});

describe('inconsistencia entre asset e índice — gana el más restrictivo', () => {
  it('asset `live` + índice `shadow` ⇒ no contesta', async () => {
    docs.set(assetPath(PNID_ACTUAL), { automationMode: 'live' });
    docs.set(`metaExternalIndex/whatsapp_${PNID_ACTUAL}`, { tenantId: TENANT, automationMode: 'shadow' });
    evento(texto(), { conTenant: false });
    await processWebhookEvent(EVENTO);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(enviados).toEqual([]);
    expect(evGuardado()['automationMode']).toBe('shadow');
  });

  it('asset `live` + índice SIN el campo ⇒ sigue `live` (la migración escribe un solo doc)', async () => {
    docs.set(assetPath(PNID_ACTUAL), { automationMode: 'live' });
    docs.set(`metaExternalIndex/whatsapp_${PNID_ACTUAL}`, { tenantId: TENANT });
    evento(texto(), { conTenant: false });
    await processWebhookEvent(EVENTO);

    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});

/**
 * ADR-0017 §2: «un cliente que le escribe a los dos números comparte carrito y takeover entre
 * ambos: el bot podría tomar el pedido empezado en un número y contestarlo por el otro».
 */
describe('un cliente en dos PNID NO comparte sesión', () => {
  it('cada número resuelve su propia `sessionKey` y así viaja al motor y al guard de silencio', async () => {
    docs.set(assetPath(PNID_ACTUAL), { automationMode: 'live' });
    docs.set(assetPath(PNID_NUEVO), { automationMode: 'live', sessionKey: `wa_${PNID_NUEVO}` });

    evento(texto('hola por el número de siempre', 'wamid.A'), { id: 'ev_a', pnid: PNID_ACTUAL });
    await processWebhookEvent('ev_a');
    evento(texto('hola por el número nuevo', 'wamid.B'), { id: 'ev_b', pnid: PNID_NUEVO });
    await processWebhookEvent('ev_b');

    const claves = handleMessage.mock.calls.map((c) => (c[0] as { sessionKey?: string }).sessionKey);
    expect(claves).toEqual(['active', `wa_${PNID_NUEVO}`]);
    expect(new Set(claves).size).toBe(2);

    // El guard autoritativo del borde de envío tiene que mirar la MISMA conversación que el motor:
    // si mirara `active` para los dos, un takeover en un número callaría al bot en el otro.
    const clavesGuard = evaluarSilencioPreEnvio.mock.calls.map((c) => c[3]);
    expect(clavesGuard).toEqual(['active', `wa_${PNID_NUEVO}`]);
  });
});

/**
 * Retrocompatibilidad dura: el gate es de NÚMEROS de WhatsApp. Instagram y Messenger no tienen
 * `phone_number_id` que autorizar y ya tienen su propio gate (`multiChannel` del plan): meterlos
 * en el fail-closed los apagaría a todos de golpe al desplegar.
 *
 * PERO cada plataforma conversa en su PROPIO canal (ADR-0017 §2). Compartir el canal mutable
 * `active` significaba: un cliente que escribe por Instagram y por WhatsApp compartía carrito,
 * takeover y estado con el número que vende — y Messenger con Instagram entre sí. Dato verificado
 * de producción (2026-08-04): hay UNA sola entrada de ruteo y es whatsapp ⇒ no existen sesiones
 * IG/Messenger reales que este cambio abandone.
 */
describe('canales sin PNID — Instagram/Messenger no se gatean, pero conversan en su PROPIO canal', () => {
  it('un inbound de Instagram sigue llegando al motor', async () => {
    evento(texto('hola por IG', 'ig_1'), { platform: 'instagram', pnid: 'IG_ACCOUNT_1' });
    await processWebhookEvent(EVENTO);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(enviados).toHaveLength(1);
  });

  it('la conversación de Instagram vive en `ig` — motor y guard de silencio miran el MISMO canal', async () => {
    evento(texto('hola por IG', 'ig_1'), { platform: 'instagram', pnid: 'IG_ACCOUNT_1' });
    await processWebhookEvent(EVENTO);
    expect((handleMessage.mock.calls[0]![0] as { sessionKey?: string }).sessionKey).toBe('ig');
    expect(evaluarSilencioPreEnvio.mock.calls[0]![3]).toBe('ig');
  });

  it('Messenger tiene el suyo (`msgr`), distinto del de Instagram y del heredado', async () => {
    evento(texto('hola por Messenger', 'msgr_1'), { platform: 'messenger', pnid: 'PAGE_1' });
    await processWebhookEvent(EVENTO);
    const clave = (handleMessage.mock.calls[0]![0] as { sessionKey?: string }).sessionKey;
    expect(clave).toBe('msgr');
    expect(clave).not.toBe('ig');
    expect(clave).not.toBe('active');
  });

  /**
   * COMPATIBILIDAD, no asumida: el `customerId` de IG/Messenger es el id que asigna Meta —no un
   * teléfono—, pero si alguna vez coincidiera con un wa_id, el canal por plataforma es lo único
   * que impide que compartan carrito/takeover. Se prueba con el MISMO id de cliente en las tres
   * plataformas: tres claves, tres conversaciones.
   */
  it('el MISMO id de cliente por WhatsApp, IG y Messenger ⇒ TRES canales distintos', async () => {
    docs.set(assetPath(PNID_ACTUAL), { automationMode: 'live' });
    evento(texto('hola por whatsapp', 'wamid.W1'), { id: 'ev_w', pnid: PNID_ACTUAL });
    await processWebhookEvent('ev_w');
    evento(texto('hola por IG', 'ig_2'), { id: 'ev_ig', platform: 'instagram', pnid: 'IG_ACCOUNT_1' });
    await processWebhookEvent('ev_ig');
    evento(texto('hola por msgr', 'msgr_2'), { id: 'ev_ms', platform: 'messenger', pnid: 'PAGE_1' });
    await processWebhookEvent('ev_ms');

    const claves = handleMessage.mock.calls.map((c) => (c[0] as { sessionKey?: string }).sessionKey);
    expect(claves).toEqual(['active', 'ig', 'msgr']);
    expect(new Set(claves).size).toBe(3);
    // Y el guard autoritativo del borde de envío miró canal por canal, nunca el de otro.
    expect(evaluarSilencioPreEnvio.mock.calls.map((c) => c[3])).toEqual(['active', 'ig', 'msgr']);
  });

  /** Una sesión que YA exista en el canal nuevo se sigue leyendo tal cual (documento con campo). */
  it('una sesión ya existente en `ig` no se abandona: la clave es determinística', async () => {
    docs.set(`tenants/${TENANT}/customers/${TEL}/sessions/ig`, { id: 'ig', context: {} });
    evento(texto('sigo por IG', 'ig_3'), { platform: 'instagram', pnid: 'IG_ACCOUNT_1' });
    await processWebhookEvent(EVENTO);
    expect((handleMessage.mock.calls[0]![0] as { sessionKey?: string }).sessionKey).toBe('ig');
  });
});
