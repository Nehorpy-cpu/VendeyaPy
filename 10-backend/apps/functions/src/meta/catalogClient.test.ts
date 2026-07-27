import { describe, it, expect, vi } from 'vitest';

/**
 * META-CATALOG-LIVE-1 — HttpMetaCatalogClient con transporte y sleep INYECTADOS:
 * retry/backoff SOLO para 429/5xx/red (respetando Retry-After con techo), 4xx sin
 * retry, token SIEMPRE por header (nunca URL, logs ni mensajes de error).
 */
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { HttpMetaCatalogClient, MetaCatalogApiError, type CatalogHttpResponse } from './catalogClient.js';
import { logger } from '../lib/logger.js';

const TOKEN = 'EAAB-super-secreto-jamas-en-logs';

/** Transporte de mentira: devuelve las respuestas en orden y registra cada request. */
function makeTransport(responses: Array<CatalogHttpResponse | Error>) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; data?: unknown }> = [];
  const transport = async (req: { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; data?: unknown; timeoutMs: number }) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers, data: req.data });
    const next = responses.shift();
    if (!next) throw new Error('transport agotado');
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls };
}

const ok = (data: unknown): CatalogHttpResponse => ({ status: 200, headers: {}, data });
const fbError = (status: number, code: number, message: string, headers: Record<string, unknown> = {}): CatalogHttpResponse => ({
  status,
  headers,
  data: { error: { message, code } },
});

