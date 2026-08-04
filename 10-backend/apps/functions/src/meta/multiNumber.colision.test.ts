/**
 * multiNumber.colision.test.ts — la ventana entre CHEQUEAR y ESCRIBIR (TOCTOU)
 * =============================================================================
 * `runAddWhatsappNumber` chequeaba la colisión cross-tenant en el paso 1 (`deps.collisionTenant`)
 * y escribía el índice recién en el paso 5 (`batch.commit()`). Entre esas dos cosas hay una ventana
 * real: otro tenant que reclama el mismo PNID en el medio queda pisado, y sus inbounds pasan a
 * resolverse a ESTE tenant. El chequeo tiene que estar DENTRO de la escritura.
 *
 * El doble de Firestore de este archivo reproduce lo único que importa para verificarlo: una
 * transacción no aplica NADA si su cuerpo rechaza.
 *
 * Y de paso, dos cosas que estaban al lado: la conexión se marcaba con un `status` que NO pertenece
 * al enum `MetaConnectionStatus`, y el token se guardaba antes del batch — si el batch fallaba
 * quedaba un secreto huérfano.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { META_CONNECTION_STATUS } from '@vpw/shared';

const docs = new Map<string, Record<string, unknown>>();

interface Op { tipo: 'set' | 'delete'; path: string; data?: Record<string, unknown>; merge?: boolean }

const aplicar = (ops: Op[]): void => {
  for (const op of ops) {
    if (op.tipo === 'delete') docs.delete(op.path);
    else docs.set(op.path, op.merge ? { ...(docs.get(op.path) ?? {}), ...op.data! } : op.data!);
  }
};

const hijosDe = (col: string) =>
  [...docs.entries()]
    .filter(([k]) => k.startsWith(`${col}/`) && !k.slice(col.length + 1).includes('/'))
    .map(([k, v]) => ({ id: k.split('/').pop()!, ref: { path: k }, data: () => v }));

const consulta = (path: string, filtro?: { campo: string; valor: unknown }): Record<string, unknown> => ({
  __coleccion: path,
  __filtro: filtro,
  get: async () => ({ docs: hijosDe(path).filter((d) => !filtro || (d.data() as Record<string, unknown>)[filtro.campo] === filtro.valor) }),
  where: (campo: string, _op: string, valor: unknown) => consulta(path, { campo, valor }),
});

const leer = async (ref: { path?: string; __coleccion?: string; __filtro?: { campo: string; valor: unknown } }) => {
  if (ref.__coleccion) {
    const f = ref.__filtro;
    return { docs: hijosDe(ref.__coleccion).filter((d) => !f || (d.data() as Record<string, unknown>)[f.campo] === f.valor) };
  }
  const path = ref.path!;
  return { exists: docs.has(path), data: () => docs.get(path) };
};

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
    collection: (path: string) => consulta(path),
    batch: () => {
      const ops: Op[] = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => ops.push({ tipo: 'set', path: ref.path, data, merge: opts?.merge }),
        delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
        commit: async () => aplicar(ops),
      };
    },
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const ops: Op[] = [];
      const tx = {
        get: leer,
        set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => ops.push({ tipo: 'set', path: ref.path, data, merge: opts?.merge }),
        delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      };
      const r = await fn(tx);
      aplicar(ops);
      return r;
    },
  }),
  paths: {
    metaAssets: (t: string) => `tenants/${t}/metaAssets`,
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaConnection: (t: string, id: string) => `tenants/${t}/metaConnections/${id}`,
    metaExternalIndex: () => 'metaExternalIndex',
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));

const secretos = new Map<string, string>();
const borrarSecreto = vi.fn(async (ref: string) => { secretos.delete(ref); });
vi.mock('../lib/secretStore.js', () => ({
  getSecretStore: () => ({ set: async (n: string, v: string) => { secretos.set(`secret://${n}`, v); return `secret://${n}`; }, get: async () => null, remove: borrarSecreto }),
}));

import { runAddWhatsappNumber, deactivateWhatsappNumber, type AddNumberDeps } from './multiNumber.js';
import type { ManualWhatsappInput } from './manualConnect.js';
import type { MetaGraphClient } from './graphClient.js';

const TENANT = 'tnt_alpha';
const OTRO_TENANT = 'tnt_beta';
const PNID = '111222333';
const idxPath = (id: string) => `metaExternalIndex/whatsapp_${id}`;
const assetPath = (t: string, id: string) => `tenants/${t}/metaAssets/${id}`;
const connPath = (t: string, id: string) => `tenants/${t}/metaConnections/${id}`;

const input: ManualWhatsappInput = {
  wabaId: 'waba-1', phoneNumberId: PNID, displayPhoneNumber: 'numero-de-prueba',
  businessName: 'Test', accessToken: 'token-de-prueba', tokenExpiresAtMs: null,
};

const graph: MetaGraphClient = {
  exchangeCode: async () => ({ accessToken: '', tokenType: '', expiresInSec: null }),
  debugToken: async () => ({ isValid: true, scopes: [], wabaIds: [], expiresAtMs: null }),
  listWabaPhoneNumbers: async () => [],
  getPhoneNumber: async () => ({ id: PNID, displayPhoneNumber: 'numero-de-prueba', verifiedName: '', qualityRating: '', codeVerificationStatus: '' }),
  subscribeApp: async () => {},
};

/** El chequeo TEMPRANO dice «libre» a propósito: es exactamente la ventana del TOCTOU. */
const deps = (over: Partial<AddNumberDeps> = {}): AddNumberDeps => ({
  collisionTenant: async () => null,
  getAsset: async () => null,
  countActiveNumbers: async () => 0,
  assertQuota: async () => {},
  storeToken: async (name, token) => { secretos.set(`secret://${name}`, token); return `secret://${name}`; },
  ...over,
});

