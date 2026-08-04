import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §1 — UN NÚMERO NUEVO NACE SIN PERMISO PARA HABLAR.
 * ===========================================================
 * «`multiNumber.ts` lo escribe `active` y desde ese instante `process.ts` lo rutea al motor.» Esa
 * es la frase que hace peligroso dar de alta el número real de la perfumería: `status:'active'`
 * significaba a la vez «la credencial sirve» y «el bot puede contestar».
 *
 * Este archivo prueba el alta REAL (batch incluido) contra un Firestore de mentira y después
 * pregunta —con el MISMO resolvedor que usa el webhook— qué puede hacer ese número. La respuesta
 * tiene que ser: nada. El alta no escribe `automationMode`, y por eso el fail-closed lo deja en
 * `inactive` sin que el alta tenga que saber nada del gate.
 */

const docs = new Map<string, Record<string, unknown>>();

interface Op { tipo: 'set' | 'delete'; path: string; data?: Record<string, unknown>; merge?: boolean }
const ops: Op[] = [];

const aplicar = (op: Op): void => {
  if (op.tipo === 'delete') { docs.delete(op.path); return; }
  docs.set(op.path, op.merge ? { ...(docs.get(op.path) ?? {}), ...op.data } : op.data!);
};

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => aplicar({ tipo: 'set', path, data: d, merge: o?.merge === true }),
    }),
    batch: () => ({
      // El `merge` del batch se respeta: la desactivación escribe con merge y perder eso haría
      // creer al test que el documento se pisa entero (no es lo que hace Firestore).
      set: (ref: { path: string }, data: Record<string, unknown>, o?: { merge?: boolean }) =>
        ops.push({ tipo: 'set', path: ref.path, data, merge: o?.merge === true }),
      delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      commit: async () => { for (const op of ops) aplicar(op); ops.length = 0; },
    }),
    // El alta pasó de batch a transacción: el guard de propiedad del PNID tiene que leer el índice
    // en el MISMO acto en que lo reclama (antes había una ventana entre chequear y escribir).
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (ref: { path: string }) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        set: (ref: { path: string }, data: Record<string, unknown>, o?: { merge?: boolean }) =>
          ops.push({ tipo: 'set', path: ref.path, data, merge: o?.merge === true }),
        delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      };
      const r = await fn(tx);
      for (const op of ops) aplicar(op);
      ops.length = 0;
      return r;
    },
  }),
  paths: {
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaConnection: (t: string, id: string) => `tenants/${t}/metaConnections/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));
vi.mock('../lib/secretStore.js', () => ({ getSecretStore: () => ({ set: async (name: string) => name, remove: async () => undefined }) }));

import { runAddWhatsappNumber, deactivateWhatsappNumber, type AddNumberDeps } from './multiNumber.js';
import { resolveAutomationMode } from './automationMode.js';
import type { ManualWhatsappInput } from './manualConnect.js';
import type { MetaGraphClient } from './graphClient.js';

const TENANT = 'tnt_alpha';
const PNID_NUEVO = '444555666';

const input: ManualWhatsappInput = {
  wabaId: 'waba_1',
  phoneNumberId: PNID_NUEVO,
  displayPhoneNumber: '+595 991 111 222',
  businessName: 'Comercio de prueba',
  accessToken: 'tok-fake',
  tokenExpiresAtMs: null,
};

const graph = {
  subscribeApp: vi.fn(async () => undefined),
  debugToken: vi.fn(async () => ({ isValid: true })),
  getPhoneNumber: vi.fn(async () => ({ displayPhoneNumber: '+595 991 111 222' })),
} as unknown as MetaGraphClient;

const deps: AddNumberDeps = {
  collisionTenant: async () => null,
  getAsset: async () => null,
  countActiveNumbers: async () => 1,
  assertQuota: async () => {},
  storeToken: async (name) => name,
};

const assetPath = `tenants/${TENANT}/metaAssets/${PNID_NUEVO}`;
const idxPath = `metaExternalIndex/whatsapp_${PNID_NUEVO}`;

beforeEach(() => {
  docs.clear();
  ops.length = 0;
});

describe('runAddWhatsappNumber — el alta no reparte permisos', () => {
  it('el alta sigue funcionando: conexión, asset e índice quedan escritos', async () => {
    const r = await runAddWhatsappNumber(TENANT, input, 'admin_uid', graph, deps);

    expect(r.ok).toBe(true);
    expect(docs.get(assetPath)?.['status']).toBe('active');
    expect(docs.get(assetPath)?.['selected']).toBe(false);
    expect(docs.get(idxPath)?.['tenantId']).toBe(TENANT);
    expect(docs.get(`tenants/${TENANT}/metaConnections/wa_${PNID_NUEVO}`)?.['status']).toBe('active');
  });

  it('NO escribe `automationMode` en el asset ni en el índice', async () => {
    await runAddWhatsappNumber(TENANT, input, 'admin_uid', graph, deps);
    expect(docs.get(assetPath)).not.toHaveProperty('automationMode');
    expect(docs.get(idxPath)).not.toHaveProperty('automationMode');
  });

  it('el número recién dado de alta resuelve `inactive` en el gate del webhook', async () => {
    await runAddWhatsappNumber(TENANT, input, 'admin_uid', graph, deps);
    const r = await resolveAutomationMode(TENANT, PNID_NUEVO);
    expect(r.mode).toBe('inactive');
  });

  /**
   * ADR-0017 §2: el número nuevo estrena su propio canal. Si naciera sobre `active`, el primer
   * mensaje que reciba se mezclaría con la conversación abierta del número que ya vende —mismo
   * carrito, mismo takeover, mismo pedido pendiente—.
   */
  it('nace con su PROPIA `sessionKey`: jamás comparte la conversación del canal heredado', async () => {
    await runAddWhatsappNumber(TENANT, input, 'admin_uid', graph, deps);

    expect(docs.get(assetPath)?.['sessionKey']).toBe(`wa_${PNID_NUEVO}`);
    const r = await resolveAutomationMode(TENANT, PNID_NUEVO);
    expect(r.sessionKey).toBe(`wa_${PNID_NUEVO}`);
    expect(r.sessionKey).not.toBe('active');
  });
});

/**
 * DEFECTO 6 — desactivar y reconectar resucitaba un número en `live`.
 * ===================================================================
 * `deactivateWhatsappNumber` sacaba el número del índice y lo marcaba `status:'inactive'`, pero le
 * dejaba el `automationMode` intacto. Como la reconexión PRESERVA ese campo (requisito de
 * despliegue del ADR, para que el número que vende no quede mudo), el número apagado volvía a
 * `live` sin que ningún humano lo decidiera.
 *
 * Apagar un número es revocarle el permiso: la decisión humana queda ESCRITA, no implícita en el
 * `status`. Así ningún otro camino de reactivación puede devolverle la voz por accidente.
 */
describe('deactivateWhatsappNumber — apagar revoca el permiso', () => {
  const sembrarActivo = (extra: Record<string, unknown> = {}) => {
    docs.set(assetPath, {
      id: PNID_NUEVO, tenantId: TENANT, connectionId: `wa_${PNID_NUEVO}`, assetType: 'whatsapp_phone_number',
      externalId: PNID_NUEVO, status: 'active', selected: false, sessionKey: `wa_${PNID_NUEVO}`, ...extra,
    });
    docs.set(`tenants/${TENANT}/metaConnections/wa_${PNID_NUEVO}`, { id: `wa_${PNID_NUEVO}`, status: 'active', tokenSecretRef: 'ref' });
    docs.set(idxPath, { id: `whatsapp_${PNID_NUEVO}`, tenantId: TENANT, externalId: PNID_NUEVO, status: 'active' });
  };

  it('un número en `live` queda en `inactive` al desactivarlo', async () => {
    sembrarActivo({ automationMode: 'live' });

    const r = await deactivateWhatsappNumber(TENANT, PNID_NUEVO);

    expect(r.ok).toBe(true);
    expect(docs.get(assetPath)?.['automationMode']).toBe('inactive');
    expect(docs.get(assetPath)?.['status']).toBe('inactive');
    // Y el resolvedor del webhook lo confirma: ese número ya no puede contestarle a nadie.
    expect((await resolveAutomationMode(TENANT, PNID_NUEVO)).mode).toBe('inactive');
  });

  it('el resto de la desactivación sigue igual: fuera del índice y sin canal compartido', async () => {
    sembrarActivo({ automationMode: 'shadow' });

    await deactivateWhatsappNumber(TENANT, PNID_NUEVO);

    expect(docs.has(idxPath)).toBe(false);
    expect(docs.get(assetPath)?.['sessionKey']).toBe(`wa_${PNID_NUEVO}`);
  });
});
