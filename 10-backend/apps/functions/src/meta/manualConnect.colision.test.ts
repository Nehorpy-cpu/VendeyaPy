/**
 * manualConnect.colision.test.ts — la colisión que aparece TARDE
 * ===============================================================
 * El alta manual chequea la colisión al principio (paso 1) y escribe el índice recién en el paso 4,
 * vía `writeDiscoveredAssets`. Ahora ese guard también corre DENTRO de la escritura, así que puede
 * rechazar cuando el chequeo temprano ya dijo «libre» — la ventana del TOCTOU. Ese rechazo tiene
 * que llegar como el MISMO motivo que el chequeo temprano (el admin no tiene por qué distinguir en
 * qué momento se detectó), y no como una excepción cruda que el callable convierte en `internal`.
 */
import { describe, it, expect, vi } from 'vitest';
import { runManualWhatsappConnect, type ManualConnectDeps, type ManualWhatsappInput } from './manualConnect.js';
import { PnidOcupadoError } from './pnidOwnership.js';
import type { MetaGraphClient } from './graphClient.js';

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const TENANT = 'tnt_alpha';
const OTRO_TENANT = 'tnt_beta';
const PNID = '111222333';

const input: ManualWhatsappInput = {
  wabaId: 'waba-1', phoneNumberId: PNID, displayPhoneNumber: 'numero-de-prueba',
  businessName: 'Test', accessToken: 'token-de-prueba', tokenExpiresAtMs: null,
};

const graph: MetaGraphClient = {
  exchangeCode: async () => ({ accessToken: '', tokenType: '', expiresInSec: null }),
  debugToken: async () => ({ isValid: true, scopes: [], wabaIds: [], expiresAtMs: null }),
  listWabaPhoneNumbers: async () => [],
  getPhoneNumber: async () => null,
  subscribeApp: async () => {},
};

const secretos = new Set<string>();

const deps = (over: Partial<ManualConnectDeps> = {}): ManualConnectDeps => ({
  collisionTenant: async () => null, // el chequeo TEMPRANO dice libre: esa es la ventana
  storeToken: async (t) => { const ref = `secret://meta-token-${t}`; secretos.add(ref); return ref; },
  writeConnection: async () => {},
  writeAssets: async () => {},
  verify: async () => ({ ready: true, reason: 'ok', status: 'active' }),
  ...over,
});

describe('runManualWhatsappConnect — la colisión detectada al escribir', () => {
  it('devuelve phone_number_collision con el tenant en conflicto (no una excepción cruda)', async () => {
    const r = await runManualWhatsappConnect(TENANT, input, 'admin', graph, deps({
      writeAssets: async () => { throw new PnidOcupadoError(PNID, OTRO_TENANT); },
    }));

    expect(r).toEqual({ ok: false, reason: 'phone_number_collision', conflictTenantId: OTRO_TENANT });
  });

  it('SIN REGRESIÓN: el chequeo temprano sigue devolviendo el mismo motivo', async () => {
    const r = await runManualWhatsappConnect(TENANT, input, 'admin', graph, deps({
      collisionTenant: async () => OTRO_TENANT,
    }));

    expect(r).toEqual({ ok: false, reason: 'phone_number_collision', conflictTenantId: OTRO_TENANT });
  });

  it('SIN REGRESIÓN: el alta limpia sigue terminando con el estado que decide el verificador', async () => {
    const r = await runManualWhatsappConnect(TENANT, input, 'admin', graph, deps());

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('active');
  });
});
