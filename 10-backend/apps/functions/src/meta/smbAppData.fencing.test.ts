/**
 * smbAppData.fencing.test.ts — el disparo no puede escribir sobre una generación que no es la suya
 * =================================================================================================
 * Cierre correctivo sobre ADR-0017 §5. Dos carreras del mismo molde: entre que el disparo LEE el
 * coordinador y ESCRIBE su desenlace, un re-onboarding legítimo puede abrir la generación N+1 — y
 * la escritura, hecha sin exigir la generación que originó la lectura, aterriza sobre el ciclo
 * equivocado.
 *
 *  · H8 — el settlement de Graph descartaba la `syncGeneration` que devolvió el reclamo: una
 *    respuesta tardía de Graph del ciclo N cerraba o fallaba la generación N+1 recién abierta.
 *  · H10 — el precheck de vencimiento leía el coordinador y después mergeaba `expired` A CIEGAS:
 *    si N+1 abría entre la lectura y el merge, la ventana NUEVA de 24 h moría marcada vencida.
 *
 * El doble de Firestore acá tiene un gancho de lectura (`alLeerCoordinador`): es lo que permite
 * ABRIR la generación N+1 exactamente en la ventana de la carrera, de forma determinística.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();
const versiones = new Map<string, number>();

interface Op { path: string; data: Record<string, unknown>; merge?: boolean }

/**
 * Gancho de lectura: corre tras capturar el snapshot de una lectura suelta (no transaccional).
 * El TEST decide sobre qué path actuar y se auto-desarma — la primera lectura suelta del flujo es
 * la del asset (guard del principal), no la del coordinador, y el gancho no puede gastarse ahí.
 */
let alLeerCoordinador: ((path: string) => Promise<void>) | null = null;

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => {
        // El snapshot se captura ANTES de disparar el gancho: es exactamente la semántica de la
        // carrera real — la lectura ya ocurrió, el mundo cambia, y la escritura posterior decide
        // con el snapshot viejo en la mano.
        const data = docs.get(path);
        const existia = docs.has(path);
        if (alLeerCoordinador) await alLeerCoordinador(path);
        return { exists: existia, data: () => data };
      },
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
        const chocó = [...leidos].some(([p, v]) => (versiones.get(p) ?? 0) !== v);
        if (chocó) continue;
        for (const op of ops) {
          docs.set(op.path, op.merge ? { ...(docs.get(op.path) ?? {}), ...op.data } : { ...op.data });
          versiones.set(op.path, (versiones.get(op.path) ?? 0) + 1);
        }
        return r;
      }
      throw new Error('transacción sin converger');
    },
  }),
  paths: {
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));

vi.mock('../messaging/resolveWhatsappCreds.js', () => ({
  resolveTenantWhatsappCredsFor: async (_tenantId: string, phoneNumberId: string) => ({
    ok: true, phoneNumberId, accessToken: 'token-del-numero-nuevo', tokenExpiresAtMs: null,
  }),
}));

import { ejecutarSincronizacionDeHistorial } from './smbAppData.js';
import {
  abrirNuevaGeneracion,
  cerrarGeneracionPorOffboarding,
  coexistenceHistorySyncPath,
  registrarDecisionDeHistorial,
  type HistorySyncDoc,
} from './historyCoordinator.js';
import type { MetaGraphClient, SmbAppDataSyncType } from './graphClient.js';

const TENANT = 'tnt_carrera';
const PNID = '900000888';
const VIGENTE = coexistenceHistorySyncPath(TENANT, PNID);
const NOW = 1_754_400_000_000;
const DIA = 24 * 3_600_000;

const coordinador = () => docs.get(VIGENTE) as HistorySyncDoc | undefined;

interface Llamada { phoneNumberId: string; syncType: SmbAppDataSyncType }

/** Graph configurable: `alLlamar` corre DURANTE la llamada — la ventana real de la carrera H8. */
const graph = (
  llamadas: Llamada[],
  opts: { fallaEn?: SmbAppDataSyncType; alLlamar?: (syncType: SmbAppDataSyncType) => Promise<void> } = {},
): MetaGraphClient => ({
  exchangeCode: async () => ({ accessToken: '', tokenType: '', expiresInSec: null }),
  debugToken: async () => ({ isValid: true, scopes: [], wabaIds: [], expiresAtMs: null }),
  listWabaPhoneNumbers: async () => [],
  getPhoneNumber: async () => null,
  subscribeApp: async () => {},
  requestSmbAppData: async (phoneNumberId, syncType) => {
    llamadas.push({ phoneNumberId, syncType });
    if (opts.alLlamar) await opts.alLlamar(syncType);
    return syncType === opts.fallaEn ? { ok: false, error: 'graph_error_100' } : { ok: true };
  },
});

