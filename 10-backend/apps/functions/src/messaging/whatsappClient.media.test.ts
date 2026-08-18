import { describe, it, expect, beforeEach, vi } from 'vitest';
// Logger espiado (mismo patrón que whatsappClient.test.ts): verificamos enmascarado, no ruido.
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { logger } from '../lib/logger.js';

// axios mockeado SOLO acá: CloudAPIClient.sendImage/sendDocument comparten la clasificación
// tipada de sendText (classifyCloudSendError / sendResultFromCloudResponse) y este archivo
// prueba que el cableado nuevo pasa por ella de verdad.
vi.mock('axios', () => {
  const post = vi.fn();
  return {
    default: {
      post,
      isAxiosError: (e: unknown) => (e as { isAxiosError?: boolean } | null)?.isAxiosError === true,
    },
  };
});
import axios from 'axios';

import {
  MockWhatsAppClient,
  BlockedChannelClient,
  CloudAPIClient,
  buildCloudApiImageBody,
  buildCloudApiDocumentBody,
} from './whatsappClient.js';

const TO = '595994893000';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.FUNCTIONS_EMULATOR;
});

describe('ADR-0021 §5 — builders puros de media saliente', () => {
  it('buildCloudApiImageBody arma el payload oficial con id de media (sin caption si no hay)', () => {
    expect(buildCloudApiImageBody(TO, { mediaId: 'MEDIA-1' })).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'image',
      image: { id: 'MEDIA-1' },
    });
  });

  it('buildCloudApiImageBody incluye caption solo cuando viene', () => {
    expect(buildCloudApiImageBody(TO, { mediaId: 'M', caption: 'mirá 🌸' })).toMatchObject({
      image: { id: 'M', caption: 'mirá 🌸' },
    });
  });

  it('buildCloudApiDocumentBody lleva filename (obligatorio) y caption opcional', () => {
    expect(buildCloudApiDocumentBody(TO, { mediaId: 'D-1', filename: 'lista.pdf' })).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'document',
      document: { id: 'D-1', filename: 'lista.pdf' },
    });
    expect(buildCloudApiDocumentBody(TO, { mediaId: 'D-1', filename: 'lista.pdf', caption: 'catálogo' })).toMatchObject({
      document: { id: 'D-1', filename: 'lista.pdf', caption: 'catálogo' },
    });
  });
});

describe('MockWhatsAppClient — media sin red (misma semántica viaMock que sendText)', () => {
  it('sendImage: ok/viaMock/outcome mock con id determinístico y CERO llamadas a axios', async () => {
    const c = new MockWhatsAppClient({ mode: 'mock' });
    const r1 = await c.sendImage(TO, { mediaId: 'M1', caption: 'hola' }, { tenantId: 'arfagi' });
    const r2 = await c.sendImage(TO, { mediaId: 'M1' }, { tenantId: 'arfagi' });
    expect(r1).toMatchObject({ ok: true, outcome: 'mock', viaMock: true });
    if (r1.ok && r2.ok) expect(r1.id).toBe(r2.id); // determinístico por (to, kind, mediaId)
    expect(vi.mocked(axios.post)).not.toHaveBeenCalled();
  });

  it('sendDocument: ok/viaMock sin red y sin filtrar el teléfono en logs', async () => {
    const c = new MockWhatsAppClient({ mode: 'mock' });
    const r = await c.sendDocument(TO, { mediaId: 'D1', filename: 'lista.pdf' }, { tenantId: 'arfagi' });
    expect(r).toMatchObject({ ok: true, outcome: 'mock', viaMock: true });
    expect(vi.mocked(axios.post)).not.toHaveBeenCalled();
    const infos = JSON.stringify(vi.mocked(logger.info).mock.calls);
    expect(infos).not.toContain(TO);
  });
});

describe('BlockedChannelClient — un canal sin permiso tampoco manda media (ADR-0017 §1)', () => {
  it('sendImage y sendDocument devuelven blocked con el motivo saneado, sin red', async () => {
    const c = new BlockedChannelClient({ mode: 'live', phoneNumberId: 'pn-1', reason: 'automation_shadow' }, 'automation_shadow');
    const img = await c.sendImage(TO, { mediaId: 'M1' }, { tenantId: 'arfagi' });
    const doc = await c.sendDocument(TO, { mediaId: 'D1', filename: 'x.pdf' }, { tenantId: 'arfagi' });
    expect(img).toEqual({ ok: false, outcome: 'blocked', reason: 'automation_shadow' });
    expect(doc).toEqual({ ok: false, outcome: 'blocked', reason: 'automation_shadow' });
    expect(vi.mocked(axios.post)).not.toHaveBeenCalled();
    // El bloqueo deja rastro (warn) con teléfono enmascarado.
    const warns = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(warns).toContain('automation_shadow');
    expect(warns).not.toContain(TO);
  });
});

describe('CloudAPIClient — media por la Cloud API con la clasificación tipada compartida', () => {
  it('2xx con wamid ⇒ accepted (mismo contrato que sendText)', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.IMG-1' }] } });
    const c = new CloudAPIClient('pn-1', 'tok-secreto');
    const r = await c.sendImage(TO, { mediaId: 'M1', caption: 'hola' }, { tenantId: 'arfagi' });
    expect(r).toEqual({ ok: true, outcome: 'accepted', id: 'wamid.IMG-1', viaMock: false });
    const [url, body] = vi.mocked(axios.post).mock.calls[0]!;
    expect(String(url)).toContain('/pn-1/messages');
    expect(body).toMatchObject({ type: 'image', image: { id: 'M1', caption: 'hola' } });
  });

  it('2xx SIN wamid ⇒ unknown (jamás se inventa un accepted)', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { messages: [] } });
    const c = new CloudAPIClient('pn-1', 'tok');
    const r = await c.sendDocument(TO, { mediaId: 'D1', filename: 'lista.pdf' }, { tenantId: 'arfagi' });
    expect(r).toEqual({ ok: false, outcome: 'unknown' });
  });

  it('4xx de Graph ⇒ rejected con providerCode saneado; el log enmascara el teléfono', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce({ isAxiosError: true, response: { status: 400, data: { error: { code: 131047 } } } });
    const c = new CloudAPIClient('pn-1', 'tok');
    const r = await c.sendImage(TO, { mediaId: 'M1' }, { tenantId: 'arfagi' });
    expect(r).toEqual({ ok: false, outcome: 'rejected', providerCode: 131047 });
    const errs = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(errs).not.toContain(TO);
  });

  it('timeout/red ⇒ unknown (el mensaje PUDO salir)', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('timeout'));
    const c = new CloudAPIClient('pn-1', 'tok');
    const r = await c.sendDocument(TO, { mediaId: 'D1', filename: 'x.pdf' }, { tenantId: 'arfagi' });
    expect(r).toEqual({ ok: false, outcome: 'unknown' });
  });
});
