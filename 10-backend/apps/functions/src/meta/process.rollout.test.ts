import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0016 §10 — NIVEL A DEL ROLLOUT (`config/attachments.ingest.enabled`), FAIL-CLOSED.
 * =====================================================================================
 * «Desplegar esta fundación cambia de golpe lo que pasa cuando un cliente manda una foto». Sin
 * este interruptor la fundación se enciende SOLA al desplegar, para todos los tenants a la vez:
 * el primer webhook con imagen ya baja bytes de Graph, los escribe en Storage y crea el documento
 * del adjunto, sin que nadie lo haya decidido.
 *
 * Lo que se prueba acá es el desenlace OBSERVABLE, no la implementación: con el nivel A apagado
 * (que es el estado por defecto: doc ausente, campo ausente o cualquier forma que no sea el
 * booleano exacto `true`) no hay ni una llamada a Graph, ni un byte en Storage, ni un documento de
 * adjunto — pero el inbound NO desaparece: queda un mensaje neutral en la conversación y el
 * cliente recibe una respuesta honesta. Y NADA de negocio se mueve: ni pedidos, ni handoff, ni el
 * modelo de IA (el caption no abre turno del motor).
 *
 * Este archivo va aparte de `process.attachments.test.ts` a propósito: aquel prueba el RUTEO con
 * la fundación encendida; este prueba el interruptor.
 */

