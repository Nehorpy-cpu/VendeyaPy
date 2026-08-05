/**
 * smbAppData.test.ts — EL DISPARO: lo que hoy directamente no existe (ADR-0017 §5)
 * =================================================================================
 * Sin `POST /<PNID>/smb_app_data` no llega un solo webhook de historial: el §4 daba por sentado que
 * llegaban por estar suscritos y el contrato verificado el 2026-08-04 dice que no. Y se pide UNA
 * sola vez: repetirlo exige que el cliente offboardee el número y rehaga el Embedded Signup.
 *
 * Lo que se custodia acá, además del orden de las dos llamadas:
 *  · nunca sobre el número PRINCIPAL (la avalancha de webhooks caería sobre el que vende);
 *  · con el token de ESA conexión, jamás con el de `main`;
 *  · el reclamo es previo a Graph, así que un segundo intento no llega a llamar;
 *  · un fallo queda `failed` y NO se reintenta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();
const versiones = new Map<string, number>();

interface Op { path: string; data: Record<string, unknown>; merge?: boolean }

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
        versiones.set(path, (versiones.get(path) ?? 0) + 1);
      },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      for (let intento = 0; intento < 5; intento++) {
        const leidos = new Map<string, number>();
        const ops: Op[] = [];
        const tx = {
          get: async (ref: { path: string }) => {
            leidos.set(ref.path, versiones.get(ref.path) ?? 0);
            return { exists: docs.has(ref.path), data: () => docs.get(ref.path) };
          },
          set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => ops.push({ path: ref.path, data, merge: opts?.merge }),
        };
        const r = await fn(tx);
        if ([...leidos].some(([p, v]) => (versiones.get(p) ?? 0) !== v)) continue;
        for (const op of ops) {
          docs.set(op.path, op.merge ? { ...(docs.get(op.path) ?? {}), ...op.data } : { ...op.data });
          versiones.set(op.path, (versiones.get(op.path) ?? 0) + 1);
        }
        return r;
      }
      throw new Error('transacción abortada por contención');
    },
  }),
  paths: {
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));

/** Credenciales POR NÚMERO. El doble deja ver con qué PNID se pidió el token. */
const credsPedidas: Array<{ tenantId: string; phoneNumberId: string }> = [];
let credsRespuesta: { ok: boolean; token?: string; reason?: string } = { ok: true, token: 'token-del-numero-nuevo' };
vi.mock('../messaging/resolveWhatsappCreds.js', () => ({
  resolveTenantWhatsappCredsFor: async (tenantId: string, phoneNumberId: string) => {
    credsPedidas.push({ tenantId, phoneNumberId });
    return credsRespuesta.ok
      ? { ok: true, phoneNumberId, accessToken: credsRespuesta.token, tokenExpiresAtMs: null }
      : { ok: false, reason: credsRespuesta.reason ?? 'token_unavailable' };
  },
}));

import { ejecutarSincronizacionDeHistorial, pedirSmbAppData } from './smbAppData.js';
import { registrarDecisionDeHistorial, leerCoordinador, coexistenceHistorySyncPath } from './historyCoordinator.js';
import type { MetaGraphClient, SmbAppDataSyncType } from './graphClient.js';

const TENANT = 'tnt_alpha';
const PNID = '900000002';
const PNID_PRINCIPAL = '900000001';
const T0 = 1_754_200_000_000;

interface Llamada { phoneNumberId: string; syncType: SmbAppDataSyncType; token: string }

const graph = (llamadas: Llamada[], fallaEn?: SmbAppDataSyncType): MetaGraphClient => ({
  exchangeCode: async () => ({ accessToken: '', tokenType: '', expiresInSec: null }),
  debugToken: async () => ({ isValid: true, scopes: [], wabaIds: [], expiresAtMs: null }),
  listWabaPhoneNumbers: async () => [],
  getPhoneNumber: async () => null,
  subscribeApp: async () => {},
  requestSmbAppData: async (phoneNumberId, syncType, token) => {
    llamadas.push({ phoneNumberId, syncType, token });
    return syncType === fallaEn ? { ok: false, error: 'graph_error_100' } : { ok: true };
  },
});