function client(responses: Array<CatalogHttpResponse | Error>, waits: number[] = []) {
  const { transport, calls } = makeTransport(responses);
  const c = new HttpMetaCatalogClient(TOKEN, {
    version: 'v23.0',
    transport,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { c, calls };
}

describe('HttpMetaCatalogClient — transporte y saneamiento', () => {
  it('el token viaja por header Authorization y JAMÁS en la URL', async () => {
    const { c, calls } = client([ok({ id: '111', name: 'Cat' })]);
    await c.getCatalog('111');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].url).not.toContain(TOKEN);
    expect(calls[0].url).toBe('https://graph.facebook.com/v23.0/111?fields=id,name');
  });

  it('la versión del Graph API es configurable por opción (sin tocar la global v19.0)', async () => {
    const { transport, calls } = makeTransport([ok({ id: '1', name: '' })]);
    const c = new HttpMetaCatalogClient(TOKEN, { version: 'v24.0', transport, sleep: async () => {} });
    await c.getCatalog('1');
    expect(calls[0].url.startsWith('https://graph.facebook.com/v24.0/')).toBe(true);
  });

  it('4xx funcional (permiso/campo/catálogo): NO reintenta y lanza error estructurado', async () => {
    const { c, calls } = client([fbError(400, 100, 'Unsupported get request')]);
    const err = await c.getCatalog('999').catch((e) => e);
    expect(err).toBeInstanceOf(MetaCatalogApiError);
    expect(err.status).toBe(400);
    expect(err.fbCode).toBe(100);
    expect(err.retriable).toBe(false);
    expect(calls.length).toBe(1); // sin retry
  });

  it('429 respeta Retry-After y luego sigue', async () => {
    const waits: number[] = [];
    const { c, calls } = client([fbError(429, 80014, 'rate limit', { 'retry-after': '3' }), ok({ id: '1', name: 'Cat' })], waits);
    const cat = await c.getCatalog('1');
    expect(cat.name).toBe('Cat');
    expect(calls.length).toBe(2);
    expect(waits).toEqual([3000]);
  });

  it('Retry-After absurdo queda topeado en 15s', async () => {
    const waits: number[] = [];
    const { c } = client([fbError(429, 80014, 'rate limit', { 'retry-after': '9999' }), ok({ id: '1', name: '' })], waits);
    await c.getCatalog('1');
    expect(waits).toEqual([15000]);
  });

  it('5xx reintenta con backoff exponencial y agota en 3 intentos con error retriable', async () => {
    const waits: number[] = [];
    const { c, calls } = client([fbError(500, 1, 'boom'), fbError(502, 1, 'boom'), fbError(503, 1, 'boom')], waits);
    const err = await c.getCatalog('1').catch((e) => e);
    expect(err).toBeInstanceOf(MetaCatalogApiError);
    expect(err.retriable).toBe(true);
    expect(calls.length).toBe(3);
    expect(waits).toEqual([400, 800]); // backoff 400ms * 2^(n-1)
  });

  it('error de red/timeout reintenta y agota como retriable', async () => {
    const { c, calls } = client([new Error('ECONNRESET'), new Error('timeout'), new Error('timeout')]);
    const err = await c.getCatalog('1').catch((e) => e);
    expect(err).toBeInstanceOf(MetaCatalogApiError);
    expect(err.retriable).toBe(true);
    expect(calls.length).toBe(3);
  });

  it('ni los mensajes de error ni los logs contienen el token', async () => {
    const { c } = client([fbError(500, 1, 'boom'), fbError(500, 1, 'boom'), fbError(500, 1, 'boom')]);
    const err = await c.getCatalog('1').catch((e) => e as Error);
    expect(err.message).not.toContain(TOKEN);
    const warnCalls = vi.mocked(logger.warn).mock.calls.flat();
    expect(JSON.stringify(warnCalls)).not.toContain(TOKEN);
  });

  it('listItems pagina con paging.next hasta agotar', async () => {
    const { c, calls } = client([
      ok({ data: [{ id: 'i1', retailer_id: 'SKU-A', name: 'A', price: '₲1.000' }], paging: { next: 'https://graph.facebook.com/v23.0/1/products?after=x' } }),
      ok({ data: [{ id: 'i2', retailer_id: 'SKU-B', name: 'B', price: '₲2.000' }] }),
    ]);
    const items = await c.listItems('1');
    expect(items.map((i) => i.retailerId)).toEqual(['SKU-A', 'SKU-B']);
    expect(calls[1].url).toContain('after=x'); // sigue el cursor que devolvió Meta
  });

  it('cursor de paginación con host ajeno ⇒ aborta SIN llamarlo (el Bearer no sale del Graph)', async () => {
    const { c, calls } = client([ok({ data: [], paging: { next: 'https://evil.example/steal' } })]);
    const err = await c.listItems('1').catch((e) => e);
    expect(err).toBeInstanceOf(MetaCatalogApiError);
    expect(calls.length).toBe(1); // jamás siguió el cursor sospechoso
  });

  it('catálogo que supera el tope de páginas ⇒ error FAIL-CLOSED (sin plan parcial)', async () => {
    const pages = Array.from({ length: 50 }, (_, i) =>
      ok({ data: [{ id: `i${i}`, retailer_id: `S${i}` }], paging: { next: `https://graph.facebook.com/v23.0/1/products?after=${i}` } }),
    );
    const { c } = client(pages);
    const err = await c.listItems('1').catch((e) => e);
    expect(err).toBeInstanceOf(MetaCatalogApiError);
    expect((err as Error).message).toContain('tope');
  });

  it('getCatalog tolera body vacío en 2xx', async () => {
    const { c } = client([{ status: 200, headers: {}, data: null }]);
    const cat = await c.getCatalog('77');
    expect(cat.id).toBe('77');
  });

  it('getBatchStatus parsea errores por item de forma defensiva', async () => {
    const { c, calls } = client([ok({ data: [{ handle: 'h1', errors: [{ retailer_id: 'SKU-A', message: 'imagen inaccesible' }, { bogus: true }] }] })]);
    const st = await c.getBatchStatus('42', 'h1');
    expect(calls[0].url).toBe('https://graph.facebook.com/v23.0/42/check_batch_request_status?handle=h1');
    expect(st.errors[0]).toEqual({ retailerId: 'SKU-A', message: 'imagen inaccesible' });
    expect(st.errors[1].retailerId).toBe(''); // entrada malformada no rompe
  });

  it('submitItemsBatch postea item_type + allow_upsert EXPLÍCITO + requests, y devuelve handles', async () => {
    const { c, calls } = client([ok({ handles: ['h1'] })]);
    const req = { method: 'UPDATE' as const, data: { id: 'SKU-A', price: '1000 PYG' } };
    const res = await c.submitItemsBatch('42', [req]);
    expect(res.handles).toEqual(['h1']);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://graph.facebook.com/v23.0/42/items_batch');
    expect(calls[0].data).toEqual({
      item_type: 'PRODUCT_ITEM',
      // El default de Meta es true: lo apagamos para que un UPDATE nunca cree por accidente.
      allow_upsert: false,
      requests: [req],
    });
  });
});
