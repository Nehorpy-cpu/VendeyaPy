/**
 * discovery.wabaGuard.test.ts — DOS TENANTS NO PUEDEN RECLAMAR EL MISMO WABA (ADR-0020, G11)
 * ===========================================================================================
 * El PNID ya tenía guard transaccional (`assertPnidLibre`); el WABA no: dos tenants podían
 * reclamar la misma cuenta de WhatsApp Business con números distintos y quedar entrelazados.
 * El discovery escribe ahora `metaExternalIndex/waba_{id}` en la MISMA transacción y con el
 * MISMO guard de «libre o mío». Sin migración: ausencia de entrada = libre; los WABAs ya
 * conectados se reclaman en la próxima conexión/reconexión (documentado en el ADR).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();

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
    else docs.set(op.path, op.merge ? { ...(docs.get(op.path) ?? {}), ...op.data! } : op.data!);
  }
};

const consulta = (path: string, filtro?: { campo: string; valor: unknown }) => ({
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
    doc: (path: string) => ({ path, get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }) }),
    collection: (path: string) => consulta(path),
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
    metaExternalIndex: () => 'metaExternalIndex',
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { writeDiscoveredAssets, type DiscoveredAsset } from './discovery.js';
import { WabaOcupadaError } from './pnidOwnership.js';

const TENANT = 'tnt_alpha';
const OTRO_TENANT = 'tnt_beta';
const WABA = 'waba_compartida';
const PNID_MIO = '111222333';
const PNID_DEL_OTRO = '444555666';

const assetPath = (t: string, id: string) => `tenants/${t}/metaAssets/${id}`;
const wabaIdxPath = (id: string) => `metaExternalIndex/waba_${id}`;

const numeros = (...ids: string[]): DiscoveredAsset[] => [
  { externalId: WABA, assetType: 'whatsapp_business_account', name: 'WhatsApp Business', selected: true },
  ...ids.map((id, i) => ({ externalId: id, assetType: 'whatsapp_phone_number' as const, name: `numero ${i}`, selected: i === 0 })),
];

beforeEach(() => docs.clear());

describe('writeDiscoveredAssets — guard de propiedad del WABA (libre o mío)', () => {
  const sembrarWabaAjeno = (over: Record<string, unknown> = {}) => {
    docs.set(wabaIdxPath(WABA), {
      id: `waba_${WABA}`, tenantId: OTRO_TENANT, connectionId: 'main',
      assetType: 'whatsapp_business_account', externalId: WABA, status: 'active', ...over,
    });
  };

  it('un WABA de OTRO tenant se rechaza con un error propio que nombra al dueño', async () => {
    sembrarWabaAjeno();

    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID_MIO))).rejects.toBeInstanceOf(WabaOcupadaError);
    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID_MIO))).rejects.toMatchObject({ conflictTenantId: OTRO_TENANT });
  });

  it('el rechazo es ATÓMICO: no queda escrito NADA (ni assets, ni índice de PNID)', async () => {
    sembrarWabaAjeno();

    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID_MIO))).rejects.toThrow();

    expect(docs.has(assetPath(TENANT, PNID_MIO))).toBe(false);
    expect(docs.has(assetPath(TENANT, WABA))).toBe(false);
    expect(docs.has(`metaExternalIndex/whatsapp_${PNID_MIO}`)).toBe(false);
    expect(docs.get(wabaIdxPath(WABA))?.['tenantId']).toBe(OTRO_TENANT);
  });

  it('dos tenants no pueden reclamar el MISMO WABA con números distintos', async () => {
    await writeDiscoveredAssets(OTRO_TENANT, 'main', numeros(PNID_DEL_OTRO));

    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID_MIO))).rejects.toBeInstanceOf(WabaOcupadaError);
    // El reclamo del primero sigue intacto.
    expect(docs.get(wabaIdxPath(WABA))?.['tenantId']).toBe(OTRO_TENANT);
  });

  it('una entrada corrupta SIN tenantId se trata como ajena (fail-closed)', async () => {
    docs.set(wabaIdxPath(WABA), { id: `waba_${WABA}`, externalId: WABA, status: 'active' });

    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID_MIO))).rejects.toBeInstanceOf(WabaOcupadaError);
  });

  it('LIBRE: el discovery escribe waba_{id} en la MISMA transacción que el resto', async () => {
    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_MIO));

    const entrada = docs.get(wabaIdxPath(WABA));
    expect(entrada?.['tenantId']).toBe(TENANT);
    expect(entrada?.['connectionId']).toBe('main');
    expect(entrada?.['externalId']).toBe(WABA);
  });

  it('MÍO: la reconexión del mismo tenant sigue funcionando (idempotente)', async () => {
    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_MIO));

    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID_MIO))).resolves.toBeUndefined();
    expect(docs.get(wabaIdxPath(WABA))?.['tenantId']).toBe(TENANT);
  });

  it('SIN REGRESIÓN: sin entrada previa (mundo pre-G11) el alta pasa — ausencia = libre', async () => {
    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID_MIO))).resolves.toBeUndefined();
    expect(docs.get(assetPath(TENANT, PNID_MIO))?.['status']).toBe('active');
  });
});
