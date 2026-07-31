import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0016 §12 — LA CARRERA TAKEOVER → ENVÍO.
 * ===========================================
 * Entre que se decide una respuesta y que sale el POST a Meta pasan segundos: turno de IA,
 * transacciones, resolución de credenciales. En esa ventana un vendedor puede tomar el chat —y
 * el caso típico es justo ese: el cliente pide una persona o manda el comprobante, el vendedor
 * abre la conversación, y el bot le contesta encima al cliente medio segundo después.
 *
 * Acá se REPRODUCE esa carrera de forma determinística: el hook solo-emulador
 * (`bot_reply_pre_send`) pausa con la respuesta ya construida y el cliente de WhatsApp ya
 * resuelto, y durante la pausa se activa `humanTakeover`. Lo que se exige al reanudar es doble:
 * el bot NO envía y NO deja burbuja. Un outbound en el historial que nunca salió le miente al
 * vendedor sobre lo que el cliente vio.
 *
 * Este archivo NO mockea `conversation/silencio.js`: la regla que decide es la real.
 */

const docs = new Map<string, Record<string, unknown>>();
const enviados: Array<{ to: string; text: string }> = [];

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
  get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
  set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => escribir(path, d, o?.merge === true),
  update: async (d: Record<string, unknown>) => escribir(path, d, true),
});

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => refFor(path),
    collection: (path: string) => ({ doc: (id?: string) => refFor(`${path}/${id ?? 'auto'}`) }),
  }),
  paths: {
    metaWebhookEvent: (id: string) => `metaWebhookInbox/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    messages: (t: string, c: string) => `tenants/${t}/customers/${c}/messages`,
    session: (t: string, c: string) => `tenants/${t}/customers/${c}/sessions/active`,
  },
}));

/** Lo que hace "el vendedor" mientras el envío está pausado. null = nadie interfiere. */
let duranteLaPausa: (() => void) | null = null;
vi.mock('../conversation/coverageTestHooks.js', () => ({
  coverageHold: vi.fn(async (_tenantId: string, punto: string) => {
    if (punto === 'bot_reply_pre_send') duranteLaPausa?.();
  }),
}));

const handleMessage = vi.fn(async () => respuestaDelMotor);
vi.mock('../conversation/engine.js', () => ({ handleMessage: (...a: unknown[]) => handleMessage(...(a as [])) }));
/** KILL-SWITCH-1: se puede apagar DURANTE la pausa, para probar que el gate se relee en el borde. */
let coberturaEncendida = true;
vi.mock('../conversation/coverage.js', () => ({
  procesarUbicacionEntrante: vi.fn(async () => ({ reply: '', inerte: true, coverageActivationId: null })),
  coberturaVigente: vi.fn(async () => coberturaEncendida),
}));

/** Desenlace del transporte (SHIPPING-CHAT-3B): configurable por test. */
let desenlaceDeMeta: unknown = { ok: true, outcome: 'accepted', id: 'wamid.out.1', viaMock: false };
vi.mock('../messaging/whatsappClient.js', () => ({
  getWhatsAppClient: vi.fn(async () => ({
    sendText: vi.fn(async (to: string, text: string) => {
      enviados.push({ to, text });
      return desenlaceDeMeta;
    }),
    sendLocationRequest: vi.fn(async () => ({ ok: true, id: 'wamid.lr' })),
  })),
}));
vi.mock('../tenants/lifecycle.js', () => ({
  checkTenantInboundGate: vi.fn(async () => ({ allowed: true })),
  incrementMessageUsage: vi.fn(async () => undefined),
}));
vi.mock('../entitlements/entitlements.js', () => ({ resolveEntitlements: vi.fn(async () => ({ features: {} })) }));
vi.mock('../entitlements/decide.js', () => ({ isFeatureEnabled: vi.fn(() => true) }));
vi.mock('./attachmentLimits.js', () => ({
  getAttachmentIngestPolicy: vi.fn(async () => ({ enabled: true, limits: { maxBytes: 5_000_000, allowedMimeTypes: ['image/jpeg'] } })),
}));
vi.mock('./attachmentIngest.js', () => ({
  ingestInboundAttachment: vi.fn(async () => ({
    attachmentId: 'att_dddddddddddddddddddddddd',
    messageId: 'pmid_d',
    ingestState: 'stored' as const,
    duplicate: false,
    reply: '',
    reason: null,
    attachment: { attachmentId: 'att_dddddddddddddddddddddddd', class: 'image' } as never,
  })),
  recordUnsupportedInbound: vi.fn(async () => ({ messageId: 'pmid_u', reply: '' })),
  recordAttachmentIngestDisabled: vi.fn(async () => ({ messageId: 'pmid_off', reply: '' })),
}));

import { processWebhookEvent } from './process.js';
import { setAttachmentGate } from './attachmentGate.js';

const TENANT = 'tnt_race1';
const TEL = '595991234567';
const EVENTO = 'whatsapp_wamid.RACE1';
const P_EVENTO = `metaWebhookInbox/${EVENTO}`;
const P_SESION = `tenants/${TENANT}/customers/${TEL}/sessions/active`;
const P_BURBUJA = `tenants/${TENANT}/customers/${TEL}/messages/auto`;
const P_AGENTE = `tenants/${TENANT}/config/agent`;

/** Respuesta que devuelve el motor mockeado (con su descriptor de outbound diferido). */
let respuestaDelMotor: Record<string, unknown>;

const evento = (payload: Record<string, unknown>) => {
  docs.set(P_EVENTO, {
    id: EVENTO,
    platform: 'whatsapp',
    externalId: 'PNID_1',
    tenantId: TENANT,
    processingStatus: 'received',
    payload,
  });
};

const textoPlano = { from: TEL, text: 'hola, tenés stock?', messageId: 'wamid.RACE1' };
const adjuntoSinCaption = {
  from: TEL,
  text: '',
  messageId: 'wamid.RACE1',
  attachment: { kind: 'image', mediaId: 'MEDIA_R', declaredMime: 'image/jpeg', filename: null, caption: '', sha256: null },
};

/** El vendedor toma el chat: es la transición canónica de HANDOFF-2, reducida a lo que se lee. */
const tomarElChat = (sourceId: string | null, reason = 'seller_manual') =>
  escribir(P_SESION, { context: { humanTakeover: true, handoffReason: reason, handoffSourceId: sourceId } }, true);

beforeEach(() => {
  docs.clear();
  enviados.length = 0;
  duranteLaPausa = null;
  coberturaEncendida = true;
  handleMessage.mockClear();
  setAttachmentGate(null);
  desenlaceDeMeta = { ok: true, outcome: 'accepted', id: 'wamid.out.1', viaMock: false };
  respuestaDelMotor = {
    reply: 'respuesta del bot',
    state: 'IDLE',
    handledByHuman: false,
    coverageActivationId: null,
    outbound: { state: 'IDLE', humanTakeover: false, expectativa: { modo: 'requiere_silencio_libre' } },
  };
});

describe('C — carrera takeover → envío (ADR-0016 §12)', () => {
  it('REPRODUCCIÓN: el vendedor toma el chat durante la pausa pre-envío ⇒ ni se envía ni se persiste', async () => {
    duranteLaPausa = () => tomarElChat('wamid.SELLER');
    evento(textoPlano);
    await processWebhookEvent(EVENTO);

    expect(handleMessage).toHaveBeenCalledTimes(1); // el turno corrió: la respuesta EXISTÍA
    expect(enviados).toHaveLength(0); // pero no salió
    expect(docs.get(P_BURBUJA)).toBeUndefined(); // y el historial no la inventa
    expect(docs.get(P_EVENTO)!['processingStatus']).toBe('processed'); // el evento no se rompe
  });

  it('CONTROL: sin takeover el mismo turno SÍ envía, y la burbuja se escribe DESPUÉS del envío', async () => {
    evento(textoPlano);
    await processWebhookEvent(EVENTO);

    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.text).toBe('respuesta del bot');
    const burbuja = docs.get(P_BURBUJA) as Record<string, unknown> | undefined;
    expect(burbuja).toBeDefined();
    expect(burbuja!['direction']).toBe('out');
    expect(burbuja!['author']).toBe('bot');
    // C4: el desenlace TIPADO del transporte no se descarta — el wamid queda en la burbuja.
    expect(burbuja!['waMessageId']).toBe('wamid.out.1');
  });

  it('el chat YA estaba tomado antes del turno: la autoridad es el borde, no lo que se leyó al empezar', async () => {
    tomarElChat('wamid.ANTERIOR');
    evento(textoPlano);
    await processWebhookEvent(EVENTO);

    expect(enviados).toHaveLength(0);
    expect(docs.get(P_BURBUJA)).toBeUndefined();
  });

  it('bot apagado desde el panel: mismo silencio (la regla es una sola)', async () => {
    docs.set(P_AGENTE, { botEnabled: false });
    evento(textoPlano);
    await processWebhookEvent(EVENTO);

    expect(enviados).toHaveLength(0);
    expect(docs.get(P_BURBUJA)).toBeUndefined();
  });

  it('un archivo SIN caption tampoco rompe el silencio si el takeover llega durante la pausa', async () => {
    // Sin caption el motor no abre turno: lo único por decir es el acuse del propio camino de
    // adjuntos, que hasta ahora se persistía ANTES de enviar.
    setAttachmentGate(async () => ({ reply: '', classification: 'generic_media' as const, orderCandidateId: null }));
    duranteLaPausa = () => tomarElChat('wamid.SELLER');
    evento(adjuntoSinCaption);
    await processWebhookEvent(EVENTO);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(enviados).toHaveLength(0);
    expect(docs.get(P_BURBUJA)).toBeUndefined();
  });

  it('CONTROL del adjunto: con el bot atendiendo, el acuse sale y queda rastro en el chat', async () => {
    setAttachmentGate(async () => ({ reply: '', classification: 'generic_media' as const, orderCandidateId: null }));
    evento(adjuntoSinCaption);
    await processWebhookEvent(EVENTO);

    expect(enviados).toHaveLength(1);
    const burbuja = docs.get(P_BURBUJA) as Record<string, unknown> | undefined;
    expect(burbuja!['author']).toBe('bot');
    // El acuse del adjunto NUNCA tocó el resumen de takeover del cliente: sigue sin tocarlo.
    const cliente = docs.get(`tenants/${TENANT}/customers/${TEL}`) as Record<string, Record<string, unknown>>;
    expect(cliente['conversation']!['humanTakeover']).toBeUndefined();
  });
});

/**
 * KILL-SWITCH-1 tenía un invariante escrito a mano —cero E/S entre `coberturaVigente()` y el
 * `sendText`— y el guard de silencio de §12 lo rompió sin que nada avisara: al meterse en el
 * medio, sus dos lecturas de Firestore ensancharon la ventana de un interruptor de emergencia de
 * un flujo con plata. Ningún test lo detectaba porque el hold del E2E (`reply_pre_send`) dispara
 * ANTES de `coberturaVigente`, así que la carrera nunca se ejercía en el punto correcto.
 *
 * Estos dos tests fijan el orden desde el hold que sí está en el punto correcto
 * (`bot_reply_pre_send`, ya dentro del borde de envío): apagar cobertura DURANTE esa pausa tiene
 * que frenar el mensaje. Contra el código anterior fallan — ahí `coberturaVigente` ya había
 * devuelto `true` antes de entrar al borde, y el mensaje salía igual.
 */
describe('C5 — el kill-switch de cobertura sigue siendo el ÚLTIMO gate antes del POST', () => {
  const respuestaDeCobertura = () => {
    respuestaDelMotor = {
      ...respuestaDelMotor,
      reply: 'Pasame tu ubicación así calculo el envío',
      coverageActivationId: 'cov_1',
    };
  };

  it('apagar cobertura durante la pausa pre-envío frena el mensaje (y no deja burbuja)', async () => {
    respuestaDeCobertura();
    duranteLaPausa = () => coberturaEncendida = false;
    evento(textoPlano);
    await processWebhookEvent(EVENTO);

    expect(handleMessage).toHaveBeenCalledTimes(1); // la respuesta se construyó
    expect(enviados).toHaveLength(0); // el kill-switch la frenó dentro del borde
    expect(docs.get(P_BURBUJA)).toBeUndefined(); // lo frenado tampoco se persiste
  });

  it('CONTROL: con cobertura vigente el mismo turno SÍ sale', async () => {
    respuestaDeCobertura();
    evento(textoPlano);
    await processWebhookEvent(EVENTO);

    expect(enviados).toHaveLength(1);
    expect(docs.get(P_BURBUJA)).toBeDefined();
  });

  it('el gate de cobertura NO se evalúa cuando el reply no es de cobertura', async () => {
    // Un reply común (activationId null) no puede quedar preso de un flag que no le corresponde.
    coberturaEncendida = false;
    evento(textoPlano);
    await processWebhookEvent(EVENTO);

    expect(enviados).toHaveLength(1);
  });
});

describe('C — la confirmación del handoff propio no puede morir por el guard', () => {
  const confirmacion = (sourceId: string | null) => {
    respuestaDelMotor = {
      reply: 'Dale, te paso con Ana 🙌',
      state: 'IDLE',
      handledByHuman: false,
      coverageActivationId: null,
      outbound: {
        state: 'IDLE',
        humanTakeover: true,
        countUnread: true,
        expectativa: { modo: 'confirma_handoff_propio', sourceId },
      },
    };
  };

  it('el takeover lo tomó ESTE turno: la confirmación sale y queda registrada', async () => {
    confirmacion('wamid.RACE1');
    // Lo que dejó la transición canónica del propio turno (handoff.ts escribe el sourceId).
    tomarElChat('wamid.RACE1', 'customer_requested');
    evento(textoPlano);
    await processWebhookEvent(EVENTO);

    expect(enviados).toHaveLength(1);
    const burbuja = docs.get(P_BURBUJA) as Record<string, unknown>;
    expect(burbuja['text']).toBe('Dale, te paso con Ana 🙌');
    const cliente = docs.get(`tenants/${TENANT}/customers/${TEL}`) as Record<string, Record<string, unknown>>;
    expect(cliente['conversation']!['humanTakeover']).toBe(true);
  });

  it('pero con un takeover AJENO vigente, la confirmación NO sale ni se registra', async () => {
    confirmacion('wamid.RACE1');
    duranteLaPausa = () => tomarElChat('otro-origen', 'seller_manual');
    evento(textoPlano);
    await processWebhookEvent(EVENTO);

    expect(enviados).toHaveLength(0);
    expect(docs.get(P_BURBUJA)).toBeUndefined();
  });
});

describe('C4 — el desenlace del transporte decide qué queda en el historial', () => {
  it('rechazo CONFIRMADO de Meta (4xx): el intento salió pero la burbuja no se escribe', async () => {
    desenlaceDeMeta = { ok: false, outcome: 'rejected', providerCode: 131047 };
    evento(textoPlano);
    await processWebhookEvent(EVENTO);

    expect(enviados).toHaveLength(1); // se intentó
    expect(docs.get(P_BURBUJA)).toBeUndefined(); // el cliente NUNCA lo vio: no se finge que sí
  });

  it('resultado DESCONOCIDO (5xx/timeout): se registra, porque el mensaje PUDO salir', async () => {
    desenlaceDeMeta = { ok: false, outcome: 'unknown' };
    evento(textoPlano);
    await processWebhookEvent(EVENTO);

    const burbuja = docs.get(P_BURBUJA) as Record<string, unknown> | undefined;
    expect(burbuja).toBeDefined();
    expect(burbuja!['waMessageId']).toBeUndefined(); // sin wamid confiable, no se inventa uno
  });

  it('modo mock (emulador / no conectado): se registra marcado como mock', async () => {
    desenlaceDeMeta = { ok: true, outcome: 'mock', id: 'mock_1', viaMock: true };
    evento(textoPlano);
    await processWebhookEvent(EVENTO);

    const burbuja = docs.get(P_BURBUJA) as Record<string, unknown>;
    expect(burbuja['viaMock']).toBe(true);
  });
});