beforeEach(() => {
  docs.clear();
  secretos.clear();
  vi.clearAllMocks();
});

describe('runAddWhatsappNumber — la colisión se verifica DENTRO de la escritura', () => {
  const sembrarAjeno = () => {
    docs.set(idxPath(PNID), { id: `whatsapp_${PNID}`, tenantId: OTRO_TENANT, connectionId: 'main', externalId: PNID, status: 'active' });
  };

  it('si el PNID se ocupa entre el chequeo temprano y el commit, el alta se rechaza', async () => {
    sembrarAjeno();

    const r = await runAddWhatsappNumber(TENANT, input, 'admin', graph, deps());

    expect(r).toEqual({ ok: false, reason: 'phone_number_collision', conflictTenantId: OTRO_TENANT });
  });

  it('y no queda NADA escrito: ni índice robado, ni asset, ni conexión', async () => {
    sembrarAjeno();

    await runAddWhatsappNumber(TENANT, input, 'admin', graph, deps());

    expect(docs.get(idxPath(PNID))?.['tenantId']).toBe(OTRO_TENANT);
    expect(docs.has(assetPath(TENANT, PNID))).toBe(false);
    expect(docs.has(connPath(TENANT, `wa_${PNID}`))).toBe(false);
  });

  it('el secreto recién creado se limpia (no deja el token del número colgado)', async () => {
    sembrarAjeno();

    await runAddWhatsappNumber(TENANT, input, 'admin', graph, deps());

    expect(secretos.size).toBe(0);
  });

  it('SIN REGRESIÓN: con el PNID libre el alta escribe conexión, asset e índice', async () => {
    const r = await runAddWhatsappNumber(TENANT, input, 'admin', graph, deps());

    expect(r.ok).toBe(true);
    expect(docs.get(idxPath(PNID))?.['tenantId']).toBe(TENANT);
    expect(docs.get(assetPath(TENANT, PNID))?.['selected']).toBe(false);
    expect(docs.get(connPath(TENANT, `wa_${PNID}`))?.['status']).toBe('active');
  });

  it('SIN REGRESIÓN: el asset nace SIN permiso de automatización (ADR-0017 §1)', async () => {
    await runAddWhatsappNumber(TENANT, input, 'admin', graph, deps());

    expect(docs.get(assetPath(TENANT, PNID))).not.toHaveProperty('automationMode');
    expect(docs.get(assetPath(TENANT, PNID))?.['sessionKey']).toBe(`wa_${PNID}`);
  });
});

describe('deactivateWhatsappNumber — el estado de la conexión pertenece al enum', () => {
  it('el `status` escrito es un MetaConnectionStatus válido (si no, el panel lee un estado que no existe)', async () => {
    docs.set(assetPath(TENANT, PNID), {
      id: PNID, tenantId: TENANT, connectionId: `wa_${PNID}`, assetType: 'whatsapp_phone_number',
      externalId: PNID, status: 'active', selected: false,
    });
    docs.set(connPath(TENANT, `wa_${PNID}`), { id: `wa_${PNID}`, tenantId: TENANT, status: 'active', tokenSecretRef: '' });

    const r = await deactivateWhatsappNumber(TENANT, PNID);

    expect(r).toEqual({ ok: true });
    const status = docs.get(connPath(TENANT, `wa_${PNID}`))?.['status'] as string;
    expect(META_CONNECTION_STATUS as readonly string[]).toContain(status);
  });

  it('SIN REGRESIÓN: sigue revocando el permiso y sacándolo del índice', async () => {
    docs.set(assetPath(TENANT, PNID), {
      id: PNID, tenantId: TENANT, connectionId: `wa_${PNID}`, assetType: 'whatsapp_phone_number',
      externalId: PNID, status: 'active', selected: false, automationMode: 'live',
    });
    docs.set(connPath(TENANT, `wa_${PNID}`), { id: `wa_${PNID}`, tenantId: TENANT, status: 'active', tokenSecretRef: '' });
    docs.set(idxPath(PNID), { id: `whatsapp_${PNID}`, tenantId: TENANT, externalId: PNID, status: 'active' });

    await deactivateWhatsappNumber(TENANT, PNID);

    expect(docs.get(assetPath(TENANT, PNID))?.['automationMode']).toBe('inactive');
    expect(docs.has(idxPath(PNID))).toBe(false);
  });
});
