/**
 * whatsappClient.origen.test.ts — el ORIGEN del envío, y qué devuelve un canal BLOQUEADO
 * =======================================================================================
 * Dos defectos que salieron de la verificación adversarial del rollout de Coexistence, y que se
 * tocan: el primero deja salir un mensaje que no debía salir, el segundo miente cuando no sale.
 *
 * R2 — EL GATE ADIVINABA LA INTENCIÓN. La regla era «canal ELEGIDO (el llamador nombró el PNID y
 *      ese PNID resolvió) ⇒ lo único que llega hasta acá es HUMANO ⇒ alcanza con que no esté
 *      `inactive`». La premisa es falsa: `enviarPorOutbox` (cobertura) construye el cliente con el
 *      PNID GUARDADO en el job (`receivedVia`), y quienes lo disparan son el mantenimiento
 *      programado y el trigger del job — cero intervención humana. Escenario completo: un número
 *      en `live` deja un job pendiente, el operador lo degrada a `shadow`, el mantenimiento toma
 *      el job, el canal está «elegido» ⇒ salía ⇒ datos bancarios a un cliente real por el número
 *      que debe estar callado. La intención ya no se adivina: el llamador la DECLARA, y todo lo
 *      automático exige `live` aunque nombre el PNID.
 *
 * R4 — BLOQUEADO NO PUEDE PARECER ENVIADO. Con el gate cerrado se devolvía un cliente cuyo
 *      `sendText` respondía `{ok:true}`: el mensaje no salía y el sistema lo anotaba como enviado
 *      (burbuja en el historial, éxito al vendedor en el panel, `sent` en el outbox). El cliente
 *      nunca recibía nada. Un silencio que miente es peor que un error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

/** Firestore de mentira: sólo para que el cableado por defecto no toque nada real. */
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
  CloudAPIClient,
  MockWhatsAppClient,
  getWhatsAppClient,
  clearWhatsappClientCache,
  decideOutboundChannel,
  type WhatsappClientDeps,
} from './whatsappClient.js';
import { defaultManualMessageDeps } from '../conversation/manualMessage.js';
import type { WhatsappCredsResult } from './resolveWhatsappCreds.js';
import type { WhatsappAutomationMode } from '@vpw/shared';

const PRINCIPAL = 'PNID_QUE_VENDE';
const NUEVO = 'PNID_NUMERO_REAL';
/** Destino de juguete: nunca un número real ni con forma de tal. */
const DESTINO = 'destino-de-prueba';

const deps = (modos: Record<string, WhatsappAutomationMode>): WhatsappClientDeps => ({
  getMode: async () => 'live',
  resolveCreds: async (_t, pnid): Promise<WhatsappCredsResult> => ({
    ok: true,
    phoneNumberId: pnid ?? PRINCIPAL,
    accessToken: 'tok-de-prueba',
    tokenExpiresAtMs: null,
  }),
  resolveAutomation: async (_t, pnid) => modos[pnid] ?? 'inactive',
});

