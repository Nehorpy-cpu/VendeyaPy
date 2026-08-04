/**
 * discovery.colision.test.ts — EL EMBEDDED SIGNUP NO PODÍA DETECTAR UNA COLISIÓN DE PNID
 * =======================================================================================
 * `writeDiscoveredAssets` es la escritura del camino REAL del Embedded Signup y reclamaba
 * `metaExternalIndex/whatsapp_{pnid}` sin mirar si otro tenant ya lo tenía. El alta manual
 * (`manualConnect`) y el alta de un número adicional (`multiNumber`) SÍ chequeaban: el único
 * camino abierto era justamente el que va a usar el número real cuando entre por Coexistence.
 *
 * Reclamar un PNID ajeno no es un detalle de ruteo: `metaExternalIndex` es lo que resuelve a QUÉ
 * empresa pertenece un inbound. Robarlo desvía los mensajes de los clientes de otro negocio hacia
 * este tenant — y la respuesta sale por el número equivocado.
 *
 * Y el chequeo tiene que pasar DENTRO de la escritura: los dos caminos que ya chequeaban lo hacían
 * antes, con una ventana entre la lectura y el commit (TOCTOU). Por eso los tests de acá abajo
 * verifican la ATOMICIDAD, no solo el veredicto: si el guard rechaza, no queda escrito NADA.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();

interface Op {
  tipo: 'set' | 'delete';
  path: string;
  data?: Record<string, unknown>;
  merge?: boolean;
}

/** Documentos hijos DIRECTOS de una colección (un solo segmento más). */
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
    batch: () => {
      const ops: Op[] = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => ops.push({ tipo: 'set', path: ref.path, data, merge: opts?.merge }),
        delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
        commit: async () => aplicar(ops),
      };
    },
    // Una transacción de verdad no aplica NADA si el cuerpo lanza: es exactamente la propiedad
    // que estos tests verifican, así que el doble tiene que reproducirla.
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

import { writeDiscoveredAssets, type DiscoveredAsset } from './discovery.js';
import { PnidOcupadoError } from './pnidOwnership.js';

const TENANT = 'tnt_alpha';
const OTRO_TENANT = 'tnt_beta';
const PNID = '111222333';
const WABA = 'waba_1';

const assetPath = (t: string, id: string) => `tenants/${t}/metaAssets/${id}`;
const idxPath = (id: string) => `metaExternalIndex/whatsapp_${id}`;

const numeros = (...ids: string[]): DiscoveredAsset[] => [
  { externalId: WABA, assetType: 'whatsapp_business_account', name: 'WhatsApp Business', selected: true },
  ...ids.map((id, i) => ({ externalId: id, assetType: 'whatsapp_phone_number' as const, name: `numero ${i}`, selected: i === 0 })),
];

beforeEach(() => docs.clear());

describe('writeDiscoveredAssets — no se puede reclamar el PNID de otro tenant', () => {
  const sembrarAjeno = () => {
    docs.set(idxPath(PNID), {
      id: `whatsapp_${PNID}`, tenantId: OTRO_TENANT, connectionId: 'main', platform: 'whatsapp',
      externalId: PNID, status: 'active',
    });
  };

  it('rechaza con un error propio que nombra al dueño', async () => {
    sembrarAjeno();

    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID))).rejects.toBeInstanceOf(PnidOcupadoError);
  });

  it('y NO reescribe el índice: el inbound del otro negocio se sigue resolviendo a su dueño', async () => {
    sembrarAjeno();

    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID))).rejects.toThrow();

    expect(docs.get(idxPath(PNID))?.['tenantId']).toBe(OTRO_TENANT);
  });

  it('el rechazo es ATÓMICO: tampoco queda el asset a medio escribir', async () => {
    sembrarAjeno();

    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID))).rejects.toThrow();

    expect(docs.has(assetPath(TENANT, PNID))).toBe(false);
    expect(docs.has(assetPath(TENANT, WABA))).toBe(false);
  });

  it('un asset preexistente de ESTE tenant tampoco se borra cuando el guard rechaza otro número', async () => {
    sembrarAjeno();
    docs.set(assetPath(TENANT, '999888777'), {
      id: '999888777', tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number',
      externalId: '999888777', status: 'active', selected: true, automationMode: 'live',
    });

    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID))).rejects.toThrow();

    expect(docs.get(assetPath(TENANT, '999888777'))?.['automationMode']).toBe('live');
  });

  it('SIN REGRESIÓN: si el PNID ya es de ESTE tenant, la reconexión sigue funcionando', async () => {
    docs.set(idxPath(PNID), { id: `whatsapp_${PNID}`, tenantId: TENANT, connectionId: 'main', externalId: PNID, status: 'active' });

    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID))).resolves.toBeUndefined();

    expect(docs.get(idxPath(PNID))?.['tenantId']).toBe(TENANT);
  });

  it('SIN REGRESIÓN: un PNID libre se reclama normalmente', async () => {
    await expect(writeDiscoveredAssets(TENANT, 'main', numeros(PNID))).resolves.toBeUndefined();

    expect(docs.get(idxPath(PNID))?.['tenantId']).toBe(TENANT);
    expect(docs.get(assetPath(TENANT, PNID))?.['status']).toBe('active');
  });

  it('lo que no es un número de WhatsApp no pasa por el guard de PNID', async () => {
    await expect(
      writeDiscoveredAssets(TENANT, 'main', [{ externalId: 'ig_1', assetType: 'instagram_account', name: 'IG', selected: false }]),
    ).resolves.toBeUndefined();
  });
});
