/**
 * multiNumber.disconnectOwner.test.ts — EL OWNER PUEDE DAR DE BAJA SU NÚMERO wa_{pnid} (ADR-0020, G3)
 * ====================================================================================================
 * `metaDisconnect` solo sabía desconectar `main`; la baja de un número de Coexistence era
 * PLATFORM_ADMIN-only. La baja del owner REUTILIZA la lógica de `deactivateWhatsappNumber`
 * (asset inactive con permiso revocado, SU entrada de índice borrada, SU conexión `wa_*` a
 * not_connected y SU secreto retirado — orden compensable) y audita `meta.number_deactivated`
 * con actor. JAMÁS toca `main` ni números de otro tenant. Nada se borra dentro de Meta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();

interface Op {
  tipo: 'set' | 'delete';
  path: string;
  data?: Record<string, unknown>;
  merge?: boolean;
}

const ops: Op[] = [];
const aplicar = (): void => {
  for (const op of ops) {
    if (op.tipo === 'delete') docs.delete(op.path);
    else docs.set(op.path, op.merge ? { ...(docs.get(op.path) ?? {}), ...op.data! } : { ...op.data! });
  }
  ops.length = 0;
};

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => {
        docs.set(path, o?.merge ? { ...(docs.get(path) ?? {}), ...d } : { ...d });
      },
    }),
    batch: () => ({
      set: (ref: { path: string }, data: Record<string, unknown>, o?: { merge?: boolean }) =>
        ops.push({ tipo: 'set', path: ref.path, data, merge: o?.merge === true }),
      delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      commit: async () => aplicar(),
    }),
  }),
  paths: {
    metaConnection: (t: string, id: string) => `tenants/${t}/metaConnections/${id}`,
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaAssets: (t: string) => `tenants/${t}/metaAssets`,
    metaExternalIndex: () => 'metaExternalIndex',
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));

const secretosBorrados: string[] = [];
vi.mock('../lib/secretStore.js', () => ({
  getSecretStore: () => ({ remove: async (ref: string) => { secretosBorrados.push(ref); } }),
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const auditar = vi.hoisted(() => vi.fn(async (_e: unknown) => {}));
vi.mock('../audit/audit.js', () => ({ recordAudit: auditar }));

import { disconnectWhatsappNumberConnection } from './multiNumber.js';

const TENANT = 'tnt_alpha';
const OTRO_TENANT = 'tnt_beta';
const PNID_MAIN = '111222333';
const PNID_COEX = '777888999';
const PNID_AJENO = '444555666';

const assetPath = (t: string, id: string) => `tenants/${t}/metaAssets/${id}`;
const connPath = (t: string, id: string) => `tenants/${t}/metaConnections/${id}`;
const idxPath = (id: string) => `metaExternalIndex/whatsapp_${id}`;

function sembrarTenant(): void {
  // Principal vendiendo.
  docs.set(connPath(TENANT, 'main'), { id: 'main', tenantId: TENANT, status: 'active', tokenSecretRef: 'secret://main' });
  docs.set(assetPath(TENANT, PNID_MAIN), {
    id: PNID_MAIN, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number',
    externalId: PNID_MAIN, status: 'active', selected: true, automationMode: 'live',
  });
  docs.set(idxPath(PNID_MAIN), { id: `whatsapp_${PNID_MAIN}`, tenantId: TENANT, connectionId: 'main', externalId: PNID_MAIN, status: 'active' });
  // Número de Coexistence en su propia conexión.
  docs.set(connPath(TENANT, `wa_${PNID_COEX}`), {
    id: `wa_${PNID_COEX}`, tenantId: TENANT, status: 'active', tokenSecretRef: `secret://wa-${PNID_COEX}`, source: 'embedded_signup',
  });
  docs.set(assetPath(TENANT, PNID_COEX), {
    id: PNID_COEX, tenantId: TENANT, connectionId: `wa_${PNID_COEX}`, assetType: 'whatsapp_phone_number',
    externalId: PNID_COEX, status: 'active', selected: false, automationMode: 'shadow', sessionKey: `wa_${PNID_COEX}`,
  });
  docs.set(idxPath(PNID_COEX), { id: `whatsapp_${PNID_COEX}`, tenantId: TENANT, connectionId: `wa_${PNID_COEX}`, externalId: PNID_COEX, status: 'active' });
  // Un número de OTRO tenant, para el aislamiento.
  docs.set(assetPath(OTRO_TENANT, PNID_AJENO), {
    id: PNID_AJENO, tenantId: OTRO_TENANT, connectionId: `wa_${PNID_AJENO}`, assetType: 'whatsapp_phone_number',
    externalId: PNID_AJENO, status: 'active', selected: false,
  });
  docs.set(idxPath(PNID_AJENO), { id: `whatsapp_${PNID_AJENO}`, tenantId: OTRO_TENANT, connectionId: `wa_${PNID_AJENO}`, externalId: PNID_AJENO, status: 'active' });
}

beforeEach(() => {
  docs.clear();
  ops.length = 0;
  secretosBorrados.length = 0;
  auditar.mockClear();
  sembrarTenant();
});

describe('G3 — baja owner-facing de una conexión wa_{pnid}', () => {
  it('da de baja SOLO ese número: asset inactive con permiso revocado, índice borrado, conexión not_connected, secreto retirado', async () => {
    const r = await disconnectWhatsappNumberConnection(TENANT, `wa_${PNID_COEX}`, 'uid-owner');

    expect(r.ok).toBe(true);
    expect(docs.get(assetPath(TENANT, PNID_COEX))?.['status']).toBe('inactive');
    expect(docs.get(assetPath(TENANT, PNID_COEX))?.['automationMode']).toBe('inactive');
    expect(docs.has(idxPath(PNID_COEX))).toBe(false);
    expect(docs.get(connPath(TENANT, `wa_${PNID_COEX}`))?.['status']).toBe('not_connected');
    expect(secretosBorrados).toEqual([`secret://wa-${PNID_COEX}`]);
  });

  it('audita meta.number_deactivated con el ACTOR', async () => {
    await disconnectWhatsappNumberConnection(TENANT, `wa_${PNID_COEX}`, 'uid-owner');

    expect(auditar).toHaveBeenCalledTimes(1);
    const entrada = auditar.mock.calls[0]![0] as { action?: string; actorUid?: string; metadata?: Record<string, unknown> };
    expect(entrada.action).toBe('meta.number_deactivated');
    expect(entrada.actorUid).toBe('uid-owner');
    expect(entrada.metadata?.['connectionId']).toBe(`wa_${PNID_COEX}`);
  });

  it('JAMÁS toca main: el asset, el índice y la conexión del principal quedan intactos', async () => {
    await disconnectWhatsappNumberConnection(TENANT, `wa_${PNID_COEX}`, 'uid-owner');

    expect(docs.get(assetPath(TENANT, PNID_MAIN))?.['status']).toBe('active');
    expect(docs.has(idxPath(PNID_MAIN))).toBe(true);
    expect(docs.get(connPath(TENANT, 'main'))?.['status']).toBe('active');
    expect(docs.get(connPath(TENANT, 'main'))?.['tokenSecretRef']).toBe('secret://main');
  });

  it('la conexión del PRINCIPAL no se baja por acá (wa_ del pnid principal ⇒ rechazo sin escrituras)', async () => {
    const r = await disconnectWhatsappNumberConnection(TENANT, `wa_${PNID_MAIN}`, 'uid-owner');

    expect(r.ok).toBe(false);
    expect(docs.get(assetPath(TENANT, PNID_MAIN))?.['status']).toBe('active');
    expect(docs.has(idxPath(PNID_MAIN))).toBe(true);
    expect(auditar).not.toHaveBeenCalled();
  });

  it('AISLAMIENTO: el pnid de OTRO tenant ⇒ not_found y sus documentos quedan intactos', async () => {
    const r = await disconnectWhatsappNumberConnection(TENANT, `wa_${PNID_AJENO}`, 'uid-owner');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
    expect(docs.get(assetPath(OTRO_TENANT, PNID_AJENO))?.['status']).toBe('active');
    expect(docs.has(idxPath(PNID_AJENO))).toBe(true);
    expect(auditar).not.toHaveBeenCalled();
  });

  it('un rechazo no audita ni borra secretos (nada que registrar: nada pasó)', async () => {
    await disconnectWhatsappNumberConnection(TENANT, 'wa_inexistente', 'uid-owner');

    expect(auditar).not.toHaveBeenCalled();
    expect(secretosBorrados).toEqual([]);
  });
});
