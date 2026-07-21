import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AxiosError } from 'axios';
// SHIPPING-CHAT-3B: logger espiado para verificar el enmascarado de teléfonos en logs.
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { logger } from '../lib/logger.js';
import {
  MockWhatsAppClient,
  CloudAPIClient,
  buildCloudApiTextBody,
  buildCloudApiLocationRequestBody,
  getWhatsAppClient,
  clearWhatsappClientCache,
  classifyCloudSendError,
  sendResultFromCloudResponse,
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

describe('SHIPPING-CHAT-3B — SendResult discriminado (sin regex)', () => {
  const axiosErr = (status: number | undefined, data?: unknown, code?: string) => {
    const e = new AxiosError('Request failed', code, undefined, undefined, status !== undefined ? ({ status, data } as never) : undefined);
    return e;
  };

  it('2xx con wamid string no vacío ⇒ accepted', () => {
    expect(sendResultFromCloudResponse('wamid.ABC')).toEqual({ ok: true, outcome: 'accepted', id: 'wamid.ABC', viaMock: false });
  });
  it('2xx SIN wamid válido (undefined, null, vacío, whitespace-only, no-string) ⇒ unknown', () => {
    expect(sendResultFromCloudResponse(undefined)).toEqual({ ok: false, outcome: 'unknown' });
    expect(sendResultFromCloudResponse(null)).toEqual({ ok: false, outcome: 'unknown' });
    expect(sendResultFromCloudResponse('')).toEqual({ ok: false, outcome: 'unknown' });
    expect(sendResultFromCloudResponse('   ')).toEqual({ ok: false, outcome: 'unknown' });
    expect(sendResultFromCloudResponse('\n\t ')).toEqual({ ok: false, outcome: 'unknown' });
    expect(sendResultFromCloudResponse(42)).toEqual({ ok: false, outcome: 'unknown' });
  });
  it('4xx con body.error.code numérico ⇒ rejected con providerCode saneado', () => {
    expect(classifyCloudSendError(axiosErr(400, { error: { code: 131047 } }))).toEqual({ ok: false, outcome: 'rejected', providerCode: 131047 });
    expect(classifyCloudSendError(axiosErr(403, { error: { code: 190 } }))).toEqual({ ok: false, outcome: 'rejected', providerCode: 190 });
  });
  it('4xx SIN code numérico (HTML de proxy, code string) ⇒ rejected con providerCode null', () => {
    expect(classifyCloudSendError(axiosErr(400, '<html>bad</html>'))).toEqual({ ok: false, outcome: 'rejected', providerCode: null });
    expect(classifyCloudSendError(axiosErr(401, { error: { code: 'X-190' } }))).toEqual({ ok: false, outcome: 'rejected', providerCode: null });
  });
  it('5xx / timeout / reset / sin respuesta / excepción rara ⇒ unknown', () => {
    expect(classifyCloudSendError(axiosErr(500, { error: { code: 1 } }))).toEqual({ ok: false, outcome: 'unknown' });
    expect(classifyCloudSendError(axiosErr(undefined, undefined, 'ECONNABORTED'))).toEqual({ ok: false, outcome: 'unknown' }); // timeout sin response
    expect(classifyCloudSendError(new Error('socket hang up'))).toEqual({ ok: false, outcome: 'unknown' });
    expect(classifyCloudSendError('basura')).toEqual({ ok: false, outcome: 'unknown' });
  });
  it('mock tipado: outcome mock con id determinístico no vacío + viaMock true', async () => {
    const r = await new MockWhatsAppClient().sendText('+595981111111', 'hola', { tenantId: 'perfumeria' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.outcome).toBe('mock');
      expect(r.viaMock).toBe(true);
      expect(r.id.length).toBeGreaterThan(5);
      expect(r.id.startsWith('mock-')).toBe(true);
    }
  });
});

describe('SHIPPING-CHAT-3B — transportInfo (metadata no sensible, jamás el token)', () => {
  beforeEach(() => {
    delete process.env.FUNCTIONS_EMULATOR;
    delete process.env.ALLOW_GLOBAL_WHATSAPP_FALLBACK;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    clearWhatsappClientCache();
  });
  afterEach(() => {
    delete process.env.ALLOW_GLOBAL_WHATSAPP_FALLBACK;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
  });

  it('CloudAPIClient tenant ⇒ live/tenant; fallback global ⇒ live/global_fallback', async () => {
    expect(new CloudAPIClient('pnid', 'tok').transportInfo).toEqual({ transport: 'live', credentials: 'tenant' });
    process.env.ALLOW_GLOBAL_WHATSAPP_FALLBACK = 'true';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'global-pnid';
    process.env.WHATSAPP_ACCESS_TOKEN = 'global-token';
    const c = await getWhatsAppClient('perfumeria', makeDeps('live', { ok: false, reason: 'not_connected' }));
    expect(c.transportInfo).toEqual({ transport: 'live', credentials: 'global_fallback' });
    expect(JSON.stringify(c.transportInfo)).not.toContain('global-token');
  });
  it('Mock ⇒ transport mock con mode/reason/tokenPresent', async () => {
    const c = await getWhatsAppClient('perfumeria', makeDeps('live', { ok: false, reason: 'token_expired' }));
    expect(c.transportInfo).toEqual({ transport: 'mock', mode: 'live', reason: 'token_expired', tokenPresent: false });
  });
});

describe('SHIPPING-CHAT-3B — cache por tenant + número (bug multi-número preexistente)', () => {
  beforeEach(() => {
    delete process.env.FUNCTIONS_EMULATOR;
    clearWhatsappClientCache();
  });
  const depsPorPnid: WhatsappClientDeps = {
    getMode: async () => 'live',
    resolveCreds: async (_t, pnid) => ({ ok: true, phoneNumberId: pnid ?? 'main', accessToken: 'tok', tokenExpiresAtMs: null }),
  };

  it('dos números del MISMO tenant producen clientes SEPARADOS (jamás mezclar credenciales)', async () => {
    const a = await getWhatsAppClient('perfumeria', depsPorPnid, 'num-A');
    const b = await getWhatsAppClient('perfumeria', depsPorPnid, 'num-B');
    expect(a).toBeInstanceOf(CloudAPIClient);
    expect(b).toBeInstanceOf(CloudAPIClient);
    expect(a).not.toBe(b);
  });
  it('mismo tenant + mismo número reutiliza la cache', async () => {
    const a1 = await getWhatsAppClient('perfumeria', depsPorPnid, 'num-A');
    const a2 = await getWhatsAppClient('perfumeria', depsPorPnid, 'num-A');
    expect(a2).toBe(a1);
  });
  it('clearWhatsappClientCache limpia', async () => {
    const a1 = await getWhatsAppClient('perfumeria', depsPorPnid, 'num-A');
    clearWhatsappClientCache();
    const a2 = await getWhatsAppClient('perfumeria', depsPorPnid, 'num-A');
    expect(a2).not.toBe(a1);
  });
  it('tenants distintos jamás comparten cliente aunque el pnid coincida', async () => {
    const a = await getWhatsAppClient('perfumeria', depsPorPnid, 'num-A');
    const b = await getWhatsAppClient('otra-empresa', depsPorPnid, 'num-A');
    expect(a).not.toBe(b);
  });
});

describe('SHIPPING-CHAT-3B — higiene de logs (teléfonos y PNIDs enmascarados)', () => {
  it('Mock.sendText loguea `to` ENMASCARADO, jamás completo', async () => {
    vi.mocked(logger.info).mockClear();
    await new MockWhatsAppClient().sendText('595994893000', 'hola', { tenantId: 'perfumeria' });
    const calls = JSON.stringify(vi.mocked(logger.info).mock.calls);
    expect(calls).toContain('…3000');
    expect(calls).not.toContain('595994893000');
  });
  it('Mock.sendLocationRequest loguea `to` ENMASCARADO', async () => {
    vi.mocked(logger.info).mockClear();
    await new MockWhatsAppClient().sendLocationRequest('595994893000', 'compartí tu ubicación', { tenantId: 'perfumeria' });
    const calls = JSON.stringify(vi.mocked(logger.info).mock.calls);
    expect(calls).toContain('…3000');
    expect(calls).not.toContain('595994893000');
  });
});
