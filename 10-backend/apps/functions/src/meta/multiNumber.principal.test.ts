/**
 * multiNumber.principal.test.ts — el alta de un número ADICIONAL no puede pisar al PRINCIPAL
 * ============================================================================================
 * `multiNumber.ts` se documenta a sí mismo con «NUNCA pisa al principal», pero el único freno que
 * tenía era el guard de `already_active`: si el asset del número principal NO estaba en `active`
 * —lo deja así un preflight que falló, un token vencido, una verificación en `error`— el alta lo
 * reescribía entero, porque el asset se direcciona por PNID y es EL MISMO DOCUMENTO.
 *
 * Lo que se perdía en esa reescritura, sobre el número que está vendiendo AHORA:
 *   · `selected: true` → `resolveTenantWhatsappCreds` exige `selected` para resolver el número por
 *     defecto: el tenant se queda sin canal de salida.
 *   · `connectionId: 'main'` → pasa a `wa_{pnid}`, o sea el ruteo apunta a otra conexión y a otro
 *     token, y `derivarSessionKey` deja de considerarlo el canal heredado: su conversación viva
 *     (carrito, takeover, pedido pendiente) se muda de documento.
 *
 * Esto deja de ser hipotético con Coexistence: el WABA que entra por el onboarding del número real
 * puede LISTAR el número que ya vende, y ahí el alta y el desastre son la misma llamada.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('../lib/secretStore.js', () => ({
  getSecretStore: () => ({ set: async (n: string, v: string) => { secretos.set(`secret://${n}`, v); return `secret://${n}`; }, get: async () => null, remove: async (r: string) => { secretos.delete(r); } }),
}));

import { runAddWhatsappNumber, type AddNumberDeps } from './multiNumber.js';
import type { ManualWhatsappInput } from './manualConnect.js';
import type { MetaGraphClient } from './graphClient.js';

const TENANT = 'tnt_alpha';
const PNID_PRINCIPAL = '900000001';
const PNID_NUEVO = '900000002';
const assetPath = (id: string) => `tenants/${TENANT}/metaAssets/${id}`;
const idxPath = (id: string) => `metaExternalIndex/whatsapp_${id}`;
const connPath = (id: string) => `tenants/${TENANT}/metaConnections/${id}`;

const input = (pnid: string): ManualWhatsappInput => ({
  wabaId: 'waba-1', phoneNumberId: pnid, displayPhoneNumber: 'numero-de-prueba',
  businessName: 'Test', accessToken: 'token-de-prueba', tokenExpiresAtMs: null,
});

const graph: MetaGraphClient = {
  exchangeCode: async () => ({ accessToken: '', tokenType: '', expiresInSec: null }),
  debugToken: async () => ({ isValid: true, scopes: [], wabaIds: [], expiresAtMs: null }),
  listWabaPhoneNumbers: async () => [],
  getPhoneNumber: async (id) => ({ id, displayPhoneNumber: 'numero-de-prueba', verifiedName: '', qualityRating: '', codeVerificationStatus: '' }),
  subscribeApp: async () => {},
  requestSmbAppData: async () => ({ ok: true }),
};

const deps = (over: Partial<AddNumberDeps> = {}): AddNumberDeps => ({
  collisionTenant: async () => null,
  getAsset: async (t, p) => (docs.get(assetPath(p)) as never) ?? null,
  countActiveNumbers: async () => 0,
  assertQuota: async () => {},
  storeToken: async (name, token) => { secretos.set(`secret://${name}`, token); return `secret://${name}`; },
  ...over,
});

/**
 * El principal CON EL ASSET CAÍDO: exactamente el estado que dejaba un preflight fallido o un
 * token vencido, y el único en el que el guard de `already_active` no frenaba nada.
 */
