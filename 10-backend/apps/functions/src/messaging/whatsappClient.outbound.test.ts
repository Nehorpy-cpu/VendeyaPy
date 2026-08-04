/**
 * whatsappClient.outbound.test.ts — el permiso del canal también del lado del ENVÍO (ADR-0017 §1)
 * ================================================================================================
 * El gate de ADR-0017 vivía solo en el inbound. Del lado del envío, `resolveCreds` cae al número
 * PRINCIPAL del tenant cuando el pedido no resuelve: si el principal es (o pasa a ser) el número
 * en `inactive`/`shadow`, TODO el outbound del tenant sale por el número que debe estar callado —
 * y ese es exactamente el desenlace prohibido: el número real escribiéndole solo a un cliente.
 *
 * DÓNDE ESTÁ LA LÍNEA, y por qué (ver `whatsappClient.origen.test.ts` para el ORIGEN, que es la
 * otra mitad de la regla y la que corrigió la premisa equivocada de la primera versión):
 *  · Canal ELEGIDO (el llamador nombró un PNID y ese PNID resolvió) + origen HUMANO declarado:
 *    alcanza con que NO esté `inactive` — es el vendedor contestando por el panel del número que
 *    él mismo atiende a mano. Sin origen declarado la vara es la estricta: `live`.
 *  · Canal INFERIDO (no se nombró PNID, o se nombró uno y se terminó usando otro): se exige `live`.
 *    Un mensaje que el sistema RE-RUTEÓ a un número que nadie nombró no puede salir por un canal
 *    sin permiso de automatización.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

/** Firestore de mentira para ejercitar el CABLEADO por defecto (sin deps inyectadas). */
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
vi.mock('./resolveWhatsappCreds.js', () => ({
  resolveTenantWhatsappCreds: async () => ({ ok: true, phoneNumberId: 'PNID_QUE_VENDE', accessToken: 'tok', tokenExpiresAtMs: null }),
  resolveTenantWhatsappCredsFor: async (_t: string, pnid: string) => ({ ok: true, phoneNumberId: pnid, accessToken: 'tok', tokenExpiresAtMs: null }),
}));

import {
  MockWhatsAppClient,
  CloudAPIClient,
  getWhatsAppClient,
  getWhatsAppClientExact,
  clearWhatsappClientCache,
  decideOutboundChannel,
  type WhatsappClientDeps,
} from './whatsappClient.js';
import type { WhatsappCredsResult } from './resolveWhatsappCreds.js';
import type { WhatsappAutomationMode } from '@vpw/shared';

const PRINCIPAL = 'PNID_QUE_VENDE';
const NUEVO = 'PNID_NUMERO_REAL';
/** Un PNID que el resolutor NO puede resolver: dispara el fallback al principal. */
const NO_RESUELVE = 'PNID_DESCONECTADO';

/**
 * Deps que reproducen el comportamiento REAL de `defaultDeps.resolveCreds`: con PNID resoluble
 * devuelve ESE número; si no resuelve, cae al principal del tenant.
 */
const deps = (modos: Record<string, WhatsappAutomationMode>): WhatsappClientDeps => ({
  getMode: async () => 'live',
  resolveCreds: async (_t, pnid): Promise<WhatsappCredsResult> => ({
    ok: true,
    phoneNumberId: pnid && pnid !== NO_RESUELVE ? pnid : PRINCIPAL,
    accessToken: 'tok-de-prueba',
    tokenExpiresAtMs: null,
  }),
  resolveAutomation: async (_t, pnid) => modos[pnid] ?? 'inactive',
});

