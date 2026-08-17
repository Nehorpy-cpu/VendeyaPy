/**
 * metaConnect.lifecycle.test.ts — El lifecycle owner-facing gana verbos parametrizados (ADR-0020)
 * ================================================================================================
 * G4 — `verifyMetaChannel` acepta `connectionId` opcional (default `main`, validado con
 *      /^(main|wa_\d+)$/) y NO altera routing, token ni modo.
 * G7 — la verificación audita `meta.verified` con actor + connectionId + razón saneada.
 * G2/G11 — los motivos nuevos (`seleccion_invalida`, `waba_collision`, `waba_selection_required`)
 *      llegan al usuario como mensajes claros y SANEADOS.
 * RBAC — `completeMetaConnectWaba` y `metaDisconnect` (wa_) usan el MISMO gate estricto de
 *      `meta/authz.ts`: manager/seller/viewer quedan afuera.
 *
 * Mismo molde que `metaConnect.modo.test.ts`: se prueban los helpers exportados; los callables
 * son la cáscara que los aplica.
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

vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../../lib/firebase.js', () => ({
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
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaExternalIndex: () => 'metaExternalIndex',
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));

const guardarSecreto = vi.hoisted(() => vi.fn(async () => 'secret://nunca'));
vi.mock('../../lib/secretStore.js', () => ({
  getSecretStore: () => ({ get: async () => 'token-de-prueba', set: guardarSecreto, remove: async () => {} }),
}));

const auditar = vi.hoisted(() => vi.fn(async (_e: unknown) => {}));
vi.mock('../../audit/audit.js', () => ({ recordAudit: auditar }));

vi.mock('../../entitlements/entitlements.js', () => ({
  assertWhatsappNumbersEntitled: async () => {},
  resolveEntitlements: async () => ({ limits: { maxWhatsappNumbers: 10 } }),
}));

import { parseMetaConnectionId, verificarCanalConAuditoria, CONNECT_FAIL_MESSAGE } from './metaConnect.js';
import { resolveMetaConnectAuth } from '../../meta/authz.js';
import { META_REQUIRED_SCOPES } from '../../meta/scopes.js';
import type { MetaGraphClient } from '../../meta/graphClient.js';

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
  auditar.mockClear();
  guardarSecreto.mockClear();
  docs.set(conn('main'), { id: 'main', tenantId: TENANT, status: 'active', tokenSecretRef: 'secret://main' });
  docs.set(`tenants/${TENANT}/metaAssets/${PNID_QUE_VENDE}`, {
    id: PNID_QUE_VENDE, assetType: 'whatsapp_phone_number', externalId: PNID_QUE_VENDE, selected: true, status: 'active',
  });
  docs.set(`metaExternalIndex/whatsapp_${PNID_QUE_VENDE}`, {
    id: `whatsapp_${PNID_QUE_VENDE}`, tenantId: TENANT, connectionId: 'main', externalId: PNID_QUE_VENDE, status: 'active',
  });
});

describe('G4 — parseMetaConnectionId: qué conexión se puede nombrar desde el panel', () => {
  it('ausente ⇒ main (los llamadores de siempre no cambian)', () => {
    expect(parseMetaConnectionId(undefined)).toBe('main');
    expect(parseMetaConnectionId(null)).toBe('main');
    expect(parseMetaConnectionId('')).toBe('main');
    expect(parseMetaConnectionId('   ')).toBe('main');
  });

  it('main y wa_{pnid} son los únicos válidos', () => {
    expect(parseMetaConnectionId('main')).toBe('main');
    expect(parseMetaConnectionId('wa_123456')).toBe('wa_123456');
  });

  it('cualquier otra cosa se RECHAZA (no se degrada a main: sería verificar otro canal en silencio)', () => {
    expect(parseMetaConnectionId('wa_abc')).toBeNull();
    expect(parseMetaConnectionId('wa_')).toBeNull();
    expect(parseMetaConnectionId('otra')).toBeNull();
    expect(parseMetaConnectionId('../main')).toBeNull();
    expect(parseMetaConnectionId(42)).toBeNull();
    expect(parseMetaConnectionId({})).toBeNull();
  });
});

describe('G4+G7 — verificarCanalConAuditoria', () => {
  it('verifica la conexión wa_ pedida (deriva su PNID) y escribe el veredicto SOBRE ESA conexión', async () => {
    docs.set(conn(`wa_${PNID_NUEVO}`), { id: `wa_${PNID_NUEVO}`, tenantId: TENANT, status: 'pending_review', tokenSecretRef: 'secret://wa' });

    const r = await verificarCanalConAuditoria(TENANT, 'uid-owner', `wa_${PNID_NUEVO}`, graph);

    expect(r.ready).toBe(true);
    expect(pedidos).toEqual([PNID_NUEVO]);
    expect(docs.get(conn(`wa_${PNID_NUEVO}`))?.['status']).toBe('active');
    expect(docs.get(conn('main'))?.['status']).toBe('active');
  });

  it('audita meta.verified con actor + connectionId + razón saneada', async () => {
    await verificarCanalConAuditoria(TENANT, 'uid-owner', 'main', graph);

    expect(auditar).toHaveBeenCalledTimes(1);
    const entrada = auditar.mock.calls[0]![0] as { action?: string; actorUid?: string; metadata?: Record<string, unknown> };
    expect(entrada.action).toBe('meta.verified');
    expect(entrada.actorUid).toBe('uid-owner');
    expect(entrada.metadata?.['connectionId']).toBe('main');
    expect(entrada.metadata?.['reason']).toBe('ok');
  });

  it('NO toca routing ni credenciales: el índice queda igual y no se escribe ningún secreto', async () => {
    const idxAntes = { ...docs.get(`metaExternalIndex/whatsapp_${PNID_QUE_VENDE}`)! };

    await verificarCanalConAuditoria(TENANT, 'uid-owner', 'main', graph);

    expect(docs.get(`metaExternalIndex/whatsapp_${PNID_QUE_VENDE}`)).toEqual(idxAntes);
    expect(guardarSecreto).not.toHaveBeenCalled();
    // El token de la conexión tampoco cambió.
    expect(docs.get(conn('main'))?.['tokenSecretRef']).toBe('secret://main');
  });

  it('SIN REGRESIÓN: main sin opciones sigue verificando el asset seleccionado', async () => {
    const r = await verificarCanalConAuditoria(TENANT, 'uid-owner', 'main', graph);

    expect(r.ready).toBe(true);
    expect(pedidos).toEqual([PNID_QUE_VENDE]);
  });
});

describe('G2/G11 — los motivos nuevos llegan saneados', () => {
  it.each(['waba_selection_required', 'seleccion_invalida', 'waba_collision'] as const)('%s tiene mensaje claro sin filtrar nada operativo', (reason) => {
    const mensaje = CONNECT_FAIL_MESSAGE[reason];
    expect(typeof mensaje).toBe('string');
    expect(mensaje.length).toBeGreaterThan(20);
    expect(mensaje).not.toMatch(/token|secret|metaConnections|metaAssets|metaExternalIndex|metaOAuthStates/i);
  });
});

describe('RBAC — completeMetaConnectWaba y metaDisconnect (wa_) usan el gate estricto de meta/authz', () => {
  it('manager y seller quedan afuera (mismo veredicto que el resto de la superficie Meta)', () => {
    expect(resolveMetaConnectAuth({ role: 'TENANT_MANAGER', tenantId: TENANT }).ok).toBe(false);
    expect(resolveMetaConnectAuth({ role: 'SELLER', tenantId: TENANT }).ok).toBe(false);
    expect(resolveMetaConnectAuth({ role: 'TENANT_VIEWER', tenantId: TENANT }).ok).toBe(false);
  });

  it('owner de SU empresa y admin con tenant objetivo pasan', () => {
    expect(resolveMetaConnectAuth({ role: 'TENANT_OWNER', tenantId: TENANT }).ok).toBe(true);
    expect(resolveMetaConnectAuth({ role: 'PLATFORM_ADMIN' }, TENANT).ok).toBe(true);
  });
});
