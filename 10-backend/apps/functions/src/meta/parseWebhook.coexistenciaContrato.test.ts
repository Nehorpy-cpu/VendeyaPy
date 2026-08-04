/**
 * parseWebhook.coexistenciaContrato.test.ts — los agujeros del parser contra el CONTRATO OFICIAL
 * ================================================================================================
 * Contrato verificado el 2026-08-04 (ADR-0017 §5 y §6 · ARCHITECTURE §12.1). Cuatro hechos que el
 * parser actual no contempla, y los cuatro cuestan material que NO se puede volver a pedir:
 *
 *  1. Los IDs de los ADJUNTOS del historial llegan con `field: "history"` pero en `value.messages[]`,
 *     no en `value.history[]`. Hoy `waHistoryChange` mira sólo `value.history[]` y los descarta en
 *     silencio. Esos IDs viven 14 días y no se pueden volver a pedir.
 *  2. «El negocio NO compartió» llega como `history[0].errors[0].code = 2593109` y ese payload NO
 *     trae el envelope `object`/`entry`/`changes` que `parseWhatsApp` itera: se pierde entero antes
 *     de llegar al router, y el coordinador se queda esperando hasta quemar la ventana de 24 h.
 *  3. `account_update` (`ACCOUNT_OFFBOARDED`, `PARTNER_REMOVED`, `ACCOUNT_RECONNECTED`) no existe en
 *     el repo. Sin consumirlo, un número en `live` sigue automatizando contra una conexión muerta.
 *  4. El error `131060` es ESPERADO tras el onboarding. Hay que poder distinguirlo de una falla
 *     real para no llenar la auditoría de ruido — y para no esconder las fallas de verdad.
 *
 * Los adjuntos del historial NO pueden salir por `result.messages`: esa lista termina en
 * `metaWebhookInbox`, que ES el disparador del motor. Van por lista propia, al archivo.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMetaWebhookPayload,
  HISTORY_NOT_SHARED_CODE,
  COEXISTENCE_EXPECTED_ERROR_CODES,
  esHistorialNoCompartido,
  historyMediaIdempotencyKey,
} from './parseWebhook.js';

const NEGOCIO = '595990000001';
const CLIENTE = '595991234567';
const PNID = 'PNID_DEL_NUMERO_REAL';
const WABA = 'WABA_ID';
const metadata = { display_phone_number: NEGOCIO, phone_number_id: PNID };

const cambio = (field: string, value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA, changes: [{ field, value }] }],
});

// ---------------------------------------------------------------------------
// 1) Los adjuntos del historial: field `history` + `value.messages[]`
// ---------------------------------------------------------------------------

describe('history con value.messages[] — los IDs de los adjuntos del historial', () => {
  const cuerpo = () =>
    cambio('history', {
      metadata,
      messages: [
        { id: 'wamid.HM1', from: CLIENTE, timestamp: '1754100000', type: 'image', image: { id: 'MEDIA_1', mime_type: 'image/jpeg', sha256: 'abc' } },
        { id: 'wamid.HM2', from: NEGOCIO, timestamp: '1754100100', type: 'document', document: { id: 'MEDIA_2', mime_type: 'application/pdf', filename: 'remito.pdf' } },
      ],
    });

  it('los captura en su propia lista (hoy se descartan en silencio)', () => {
    const r = parseMetaWebhookPayload(cuerpo());
    expect(r.historyMedia.map((m) => m.mediaId)).toEqual(['MEDIA_1', 'MEDIA_2']);
    expect(r.historyMedia[0]!.externalId).toBe(PNID);
    expect(r.historyMedia[0]!.kind).toBe('image');
    expect(r.historyMedia[1]!.declaredMime).toBe('application/pdf');
  });

  it('JAMÁS entran por `messages`: esa lista es la que dispara el motor', () => {
    const r = parseMetaWebhookPayload(cuerpo());
    expect(r.messages).toEqual([]);
  });

  it('nacen inertes: nada del archivo es elegible para automatización', () => {
    const r = parseMetaWebhookPayload(cuerpo());
    for (const m of r.historyMedia) expect(m.automationEligible).toBe(false);
  });

  it('un mensaje del historial SIN media id no inventa un adjunto', () => {
    const r = parseMetaWebhookPayload(cambio('history', { metadata, messages: [{ id: 'wamid.X', type: 'text', text: { body: 'hola' } }] }));
    expect(r.historyMedia).toEqual([]);
  });

  it('la clave de idempotencia distingue la generación de la sincronización', () => {
    const m = parseMetaWebhookPayload(cuerpo()).historyMedia[0]!;
    expect(historyMediaIdempotencyKey(m, 1)).not.toBe(historyMediaIdempotencyKey(m, 2));
  });

  it('convive con `value.history[]` en el MISMO cambio (Meta puede mandar los dos)', () => {
    const r = parseMetaWebhookPayload(
      cambio('history', {
        metadata,
        history: [{ metadata: { phase: 0, chunk_order: 1, progress: 50 }, threads: [{ id: CLIENTE, messages: [{ id: 'wamid.H1', from: CLIENTE, type: 'text', text: { body: 'hola' } }] }] }],
        messages: [{ id: 'wamid.HM1', type: 'image', image: { id: 'MEDIA_1' } }],
      }),
    );
    expect(r.historyChunks).toHaveLength(1);
    expect(r.historyMedia).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2) «No compartió»: `errors[0].code = 2593109`, y SIN envelope
// ---------------------------------------------------------------------------

describe('el desenlace «el negocio no compartió el historial»', () => {
  const chunkConError = {
    metadata: { phase: 0, chunk_order: 0, progress: 0 },
    errors: [{ code: HISTORY_NOT_SHARED_CODE, title: 'Business did not share history', message: 'not shared' }],
  };

  it('CON envelope: `chunk.errors` se lee (hoy se ignora entero)', () => {
    const r = parseMetaWebhookPayload(cambio('history', { metadata, history: [chunkConError] }));
    expect(r.historyChunks).toHaveLength(1);
    expect(r.historyChunks[0]!.errors.map((e) => e.code)).toEqual([HISTORY_NOT_SHARED_CODE]);
    expect(esHistorialNoCompartido(r.historyChunks[0]!)).toBe(true);
  });

  it('SIN envelope `object`/`entry`/`changes`: hoy se pierde entero antes del router', () => {
    const r = parseMetaWebhookPayload({ metadata, history: [chunkConError] });
    expect(r.historyChunks).toHaveLength(1);
    expect(r.historyChunks[0]!.externalId).toBe(PNID);
    expect(esHistorialNoCompartido(r.historyChunks[0]!)).toBe(true);
  });

  it('SIN envelope pero envuelto en `value` (Meta se contradice entre páginas): también', () => {
    const r = parseMetaWebhookPayload({ field: 'history', value: { metadata, history: [chunkConError] } });
    expect(r.historyChunks).toHaveLength(1);
    expect(esHistorialNoCompartido(r.historyChunks[0]!)).toBe(true);
  });

  it('un chunk NORMAL no se confunde con un rechazo', () => {
    const r = parseMetaWebhookPayload(
      cambio('history', { metadata, history: [{ metadata: { phase: 0, chunk_order: 1, progress: 50 }, threads: [{ id: CLIENTE, messages: [] }] }] }),
    );
    expect(r.historyChunks[0]!.errors).toEqual([]);
    expect(esHistorialNoCompartido(r.historyChunks[0]!)).toBe(false);
  });

  it('un payload cualquiera SIN envelope y SIN historial sigue devolviendo vacío', () => {
    expect(parseMetaWebhookPayload({ hola: 'mundo' }).historyChunks).toEqual([]);
    expect(parseMetaWebhookPayload({ object: 'otra_cosa', entry: [] }).historyChunks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3) account_update: el ciclo de desconexión (ADR-0017 §6)
// ---------------------------------------------------------------------------

describe('account_update — Meta desconecta el número solo y hay que enterarse', () => {
  const evento = (event: string, value: Record<string, unknown> = {}) =>
    cambio('account_update', { metadata, event, ...value });

  it('ACCOUNT_OFFBOARDED se normaliza (hoy cae en `unknownFields` y no ejecuta nada)', () => {
    const r = parseMetaWebhookPayload(evento('ACCOUNT_OFFBOARDED'));
    expect(r.accountUpdates).toHaveLength(1);
    expect(r.accountUpdates[0]!.event).toBe('ACCOUNT_OFFBOARDED');
    expect(r.accountUpdates[0]!.externalId).toBe(PNID);
    expect(r.accountUpdates[0]!.wabaId).toBe(WABA);
    expect(r.unknownFields).toEqual([]);
  });

  it('PARTNER_REMOVED y ACCOUNT_RECONNECTED también', () => {
    expect(parseMetaWebhookPayload(evento('PARTNER_REMOVED')).accountUpdates[0]!.event).toBe('PARTNER_REMOVED');
    expect(parseMetaWebhookPayload(evento('ACCOUNT_RECONNECTED')).accountUpdates[0]!.event).toBe('ACCOUNT_RECONNECTED');
  });

  it('un evento que este despliegue no conoce NO se degrada a uno conocido', () => {
    const r = parseMetaWebhookPayload(evento('ALGO_NUEVO_DE_META'));
    expect(r.accountUpdates[0]!.event).toBe('unknown');
  });

  it('sin `phone_number_id` el PNID queda vacío: no se adivina a quién degradar', () => {
    const r = parseMetaWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [{ id: WABA, changes: [{ field: 'account_update', value: { event: 'ACCOUNT_OFFBOARDED', phone_number: NEGOCIO } }] }],
    });
    expect(r.accountUpdates).toHaveLength(1);
    expect(r.accountUpdates[0]!.externalId).toBe('');
  });

  it('un account_update no produce mensajes ni echoes', () => {
    const r = parseMetaWebhookPayload(evento('ACCOUNT_OFFBOARDED'));
    expect(r.messages).toEqual([]);
    expect(r.echoes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4) 131060: esperado tras el onboarding, no una falla
// ---------------------------------------------------------------------------

describe('errores del canal `messages` — 131060 es ESPERADO tras el onboarding', () => {
  it('los errores a nivel del cambio se exponen (hoy son invisibles)', () => {
    const r = parseMetaWebhookPayload(cambio('messages', { metadata, errors: [{ code: 131060, title: 'Unsupported message type' }] }));
    expect(r.messageErrors.map((e) => e.code)).toEqual([131060]);
    expect(r.messageErrors[0]!.expected).toBe(true);
  });

  it('los errores de un mensaje `unsupported` también', () => {
    const r = parseMetaWebhookPayload(
      cambio('messages', { metadata, messages: [{ id: 'wamid.U1', from: CLIENTE, type: 'unsupported', errors: [{ code: 131060, title: 'Unsupported' }] }] }),
    );
    expect(r.messageErrors.map((e) => e.code)).toEqual([131060]);
    expect(r.messageErrors[0]!.expected).toBe(true);
  });

  it('cualquier OTRO código NO es esperado: no se esconde', () => {
    const r = parseMetaWebhookPayload(cambio('messages', { metadata, errors: [{ code: 131000, title: 'Something failed' }] }));
    expect(r.messageErrors[0]!.expected).toBe(false);
  });

  it('131060 está declarado como esperado y 2593109 no es un error de canal', () => {
    expect(COEXISTENCE_EXPECTED_ERROR_CODES).toContain(131060);
    expect(COEXISTENCE_EXPECTED_ERROR_CODES).not.toContain(HISTORY_NOT_SHARED_CODE);
  });

  it('SIN REGRESIÓN: un `messages` normal sigue produciendo su inbound y ningún error', () => {
    const r = parseMetaWebhookPayload(cambio('messages', { metadata, messages: [{ from: CLIENTE, id: 'wamid.M1', timestamp: '1754200000', type: 'text', text: { body: 'hola' } }] }));
    expect(r.messages).toHaveLength(1);
    expect(r.messageErrors).toEqual([]);
  });
});