const sembrarNumeroNuevo = (): void => {
  docs.set(`tenants/${TENANT}/metaAssets/${PNID}`, {
    id: PNID, tenantId: TENANT, connectionId: `wa_${PNID}`, assetType: 'whatsapp_phone_number',
    externalId: PNID, status: 'active', selected: false,
  });
  docs.set(`metaExternalIndex/whatsapp_${PNID}`, { tenantId: TENANT, connectionId: `wa_${PNID}`, externalId: PNID });
};

const sembrarPrincipal = (): void => {
  docs.set(`tenants/${TENANT}/metaAssets/${PNID_PRINCIPAL}`, {
    id: PNID_PRINCIPAL, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number',
    externalId: PNID_PRINCIPAL, status: 'active', selected: true, automationMode: 'live',
  });
  docs.set(`metaExternalIndex/whatsapp_${PNID_PRINCIPAL}`, { tenantId: TENANT, connectionId: 'main', externalId: PNID_PRINCIPAL });
};

const decidirCompartir = (pnid = PNID) =>
  registrarDecisionDeHistorial({ tenantId: TENANT, phoneNumberId: pnid, connectionId: `wa_${pnid}`, decision: 'share', actorUid: 'uid-owner', onboardedAtMs: T0, nowMs: T0 + 1000 });

beforeEach(() => {
  docs.clear();
  versiones.clear();
  credsPedidas.length = 0;
  credsRespuesta = { ok: true, token: 'token-del-numero-nuevo' };
  vi.clearAllMocks();
});

describe('pedirSmbAppData — el orden del contrato', () => {
  it('pide primero la agenda y después el historial', async () => {
    const llamadas: Llamada[] = [];

    const r = await pedirSmbAppData(PNID, 'tok', graph(llamadas));

    expect(r).toEqual({ ok: true, syncTypes: ['smb_app_state_sync', 'history'] });
    expect(llamadas.map((l) => l.syncType)).toEqual(['smb_app_state_sync', 'history']);
  });

  it('si la primera falla, la segunda NI SE INTENTA y se declara hasta dónde se llegó', async () => {
    const llamadas: Llamada[] = [];

    const r = await pedirSmbAppData(PNID, 'tok', graph(llamadas, 'smb_app_state_sync'));

    expect(r).toMatchObject({ ok: false, syncTypes: [] });
    expect(llamadas).toHaveLength(1);
  });
});