describe('decideOutboundChannel (decisión PURA)', () => {
  // El origen es explícito en cada caso: la primera versión lo DEDUCÍA de la forma de la llamada
  // y esa deducción es justamente el defecto que se corrigió (ver whatsappClient.origen.test.ts).
  const caso = (requested: string | null, resolved: string, mode: WhatsappAutomationMode, origen: 'humano' | 'automatico' = 'humano') =>
    decideOutboundChannel({ requestedPhoneNumberId: requested, resolvedPhoneNumberId: resolved, mode, origen });

  it('canal elegido en `live` → sale', () => {
    expect(caso(NUEVO, NUEVO, 'live').allow).toBe(true);
  });

  it('canal elegido en `shadow` con origen HUMANO → sale (outbound del vendedor)', () => {
    expect(caso(NUEVO, NUEVO, 'shadow', 'humano').allow).toBe(true);
  });

  it('el MISMO canal elegido en `shadow` con origen AUTOMÁTICO → NO sale', () => {
    expect(caso(NUEVO, NUEVO, 'shadow', 'automatico').allow).toBe(false);
  });

  it('canal elegido en `inactive` → NO sale', () => {
    const d = caso(NUEVO, NUEVO, 'inactive');
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.canal).toBe('elegido');
  });

  it('FALLBACK al principal en `shadow` → NO sale (el número que debe estar callado)', () => {
    const d = caso(NO_RESUELVE, PRINCIPAL, 'shadow');
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.canal).toBe('inferido');
  });

  it('sin PNID (conversación legacy) con principal `live` → sale', () => {
    expect(caso(null, PRINCIPAL, 'live').allow).toBe(true);
  });

  it('sin PNID con principal `shadow` → NO sale', () => {
    expect(caso(null, PRINCIPAL, 'shadow').allow).toBe(false);
  });

  it('el motivo nombra el modo (diagnóstico de por qué un número quedó mudo)', () => {
    const d = caso(null, PRINCIPAL, 'inactive');
    if (!d.allow) expect(d.reason).toBe('automation_inactive');
    else expect.unreachable();
  });
});

describe('getWhatsAppClient — el gate del envío', () => {
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

  it('SIN REGRESIÓN: el número que hoy vende (`live`) sigue saliendo por Cloud API', async () => {
    const c = await getWhatsAppClient('perfumeria', deps({ [PRINCIPAL]: 'live' }), PRINCIPAL);
    expect(c).toBeInstanceOf(CloudAPIClient);
    expect(c.transportInfo).toEqual({ transport: 'live', credentials: 'tenant' });
  });

  it('SIN REGRESIÓN: conversación legacy sin PNID, principal `live` → Cloud API', async () => {
    const c = await getWhatsAppClient('perfumeria', deps({ [PRINCIPAL]: 'live' }), null);
    expect(c).toBeInstanceOf(CloudAPIClient);
  });

  it('EL DEFECTO: PNID que no resuelve + principal en `shadow` → NUNCA Cloud API', async () => {
    const c = await getWhatsAppClient('perfumeria', deps({ [PRINCIPAL]: 'shadow', [NUEVO]: 'live' }), NO_RESUELVE);
    expect(c).toBeInstanceOf(MockWhatsAppClient);
    expect((c as MockWhatsAppClient).resolution).toMatchObject({ reason: 'automation_shadow' });
  });

  it('EL DEFECTO: PNID que no resuelve + principal en `inactive` → NUNCA Cloud API', async () => {
    const c = await getWhatsAppClient('perfumeria', deps({ [PRINCIPAL]: 'inactive' }), NO_RESUELVE);
    expect(c).toBeInstanceOf(MockWhatsAppClient);
  });

  it('canal explícito en `inactive` → bloqueado', async () => {
    const c = await getWhatsAppClient('perfumeria', deps({ [NUEVO]: 'inactive' }), NUEVO);
    expect(c).toBeInstanceOf(MockWhatsAppClient);
    expect((c as MockWhatsAppClient).resolution).toMatchObject({ reason: 'automation_inactive' });
  });

  it('canal explícito en `shadow` con origen humano → SÍ sale (mensaje manual del vendedor)', async () => {
    const c = await getWhatsAppClient('perfumeria', deps({ [NUEVO]: 'shadow' }), NUEVO, 'humano');
    expect(c).toBeInstanceOf(CloudAPIClient);
  });

  it('un canal bloqueado NO puede parecer una resolución válida (la cotización acepta mock live+token)', async () => {
    // `coverageQuote` acepta un mock en emulador SOLO si la resolución habría sido un envío live
    // válido (`mode:'live' && tokenPresent`). Un canal bloqueado tiene que fallar ese chequeo.
    const c = await getWhatsAppClient('perfumeria', deps({ [PRINCIPAL]: 'shadow' }), NO_RESUELVE);
    const info = c.transportInfo;
    expect(info.transport).toBe('mock');
    if (info.transport === 'mock') expect(info.tokenPresent).toBe(false);
  });

  it('la caché de clientes no revive un canal bloqueado después de una degradación', async () => {
    const c1 = await getWhatsAppClient('perfumeria', deps({ [NUEVO]: 'live' }), NUEVO, 'humano');
    expect(c1).toBeInstanceOf(CloudAPIClient);
    // Mismo tenant, mismo número, dentro del TTL de caché: si el permiso bajó, no se reusa el veredicto.
    const c2 = await getWhatsAppClient('perfumeria', deps({ [NUEVO]: 'shadow' }), NUEVO, 'humano');
    expect(c2).toBeInstanceOf(CloudAPIClient); // shadow + canal elegido + humano sigue permitido
    const c3 = await getWhatsAppClient('perfumeria', deps({ [NUEVO]: 'inactive' }), NUEVO, 'humano');
    expect(c3).toBeInstanceOf(MockWhatsAppClient);
    // Y el mismo `shadow` con la vara automática (el default) ya no vuelve a Cloud API.
    const c4 = await getWhatsAppClient('perfumeria', deps({ [NUEVO]: 'shadow' }), NUEVO);
    expect(c4).not.toBeInstanceOf(CloudAPIClient);
  });

  it('el gate corre también en emulador (mismo criterio en todos lados)', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    const c = await getWhatsAppClient('perfumeria', deps({ [PRINCIPAL]: 'inactive' }), NO_RESUELVE);
    expect(c).toBeInstanceOf(MockWhatsAppClient);
    expect((c as MockWhatsAppClient).resolution).toMatchObject({ reason: 'automation_inactive' });
  });

  it('el fallback global DEPRECATED no es una puerta trasera para un canal bloqueado', async () => {
    process.env.ALLOW_GLOBAL_WHATSAPP_FALLBACK = 'true';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'PNID_GLOBAL';
    process.env.WHATSAPP_ACCESS_TOKEN = 'tok-global';
    const c = await getWhatsAppClient('perfumeria', deps({ [PRINCIPAL]: 'shadow' }), NO_RESUELVE);
    expect(c).toBeInstanceOf(MockWhatsAppClient);
  });
});

