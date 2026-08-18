import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { logger } from '../lib/logger.js';

import { uploadWhatsappMedia, type FetchLike } from './mediaClient.js';

const TOKEN = 'tok-super-secreto-9999';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8');
const EXE = Buffer.concat([Buffer.from('MZ', 'ascii'), Buffer.alloc(64)]);

const okResponse = (id: unknown = 'MEDIA-OK-1') =>
  ({ ok: true, status: 200, json: async () => ({ id }) }) as unknown as Response;
const errResponse = (status: number) =>
  ({ ok: false, status, body: null, json: async () => ({}) }) as unknown as Response;

beforeEach(() => vi.clearAllMocks());

describe('meta/mediaClient uploadWhatsappMedia (ADR-0021 §5 — POST /{pnid}/media)', () => {
  it('sube multipart con el MIME verificado y devuelve el media id', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/pn-123/media');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get('messaging_product')).toBe('whatsapp');
      expect(form.get('type')).toBe('image/jpeg');
      const file = form.get('file') as Blob;
      expect(file).toBeInstanceOf(Blob);
      expect(file.type).toBe('image/jpeg');
      expect(file.size).toBe(JPEG.length);
      return okResponse();
    }) as unknown as FetchLike;
    const r = await uploadWhatsappMedia({
      phoneNumberId: 'pn-123',
      accessToken: TOKEN,
      buffer: JPEG,
      mimeType: 'image/jpeg',
      filename: 'foto.jpg',
      fetchImpl,
    });
    expect(r).toEqual({ ok: true, mediaId: 'MEDIA-OK-1' });
  });

  it('PDF: type application/pdf y filename saneado', async () => {
    const fetchImpl = vi.fn(async () => okResponse('MEDIA-PDF')) as unknown as FetchLike;
    const r = await uploadWhatsappMedia({
      phoneNumberId: 'pn-1',
      accessToken: TOKEN,
      buffer: PDF,
      mimeType: 'application/pdf',
      filename: 'lista.pdf',
      fetchImpl,
    });
    expect(r).toEqual({ ok: true, mediaId: 'MEDIA-PDF' });
  });

  it('MIME declarado ≠ magic bytes ⇒ rejected SIN tocar la red', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    const r = await uploadWhatsappMedia({
      phoneNumberId: 'pn-1',
      accessToken: TOKEN,
      buffer: EXE,
      mimeType: 'image/png',
      fetchImpl,
    });
    expect(r).toMatchObject({ ok: false, outcome: 'rejected' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('oversize ⇒ rejected SIN tocar la red', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    const r = await uploadWhatsappMedia({
      phoneNumberId: 'pn-1',
      accessToken: TOKEN,
      buffer: JPEG,
      mimeType: 'image/jpeg',
      maxBytes: 8,
      fetchImpl,
    });
    expect(r).toMatchObject({ ok: false, outcome: 'rejected' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('4xx de Graph ⇒ rejected (rechazo CONFIRMADO, reintento seguro para el caller)', async () => {
    const fetchImpl = vi.fn(async () => errResponse(400)) as unknown as FetchLike;
    const r = await uploadWhatsappMedia({ phoneNumberId: 'pn-1', accessToken: TOKEN, buffer: JPEG, mimeType: 'image/jpeg', fetchImpl });
    expect(r).toMatchObject({ ok: false, outcome: 'rejected' });
  });

  it('5xx ⇒ unknown; excepción de red/timeout ⇒ unknown', async () => {
    const cincoxx = vi.fn(async () => errResponse(503)) as unknown as FetchLike;
    expect(await uploadWhatsappMedia({ phoneNumberId: 'pn-1', accessToken: TOKEN, buffer: JPEG, mimeType: 'image/jpeg', fetchImpl: cincoxx }))
      .toMatchObject({ ok: false, outcome: 'unknown' });
    const red = vi.fn(async () => { throw new Error('socket reset'); }) as unknown as FetchLike;
    expect(await uploadWhatsappMedia({ phoneNumberId: 'pn-1', accessToken: TOKEN, buffer: JPEG, mimeType: 'image/jpeg', fetchImpl: red }))
      .toMatchObject({ ok: false, outcome: 'unknown' });
  });

  it('2xx sin id ⇒ unknown (no se inventa un media id)', async () => {
    const fetchImpl = vi.fn(async () => okResponse(null)) as unknown as FetchLike;
    const r = await uploadWhatsappMedia({ phoneNumberId: 'pn-1', accessToken: TOKEN, buffer: JPEG, mimeType: 'image/jpeg', fetchImpl });
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
  });

  it('el token JAMÁS aparece en detail ni en logs', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`falló con ${TOKEN}`); }) as unknown as FetchLike;
    const r = await uploadWhatsappMedia({ phoneNumberId: 'pn-1', accessToken: TOKEN, buffer: JPEG, mimeType: 'image/jpeg', fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).not.toContain(TOKEN);
    const todo = JSON.stringify([vi.mocked(logger.info).mock.calls, vi.mocked(logger.warn).mock.calls, vi.mocked(logger.error).mock.calls]);
    expect(todo).not.toContain(TOKEN);
  });
});
