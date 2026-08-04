/**
 * whatsappClient.canalPedido.test.ts — EL FALLBACK SILENCIOSO AL NÚMERO QUE VENDE
 * ================================================================================
 * `defaultDeps.resolveCreds` hacía esto: si el llamador pidió un phone_number_id concreto y ESE
 * número no resolvía credenciales, caía al número PRINCIPAL del tenant. Nació como una comodidad
 * de MULTI-NUMBER-1 («el número se desactivó con mensajes en vuelo»), y con Coexistence se
 * convierte en el peor desenlace posible: un número adicional que todavía no está `active` —el
 * estado NORMAL de un número recién incorporado— hace que la respuesta salga por el número que
 * está vendiendo, a un cliente que le escribió al OTRO número.
 *
 * Cuando hay un PNID pedido explícitamente no puede haber sustitución silenciosa: el canal no está
 * disponible y no sale nada. Y «no sale nada» tiene que ser visible: devolver un mock con `ok:true`
 * dejaría la burbuja en el chat y le diría «enviado» al vendedor mientras el cliente no recibe
 * nada.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const store = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (p: string) => ({ get: async () => ({ exists: store.has(p), data: () => store.get(p) }) }),
  }),
  storage: () => ({}),
  paths: {
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));

/**
 * El número ADICIONAL no resuelve (conexión todavía no `active`); el PRINCIPAL sí. Es exactamente
 * el estado del día del onboarding del número real.
 */
vi.mock('./resolveWhatsappCreds.js', () => ({
  resolveTenantWhatsappCreds: async () => ({ ok: true, phoneNumberId: 'PNID_QUE_VENDE', accessToken: 'tok', tokenExpiresAtMs: null }),
  resolveTenantWhatsappCredsFor: async (_t: string, pnid: string) =>
    pnid === 'PNID_QUE_VENDE'
      ? { ok: true, phoneNumberId: pnid, accessToken: 'tok', tokenExpiresAtMs: null }
      : { ok: false, reason: 'not_connected' },
}));

import { CloudAPIClient, getWhatsAppClient, clearWhatsappClientCache } from './whatsappClient.js';

const PRINCIPAL = 'PNID_QUE_VENDE';
const NUEVO = 'PNID_NUMERO_REAL';
const DESTINO = 'destino-de-prueba';
const TENANT = 'tnt_alpha';

beforeEach(() => {
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.ALLOW_GLOBAL_WHATSAPP_FALLBACK;
  clearWhatsappClientCache();
  store.clear();
  store.set(`tenants/${TENANT}/config/channels`, { whatsappSendMode: 'live' });
  // El número que vende está habilitado: si hubiera fallback, el envío saldría de verdad.
  store.set(`tenants/${TENANT}/metaAssets/${PRINCIPAL}`, { assetType: 'whatsapp_phone_number', automationMode: 'live' });
});

afterEach(() => {
  store.clear();
  clearWhatsappClientCache();
});

describe('EL DEFECTO — un PNID pedido que no resuelve no puede salir por el número que vende', () => {
  it('no devuelve un cliente Cloud API', async () => {
    const c = await getWhatsAppClient(TENANT, undefined, NUEVO);
    expect(c).not.toBeInstanceOf(CloudAPIClient);
  });

  it('el transporte NO puede quedar apuntando al número principal', async () => {
    const c = await getWhatsAppClient(TENANT, undefined, NUEVO);
    const info = c.transportInfo;
    expect(info.transport).toBe('mock');
    expect(JSON.stringify(info)).not.toContain(PRINCIPAL);
  });

  it('enviar devuelve un NO-ENVÍO explícito, no un éxito simulado', async () => {
    const c = await getWhatsAppClient(TENANT, undefined, NUEVO);
    const r = await c.sendText(DESTINO, 'texto de prueba');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toBe('blocked');
  });

  it('el pedido de ubicación tampoco dice ok', async () => {
    const c = await getWhatsAppClient(TENANT, undefined, NUEVO);
    const r = await c.sendLocationRequest(DESTINO, 'texto de prueba');
    expect(r.ok).toBe(false);
  });

  it('ni siquiera con el fallback GLOBAL habilitado sale por otro número', async () => {
    // El fallback global es deprecated y env-gated, pero sigue existiendo: si el PNID pedido no
    // resuelve, mandar por credenciales AJENAS al tenant es la misma sustitución silenciosa.
    process.env.ALLOW_GLOBAL_WHATSAPP_FALLBACK = 'true';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'PNID_GLOBAL';
    process.env.WHATSAPP_ACCESS_TOKEN = 'token-global-de-prueba';
    try {
      const c = await getWhatsAppClient(TENANT, undefined, NUEVO);
      expect(c).not.toBeInstanceOf(CloudAPIClient);
    } finally {
      delete process.env.ALLOW_GLOBAL_WHATSAPP_FALLBACK;
      delete process.env.WHATSAPP_PHONE_NUMBER_ID;
      delete process.env.WHATSAPP_ACCESS_TOKEN;
    }
  });

  it('el emulador se comporta igual (un permiso que cambia según el entorno no lo probó nadie)', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    try {
      const c = await getWhatsAppClient(TENANT, undefined, NUEVO);
      const r = await c.sendText(DESTINO, 'texto de prueba');
      expect(r.ok).toBe(false);
    } finally {
      delete process.env.FUNCTIONS_EMULATOR;
    }
  });
});

describe('SIN REGRESIÓN — lo que sí tiene que seguir saliendo', () => {
  it('el número que vende, pedido explícitamente, sigue enviando por Cloud API', async () => {
    const c = await getWhatsAppClient(TENANT, undefined, PRINCIPAL);
    expect(c).toBeInstanceOf(CloudAPIClient);
  });

  it('sin PNID pedido (conversación vieja mono-número) se sigue resolviendo el principal', async () => {
    const c = await getWhatsAppClient(TENANT, undefined, null);
    expect(c).toBeInstanceOf(CloudAPIClient);
  });
});
