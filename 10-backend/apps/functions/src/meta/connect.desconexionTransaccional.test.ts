/**
 * connect.desconexionTransaccional.test.ts — DESCONECTAR MAIN ES UNA SOLA TRANSACCIÓN (ADR-0020, G12+G6)
 * =======================================================================================================
 * `disconnectMeta` escribía la conexión, borraba el secreto y DESPUÉS corría un batch con el
 * índice y los assets. Un fallo en el medio dejaba un `not_connected` que seguía ruteando (o un
 * ruteo muerto con una conexión que decía estar sana). El contrato nuevo:
 *
 *  · lecturas primero; UNA transacción con TODAS las escrituras (índice de main + assets phone
 *    marcados `disconnected` con merge + demás assets borrados + conexión → not_connected con
 *    tokenSecretRef '') — o todo o nada;
 *  · el retiro del secreto va DESPUÉS de la tx (compensable): si falla, la conexión ya quedó
 *    `not_connected` con ref vacía y el huérfano se retira en el reintento idempotente (naming
 *    determinístico) — nunca al revés;
 *  · la auditoría `meta.disconnected` lleva el ACTOR (G6).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();
/** Bitácora de eventos para verificar el ORDEN (tx → secreto → audit). */
const eventos: string[] = [];
/** Contadores por canal de escritura: la desconexión no puede escribir fuera de la tx. */
const contadores = { setsDirectos: 0, batchCommits: 0, txCommits: 0 };
/** Inyección de fallo: la transacción no confirma. */
const flags = { fallarTx: false, fallarRemove: false };

interface Op {
  tipo: 'set' | 'delete';
  path: string;
  data?: Record<string, unknown>;
  merge?: boolean;
}

const hijosDe = (col: string) =>
  [...docs.entries()]
    .filter(([k]) => k.startsWith(`${col}/`) && !k.slice(col.length + 1).includes('/'))
    .map(([k, v]) => ({ id: k.split('/').pop()!, ref: { path: k }, data: () => v }));

const aplicar = (ops: Op[]): void => {
  for (const op of ops) {
    if (op.tipo === 'delete') docs.delete(op.path);
    else docs.set(op.path, op.merge ? { ...(docs.get(op.path) ?? {}), ...op.data! } : { ...op.data! });
  }
};

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

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => {
        contadores.setsDirectos += 1;
        aplicar([{ tipo: 'set', path, data: d, merge: o?.merge === true }]);
      },
    }),
    collection: (path: string) => consulta(path),
    batch: () => {
      const ops: Op[] = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>, o?: { merge?: boolean }) =>
          ops.push({ tipo: 'set', path: ref.path, data, merge: o?.merge === true }),
        delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
        commit: async () => {
          contadores.batchCommits += 1;
          aplicar(ops);
        },
      };
    },
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const ops: Op[] = [];
      const tx = {
        get: leer,
        set: (ref: { path: string }, data: Record<string, unknown>, o?: { merge?: boolean }) =>
          ops.push({ tipo: 'set', path: ref.path, data, merge: o?.merge === true }),
        delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      };
      const r = await fn(tx);
      // Una transacción real que no confirma NO aplica ninguna operación.
      if (flags.fallarTx) throw new Error('fallo simulado del commit de la transacción');
      aplicar(ops);
      contadores.txCommits += 1;
      eventos.push('tx_commit');
      return r;
    },
  }),
  paths: {
    metaConnection: (t: string, id: string) => `tenants/${t}/metaConnections/${id}`,
    metaAssets: (t: string) => `tenants/${t}/metaAssets`,
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaExternalIndex: () => 'metaExternalIndex',
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));