describe('ejecutarSincronizacionDeHistorial — el disparo, una sola vez', () => {
  it('dispara con el token de ESA conexión y deja el coordinador en `requested`', async () => {
    sembrarNumeroNuevo();
    await decidirCompartir();
    const llamadas: Llamada[] = [];

    const r = await ejecutarSincronizacionDeHistorial(TENANT, PNID, graph(llamadas), T0 + 5000);

    expect(r).toEqual({ ok: true, syncTypes: ['smb_app_state_sync', 'history'] });
    expect(credsPedidas).toEqual([{ tenantId: TENANT, phoneNumberId: PNID }]);
    expect(llamadas.every((l) => l.token === 'token-del-numero-nuevo' && l.phoneNumberId === PNID)).toBe(true);
    const coord = await leerCoordinador(TENANT, PNID);
    expect(coord!.status).toBe('requested');
    expect(coord!.syncTypesRequested).toEqual(['smb_app_state_sync', 'history']);
  });

  it('el SEGUNDO intento no llega a llamar a Graph, y dice por qué', async () => {
    sembrarNumeroNuevo();
    await decidirCompartir();
    await ejecutarSincronizacionDeHistorial(TENANT, PNID, graph([]), T0 + 5000);
    const llamadas: Llamada[] = [];

    const r = await ejecutarSincronizacionDeHistorial(TENANT, PNID, graph(llamadas), T0 + 6000);

    expect(r).toMatchObject({ ok: false, motivo: 'ya_disparado' });
    expect((r as { explicacion: string }).explicacion).toMatch(/una sola vez/i);
    expect(llamadas).toEqual([]);
  });

  it('SIN decisión humana previa no se dispara nada', async () => {
    sembrarNumeroNuevo();
    const llamadas: Llamada[] = [];

    const r = await ejecutarSincronizacionDeHistorial(TENANT, PNID, graph(llamadas), T0 + 5000);

    expect(r).toMatchObject({ ok: false, motivo: 'sin_coordinador' });
    expect(llamadas).toEqual([]);
    expect(docs.has(coexistenceHistorySyncPath(TENANT, PNID))).toBe(false);
  });

  it('sobre el número PRINCIPAL se rechaza ANTES de reclamar y ANTES de Graph', async () => {
    sembrarPrincipal();
    await decidirCompartir(PNID_PRINCIPAL);
    const llamadas: Llamada[] = [];

    const r = await ejecutarSincronizacionDeHistorial(TENANT, PNID_PRINCIPAL, graph(llamadas), T0 + 5000);

    expect(r).toMatchObject({ ok: false, motivo: 'es_numero_principal' });
    expect(llamadas).toEqual([]);
    // El disparo NO se consumió: el coordinador sigue disponible para el número correcto.
    expect((await leerCoordinador(TENANT, PNID_PRINCIPAL))!.status).toBe('pending_request');
  });

  it('sin credenciales: el disparo NO se consume — es un fallo LOCAL con Meta sin enterarse (correctivo, MEDIO 14)', async () => {
    sembrarNumeroNuevo();
    await decidirCompartir();
    credsRespuesta = { ok: false, reason: 'token_unavailable' };
    const llamadas: Llamada[] = [];

    const r = await ejecutarSincronizacionDeHistorial(TENANT, PNID, graph(llamadas), T0 + 5000);

    expect(r).toMatchObject({ ok: false, motivo: 'sin_credenciales' });
    expect(llamadas).toEqual([]);
    // El comportamiento anterior consumía el ÚNICO disparo de la vida del número por un token
    // vencido local. Ahora el coordinador sigue disponible: arreglada la conexión, se dispara.
    const coord = await leerCoordinador(TENANT, PNID);
    expect(coord!.status).toBe('pending_request');
    expect(r.explicacion).toMatch(/NO se consumió/i);

    // Y arreglada la credencial, el disparo único funciona — una sola vez, como siempre.
    credsRespuesta = { ok: true, accessToken: 'token-ok' };
    const r2 = await ejecutarSincronizacionDeHistorial(TENANT, PNID, graph(llamadas), T0 + 6000);
    expect(r2.ok).toBe(true);
  });

  it('si Graph rechaza el historial, queda `failed` con la agenda ya pedida', async () => {
    sembrarNumeroNuevo();
    await decidirCompartir();
    const llamadas: Llamada[] = [];

    const r = await ejecutarSincronizacionDeHistorial(TENANT, PNID, graph(llamadas, 'history'), T0 + 5000);

    expect(r).toMatchObject({ ok: false, motivo: 'graph_error' });
    expect((r as { explicacion: string }).explicacion).toMatch(/Embedded Signup/);
    const coord = await leerCoordinador(TENANT, PNID);
    expect(coord!.status).toBe('failed');
    expect(coord!.syncTypesRequested).toEqual(['smb_app_state_sync']);
  });

  it('DOS disparos concurrentes: Graph se llama una sola vez', async () => {
    sembrarNumeroNuevo();
    await decidirCompartir();
    const llamadas: Llamada[] = [];

    const [a, b] = await Promise.all([
      ejecutarSincronizacionDeHistorial(TENANT, PNID, graph(llamadas), T0 + 5000),
      ejecutarSincronizacionDeHistorial(TENANT, PNID, graph(llamadas), T0 + 5001),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(llamadas.map((l) => l.syncType)).toEqual(['smb_app_state_sync', 'history']);
  });
});
