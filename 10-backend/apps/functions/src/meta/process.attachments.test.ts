import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0016 §1/§2 — LA CORRECCIÓN CENTRAL EN EL RUTEO DEL WEBHOOK.
 * ==============================================================
 * Antes, `if (esImagen)` mandaba TODA imagen al camino de comprobante y salía con un `return`:
 * la foto de un producto pasaba el pedido a PENDING_VERIFICATION, disparaba handoff y sacaba al
 * bot del chat. Acá se prueba el desenlace observable del ruteo nuevo: el archivo SIEMPRE se
 * ingesta, el pedido no se toca, el caption no llega al motor (ni, por lo tanto, a la IA) y un
 * audio deja rastro en vez de desaparecer.
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
  storage: () => ({ bucket: () => ({ file: () => ({ save: async () => undefined }) }) }),
  paths: {
    metaWebhookEvent: (id: string) => `metaWebhookInbox/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    messages: (t: string, c: string) => `tenants/${t}/customers/${c}/messages`,
  },
}));

const handleMessage = vi.fn(async () => ({ reply: 'respuesta del bot', state: 'IDLE', handledByHuman: false, coverageActivationId: null }));
/** A1: el estado REAL del silencio (sesión + config del agente), que el motor y el camino de
 *  adjuntos comparten. Por default el bot atiende. Vive en una variable —y no en el valor
 *  resuelto del spy— para que las DOS puertas de la costura puedan reflejar el mismo estado sin
 *  ensuciarse el registro de llamadas entre ellas. */
let chatSilenciado = false;
const botSilenciadoEnChat = vi.fn(async () => chatSilenciado);
const evaluarSilencioPreEnvio = vi.fn(async () => (chatSilenciado ? 'silenciado' : 'libre'));
vi.mock('../conversation/engine.js', () => ({
  handleMessage: (...a: unknown[]) => handleMessage(...(a as [])),
}));
/** ADR-0016 §12: la regla de silencio vive en su propia costura (`conversation/silencio.js`), que
 *  es la MISMA para el motor y para el camino de adjuntos. Las dos puertas —la consulta suelta y
 *  el guard autoritativo pre-envío— responden lo mismo, porque son la misma regla. */
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

const ingestInboundAttachment = vi.fn(async () => ({
  attachmentId: 'att_aaaaaaaaaaaaaaaaaaaaaaaa',
  messageId: 'pmid_aaaaaaaaaaaaaaaaaaaaaaaa',
  ingestState: 'stored' as const,
  duplicate: false,
  reply: '',
  reason: null,
  attachment: { attachmentId: 'att_aaaaaaaaaaaaaaaaaaaaaaaa', class: 'image', ingestState: 'stored', classification: { value: 'unclassified' } } as never,
}));
const recordUnsupportedInbound = vi.fn(async () => ({ messageId: 'pmid_x', reply: 'Recibí tu audio 🎧 pero todavía no puedo escucharlo. ¿Me lo escribís?' }));
/** ADR-0016 §10: camino del nivel A APAGADO. Acá NO debe correr (este archivo prueba el ruteo con
 *  la fundación encendida); el interruptor tiene su propio archivo, `process.rollout.test.ts`. */
const recordAttachmentIngestDisabled = vi.fn(async () => ({ messageId: 'pmid_off', reply: 'no debería usarse' }));
vi.mock('./attachmentIngest.js', () => ({
  ingestInboundAttachment: (...a: unknown[]) => ingestInboundAttachment(...(a as [])),
  recordUnsupportedInbound: (...a: unknown[]) => recordUnsupportedInbound(...(a as [])),
  recordAttachmentIngestDisabled: (...a: unknown[]) => recordAttachmentIngestDisabled(...(a as [])),
}));

import { Timestamp } from 'firebase-admin/firestore';
import { processWebhookEvent, WEBHOOK_STUCK_MS } from './process.js';
import { setAttachmentGate } from './attachmentGate.js';

const TENANT = 'tnt_test01';
const TEL = '595991234567';
const EVENTO = 'whatsapp_wamid.IMG1';
const P_EVENTO = `metaWebhookInbox/${EVENTO}`;

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

beforeEach(() => {
  docs.clear();
  enviados.length = 0;
  handleMessage.mockClear();
  ingestInboundAttachment.mockClear();
  recordUnsupportedInbound.mockClear();
  recordAttachmentIngestDisabled.mockClear();
  chatSilenciado = false;
  botSilenciadoEnChat.mockClear();
  evaluarSilencioPreEnvio.mockClear();
  setAttachmentGate(null);
  // ADR-0016 §10: la fundación de medios ya NO se enciende sola. Este archivo prueba el RUTEO con
  // la ingesta encendida, así que el tenant tiene el nivel A prendido explícitamente (el booleano
  // exacto, que es lo único que enciende). Que sin esta línea todo el archivo se caiga es
  // justamente la prueba de que el interruptor gobierna el camino.
  docs.set(`tenants/${TENANT}/config/attachments`, { ingest: { enabled: true } });
});

describe('processWebhookEvent — ruteo de adjuntos (ADR-0016)', () => {
  it('una imagen SIEMPRE se ingesta, con los límites del tenant', async () => {
    evento(adjuntoImagen);
    await processWebhookEvent(EVENTO);

    expect(ingestInboundAttachment).toHaveBeenCalledTimes(1);
    const arg = ingestInboundAttachment.mock.calls[0]![0] as unknown as {
      customerId: string;
      providerMessageId: string;
      limits: { maxBytes: number; allowedMimeTypes: readonly string[] };
    };
    expect(arg.customerId).toBe(TEL);
    expect(arg.providerMessageId).toBe('wamid.IMG1');
    // ADR-0016 §8: los límites entran por parámetro (config del tenant), no hardcodeados adentro.
    expect(arg.limits.maxBytes).toBeGreaterThan(0);
    expect(arg.limits.allowedMimeTypes.length).toBeGreaterThan(0);
    expect(docs.get(P_EVENTO)!['processingStatus']).toBe('processed');
  });

  /**
   * ADR-0016 §9 vs. "no dejarlo mudo". El caption SÍ alimenta las reglas determinísticas —una
   * pregunta con foto tiene que ser respondida— pero viaja marcado con `attachmentCaption`, que es
   * lo que impide que el motor lo persista como mensaje y que la IA lo vea.
   */
  it('el caption va al motor MARCADO como turno de adjunto (regla sí, modelo nunca)', async () => {
    evento(adjuntoImagen);
    await processWebhookEvent(EVENTO);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const turno = handleMessage.mock.calls[0]![0] as unknown as { text: string; attachmentCaption?: boolean };
    expect(turno.text).toBe('cuánto sale este?');
    expect(turno.attachmentCaption).toBe(true);
    // Y la respuesta del motor es la que sale (no el acuse genérico del archivo).
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.text).toBe('respuesta del bot');
  });

  it('un archivo SIN caption no inventa un turno de motor', async () => {
    evento({ ...adjuntoImagen, attachment: { ...adjuntoImagen.attachment, caption: '' } });
    await processWebhookEvent(EVENTO);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  /**
   * A7 — Los eventos LEGACY que quedaron en vuelo traen el caption promovido a `payload.text`
   * (así lo hacía ORDER-1B). Si se los tratara como texto libre, el caption iría derecho al
   * modelo por el camino normal del motor: el mismo agujero de §9, por la puerta de atrás.
   */
  it('evento LEGACY con el caption promovido a `text` se trata como turno de adjunto', async () => {
    evento({ from: TEL, text: 'cuánto sale este?', messageId: 'wamid.LEG2', image: { mediaId: 'MEDIA_LEG', mimeType: 'image/jpeg', caption: 'cuánto sale este?' } });
    await processWebhookEvent(EVENTO);
    const turno = handleMessage.mock.calls[0]![0] as unknown as { text: string; attachmentCaption?: boolean };
    expect(turno.text).toBe('cuánto sale este?');
    expect(turno.attachmentCaption).toBe(true); // ⇒ ni se persiste ni llega a la IA
  });

  it('un mensaje de TEXTO SIN adjunto sigue siendo un turno normal (sin marca)', async () => {
    evento({ from: TEL, text: 'hola', messageId: 'wamid.TXT2' });
    await processWebhookEvent(EVENTO);
    const turno = handleMessage.mock.calls[0]![0] as unknown as { text: string; attachmentCaption?: boolean };
    expect(turno.text).toBe('hola');
    expect(turno.attachmentCaption).toBeUndefined();
  });

  it('con el archivo ya guardado, el mediaId se borra del inbox (deja de apuntar al archivo del cliente)', async () => {
    evento(adjuntoImagen);
    await processWebhookEvent(EVENTO);
    const guardado = docs.get(P_EVENTO) as Record<string, any>;
    expect(guardado['payload']['attachment']['mediaId']).toBeNull();
  });

  it('la ingesta que FALLA responde al cliente y NO rompe el evento', async () => {
    ingestInboundAttachment.mockResolvedValueOnce({
      attachmentId: 'att_bbbbbbbbbbbbbbbbbbbbbbbb',
      messageId: 'pmid_b',
      ingestState: 'download_failed' as const,
      duplicate: false,
      reply: 'No pude descargar tu archivo 😕 ¿Me lo reenviás?',
      reason: 'download_failed',
      attachment: null,
    });
    evento(adjuntoImagen);
    await processWebhookEvent(EVENTO);

    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.text).toContain('reenviás');
    expect(docs.get(P_EVENTO)!['processingStatus']).toBe('processed');
    // Sin archivo guardado, el mediaId SE CONSERVA: es lo único que permite recuperarlo a mano.
    expect((docs.get(P_EVENTO) as Record<string, any>)['payload']['attachment']['mediaId']).toBe('MEDIA_1');
  });

  it('la respuesta por el archivo QUEDA EN EL CHAT, no solo se envía (ADR-0016: rastro visible)', async () => {
    setAttachmentGate(async () => ({ reply: 'Recibí tu comprobante 🙌 lo revisamos.', classification: 'payment_receipt_candidate', orderCandidateId: 'ord_1' }));
    evento(adjuntoImagen);
    await processWebhookEvent(EVENTO);

    // Sin esto, el camino de adjuntos sería el único del sistema que le contesta al cliente fuera
    // de acta: el vendedor abriría la conversación, vería el archivo y ninguna respuesta.
    const burbuja = docs.get(`tenants/${TENANT}/customers/${TEL}/messages/auto`) as Record<string, unknown> | undefined;
    expect(burbuja).toBeDefined();
    expect(burbuja!['direction']).toBe('out');
    expect(burbuja!['author']).toBe('bot');
    expect(burbuja!['text']).toBe('Recibí tu comprobante 🙌 lo revisamos.');
    expect(enviados).toHaveLength(1);
    // Y el resumen denormalizado del cliente acompaña (la bandeja no queda desactualizada).
    const cliente = docs.get(`tenants/${TENANT}/customers/${TEL}`) as Record<string, any> | undefined;
    expect(cliente!['conversation']['lastMessageDirection']).toBe('out');
  });

  it('el gate decide la respuesta del archivo válido; si explota, el adjunto igual quedó guardado', async () => {
    setAttachmentGate(async () => ({ reply: 'Recibí tu comprobante 🙌 lo revisamos.', classification: 'payment_receipt_candidate', orderCandidateId: 'ord_1' }));
    evento(adjuntoImagen);
    await processWebhookEvent(EVENTO);
    expect(enviados[0]!.text).toContain('comprobante');

    enviados.length = 0;
    setAttachmentGate(async () => {
      throw new Error('gate roto');
    });
    evento(adjuntoImagen);
    await processWebhookEvent(EVENTO);
    expect(docs.get(P_EVENTO)!['processingStatus']).toBe('processed');
    // Un gate roto NO puede dejar mudo al cliente (ADR-0016 §4). Con caption, contesta el motor;
    // sin caption contestaría el acuse honesto (ver el bloque de "toda recepción responde").
    expect(enviados).toHaveLength(1);
  });

  it('un reintento del webhook no vuelve a consultar el gate NI a contestar de nuevo', async () => {
    const gate = vi.fn(async () => ({ reply: '', classification: 'generic_media' as const, orderCandidateId: null }));
    setAttachmentGate(gate);
    ingestInboundAttachment.mockResolvedValueOnce({
      attachmentId: 'att_cccccccccccccccccccccccc',
      messageId: 'pmid_c',
      ingestState: 'stored' as const,
      duplicate: true,
      reply: '',
      reason: null,
      attachment: { attachmentId: 'att_cccccccccccccccccccccccc' } as never,
    });
    evento({ ...adjuntoImagen, attachment: { ...adjuntoImagen.attachment, caption: '' } });
    await processWebhookEvent(EVENTO);
    expect(gate).not.toHaveBeenCalled();
    expect(enviados).toHaveLength(0); // el acuse ya salió la primera vez
  });

  /**
   * A2 — EL SILENCIO TOTAL. Este bloque es el que cierra el agujero: el gate degrada a
   * `generic_media` con `reply: ''`, el caption no promueve texto ⇒ antes NO salía ni un mensaje.
   * Un cliente en espera de pago que manda el PDF del banco creía que nadie lo había visto.
   */
  describe('toda recepción de archivo produce una respuesta honesta (ADR-0016 §4)', () => {
    const sinCaption = { ...adjuntoImagen, attachment: { ...adjuntoImagen.attachment, caption: '' } };

    it('gate que degrada SIN texto propio → igual se le contesta al cliente', async () => {
      setAttachmentGate(async () => ({ reply: '', classification: 'generic_media' as const, orderCandidateId: null }));
      evento(sinCaption);
      await processWebhookEvent(EVENTO);

      expect(enviados).toHaveLength(1);
      expect(enviados[0]!.text).toContain('dejo en la conversación');
      // Y queda rastro en el chat, no solo en el aire.
      expect((docs.get(`tenants/${TENANT}/customers/${TEL}/messages/auto`) as Record<string, unknown>)['author']).toBe('bot');
    });

    it('el MOTIVO del gate elige la redacción (dos pedidos ambiguos ≠ medio normal)', async () => {
      setAttachmentGate(async () => ({
        reply: '',
        classification: 'generic_media' as const,
        orderCandidateId: null,
        reason: 'ambiguous_orders' as const,
      }));
      evento(sinCaption);
      await processWebhookEvent(EVENTO);
      expect(enviados[0]!.text).toContain('más de un pedido pendiente');
    });

    it('gate que EXPLOTA → el archivo ya está guardado y el cliente igual recibe respuesta', async () => {
      setAttachmentGate(async () => {
        throw new Error('gate roto');
      });
      evento(sinCaption);
      await processWebhookEvent(EVENTO);
      expect(docs.get(P_EVENTO)!['processingStatus']).toBe('processed');
      expect(enviados).toHaveLength(1);
      expect(enviados[0]!.text).toContain('Recibí');
    });

    it('un archivo YA propuesto como comprobante no recibe encima el acuse genérico', async () => {
      // Idempotencia del gate (`alreadyLinked`): ya se le acusó recibo en su momento. Mandarle
      // "si es el comprobante, escribí *pagar*" sería contradecir lo que ya se le dijo.
      setAttachmentGate(async () => ({
        reply: '',
        classification: 'payment_receipt_candidate' as const,
        orderCandidateId: 'ord_1',
      }));
      evento(sinCaption);
      await processWebhookEvent(EVENTO);
      expect(enviados).toHaveLength(0);
    });

    it('con el chat en atención humana, el bot NO pisa al vendedor', async () => {
      handleMessage.mockResolvedValueOnce({ reply: '', state: 'IDLE', handledByHuman: true, coverageActivationId: null });
      setAttachmentGate(async () => ({ reply: '', classification: 'generic_media' as const, orderCandidateId: null }));
      evento(adjuntoImagen); // con caption ⇒ el motor corre y decide callarse
      await processWebhookEvent(EVENTO);
      expect(enviados).toHaveLength(0);
    });
  });

  /**
   * A1 — EL SILENCIO DE HANDOFF-2 CON UN ARCHIVO SIN CAPTION. Este es el caso que discrimina y el
   * que el bloque de arriba NO probaba: sin caption el motor NO corre, `result` queda en `null` y
   * la condición vieja (`!result?.handledByHuman`) daba SIEMPRE true. Vector real: el vendedor
   * tomó el chat por `payment_verification`, el cliente manda la foto del comprobante —sin pie,
   * como se manda un comprobante— y el bot le contestaba encima, rompiendo la garantía de silencio.
   */
  describe('A1 — un archivo SIN caption no puede romper el silencio del bot', () => {
    const sinCaption = { ...adjuntoImagen, attachment: { ...adjuntoImagen.attachment, caption: '' } };

    beforeEach(() => {
      // El gate degrada a medio normal sin texto propio ⇒ lo único por decir es el acuse genérico.
      setAttachmentGate(async () => ({ reply: '', classification: 'generic_media' as const, orderCandidateId: null }));
    });

    it('vendedor con el chat tomado: NO se envía el acuse NI queda burbuja del bot', async () => {
      chatSilenciado = true;
      evento(sinCaption);
      await processWebhookEvent(EVENTO);

      expect(handleMessage).not.toHaveBeenCalled(); // sin caption el motor no abre turno
      expect(botSilenciadoEnChat).toHaveBeenCalledWith(TENANT, TEL);
      expect(enviados).toHaveLength(0);
      // Y tampoco se finge en el historial que el bot contestó.
      expect(docs.get(`tenants/${TENANT}/customers/${TEL}/messages/auto`)).toBeUndefined();
      expect(docs.get(P_EVENTO)!['processingStatus']).toBe('processed');
    });

    it('bot apagado desde el panel: mismo silencio (es la MISMA regla, no una copia)', async () => {
      chatSilenciado = true;
      evento(sinCaption);
      await processWebhookEvent(EVENTO);
      expect(enviados).toHaveLength(0);
    });

    it('con el bot atendiendo, el acuse SÍ sale (el arreglo no enmudece el camino feliz)', async () => {
      chatSilenciado = false;
      evento(sinCaption);
      await processWebhookEvent(EVENTO);
      expect(enviados).toHaveLength(1);
      expect(enviados[0]!.text).toContain('dejo en la conversación');
    });

    it('un AUDIO en atención humana tampoco recibe la respuesta automática', async () => {
      chatSilenciado = true;
      evento({ from: TEL, text: '', messageId: 'wamid.AUD2', unsupported: { kind: 'audio' } });
      await processWebhookEvent(EVENTO);
      expect(enviados).toHaveLength(0);
    });

    it('si el motor CORRIÓ, manda su veredicto y no se paga la lectura extra', async () => {
      evento(adjuntoImagen); // con caption ⇒ hay turno de motor
      await processWebhookEvent(EVENTO);
      expect(handleMessage).toHaveBeenCalledTimes(1);
      expect(botSilenciadoEnChat).not.toHaveBeenCalled();
      expect(enviados[0]!.text).toBe('respuesta del bot');
    });
  });

  it('A5 — evento sin messageId (Meta no siempre lo manda): cae al id del evento, no se pierde', async () => {
    // El parser escribe cadena VACÍA: con `??` el '' no caía al fallback y el evento moría.
    evento({ ...adjuntoImagen, messageId: '' });
    await processWebhookEvent(EVENTO);
    const arg = ingestInboundAttachment.mock.calls[0]![0] as unknown as { providerMessageId: string };
    expect(arg.providerMessageId).toBe(EVENTO);
    expect(docs.get(P_EVENTO)!['processingStatus']).toBe('processed');
  });

  it('audio: deja rastro y responde; nunca se descarta en silencio', async () => {
    evento({ from: TEL, text: '', messageId: 'wamid.AUD1', unsupported: { kind: 'audio' } });
    await processWebhookEvent(EVENTO);

    expect(recordUnsupportedInbound).toHaveBeenCalledTimes(1);
    expect(ingestInboundAttachment).not.toHaveBeenCalled();
    expect(enviados[0]!.text).toContain('audio');
    expect(docs.get(P_EVENTO)!['processingStatus']).toBe('processed');
  });

  it('mensaje de TEXTO: el camino del bot sigue igual (sin regresión)', async () => {
    evento({ from: TEL, text: 'hola, tenés stock?', messageId: 'wamid.TXT1' });
    await processWebhookEvent(EVENTO);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(ingestInboundAttachment).not.toHaveBeenCalled();
    expect(enviados[0]!.text).toBe('respuesta del bot');
  });

  it('evento LEGACY con `payload.image` (en vuelo al desplegar) también se ingesta y se redacta', async () => {
    evento({ from: TEL, text: '', messageId: 'wamid.LEG1', image: { mediaId: 'MEDIA_LEG', mimeType: 'image/jpeg', caption: null } });
    await processWebhookEvent(EVENTO);
    expect(ingestInboundAttachment).toHaveBeenCalledTimes(1);
    const arg = ingestInboundAttachment.mock.calls[0]![0] as unknown as { attachment: { mediaId: string } };
    expect(arg.attachment.mediaId).toBe('MEDIA_LEG');
    const guardado = docs.get(P_EVENTO) as Record<string, any>;
    expect(guardado['payload']['image']).toBeNull();
    expect(guardado['payload']['attachment']).toBeUndefined(); // no se inventa la forma nueva
  });

  it('sin texto, sin adjunto y sin ubicación → ignorado (guard intacto)', async () => {
    evento({ from: TEL, text: '', messageId: 'wamid.NADA' });
    await processWebhookEvent(EVENTO);
    expect(docs.get(P_EVENTO)!['processingStatus']).toBe('ignored');
    expect(ingestInboundAttachment).not.toHaveBeenCalled();
  });
});

/**
 * A3 — EL RESCATE DEL EVENTO CLAVADO. `INGEST_STUCK_MS` prometía retomar un adjunto colgado en
 * `downloading`, pero era INALCANZABLE: `processWebhookEvent` marcaba `processing` antes de
 * trabajar y salía temprano con cualquier estado distinto de `received`, así que la ingesta nunca
 * corría dos veces con la misma clave. La red de seguridad no atrapaba nada. Acá se prueba que
 * ahora sí, y —tan importante— que sigue sin retomar lo que NO se puede retomar sin duplicar.
 */
describe('processWebhookEvent — rescate de un evento clavado en `processing` (A3)', () => {
  const AHORA = Date.now();
  const clavado = (payload: Record<string, unknown>, antigüedadMs: number, marca: 'processingStartedAt' | 'receivedAt') => {
    docs.set(P_EVENTO, {
      id: EVENTO,
      platform: 'whatsapp',
      externalId: 'PNID_1',
      tenantId: TENANT,
      processingStatus: 'processing',
      receivedAt: Timestamp.fromMillis(AHORA - (marca === 'receivedAt' ? antigüedadMs : 0)),
      ...(marca === 'processingStartedAt' ? { processingStartedAt: Timestamp.fromMillis(AHORA - antigüedadMs) } : {}),
      payload,
    });
  };

  it('al tomar el evento queda registrado CUÁNDO se lo tomó (sin esa marca no hay rescate posible)', async () => {
    evento(adjuntoImagen);
    await processWebhookEvent(EVENTO);
    const marca = docs.get(P_EVENTO)!['processingStartedAt'] as { toMillis: () => number };
    expect(typeof marca?.toMillis).toBe('function');
  });

  it('un evento CON ADJUNTO clavado hace rato se retoma y termina la ingesta', async () => {
    clavado(adjuntoImagen, WEBHOOK_STUCK_MS + 60_000, 'processingStartedAt');
    await processWebhookEvent(EVENTO);
    expect(ingestInboundAttachment).toHaveBeenCalledTimes(1);
    expect(docs.get(P_EVENTO)!['processingStatus']).toBe('processed');
  });

  it('uno tomado recién NO se retoma: sería una segunda descarga del mismo archivo', async () => {
    clavado(adjuntoImagen, 5_000, 'processingStartedAt');
    await processWebhookEvent(EVENTO);
    expect(ingestInboundAttachment).not.toHaveBeenCalled();
    expect(docs.get(P_EVENTO)!['processingStatus']).toBe('processing');
  });

  it('un turno de TEXTO clavado NO se retoma: su burbuja no es idempotente y se duplicaría', async () => {
    clavado({ from: TEL, text: 'hola', messageId: 'wamid.TXT9' }, WEBHOOK_STUCK_MS * 10, 'processingStartedAt');
    await processWebhookEvent(EVENTO);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(docs.get(P_EVENTO)!['processingStatus']).toBe('processing');
  });

  it('un evento YA terminal no se retoma por viejo que sea', async () => {
    clavado(adjuntoImagen, WEBHOOK_STUCK_MS * 10, 'processingStartedAt');
    docs.set(P_EVENTO, { ...docs.get(P_EVENTO)!, processingStatus: 'processed' });
    await processWebhookEvent(EVENTO);
    expect(ingestInboundAttachment).not.toHaveBeenCalled();
  });

  it('evento ANTERIOR a este cambio (sin `processingStartedAt`): manda `receivedAt`', async () => {
    clavado(adjuntoImagen, WEBHOOK_STUCK_MS + 60_000, 'receivedAt');
    await processWebhookEvent(EVENTO);
    expect(ingestInboundAttachment).toHaveBeenCalledTimes(1);
  });
});