const sembrarNumeroNuevo = (): void => {
  docs.set(`tenants/${TENANT}/metaAssets/${PNID}`, {
    id: PNID, tenantId: TENANT, connectionId: `wa_${PNID}`, assetType: 'whatsapp_phone_number',
    externalId: PNID, status: 'active', selected: false,
  });
  docs.set(`metaExternalIndex/whatsapp_${PNID}`, { tenantId: TENANT, connectionId: `wa_${PNID}`, externalId: PNID });
};

/** Simula el re-onboarding legítimo completo: offboarding + claim nuevo ⇒ nace la generación 2. */
const reOnboardear = async (nowMs: number): Promise<void> => {
  await cerrarGeneracionPorOffboarding(TENANT, PNID, nowMs);
  await abrirNuevaGeneracion({
    tenantId: TENANT, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
    claimId: 'claim_reonboard', onboardedAtMs: nowMs, nowMs,
  });
};

beforeEach(() => {
  docs.clear();
  versiones.clear();
  alLeerCoordinador = null;
  vi.clearAllMocks();
});

describe('H8 — una respuesta tardía de Graph no cierra ni falla la generación siguiente', () => {
  it('si la gen 2 abre con la llamada Graph de la gen 1 EN VUELO, el settlement no la toca', async () => {
    sembrarNumeroNuevo();
    await registrarDecisionDeHistorial({
      tenantId: TENANT, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
      decision: 'share', actorUid: 'uid-owner', onboardedAtMs: NOW - 3_600_000, nowMs: NOW,
    });
    const llamadas: Llamada[] = [];
    // Durante la PRIMERA llamada a Graph (el reclamo de la gen 1 ya está hecho), el cliente
    // offboardea y rehace el Embedded Signup: nace la generación 2, virgen, `pending_request`.
    const g = graph(llamadas, {
      fallaEn: 'history',
      alLlamar: async (syncType) => { if (syncType === 'smb_app_state_sync') await reOnboardear(NOW + 2000); },
    });

    const r = await ejecutarSincronizacionDeHistorial(TENANT, PNID, g, NOW + 1000);

    // Para el LLAMADOR el disparo de la gen 1 falló — eso sigue siendo verdad y se dice.
    expect(r).toMatchObject({ ok: false, motivo: 'graph_error' });
    const c = coordinador();
    expect(c?.syncGeneration).toBe(2);
    // El defecto contra 2798296: el settlement de la gen 1 mergeaba `failed` + syncTypes sobre la
    // gen 2 recién nacida — su ÚNICO disparo moría antes de existir, y el panel mostraba un fallo
    // de un ciclo que jamás disparó.
    expect(c?.status).toBe('pending_request');
    expect(c?.syncTypesRequested).toEqual([]);
    expect(c?.errorMessage).toBe('');
  });
});

describe('H10 — el precheck de vencimiento no puede vencer una generación que no leyó', () => {
  it('si la gen 2 abre entre la lectura y el marcado, la ventana nueva NO queda `expired`', async () => {
    sembrarNumeroNuevo();
    // Gen 1 decidida `share` con la ventana YA vencida: el precheck va a querer marcar `expired`.
    await registrarDecisionDeHistorial({
      tenantId: TENANT, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
      decision: 'share', actorUid: 'uid-owner', onboardedAtMs: NOW - DIA - 3_600_000, nowMs: NOW - DIA - 3_500_000,
    });
    // La carrera exacta: la lectura del precheck ya capturó la gen 1 vencida; ANTES de la
    // escritura, un re-onboarding legítimo abre la gen 2 con su ventana de 24 h nueva.
    alLeerCoordinador = async (path) => {
      if (path !== VIGENTE) return; // las lecturas del asset/índice no son la ventana de la carrera
      alLeerCoordinador = null; // un solo uso: el re-onboarding ocurre UNA vez
      await reOnboardear(NOW);
    };
    const llamadas: Llamada[] = [];

    const r = await ejecutarSincronizacionDeHistorial(TENANT, PNID, graph(llamadas), NOW);

    // El veredicto del llamador salió del snapshot viejo y es honesto para ESE ciclo…
    expect(r).toMatchObject({ ok: false, motivo: 'vencido' });
    expect(llamadas).toEqual([]);
    const c = coordinador();
    expect(c?.syncGeneration).toBe(2);
    // …pero contra 2798296 el merge ciego dejaba la generación NUEVA `expired` con 24 h por
    // delante: el número re-onboardeado perdía su única ventana sin haberla usado.
    expect(c?.status).toBe('pending_request');
    expect(c?.errorMessage).toBe('');
  });
});
