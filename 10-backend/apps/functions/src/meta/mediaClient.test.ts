import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { downloadWhatsappAttachment, type FetchLike } from './mediaClient.js';

/**
 * ADR-0016 — Descarga endurecida. Lo que se prueba acá es lo que la auditoría encontró roto:
 * el MIME declarado por Graph se creía a ojos cerrados y el archivo se materializaba entero antes
 * de medirlo. Ninguno de estos tests toca la red.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x41, 0x42]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n', 'utf8'), Buffer.alloc(64, 0x41)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');

interface FakeStream {
  response: Response;
  /** Cuántos chunks se llegaron a pedir realmente (prueba que el stream se corta). */
  pedidos: () => number;
  cancelado: () => boolean;
}

function streamOf(chunks: Buffer[], headers: Record<string, string> = {}): FakeStream {
  let i = 0;
  let cancelado = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(new Uint8Array(chunks[i++] as Buffer));
      else controller.close();
    },
    cancel() {
      cancelado = true;
    },
  });
  const response = {
    ok: true,
    status: 200,
    body: stream,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
  return { response, pedidos: () => i, cancelado: () => cancelado };
}

const metaResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } }) as unknown as Response;

/** fetch falso: primera llamada = metadata, segunda = contenido. */
function fakeFetch(meta: Response | (() => Response), contenido?: Response | (() => Response)): { fn: FetchLike; calls: () => number } {
  let calls = 0;
  const fn: FetchLike = async (url) => {
    calls += 1;
    const esMeta = url.includes('graph.facebook.com');
    const target = esMeta ? meta : contenido;
    if (!target) throw new Error('sin respuesta configurada');
    return typeof target === 'function' ? target() : target;
  };
  return { fn, calls: () => calls };
}

const OPTS = { mediaId: 'M1', accessToken: 'tok', retryDelayMs: 0 };

