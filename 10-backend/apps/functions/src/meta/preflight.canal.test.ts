/**
 * preflight.canal.test.ts — `verifyWhatsappChannel` estaba cableado a `main`
 * ==========================================================================
 * Leía `metaConnections/main`, buscaba el asset `selected` y escribía el estado en `main`. Un
 * número ADICIONAL vive en `wa_{pnid}` y su asset es `selected: false`, así que la verificación no
 * se podía reusar para él: o no encontraba el número, o —peor— escribía el veredicto de OTRO canal
 * sobre la conexión que está vendiendo.
 *
 * Se parametriza sin cambiar el default: quien llama sin opciones sigue verificando `main`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = vi.hoisted(() => new Map<string, Record<string, unknown>>());

const hijosDe = (col: string) =>
  [...docs.entries()]
    .filter(([k]) => k.startsWith(`${col}/`) && !k.slice(col.length + 1).includes('/'))
    .map(([k, v]) => ({ id: k.split('/').pop()!, ref: { path: k }, data: () => v }));

const consulta = (path: string, filtros: Array<{ campo: string; valor: unknown }>): Record<string, unknown> => ({
  get: async () => ({ docs: hijosDe(path).filter((d) => filtros.every((f) => (d.data() as Record<string, unknown>)[f.campo] === f.valor)) }),
  where: (campo: string, _op: string, valor: unknown) => consulta(path, [...filtros, { campo, valor }]),
  limit: () => consulta(path, filtros),
});

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
      },
    }),
    collection: (path: string) => consulta(path, []),
  }),
  paths: {
    metaConnection: (t: string, id: string) => `tenants/${t}/metaConnections/${id}`,
    metaAssets: (t: string) => `tenants/${t}/metaAssets`,
  },
}));

vi.mock('../lib/secretStore.js', () => ({
  getSecretStore: () => ({ get: async () => 'token-de-prueba', set: async () => '', remove: async () => {} }),
}));

import { verifyWhatsappChannel } from './preflight.js';
import { META_REQUIRED_SCOPES } from './scopes.js';
import type { MetaGraphClient } from './graphClient.js';

const TENANT = 'tnt_alpha';
const PNID_QUE_VENDE = '111222333';
const PNID_NUEVO = '444555666';
const conn = (id: string) => `tenants/${TENANT}/metaConnections/${id}`;

const pedidos: string[] = [];
const graph: MetaGraphClient = {
  exchangeCode: async () => ({ accessToken: '', tokenType: '', expiresInSec: null }),
  debugToken: async () => ({ isValid: true, scopes: [...META_REQUIRED_SCOPES], wabaIds: [], expiresAtMs: null }),
  listWabaPhoneNumbers: async () => [],
  getPhoneNumber: async (pnid) => {
    pedidos.push(pnid);
    return { id: pnid, displayPhoneNumber: 'numero-de-prueba', verifiedName: '', qualityRating: '', codeVerificationStatus: '' };
  },
  subscribeApp: async () => {},
};

beforeEach(() => {
  docs.clear();
  pedidos.length = 0;
  docs.set(conn('main'), { id: 'main', tenantId: TENANT, status: 'active', tokenSecretRef: 'secret://main' });
  docs.set(`tenants/${TENANT}/metaAssets/${PNID_QUE_VENDE}`, {
    id: PNID_QUE_VENDE, assetType: 'whatsapp_phone_number', externalId: PNID_QUE_VENDE, selected: true, status: 'active',
  });
});

describe('verifyWhatsappChannel — se puede verificar un canal que no es `main`', () => {
  it('verifica la conexión pedida y escribe el veredicto SOBRE ESA conexión', async () => {
    docs.set(conn(`wa_${PNID_NUEVO}`), { id: `wa_${PNID_NUEVO}`, tenantId: TENANT, status: 'pending_review', tokenSecretRef: 'secret://wa' });

    const r = await verifyWhatsappChannel(TENANT, graph, { connectionId: `wa_${PNID_NUEVO}`, phoneNumberId: PNID_NUEVO });

    expect(r.ready).toBe(true);
    expect(pedidos).toEqual([PNID_NUEVO]);
    expect(docs.get(conn(`wa_${PNID_NUEVO}`))?.['status']).toBe('active');
  });

  it('y NO toca la conexión que está vendiendo', async () => {
    docs.set(conn(`wa_${PNID_NUEVO}`), { id: `wa_${PNID_NUEVO}`, tenantId: TENANT, status: 'pending_review', tokenSecretRef: 'secret://wa' });

    await verifyWhatsappChannel(TENANT, graph, { connectionId: `wa_${PNID_NUEVO}`, phoneNumberId: PNID_NUEVO });

    expect(docs.get(conn('main'))?.['status']).toBe('active');
    expect(docs.get(conn('main'))?.['tokenSecretRef']).toBe('secret://main');
  });

  it('una conexión pedida que no existe no se resuelve contra `main` (no hereda su token)', async () => {
    const r = await verifyWhatsappChannel(TENANT, graph, { connectionId: `wa_${PNID_NUEVO}` });

    expect(r.ready).toBe(false);
    expect(r.reason).toBe('not_connected');
    expect(pedidos).toEqual([]);
  });

  it('SIN REGRESIÓN: sin opciones sigue verificando `main` con el asset seleccionado', async () => {
    const r = await verifyWhatsappChannel(TENANT, graph);

    expect(r.ready).toBe(true);
    expect(pedidos).toEqual([PNID_QUE_VENDE]);
    expect(docs.get(conn('main'))?.['status']).toBe('active');
  });
});