const sembrarPrincipalCaido = (): void => {
  docs.set(assetPath(PNID_PRINCIPAL), {
    id: PNID_PRINCIPAL, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number',
    externalId: PNID_PRINCIPAL, name: 'el que vende', status: 'error', selected: true, automationMode: 'live',
  });
  docs.set(idxPath(PNID_PRINCIPAL), {
    id: `whatsapp_${PNID_PRINCIPAL}`, tenantId: TENANT, connectionId: 'main',
    assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID_PRINCIPAL, status: 'active',
  });
  docs.set(connPath('main'), { id: 'main', tenantId: TENANT, status: 'active', tokenSecretRef: 'secret://meta-token-tnt_alpha' });
  secretos.set('secret://meta-token-tnt_alpha', 'token-del-que-vende');
};

beforeEach(() => {
  docs.clear();
  secretos.clear();
  vi.clearAllMocks();
});

describe('runAddWhatsappNumber — el número PRINCIPAL no se da de alta como adicional', () => {
  it('se rechaza con un motivo propio', async () => {
    sembrarPrincipalCaido();

    const r = await runAddWhatsappNumber(TENANT, input(PNID_PRINCIPAL), 'admin', graph, deps());

    expect(r).toEqual({ ok: false, reason: 'is_main_number' });
  });

  it('el asset del que vende queda INTACTO: sigue seleccionado y sigue en la conexión main', async () => {
    sembrarPrincipalCaido();

    await runAddWhatsappNumber(TENANT, input(PNID_PRINCIPAL), 'admin', graph, deps());

    const asset = docs.get(assetPath(PNID_PRINCIPAL))!;
    expect(asset['selected']).toBe(true);
    expect(asset['connectionId']).toBe('main');
    expect(asset['automationMode']).toBe('live');
    expect(asset).not.toHaveProperty('sessionKey');
  });

  it('el índice de ruteo sigue apuntando a `main`, no a una conexión nueva', async () => {
    sembrarPrincipalCaido();

    await runAddWhatsappNumber(TENANT, input(PNID_PRINCIPAL), 'admin', graph, deps());

    expect(docs.get(idxPath(PNID_PRINCIPAL))?.['connectionId']).toBe('main');
    expect(docs.has(connPath(`wa_${PNID_PRINCIPAL}`))).toBe(false);
  });

  it('no se crea ningún secreto nuevo y el del principal sigue ahí', async () => {
    sembrarPrincipalCaido();

    await runAddWhatsappNumber(TENANT, input(PNID_PRINCIPAL), 'admin', graph, deps());

    expect([...secretos.keys()]).toEqual(['secret://meta-token-tnt_alpha']);
    expect(secretos.get('secret://meta-token-tnt_alpha')).toBe('token-del-que-vende');
  });

  it('también se rechaza cuando el índice dice `main` aunque el asset no lo diga', async () => {
    // El desempate no puede depender de un solo documento: si el asset quedó a medio escribir, el
    // índice sigue siendo el que rutea los inbounds de ese número.
    docs.set(idxPath(PNID_PRINCIPAL), { id: `whatsapp_${PNID_PRINCIPAL}`, tenantId: TENANT, connectionId: 'main', externalId: PNID_PRINCIPAL, status: 'active' });

    const r = await runAddWhatsappNumber(TENANT, input(PNID_PRINCIPAL), 'admin', graph, deps());

    expect(r).toEqual({ ok: false, reason: 'is_main_number' });
  });

  it('SIN REGRESIÓN: un número DISTINTO se sigue dando de alta con normalidad', async () => {
    sembrarPrincipalCaido();

    const r = await runAddWhatsappNumber(TENANT, input(PNID_NUEVO), 'admin', graph, deps());

    expect(r.ok).toBe(true);
    expect(docs.get(assetPath(PNID_NUEVO))?.['connectionId']).toBe(`wa_${PNID_NUEVO}`);
    expect(docs.get(assetPath(PNID_NUEVO))?.['selected']).toBe(false);
    // Y el que vende sigue igual que antes.
    expect(docs.get(assetPath(PNID_PRINCIPAL))?.['selected']).toBe(true);
    expect(docs.get(idxPath(PNID_PRINCIPAL))?.['connectionId']).toBe('main');
  });
});