describe('mediaClient — descarga endurecida (ADR-0016)', () => {
  it('imagen válida: contentType VERIFICADO, bytes medidos y checksum del contenido', async () => {
    const bin = streamOf([JPEG]);
    const { fn } = fakeFetch(metaResponse({ url: 'https://lookaside/x', mime_type: 'image/jpeg', file_size: JPEG.length }), bin.response);
    const r = await downloadWhatsappAttachment({ ...OPTS, fetchImpl: fn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verifiedMime).toBe('image/jpeg');
    expect(r.declaredMime).toBe('image/jpeg');
    expect(r.bytes).toBe(JPEG.length);
    expect(r.checksum).toBe(createHash('sha256').update(JPEG).digest('hex'));
  });

  it('PDF (comprobante de app bancaria) se descarga y verifica como application/pdf', async () => {
    const bin = streamOf([PDF.subarray(0, 5), PDF.subarray(5)]);
    const { fn } = fakeFetch(metaResponse({ url: 'https://lookaside/x', mime_type: 'application/pdf', file_size: PDF.length }), bin.response);
    const r = await downloadWhatsappAttachment({ ...OPTS, fetchImpl: fn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verifiedMime).toBe('application/pdf');
    expect(r.bytes).toBe(PDF.length);
  });

  it('MIME FALSO (declara imagen, el contenido es HTML) → rechazo apenas se leen los primeros bytes', async () => {
    // Varios chunks: el rechazo tiene que ocurrir con el PRIMERO, sin bajar el resto.
    const chunks = [HTML, ...Array.from({ length: 4 }, () => Buffer.alloc(512, 0x41))];
    const bin = streamOf(chunks);
    const { fn } = fakeFetch(metaResponse({ url: 'https://lookaside/x', mime_type: 'image/jpeg' }), bin.response);
    const r = await downloadWhatsappAttachment({ ...OPTS, fetchImpl: fn });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unsupported_type');
    expect(bin.pedidos()).toBeLessThan(chunks.length); // se corta la conexión, no se termina de bajar
    expect(bin.cancelado()).toBe(true);
  });

  it('MIME que MIENTE hacia adentro de la whitelist (dice PDF, es JPEG) → mime_mismatch', async () => {
    const bin = streamOf([JPEG]);
    const { fn } = fakeFetch(metaResponse({ url: 'https://lookaside/x', mime_type: 'application/pdf', file_size: JPEG.length }), bin.response);
    const r = await downloadWhatsappAttachment({ ...OPTS, fetchImpl: fn });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('mime_mismatch');
  });

  it('alias tolerado del lado declarado (image/jpg) NO se considera discrepancia', async () => {
    const bin = streamOf([JPEG]);
    const { fn } = fakeFetch(metaResponse({ url: 'https://lookaside/x', mime_type: 'image/jpg' }), bin.response);
    const r = await downloadWhatsappAttachment({ ...OPTS, fetchImpl: fn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verifiedMime).toBe('image/jpeg');
  });

  it('OVERSIZE: se corta DURANTE el stream — no se materializa el archivo entero', async () => {
    // 10 chunks de 1 KB con tope de 2 KB: si midiera al final, pediría los 10.
    const chunks = Array.from({ length: 10 }, (_, i) => (i === 0 ? Buffer.concat([JPEG, Buffer.alloc(1010, 0x41)]) : Buffer.alloc(1024, 0x41)));
    const bin = streamOf(chunks);
    const { fn } = fakeFetch(metaResponse({ url: 'https://lookaside/x', mime_type: 'image/jpeg' }), bin.response);
    const r = await downloadWhatsappAttachment({ ...OPTS, maxBytes: 2048, fetchImpl: fn });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('too_large');
    expect(bin.pedidos()).toBeLessThan(chunks.length);
    expect(bin.cancelado()).toBe(true);
  });

  it('tamaño declarado sobre el tope → ni se pide el contenido', async () => {
    const { fn, calls } = fakeFetch(metaResponse({ url: 'https://lookaside/x', mime_type: 'image/jpeg', file_size: 99_000_000 }));
    const r = await downloadWhatsappAttachment({ ...OPTS, maxBytes: 1024, fetchImpl: fn });
    expect(r).toMatchObject({ ok: false, reason: 'too_large' });
    expect(calls()).toBe(1);
  });

  it('content-length que ya se pasa del tope → corta antes de leer un solo byte', async () => {
    const bin = streamOf([JPEG], { 'content-length': '999999' });
    const { fn } = fakeFetch(metaResponse({ url: 'https://lookaside/x', mime_type: 'image/jpeg' }), bin.response);
    const r = await downloadWhatsappAttachment({ ...OPTS, maxBytes: 1024, fetchImpl: fn });
    expect(r).toMatchObject({ ok: false, reason: 'too_large' });
    expect(bin.cancelado()).toBe(true); // cuerpo cancelado: el socket no queda colgado
  });

  it('tipo declarado fuera de la whitelist → rechazo temprano, sin descargar', async () => {
    const { fn, calls } = fakeFetch(metaResponse({ url: 'https://lookaside/x', mime_type: 'audio/ogg' }));
    const r = await downloadWhatsappAttachment({ ...OPTS, fetchImpl: fn });
    expect(r).toMatchObject({ ok: false, reason: 'unsupported_type' });
    expect(calls()).toBe(1);
  });

  it('5xx de Graph: reintenta ACOTADO (1 intento + 2 reintentos) y después se rinde', async () => {
    const { fn, calls } = fakeFetch(() => metaResponse({}, 503));
    const r = await downloadWhatsappAttachment({ ...OPTS, fetchImpl: fn });
    expect(r).toMatchObject({ ok: false, reason: 'fetch_failed' });
    expect(calls()).toBe(3);
  });

  it('5xx transitorio: el reintento SALVA la descarga', async () => {
    let n = 0;
    const bin = streamOf([JPEG]);
    const { fn } = fakeFetch(() => {
      n += 1;
      return n === 1 ? metaResponse({}, 500) : metaResponse({ url: 'https://lookaside/x', mime_type: 'image/jpeg' });
    }, bin.response);
    const r = await downloadWhatsappAttachment({ ...OPTS, fetchImpl: fn });
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
  });

  it('4xx NO se reintenta (un token vencido no se arregla insistiendo)', async () => {
    const { fn, calls } = fakeFetch(() => metaResponse({}, 401));
    const r = await downloadWhatsappAttachment({ ...OPTS, fetchImpl: fn });
    expect(r).toMatchObject({ ok: false, reason: 'fetch_failed' });
    expect(calls()).toBe(1);
  });

  it('timeout/red: se reintenta y el detalle sale SANEADO (sin URLs ni dígitos largos)', async () => {
    const fn = vi.fn(async () => {
      throw new Error('conexión a https://lookaside.fbsbx.com/abc rechazada para 595991234567');
    }) as unknown as FetchLike;
    const r = await downloadWhatsappAttachment({ ...OPTS, fetchImpl: fn });
    expect(r).toMatchObject({ ok: false, reason: 'fetch_failed' });
    if (r.ok) return;
    expect(r.detail).not.toContain('lookaside');
    expect(r.detail).not.toContain('595991234567');
    expect((fn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(3);
  });

  it('respuesta sin cuerpo legible → fetch_failed (no se cae a arrayBuffer)', async () => {
    const sinBody = { ok: true, status: 200, body: null, headers: { get: () => null } } as unknown as Response;
    const { fn } = fakeFetch(metaResponse({ url: 'https://lookaside/x', mime_type: 'image/jpeg' }), sinBody);
    const r = await downloadWhatsappAttachment({ ...OPTS, fetchImpl: fn });
    expect(r).toMatchObject({ ok: false, reason: 'fetch_failed' });
  });

  /**
   * A4 — el wrapper LEGACY (`downloadWhatsappMedia`) y `extensionForMime` se BORRARON junto con
   * `orders/comprobanteImage.ts`: quedaron sin ningún consumidor de producción. Este test lo ata,
   * para que nadie los reviva sin darse cuenta de que serían una segunda puerta de descarga —sin
   * los límites por tenant de ADR-0016 §8— que ya nadie mantiene.
   */
  it('no quedó ninguna puerta de descarga LEGACY exportada', async () => {
    const mod = await import('./mediaClient.js');
    expect(Object.keys(mod)).not.toContain('downloadWhatsappMedia');
    expect(Object.keys(mod)).not.toContain('extensionForMime');
  });
});