describe('R2 — decideOutboundChannel: la intención se DECLARA, no se adivina', () => {
  it('AUTOMÁTICO + canal elegido en `shadow` → NO sale (el job de reanudación con PNID guardado)', () => {
    const d = decideOutboundChannel({
      requestedPhoneNumberId: NUEVO,
      resolvedPhoneNumberId: NUEVO,
      mode: 'shadow',
      origen: 'automatico',
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe('automation_shadow');
  });

  it('AUTOMÁTICO + canal elegido en `inactive` → NO sale', () => {
    expect(
      decideOutboundChannel({ requestedPhoneNumberId: NUEVO, resolvedPhoneNumberId: NUEVO, mode: 'inactive', origen: 'automatico' }).allow,
    ).toBe(false);
  });

  it('SIN REGRESIÓN: automático + `live` (el número que hoy vende) → sale', () => {
    expect(
      decideOutboundChannel({ requestedPhoneNumberId: PRINCIPAL, resolvedPhoneNumberId: PRINCIPAL, mode: 'live', origen: 'automatico' }).allow,
    ).toBe(true);
  });

  it('HUMANO + canal elegido en `shadow` → sale (el mensaje manual del vendedor no se rompe)', () => {
    expect(
      decideOutboundChannel({ requestedPhoneNumberId: NUEVO, resolvedPhoneNumberId: NUEVO, mode: 'shadow', origen: 'humano' }).allow,
    ).toBe(true);
  });

  it('HUMANO + canal INFERIDO (re-ruteo) en `shadow` → NO sale: nadie eligió ese destino', () => {
    const d = decideOutboundChannel({ requestedPhoneNumberId: null, resolvedPhoneNumberId: PRINCIPAL, mode: 'shadow', origen: 'humano' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.canal).toBe('inferido');
  });

  it('ORIGEN AUSENTE ⇒ automático: el default es la vara ESTRICTA (fail-closed)', () => {
    expect(decideOutboundChannel({ requestedPhoneNumberId: NUEVO, resolvedPhoneNumberId: NUEVO, mode: 'shadow' }).allow).toBe(false);
  });

  it('el veredicto nombra el origen: sin eso, un número mudo no se puede diagnosticar', () => {
    const d = decideOutboundChannel({ requestedPhoneNumberId: NUEVO, resolvedPhoneNumberId: NUEVO, mode: 'shadow', origen: 'automatico' });
    if (!d.allow) expect(d.origen).toBe('automatico');
    else expect.unreachable();
  });
});

describe('R2 — getWhatsAppClient: el camino del job automático', () => {
  beforeEach(() => {
    delete process.env.FUNCTIONS_EMULATOR;
    clearWhatsappClientCache();
  });
  afterEach(() => clearWhatsappClientCache());

  it('EL DEFECTO: `enviarPorOutbox` con el PNID del job y el canal degradado a `shadow` → NO sale', async () => {
    // Exactamente la llamada de `conversation/coverageResume.ts` (`getWhatsAppClient(tenantId,
    // undefined, input.receivedVia)`), pero con las deps inyectadas.
    const c = await getWhatsAppClient('perfumeria', deps({ [NUEVO]: 'shadow' }), NUEVO);
    expect(c).not.toBeInstanceOf(CloudAPIClient);
    expect(c.transportInfo).toMatchObject({ transport: 'mock' });
  });

  it('SIN REGRESIÓN: el mismo job por un canal `live` sigue saliendo por Cloud API', async () => {
    const c = await getWhatsAppClient('perfumeria', deps({ [NUEVO]: 'live' }), NUEVO);
    expect(c).toBeInstanceOf(CloudAPIClient);
  });

  it('con origen HUMANO explícito, el canal elegido en `shadow` sigue pudiendo enviar', async () => {
    const c = await getWhatsAppClient('perfumeria', deps({ [NUEVO]: 'shadow' }), NUEVO, 'humano');
    expect(c).toBeInstanceOf(CloudAPIClient);
  });

  it('ni siquiera con origen humano sale por un canal `inactive`', async () => {
    const c = await getWhatsAppClient('perfumeria', deps({ [NUEVO]: 'inactive' }), NUEVO, 'humano');
    expect(c).not.toBeInstanceOf(CloudAPIClient);
  });
});

describe('R2 — el cableado real de cada llamador', () => {
  beforeEach(() => {
    delete process.env.FUNCTIONS_EMULATOR;
    clearWhatsappClientCache();
    store.clear();
    store.set('tenants/perfumeria/config/channels', { whatsappSendMode: 'live' });
  });
  afterEach(() => {
    store.clear();
    clearWhatsappClientCache();
  });

  it('el mensaje MANUAL del panel declara origen humano: el vendedor sigue contestando en `shadow`', async () => {
    // Si alguien saca el `'humano'` del dep por defecto de `manualMessage.ts`, el vendedor deja de
    // poder contestar por el panel del número que atiende a mano — y este test es el que lo dice.
    store.set(`tenants/perfumeria/metaAssets/${NUEVO}`, { assetType: 'whatsapp_phone_number', automationMode: 'shadow' });
    const c = await defaultManualMessageDeps.getClient('perfumeria', NUEVO);
    expect(c).toBeInstanceOf(CloudAPIClient);
  });

  it('el mismo canal `shadow` por el camino AUTOMÁTICO (default) no sale', async () => {
    store.set(`tenants/perfumeria/metaAssets/${NUEVO}`, { assetType: 'whatsapp_phone_number', automationMode: 'shadow' });
    const c = await getWhatsAppClient('perfumeria', undefined, NUEVO);
    expect(c).not.toBeInstanceOf(CloudAPIClient);
  });
});

describe('R4 — un canal bloqueado NO puede parecer un envío exitoso', () => {
  beforeEach(() => {
    delete process.env.FUNCTIONS_EMULATOR;
    clearWhatsappClientCache();
  });
  afterEach(() => clearWhatsappClientCache());

  const bloqueado = (modo: WhatsappAutomationMode) => getWhatsAppClient('perfumeria', deps({ [NUEVO]: modo }), NUEVO);

  it('sendText de un canal bloqueado devuelve ok:false con desenlace propio', async () => {
    const c = await bloqueado('inactive');
    const r = await c.sendText(DESTINO, 'texto de prueba');
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('blocked');
    if (r.outcome === 'blocked') expect(r.reason).toBe('automation_inactive');
  });

  it('un bloqueo automático sobre `shadow` también devuelve `blocked` (no `mock`)', async () => {
    const c = await bloqueado('shadow');
    const r = await c.sendText(DESTINO, 'texto de prueba');
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome === 'blocked') expect(r.reason).toBe('automation_shadow');
    else expect.unreachable();
  });

  it('sendLocationRequest de un canal bloqueado tampoco dice ok', async () => {
    const c = await bloqueado('inactive');
    const r = await c.sendLocationRequest(DESTINO, 'texto de prueba');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('channel_blocked');
  });

  it('el mock LEGÍTIMO (modo mock del tenant) sigue devolviendo ok:true con id determinístico', async () => {
    // La distinción es el punto: «no salió porque el canal no tiene permiso» ≠ «no salió porque
    // el tenant está en modo mock, y el historial lo registra como tal».
    const mockDeps: WhatsappClientDeps = { ...deps({ [NUEVO]: 'live' }), getMode: async () => 'mock' };
    const c = await getWhatsAppClient('perfumeria', mockDeps, NUEVO);
    expect(c).toBeInstanceOf(MockWhatsAppClient);
    const r = await c.sendText(DESTINO, 'texto de prueba');
    expect(r).toMatchObject({ ok: true, outcome: 'mock', viaMock: true });
  });

  it('el bloqueado sigue SIN parecer una resolución live válida (la cotización lo rechaza)', async () => {
    const c = await bloqueado('shadow');
    const info = c.transportInfo;
    expect(info.transport).toBe('mock');
    if (info.transport === 'mock') expect(info.tokenPresent).toBe(false);
  });
});