describe('cableado por DEFECTO (sin deps inyectadas)', () => {
  beforeEach(() => {
    delete process.env.FUNCTIONS_EMULATOR;
    clearWhatsappClientCache();
    store.clear();
    store.set('tenants/perfumeria/config/channels', { whatsappSendMode: 'live' });
  });
  afterEach(() => { store.clear(); clearWhatsappClientCache(); });

  it('asset SIN `automationMode` → fail-closed: no sale (mismo criterio que el inbound)', async () => {
    store.set(`tenants/perfumeria/metaAssets/${NUEVO}`, { assetType: 'whatsapp_phone_number' });
    const c = await getWhatsAppClient('perfumeria', undefined, NUEVO);
    expect(c).toBeInstanceOf(MockWhatsAppClient);
    expect((c as MockWhatsAppClient).resolution).toMatchObject({ reason: 'automation_inactive' });
  });

  it('asset en `live` → sale por Cloud API', async () => {
    store.set(`tenants/perfumeria/metaAssets/${NUEVO}`, { assetType: 'whatsapp_phone_number', automationMode: 'live' });
    const c = await getWhatsAppClient('perfumeria', undefined, NUEVO);
    expect(c).toBeInstanceOf(CloudAPIClient);
  });

  it('getWhatsAppClientExact (cotización financiera) hereda el mismo gate', async () => {
    store.set(`tenants/perfumeria/metaAssets/${NUEVO}`, { assetType: 'whatsapp_phone_number' });
    const c = await getWhatsAppClientExact('perfumeria', NUEVO);
    expect(c.transportInfo.transport).toBe('mock');
  });
});
