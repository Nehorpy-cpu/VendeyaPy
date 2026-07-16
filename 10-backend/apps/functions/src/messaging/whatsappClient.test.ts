import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MockWhatsAppClient,
  CloudAPIClient,
  buildCloudApiTextBody,
  buildCloudApiLocationRequestBody,
  getWhatsAppClient,
  clearWhatsappClientCache,
  type WhatsappClientDeps,
} from './whatsappClient.js';
import type { WhatsappCredsResult } from './resolveWhatsappCreds.js';

const makeDeps = (mode: 'mock' | 'live', creds: WhatsappCredsResult): WhatsappClientDeps => ({
  getMode: async () => mode,
  resolveCreds: async () => creds,
});
const OK: WhatsappCredsResult = { ok: true, phoneNumberId: 'wa-595', accessToken: 'tok-abc', tokenExpiresAtMs: null };

describe('whatsappClient', () => {
  beforeEach(() => {
    delete process.env.FUNCTIONS_EMULATOR;
    delete process.env.ALLOW_GLOBAL_WHATSAPP_FALLBACK;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    clearWhatsappClientCache();
  });
  afterEach(() => {
    delete process.env.FUNCTIONS_EMULATOR;
    clearWhatsappClientCache();
  });

  it('MockWhatsAppClient no llama a Meta y responde ok', async () => {
    const r = await new MockWhatsAppClient().sendText('+595981111111', 'hola', { tenantId: 'perfumeria' });
    expect(r.ok).toBe(true);
    expect(r.viaMock).toBe(true);
  });

  it('COVERAGE-1B: Mock sendLocationRequest no llama a Meta, resultado tipado ok/viaMock', async () => {
    const r = await new MockWhatsAppClient().sendLocationRequest('+595981111111', 'compartí tu ubicación', { tenantId: 'perfumeria' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.viaMock).toBe(true);
  });

  it('COVERAGE-1B: buildCloudApiLocationRequestBody arma el interactive oficial (Graph actual, sin upgrade)', () => {
    const b = buildCloudApiLocationRequestBody('595981111111', '📍 Compartí tu ubicación');
    expect(b).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '595981111111',
      type: 'interactive',
      // action.name 'send_location' es OBLIGATORIO (doc oficial): sin él Graph rechaza el POST.
      interactive: { type: 'location_request_message', body: { text: '📍 Compartí tu ubicación' }, action: { name: 'send_location' } },
    });
  });

  it('buildCloudApiTextBody arma el payload correcto de Cloud API', () => {
    const b = buildCloudApiTextBody('595981111111', 'hola 🌸');
    expect(b).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '595981111111',
      type: 'text',
      text: { preview_url: false, body: 'hola 🌸' },
    });
  });

  it('en emulador SIEMPRE devuelve Mock (nunca CloudAPIClient), aunque haya creds live', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    const c = await getWhatsAppClient('perfumeria', makeDeps('live', OK));
    expect(c).toBeInstanceOf(MockWhatsAppClient);
    // Mock inspeccionable: resuelve el phone_number_id del tenant, sin exponer el token.
    expect((c as MockWhatsAppClient).resolution).toMatchObject({ mode: 'live', phoneNumberId: 'wa-595', tokenPresent: true });
  });

  it('en emulador con sendMode mock → Mock con reason mode_mock', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    const c = await getWhatsAppClient('perfumeria', makeDeps('mock', OK));
    expect(c).toBeInstanceOf(MockWhatsAppClient);
    expect((c as MockWhatsAppClient).resolution?.reason).toBe('mode_mock');
  });

  it('prod + sendMode mock → Mock (no envía), reason mode_mock', async () => {
    const c = await getWhatsAppClient('perfumeria', makeDeps('mock', OK));
    expect(c).toBeInstanceOf(MockWhatsAppClient);
    expect((c as MockWhatsAppClient).resolution?.reason).toBe('mode_mock');
  });

  it('prod + live + creds ok → CloudAPIClient', async () => {
    const c = await getWhatsAppClient('perfumeria', makeDeps('live', OK));
    expect(c).toBeInstanceOf(CloudAPIClient);
  });

  it('prod + live + not_connected → Mock con reason claro', async () => {
    const c = await getWhatsAppClient('perfumeria', makeDeps('live', { ok: false, reason: 'not_connected' }));
    expect(c).toBeInstanceOf(MockWhatsAppClient);
    expect((c as MockWhatsAppClient).resolution?.reason).toBe('not_connected');
  });

  it('prod + live + token_expired → Mock con reason token_expired', async () => {
    const c = await getWhatsAppClient('perfumeria', makeDeps('live', { ok: false, reason: 'token_expired' }));
    expect(c).toBeInstanceOf(MockWhatsAppClient);
    expect((c as MockWhatsAppClient).resolution?.reason).toBe('token_expired');
  });

  it('prod + live + sin creds + fallback global habilitado → CloudAPIClient (deprecated)', async () => {
    process.env.ALLOW_GLOBAL_WHATSAPP_FALLBACK = 'true';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'global-pnid';
    process.env.WHATSAPP_ACCESS_TOKEN = 'global-token';
    const c = await getWhatsAppClient('perfumeria', makeDeps('live', { ok: false, reason: 'not_connected' }));
    expect(c).toBeInstanceOf(CloudAPIClient);
  });

  it('prod + live + sin creds + fallback global DESHABILITADO (default) → Mock', async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'global-pnid';
    process.env.WHATSAPP_ACCESS_TOKEN = 'global-token';
    const c = await getWhatsAppClient('perfumeria', makeDeps('live', { ok: false, reason: 'token_unavailable' }));
    expect(c).toBeInstanceOf(MockWhatsAppClient);
    expect((c as MockWhatsAppClient).resolution?.reason).toBe('token_unavailable');
  });

  it('sin tenantId → Mock (getMode global = mock)', async () => {
    const c = await getWhatsAppClient(undefined, makeDeps('mock', { ok: false, reason: 'no_tenant' }));
    expect(c).toBeInstanceOf(MockWhatsAppClient);
  });
});