const secretosBorrados: string[] = [];
vi.mock('../lib/secretStore.js', () => ({
  getSecretStore: () => ({
    remove: async (ref: string) => {
      eventos.push('secret_remove');
      if (flags.fallarRemove) throw new Error('fallo simulado del SecretStore');
      secretosBorrados.push(ref);
    },
  }),
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const auditar = vi.hoisted(() => vi.fn(async (_e: unknown) => {}));
vi.mock('../audit/audit.js', () => ({ recordAudit: auditar }));

import { disconnectMeta } from './connect.js';

const TENANT = 'tnt_alpha';
const PNID = '111222333';
const WABA = 'waba_1';
const connPath = `tenants/${TENANT}/metaConnections/main`;
const assetPath = (id: string) => `tenants/${TENANT}/metaAssets/${id}`;
const idxPath = (id: string) => `metaExternalIndex/${id}`;

function sembrarConexionActiva(): void {
  docs.set(connPath, { id: 'main', tenantId: TENANT, status: 'active', tokenSecretRef: `secret://firestore/meta-token-${TENANT}` });
  docs.set(assetPath(WABA), {
    id: WABA, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_business_account',
    externalId: WABA, status: 'active', selected: true,
  });
  docs.set(assetPath(PNID), {
    id: PNID, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number',
    externalId: PNID, status: 'active', selected: true, automationMode: 'live', sessionKey: 'active',
  });
  docs.set(idxPath(`whatsapp_${PNID}`), {
    id: `whatsapp_${PNID}`, tenantId: TENANT, connectionId: 'main', platform: 'whatsapp', externalId: PNID, status: 'active',
  });
  docs.set(idxPath(`waba_${WABA}`), {
    id: `waba_${WABA}`, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_business_account', externalId: WABA, status: 'active',
  });
}

beforeEach(() => {
  docs.clear();
  eventos.length = 0;
  secretosBorrados.length = 0;
  contadores.setsDirectos = 0;
  contadores.batchCommits = 0;
  contadores.txCommits = 0;
  flags.fallarTx = false;
  flags.fallarRemove = false;
  auditar.mockClear();
});

describe('G12 — la desconexión de main es UNA transacción', () => {
  it('todas las escrituras van por la transacción: cero sets directos y cero batches', async () => {
    sembrarConexionActiva();

    await disconnectMeta(TENANT, 'uid-owner');

    expect(contadores.txCommits).toBe(1);
    expect(contadores.setsDirectos).toBe(0);
    expect(contadores.batchCommits).toBe(0);
  });

  it('o todo o nada: si la tx no confirma, NO cambia nada (ni conexión, ni ruteo, ni secreto)', async () => {
    sembrarConexionActiva();
    flags.fallarTx = true;

    await expect(disconnectMeta(TENANT, 'uid-owner')).rejects.toThrow();

    expect(docs.get(connPath)?.['status']).toBe('active');
    expect(docs.get(connPath)?.['tokenSecretRef']).toBe(`secret://firestore/meta-token-${TENANT}`);
    expect(docs.has(idxPath(`whatsapp_${PNID}`))).toBe(true);
    expect(docs.has(assetPath(WABA))).toBe(true);
    expect(eventos).not.toContain('secret_remove');
    expect(auditar).not.toHaveBeenCalled();
  });

  it('el secreto se retira DESPUÉS de confirmar la transacción, nunca antes', async () => {
    sembrarConexionActiva();

    await disconnectMeta(TENANT, 'uid-owner');

    expect(eventos.indexOf('tx_commit')).toBeGreaterThanOrEqual(0);
    expect(eventos.indexOf('secret_remove')).toBeGreaterThan(eventos.indexOf('tx_commit'));
    expect(secretosBorrados).toEqual([`secret://firestore/meta-token-${TENANT}`, `secret://firestore/meta-token-pending-${TENANT}`]);
  });

  it('la tx deja el estado final completo: conexión not_connected sin ref, índice de main borrado, waba_ incluido', async () => {
    sembrarConexionActiva();

    await disconnectMeta(TENANT, 'uid-owner');

    expect(docs.get(connPath)?.['status']).toBe('not_connected');
    expect(docs.get(connPath)?.['tokenSecretRef']).toBe('');
    expect(docs.has(idxPath(`whatsapp_${PNID}`))).toBe(false);
    expect(docs.has(idxPath(`waba_${WABA}`))).toBe(false);
    expect(docs.has(assetPath(WABA))).toBe(false);
    // El asset del número se MARCA (merge): permiso y canal intactos.
    expect(docs.get(assetPath(PNID))?.['status']).toBe('disconnected');
    expect(docs.get(assetPath(PNID))?.['automationMode']).toBe('live');
    expect(docs.get(assetPath(PNID))?.['sessionKey']).toBe('active');
  });

  it('el secreto huérfano es REINTENTABLE: si el retiro falla, un segundo disconnect lo saca (naming determinístico)', async () => {
    sembrarConexionActiva();
    flags.fallarRemove = true;

    await disconnectMeta(TENANT, 'uid-owner');
    expect(docs.get(connPath)?.['status']).toBe('not_connected');
    expect(secretosBorrados).toEqual([]);

    // Reintento idempotente: la conexión ya no tiene ref, pero el nombre es determinístico.
    flags.fallarRemove = false;
    await disconnectMeta(TENANT, 'uid-owner');

    expect(secretosBorrados).toEqual([`secret://firestore/meta-token-${TENANT}`, `secret://firestore/meta-token-pending-${TENANT}`]);
  });
});

describe('G6 — la desconexión audita con ACTOR', () => {
  it('meta.disconnected lleva el actorUid propagado desde el callable', async () => {
    sembrarConexionActiva();

    await disconnectMeta(TENANT, 'uid-owner');

    expect(auditar).toHaveBeenCalledTimes(1);
    const entrada = auditar.mock.calls[0]![0] as { action?: string; actorUid?: string };
    expect(entrada.action).toBe('meta.disconnected');
    expect(entrada.actorUid).toBe('uid-owner');
  });
});
