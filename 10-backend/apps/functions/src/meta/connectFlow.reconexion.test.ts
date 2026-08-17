/**
 * connectFlow.reconexion.test.ts — RECONECTAR se distingue de CONECTAR en la auditoría (ADR-0020, G7)
 * ===================================================================================================
 * Un reemplazo del token sobre una conexión que YA estaba `active` no es un alta: es una
 * reconexión, y la bitácora tiene que decirlo (`meta.reconnected`). El payload sigue siendo el
 * mismo enmascarado del `meta.connected` actual: sin token, sin PNID crudo.
 *
 * Y el contrato existente queda cubierto por test discriminante: si el reemplazo falla
 * (token inválido), la conexión anterior queda OPERATIVA y no se registra ninguna conexión.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MetaPhoneNumber, MetaGraphClient, DebugTokenResult } from './graphClient.js';

const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const secretos = new Map<string, string>();
  return {
    docs,
    secretos,
    escribirAssets: vi.fn(async (_t: string, _c: string, _a: unknown[]) => {}),
    guardarSecreto: vi.fn(async (name: string, valor: string) => {
      const ref = `secret://${name}`;
      secretos.set(ref, valor);
      return ref;
    }),
    borrarSecreto: vi.fn(async (ref: string) => {
      secretos.delete(ref);
    }),
    auditar: vi.fn(async (_e: unknown) => {}),
    verificar: vi.fn(async () => ({ ready: true, reason: 'ok', status: 'active' })),
  };
});

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: h.docs.has(path), data: () => h.docs.get(path) }),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        h.docs.set(path, opts?.merge ? { ...(h.docs.get(path) ?? {}), ...data } : { ...data });
      },
    }),
  }),
  paths: { metaConnection: (t: string, id: string) => `tenants/${t}/metaConnections/${id}` },
}));

vi.mock('../lib/secretStore.js', () => ({
  getSecretStore: () => ({ set: h.guardarSecreto, get: async (ref: string) => h.secretos.get(ref) ?? null, remove: h.borrarSecreto }),
}));

vi.mock('./discovery.js', () => ({
  buildMetaAssets: (i: { phones: MetaPhoneNumber[] }) =>
    i.phones.map((p) => ({ externalId: p.id, assetType: 'whatsapp_phone_number', name: p.id, selected: true })),
  writeDiscoveredAssets: h.escribirAssets,
}));

vi.mock('./preflight.js', () => ({ verifyWhatsappChannel: h.verificar }));

vi.mock('../entitlements/entitlements.js', () => ({
  resolveEntitlements: async () => ({ limits: { maxWhatsappNumbers: 10 } }),
}));

vi.mock('../audit/audit.js', () => ({ recordAudit: h.auditar }));

import { runMetaConnect } from './connectFlow.js';

const TENANT = 'tnt_alpha';
const WABA = 'waba_1';
const PNID = '111222333';
const CONN = `tenants/${TENANT}/metaConnections/main`;
const REF_PREVIA = `secret://meta-token-${TENANT}`;

const numero = (id: string): MetaPhoneNumber => ({
  id,
  displayPhoneNumber: id,
  verifiedName: '',
  qualityRating: '',
  codeVerificationStatus: '',
});

const SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management'];

const graphFake = (over: Partial<MetaGraphClient> & { dbg?: Partial<DebugTokenResult> } = {}): MetaGraphClient => ({
  exchangeCode: async () => ({ accessToken: 'token-nuevo', tokenType: 'bearer', expiresInSec: null }),
  debugToken: async () => ({ isValid: true, scopes: SCOPES, wabaIds: [WABA], expiresAtMs: null, ...over.dbg }),
  listWabaPhoneNumbers: async () => [numero(PNID)],
  getPhoneNumber: async () => null,
  subscribeApp: async () => {},
  ...over,
});

const sembrarConexionActiva = (): void => {
  h.docs.set(CONN, { id: 'main', tenantId: TENANT, status: 'active', tokenSecretRef: REF_PREVIA, scopes: SCOPES });
  h.secretos.set(REF_PREVIA, 'token-que-vende');
};

const accionAuditada = (): string => (h.auditar.mock.calls[0]?.[0] as { action?: string } | undefined)?.action ?? '';

beforeEach(() => {
  h.docs.clear();
  h.secretos.clear();
  vi.clearAllMocks();
  h.escribirAssets.mockImplementation(async () => {});
  h.verificar.mockImplementation(async () => ({ ready: true, reason: 'ok', status: 'active' }));
});

describe('G7 — la reconexión se audita como meta.reconnected', () => {
  it('conexión previa `active` + connect exitoso ⇒ meta.reconnected (no meta.connected)', async () => {
    sembrarConexionActiva();

    const r = await runMetaConnect(TENANT, { code: 'code-nuevo' }, 'uid-1', graphFake());

    expect(r.ok).toBe(true);
    expect(h.auditar).toHaveBeenCalledTimes(1);
    expect(accionAuditada()).toBe('meta.reconnected');
  });

  it('el payload de la reconexión sigue enmascarado: sin PNID crudo y sin token', async () => {
    sembrarConexionActiva();

    await runMetaConnect(TENANT, { code: 'code-nuevo' }, 'uid-1', graphFake());

    const entrada = h.auditar.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(entrada)).not.toContain(PNID);
    expect(JSON.stringify(entrada)).not.toContain('token-nuevo');
    expect(entrada['actorUid']).toBe('uid-1');
  });

  it('SIN conexión previa sigue siendo meta.connected (el alta no cambia)', async () => {
    const r = await runMetaConnect(TENANT, { code: 'code-nuevo' }, 'uid-1', graphFake());

    expect(r.ok).toBe(true);
    expect(accionAuditada()).toBe('meta.connected');
  });

  it('una conexión previa NO activa (not_connected) también audita meta.connected: no había nada operativo que reemplazar', async () => {
    h.docs.set(CONN, { id: 'main', tenantId: TENANT, status: 'not_connected', tokenSecretRef: '' });

    const r = await runMetaConnect(TENANT, { code: 'code-nuevo' }, 'uid-1', graphFake());

    expect(r.ok).toBe(true);
    expect(accionAuditada()).toBe('meta.connected');
  });
});

describe('G7 — la reconexión FALLIDA no degrada ni audita', () => {
  it('token inválido ⇒ la conexión previa queda operativa (status + ref + valor del secreto) y sin auditoría', async () => {
    sembrarConexionActiva();

    const r = await runMetaConnect(TENANT, { code: 'code-nuevo' }, 'uid-1', graphFake({ dbg: { isValid: false } }));

    expect(r.ok).toBe(false);
    expect(h.docs.get(CONN)?.['status']).toBe('active');
    expect(h.docs.get(CONN)?.['tokenSecretRef']).toBe(REF_PREVIA);
    expect(h.secretos.get(REF_PREVIA)).toBe('token-que-vende');
    expect(h.auditar).not.toHaveBeenCalled();
  });
});
