/**
 * visionProducer.test.ts — productor de jobs de visión DESACOPLADO (AI-VISION-PRODUCER-DECOUPLE-1)
 * ================================================================================================
 * El productor ya no vive en process.ts: observa la transición durable del evento del inbox a
 * 'processed' (que el código productivo VIEJO también escribe, con tenantId sellado) y encola el
 * job releyendo la clasificación FINAL del doc del adjunto. Discriminador de reintento: al marcar
 * processed, process.ts anula payload.attachment.mediaId SOLO si el archivo quedó almacenado —
 * mediaId null + query vacía = transitorio (reintentar); mediaId presente = jamás se almacenó
 * (cerrar sin job, sin reintentos). Clasificación estricta: SOLO 'generic_media' produce job
 * ('unclassified' = el gate no decidió ⇒ fail-closed, review MEDIO 5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { producirVisionDesdeEvento, type VisionProducerDeps } from './visionProducer.js';

const T = 'tnt_prod';
const ATT = 'att_bbbbbbbbbbbbbbbbbbbbbbb1';
const PMID = 'pmid_bbbbbbbbbbbbbbbbbbbbbbbb';

const eventoBase = (over: Record<string, unknown> = {}) => ({
  id: 'whatsapp_wamid1',
  platform: 'whatsapp',
  kind: 'message',
  tenantId: T,
  externalId: '555000111',
  payload: { from: '0000p1', messageId: 'wamid1', attachment: { kind: 'image', mediaId: null, declaredMime: 'image/jpeg' } },
  processingStatus: 'processed',
  ...over,
});

const adjunto = (over: Record<string, unknown> = {}) => ({
  attachmentId: ATT, tenantId: T, customerId: '0000p1', messageId: PMID, channel: 'whatsapp',
  ingestState: 'stored', class: 'image', mime: { verified: 'image/jpeg' },
  classification: { value: 'generic_media' }, storage: { path: 'x' }, purgedAt: null, ...over,
});

function hacerDeps(over: Partial<VisionProducerDeps> = {}) {
  const encolados: Array<Record<string, unknown>> = [];
  const deps: VisionProducerDeps = {
    flagActivo: async () => true,
    hashMessageId: () => PMID,
    buscarAdjuntosPorMensaje: async () => [adjunto()],
    resolverSessionKey: async (_t, _p, _e) => 'active',
    encolar: async (p) => { encolados.push(p as unknown as Record<string, unknown>); return { encolado: true }; },
    ...over,
  };
  return { deps, encolados };
}

beforeEach(() => vi.clearAllMocks());

describe('la transición y los tipos de evento (casos 1, 6-9)', () => {
  it('1. imagen genérica procesada + flag ON ⇒ exactamente un job, con el tenant del doc SELLADO', async () => {
    const { deps, encolados } = hacerDeps();
    const r = await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase(), deps);
    expect(r.resultado).toBe('encolado');
    expect(encolados).toHaveLength(1);
    expect(encolados[0]).toMatchObject({ tenantId: T, attachmentId: ATT, customerId: '0000p1', receivedVia: '555000111', sessionKey: 'active' });
  });
  it('9. transición repetida (redelivery con before ya processed) ⇒ no-op', async () => {
    const { deps, encolados } = hacerDeps();
    const r = await producirVisionDesdeEvento(eventoBase(), eventoBase(), deps);
    expect(r.resultado).toBe('no_transicion');
    expect(encolados).toHaveLength(0);
  });
  it('8. evento failed/ignored/retrying ⇒ cero jobs', async () => {
    const { deps, encolados } = hacerDeps();
    for (const st of ['failed', 'ignored', 'processing', 'received']) {
      const r = await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase({ processingStatus: st }), deps);
      expect(r.resultado).toBe('no_transicion');
    }
    expect(encolados).toHaveLength(0);
  });
  it('6-7. texto, ubicación, PDF, echo y kind desconocido ⇒ cero jobs', async () => {
    const { deps, encolados } = hacerDeps();
    expect((await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase({ payload: { from: 'x', messageId: 'w', text: 'hola' } }), deps)).resultado).toBe('sin_adjunto');
    expect((await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase({ payload: { from: 'x', messageId: 'w', attachment: { kind: 'document', mediaId: null } } }), deps)).resultado).toBe('sin_adjunto');
    expect((await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase({ kind: 'echo' }), deps)).resultado).toBe('sin_adjunto');
    expect((await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase({ kind: 'unknown' }), deps)).resultado).toBe('sin_adjunto');
    expect((await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase({ platform: 'instagram' }), deps)).resultado).toBe('sin_adjunto');
    expect(encolados).toHaveLength(0);
  });
  it('kind AUSENTE (eventos del código productivo viejo) se trata como message y produce', async () => {
    const { deps, encolados } = hacerDeps();
    const ev = eventoBase(); delete (ev as Record<string, unknown>)['kind'];
    expect((await producirVisionDesdeEvento({ processingStatus: 'processing' }, ev, deps)).resultado).toBe('encolado');
    expect(encolados).toHaveLength(1);
  });
});

describe('gates fail-closed (casos 2-5, 12)', () => {
  it('2. flag OFF ⇒ cero jobs (y ni siquiera consulta adjuntos)', async () => {
    const busco = vi.fn(async () => [adjunto()]);
    const { deps, encolados } = hacerDeps({ flagActivo: async () => false, buscarAdjuntosPorMensaje: busco });
    const r = await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase(), deps);
    expect(r.resultado).toBe('flag_apagado');
    expect(encolados).toHaveLength(0);
    expect(busco).not.toHaveBeenCalled();
  });
  it('3-4. comprobante candidato o vinculado ⇒ cero jobs (precedencia absoluta)', async () => {
    for (const v of ['payment_receipt_candidate', 'payment_receipt_linked']) {
      const { deps, encolados } = hacerDeps({ buscarAdjuntosPorMensaje: async () => [adjunto({ classification: { value: v } })] });
      const r = await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase(), deps);
      expect(r.resultado).toBe('no_elegible');
      expect(encolados).toHaveLength(0);
    }
  });
  it('5. clasificación unclassified (gate lanzado o sin decisión terminal) ⇒ CERO job prematuro', async () => {
    const { deps, encolados } = hacerDeps({ buscarAdjuntosPorMensaje: async () => [adjunto({ classification: { value: 'unclassified' } })] });
    const r = await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase(), deps);
    expect(r.resultado).toBe('no_elegible');
    expect(encolados).toHaveLength(0);
  });
  it('12. tenant no resoluble (processed sin tenantId — no debería existir, pero fail-closed) ⇒ cero jobs', async () => {
    const { deps, encolados } = hacerDeps();
    const r = await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase({ tenantId: null }), deps);
    expect(r.resultado).toBe('sin_tenant');
    expect(encolados).toHaveLength(0);
  });
  it('sessionKey no resoluble ⇒ fail-closed sin job', async () => {
    const { deps, encolados } = hacerDeps({ resolverSessionKey: async () => null });
    const r = await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase(), deps);
    expect(r.resultado).toBe('no_elegible');
    expect(encolados).toHaveLength(0);
  });
});

describe('el discriminador de reintento (adjunto no visible, caso de carrera)', () => {
  it('mediaId NULL (el archivo SÍ se almacenó) + query vacía ⇒ reintentar (redelivery lo reevalúa)', async () => {
    const { deps, encolados } = hacerDeps({ buscarAdjuntosPorMensaje: async () => [] });
    const r = await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase(), deps);
    expect(r.resultado).toBe('reintentar');
    expect(encolados).toHaveLength(0);
  });
  it('mediaId PRESENTE (jamás se almacenó: rechazado/fallado/nivel A off) ⇒ cerrar sin job y sin reintentos', async () => {
    const { deps, encolados } = hacerDeps({ buscarAdjuntosPorMensaje: async () => [] });
    const ev = eventoBase({ payload: { from: '0000p1', messageId: 'wamid1', attachment: { kind: 'image', mediaId: 'MEDIA123', declaredMime: 'image/jpeg' } } });
    const r = await producirVisionDesdeEvento({ processingStatus: 'processing' }, ev, deps);
    expect(r.resultado).toBe('sin_adjunto');
    expect(encolados).toHaveLength(0);
  });
});

describe('idempotencia y aislamiento (casos 10-11, 13)', () => {
  it('10-11. job ya existente (encolar devuelve false) ⇒ no-op limpio', async () => {
    const { deps } = hacerDeps({ encolar: async () => ({ encolado: false }) });
    const r = await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase(), deps);
    expect(r.resultado).toBe('ya_existia');
  });
  it('error al crear el job ⇒ reintentar (redelivery), jamás tragado', async () => {
    const { deps } = hacerDeps({ encolar: async () => { throw new Error('firestore caído'); } });
    await expect(producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase(), deps)).rejects.toThrow();
  });
  it('13. el tenant del encolado es SIEMPRE el sellado en el doc del evento, jamás otro', async () => {
    const { deps, encolados } = hacerDeps({
      buscarAdjuntosPorMensaje: async () => [adjunto({ tenantId: 'OTRO_TENANT' })],
    });
    await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase(), deps);
    // El adjunto con tenant ajeno NO produce job para el tenant ajeno: el productor exige coincidencia.
    expect(encolados).toHaveLength(0);
  });
  it('varios adjuntos del MISMO mensaje: un job por adjunto elegible (imagen), documentos excluidos', async () => {
    const { deps, encolados } = hacerDeps({
      buscarAdjuntosPorMensaje: async () => [
        adjunto(),
        adjunto({ attachmentId: 'att_bbbbbbbbbbbbbbbbbbbbbbb2', class: 'document', mime: { verified: 'application/pdf' } }),
      ],
    });
    const r = await producirVisionDesdeEvento({ processingStatus: 'processing' }, eventoBase(), deps);
    expect(r.resultado).toBe('encolado');
    expect(encolados).toHaveLength(1);
  });
});