const docs = new Map<string, Record<string, unknown>>();
const enviados: Array<{ to: string; text: string }> = [];
/** Toda llamada a Graph (descarga de media) y toda resolución de credenciales para bajarla. */
const graph: string[] = [];
/** Toda escritura de bytes en Storage. */
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
  }),
  storage: () => ({
    bucket: () => ({
      file: (path: string) => ({
        save: async () => {
          bytesGuardados.push(path);
        },
      }),
    }),
  }),
  paths: {
    metaWebhookEvent: (id: string) => `metaWebhookInbox/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    messages: (t: string, c: string) => `tenants/${t}/customers/${c}/messages`,
  },
}));

const handleMessage = vi.fn(async () => ({ reply: 'respuesta del bot', state: 'IDLE', handledByHuman: false, coverageActivationId: null }));
vi.mock('../conversation/engine.js', () => ({
  handleMessage: (...a: unknown[]) => handleMessage(...(a as [])),
}));

/**
 * Estado del silencio de HANDOFF-2. Este archivo prueba el INTERRUPTOR del rollout, no la regla
 * de silencio: se moquea la costura entera (`conversation/silencio.js`) para que las dos puertas
 * —la consulta suelta y el guard autoritativo pre-envío del §12— respondan lo MISMO. Así, si el
 * borde de envío cambia de una a la otra, este archivo sigue probando lo que dice probar.
 */
let chatSilenciado = false;
const botSilenciadoEnChat = vi.fn(async () => chatSilenciado);
const evaluarSilencioPreEnvio = vi.fn(async () => (chatSilenciado ? 'silenciado' : 'libre'));
vi.mock('../conversation/silencio.js', () => ({
  botSilenciadoEnChat: (...a: unknown[]) => botSilenciadoEnChat(...(a as [])),
  evaluarSilencioPreEnvio: (...a: unknown[]) => evaluarSilencioPreEnvio(...(a as [])),
  EXIGE_SILENCIO_LIBRE: { modo: 'requiere_silencio_libre' },
}));
vi.mock('../conversation/coverage.js', () => ({
  procesarUbicacionEntrante: vi.fn(async () => ({ reply: '', inerte: true, coverageActivationId: null })),
  coberturaVigente: vi.fn(async () => true),
}));
vi.mock('../conversation/coverageTestHooks.js', () => ({ coverageHold: vi.fn(async () => undefined) }));
vi.mock('../messaging/whatsappClient.js', () => ({
  getWhatsAppClient: vi.fn(async () => ({
    sendText: vi.fn(async (to: string, text: string) => {
      enviados.push({ to, text });
      return { ok: true };
    }),
    sendLocationRequest: vi.fn(async () => ({ ok: true })),
  })),
}));
vi.mock('../tenants/lifecycle.js', () => ({
  checkTenantInboundGate: vi.fn(async () => ({ allowed: true })),
  incrementMessageUsage: vi.fn(async () => undefined),
}));
vi.mock('../entitlements/entitlements.js', () => ({ resolveEntitlements: vi.fn(async () => ({ features: {} })) }));
vi.mock('../entitlements/decide.js', () => ({ isFeatureEnabled: vi.fn(() => true) }));

// La ingesta corre DE VERDAD: lo que se instrumenta son sus dos salidas al mundo —Graph y el
// bucket—, que con el nivel A apagado no pueden ocurrir NI UNA VEZ.
vi.mock('../messaging/resolveWhatsappCreds.js', () => ({
  resolveTenantWhatsappCreds: vi.fn(async () => {
    graph.push('creds');
    return { ok: true, accessToken: 'TOKEN_TEST', phoneNumberId: 'PNID_1', mode: 'live' };
  }),
}));
vi.mock('./mediaClient.js', () => ({
  MAX_MEDIA_BYTES: 10 * 1024 * 1024,
  downloadWhatsappAttachment: vi.fn(async () => {
    graph.push('download');
    return { ok: false, reason: 'fetch_failed', detail: 'la red no se toca en tests' };
  }),
}));

import { processWebhookEvent } from './process.js';
import { setAttachmentGate } from './attachmentGate.js';

const TENANT = 'tnt_test01';
const TEL = '595991234567';
const EVENTO = 'whatsapp_wamid.IMG1';
const P_EVENTO = `metaWebhookInbox/${EVENTO}`;
const P_CONFIG = `tenants/${TENANT}/config/attachments`;

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

const adjuntoImagen = {
  from: TEL,
  text: '',
  messageId: 'wamid.IMG1',
  attachment: { kind: 'image', mediaId: 'MEDIA_1', declaredMime: 'image/jpeg', filename: null, caption: 'cuánto sale este?', sha256: null },
};
const adjuntoPdf = {
  from: TEL,
  text: '',
  messageId: 'wamid.PDF1',
  attachment: { kind: 'document', mediaId: 'MEDIA_2', declaredMime: 'application/pdf', filename: 'comprobante.pdf', caption: '', sha256: null },
};

/** Claves de `docs` que representan documentos de adjunto (los que NO pueden existir con el flag OFF). */
const docsDeAdjunto = () => [...docs.keys()].filter((k) => k.startsWith(`tenants/${TENANT}/attachments/`));
/** Burbujas del historial, en orden de escritura. */
const mensajes = () =>
  [...docs.entries()]
    .filter(([k]) => k.includes('/messages/'))
    .map(([, v]) => v as Record<string, unknown>);

const gate = vi.fn(async () => ({ reply: '', classification: 'generic_media' as const, orderCandidateId: null }));

beforeEach(() => {
  docs.clear();
  enviados.length = 0;
  graph.length = 0;
  bytesGuardados.length = 0;
  handleMessage.mockClear();
  chatSilenciado = false;
  botSilenciadoEnChat.mockClear();
  evaluarSilencioPreEnvio.mockClear();
  gate.mockClear();
  setAttachmentGate(gate);
  // ADR-0017 §1: este archivo prueba el interruptor de ADJUNTOS, no el permiso del número. Para
  // que el sujeto bajo prueba sea el que dice el título, el número tiene permiso explícito —la
  // misma precondición que en producción, donde la migración a `live` corre antes que el gate—.
  docs.set(`tenants/${TENANT}/metaAssets/PNID_1`, { externalId: 'PNID_1', status: 'active', automationMode: 'live' });
});

/**
 * El corazón del bloqueante: cada una de estas formas es lo que un tenant puede tener escrito HOY
 * (o mañana, por un panel mal tipado). Ninguna enciende la fundación.
 */
describe('nivel A APAGADO ⇒ cero Graph, cero Storage, cero documento de adjunto', () => {
  const APAGADOS: Array<[string, Record<string, unknown> | null]> = [
    ['config del tenant ausente (el caso del día del deploy)', null],
    ['doc presente pero sin `ingest`', {}],
    ['`ingest` sin `enabled`', { ingest: { maxBytes: 1_000_000 } }],
    ['`enabled: false`', { ingest: { enabled: false } }],
    ['`enabled: "true"` (la cadena, no el booleano)', { ingest: { enabled: 'true' } }],
    ['`enabled: 1`', { ingest: { enabled: 1 } }],
    ['`enabled: "1"`', { ingest: { enabled: '1' } }],
    ['`enabled: "yes"`', { ingest: { enabled: 'yes' } }],
    ['`enabled: null`', { ingest: { enabled: null } }],
    ['`ingest` como arreglo', { ingest: [{ enabled: true }] }],
  ];

  for (const [caso, config] of APAGADOS) {
    it(`${caso} ⇒ la fundación NO se enciende`, async () => {
      if (config) docs.set(P_CONFIG, config);
      evento(adjuntoImagen);
      await processWebhookEvent(EVENTO);

      expect(graph, 'no se toca Graph con el flag apagado').toEqual([]);
      expect(bytesGuardados, 'no se escribe un solo byte en Storage').toEqual([]);
      expect(docsDeAdjunto(), 'no se crea documento de adjunto').toEqual([]);
    });
  }

  it('el inbound NO desaparece: queda un mensaje neutral estructurado en la conversación', async () => {
    evento(adjuntoPdf);
    await processWebhookEvent(EVENTO);

    const entrantes = mensajes().filter((m) => m['direction'] === 'in');
    expect(entrantes).toHaveLength(1);
    const burbuja = entrantes[0]!;
    expect(burbuja['author']).toBe('customer');
    expect(String(burbuja['text']).trim()).not.toBe('');
    // Sin adjunto guardado, la burbuja NO puede fingir que hay uno: `attachmentIds`/`hasAttachments`
    // son la única autoridad del panel sobre la existencia de un archivo (ADR-0016 §1).
    expect(burbuja['attachmentIds']).toBeUndefined();
    expect(burbuja['hasAttachments']).toBeUndefined();
  });

  it('el marcador del historial NUNCA es el caption del cliente (§9: no entra al prompt)', async () => {
    evento(adjuntoImagen); // caption: 'cuánto sale este?'
    await processWebhookEvent(EVENTO);
    const entrante = mensajes().find((m) => m['direction'] === 'in')!;
    expect(String(entrante['text'])).not.toContain('cuánto sale este');
  });

  it('el cliente recibe una respuesta HONESTA (ni promete guardarlo ni pide reenviarlo en bucle)', async () => {
    evento(adjuntoPdf);
    await processWebhookEvent(EVENTO);

    expect(enviados).toHaveLength(1);
    const texto = enviados[0]!.text.toLowerCase();
    expect(texto.trim()).not.toBe('');
    // Nada de "lo dejo en la conversación" (mentira: no se guardó) ni "reenviámelo" (bucle: el
    // reenvío termina igual). Tampoco promete que alguien lo revise: eso es §11 y no corre acá.
    expect(texto).not.toContain('dejo en la conversación');
    expect(texto).not.toMatch(/reenvi|de nuevo/);
    expect(texto).not.toMatch(/revisa|asesor|vendedor/);
    // Y queda rastro de la respuesta en el chat, no solo en el aire.
    expect(mensajes().some((m) => m['direction'] === 'out' && m['author'] === 'bot')).toBe(true);
  });

  it('sin caption a la IA: el motor NO abre turno aunque el archivo traiga pie de foto', async () => {
    evento(adjuntoImagen);
    await processWebhookEvent(EVENTO);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('evento LEGACY con el caption promovido a `text` tampoco abre turno del motor', async () => {
    evento({ from: TEL, text: 'cuánto sale este?', messageId: 'wamid.LEG1', image: { mediaId: 'MEDIA_LEG', mimeType: 'image/jpeg', caption: 'cuánto sale este?' } });
    await processWebhookEvent(EVENTO);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(graph).toEqual([]);
    expect(docsDeAdjunto()).toEqual([]);
  });

  it('sin clasificación: el gate no se consulta (no hay archivo que clasificar)', async () => {
    evento(adjuntoImagen);
    await processWebhookEvent(EVENTO);
    expect(gate).not.toHaveBeenCalled();
  });

  it('sin mutación comercial: no se toca ningún pedido ni se marca handoff', async () => {
    evento(adjuntoPdf);
    await processWebhookEvent(EVENTO);
    expect([...docs.keys()].filter((k) => k.includes('/orders/'))).toEqual([]);
    const cliente = docs.get(`tenants/${TENANT}/customers/${TEL}`) as Record<string, any> | undefined;
    expect(cliente?.['conversation']?.['humanTakeover']).toBeUndefined();
  });

  it('el mediaId SE CONSERVA en el inbox: es lo único que permite recuperar el archivo a mano', async () => {
    evento(adjuntoImagen);
    await processWebhookEvent(EVENTO);
    const guardado = docs.get(P_EVENTO) as Record<string, any>;
    expect(guardado['payload']['attachment']['mediaId']).toBe('MEDIA_1');
    expect(guardado['processingStatus']).toBe('processed');
  });

  it('con el vendedor en el chat, el flag apagado tampoco habla encima (HANDOFF-2 intacto)', async () => {
    chatSilenciado = true;
    evento(adjuntoPdf);
    await processWebhookEvent(EVENTO);
    expect(enviados).toHaveLength(0);
    expect(mensajes().some((m) => m['direction'] === 'out')).toBe(false);
  });

  it('un reintento del webhook no duplica la burbuja neutral', async () => {
    evento(adjuntoPdf);
    await processWebhookEvent(EVENTO);
    docs.set(P_EVENTO, { ...docs.get(P_EVENTO)!, processingStatus: 'received' });
    await processWebhookEvent(EVENTO);
    expect(mensajes().filter((m) => m['direction'] === 'in')).toHaveLength(1);
  });

  it('un audio (tipo no soportado) sigue igual: el flag gobierna archivos, no el resto', async () => {
    evento({ from: TEL, text: '', messageId: 'wamid.AUD1', unsupported: { kind: 'audio' } });
    await processWebhookEvent(EVENTO);
    expect(enviados[0]!.text).toContain('audio');
    expect(graph).toEqual([]);
  });

  it('un mensaje de TEXTO no se ve afectado por el flag de adjuntos', async () => {
    evento({ from: TEL, text: 'hola, tenés stock?', messageId: 'wamid.TXT1' });
    await processWebhookEvent(EVENTO);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(enviados[0]!.text).toBe('respuesta del bot');
  });
});

/**
 * El otro lado del interruptor: con el booleano EXACTO la fundación corre como está probado en
 * `process.attachments.test.ts`. Si este bloque se pusiera verde por sí solo (p. ej. porque el
 * flag dejó de leerse) el bloque de arriba se pondría rojo — son la misma prueba desde los dos
 * lados.
 */
describe('nivel A ENCENDIDO (`enabled: true` exacto) ⇒ camino normal', () => {
  beforeEach(() => {
    docs.set(P_CONFIG, { ingest: { enabled: true } });
  });

  it('se descarga por Graph y el adjunto queda registrado', async () => {
    evento(adjuntoImagen);
    await processWebhookEvent(EVENTO);

    expect(graph).toContain('download');
    expect(docsDeAdjunto()).toHaveLength(1);
    // La descarga mockeada falla ⇒ estado terminal honesto y respuesta al cliente (ADR-0016 §4).
    const adj = docs.get(docsDeAdjunto()[0]!) as Record<string, unknown>;
    expect(adj['ingestState']).toBe('download_failed');
    expect(enviados[0]!.text).toContain('reenviás');
  });

  it('los límites del tenant siguen aplicándose junto con el flag (un solo doc de config)', async () => {
    docs.set(P_CONFIG, { ingest: { enabled: true, maxBytes: 1_000_000, allowedMimeTypes: ['application/pdf'] } });
    evento(adjuntoPdf);
    await processWebhookEvent(EVENTO);
    expect(graph).toContain('download');
    expect(docsDeAdjunto()).toHaveLength(1);
  });
});
