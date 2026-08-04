import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 (consecuencias) — DESCONECTAR Y RECONECTAR NO PUEDE DEJAR MUDO AL NÚMERO QUE VENDE.
 * ============================================================================================
 * `metaDisconnect` es una operación NORMAL del panel: un click de TENANT_OWNER en Integraciones.
 * Hasta este cambio BORRABA todos los `metaAssets` del tenant, y con ellos el `automationMode` que
 * ADR-0017 puso a vivir en el asset del número. La reconexión posterior encontraba la colección
 * VACÍA, así que `writeDiscoveredAssets` no tenía nada que preservar y reescribía el número que
 * está atendiendo clientes SIN permiso ⇒ `inactive` por fail-closed ⇒ cada inbound se cerraba sin
 * respuesta. Es el mismo desenlace que el ADR marca como requisito de despliegue, por otra puerta.
 *
 * LA TENSIÓN, EXPLÍCITA. Reconectar tampoco puede RESUCITAR a un número que un humano apagó a
 * mano: `writeDiscoveredAssets` desconfía de todo asset que no esté `active` justamente por eso.
 * Las dos cosas conviven porque son estados DISTINTOS, y por eso desconectar no escribe
 * `'inactive'`:
 *
 *   · `inactive`     — alguien apagó ESTE número (`deactivateWhatsappNumber` además REVOCA el
 *                      permiso escribiendo `automationMode:'inactive'`). Reconectar no lo revive.
 *   · `disconnected` — se cortó la conexión ENTERA con Meta. Nadie revocó nada: el permiso que el
 *                      número ya tenía sigue siendo suyo y vuelve con la reconexión.
 *
 * Mientras dura la desconexión el número está igual de mudo que antes, y por el mecanismo de
 * siempre: sin entrada en `metaExternalIndex` el inbound no resuelve empresa y no se procesa.
 */

const docs = new Map<string, Record<string, unknown>>();

/** Documentos hijos DIRECTOS de una colección (un solo segmento más). */
const hijosDe = (col: string) =>
  [...docs.entries()]
    .filter(([k]) => k.startsWith(`${col}/`) && !k.slice(col.length + 1).includes('/'))
    .map(([k, v]) => ({ id: k.split('/').pop()!, ref: { path: k }, data: () => v }));

function escribir(path: string, data: Record<string, unknown>, merge: boolean): void {
  docs.set(path, merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
}

interface Op {
  tipo: 'set' | 'delete';
  path: string;
  data?: Record<string, unknown>;
  merge?: boolean;
}

const ops: Op[] = [];

/** Una transacción/batch real aplica EN ORDEN y respeta el merge de cada operación. */
const aplicarOps = (): void => {
  for (const op of ops) {
    if (op.tipo === 'delete') docs.delete(op.path);
    else escribir(op.path, op.data!, op.merge === true);
  }
  ops.length = 0;
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
      set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => escribir(path, d, o?.merge === true),
    }),
    collection: (path: string) => consulta(path),
    batch: () => ({
      set: (ref: { path: string }, data: Record<string, unknown>, o?: { merge?: boolean }) =>
        ops.push({ tipo: 'set', path: ref.path, data, merge: o?.merge === true }),
      delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      commit: async () => aplicarOps(),
    }),
    // `writeDiscoveredAssets` pasó de batch a transacción para poder leer (guard de propiedad del
    // PNID) en el mismo acto en que escribe. Lo que este archivo afirma no cambia.
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: leer,
        set: (ref: { path: string }, data: Record<string, unknown>, o?: { merge?: boolean }) =>
          ops.push({ tipo: 'set', path: ref.path, data, merge: o?.merge === true }),
        delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      };
      const r = await fn(tx);
      aplicarOps();
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
  getSecretStore: () => ({ remove: async (ref: string) => { secretosBorrados.push(ref); } }),
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../audit/audit.js', () => ({ recordAudit: vi.fn(async () => undefined) }));

import { disconnectMeta } from './connect.js';
import { writeDiscoveredAssets, type DiscoveredAsset } from './discovery.js';

/** Multi-tenant: ningún tenant, número ni WABA real aparece acá. */
const TENANT = 'tnt_alpha';
const PNID_QUE_VENDE = '111222333';
const PNID_APAGADO = '444555666';
const WABA = 'waba_1';

const assetPath = (id: string) => `tenants/${TENANT}/metaAssets/${id}`;
const idxPath = (id: string) => `metaExternalIndex/whatsapp_${id}`;
const connPath = `tenants/${TENANT}/metaConnections/main`;

/** Lo que el discovery de Meta devuelve al reconectar la MISMA cuenta. */
const descubiertos = (...ids: string[]): DiscoveredAsset[] => [
  { externalId: WABA, assetType: 'whatsapp_business_account', name: 'WhatsApp Business', selected: true },
  ...ids.map((id, i) => ({ externalId: id, assetType: 'whatsapp_phone_number' as const, name: `+595 ${id}`, selected: i === 0 })),
];

/** El estado REAL antes del click: el número que vende en `live`, conectado y ruteando. */
function sembrarNumeroQueVende(): void {
  docs.set(connPath, { id: 'main', tenantId: TENANT, status: 'active', tokenSecretRef: 'secret://tnt/meta-token' });
  docs.set(assetPath(WABA), {
    id: WABA, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_business_account',
    externalId: WABA, status: 'active', selected: true,
  });
  docs.set(assetPath(PNID_QUE_VENDE), {
    id: PNID_QUE_VENDE, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number',
    externalId: PNID_QUE_VENDE, status: 'active', selected: true, automationMode: 'live',
  });
  docs.set(idxPath(PNID_QUE_VENDE), {
    id: `whatsapp_${PNID_QUE_VENDE}`, tenantId: TENANT, connectionId: 'main', platform: 'whatsapp',
    externalId: PNID_QUE_VENDE, status: 'active',
  });
}

beforeEach(() => {
  docs.clear();
  ops.length = 0;
  secretosBorrados.length = 0;
});

describe('disconnectMeta — el permiso del número sobrevive a la desconexión', () => {
  it('NO borra el asset del número: conserva su permiso y su canal', async () => {
    sembrarNumeroQueVende();

    await disconnectMeta(TENANT);

    const asset = docs.get(assetPath(PNID_QUE_VENDE));
    expect(asset, 'el asset del número que vende no puede desaparecer').toBeDefined();
    expect(asset?.['automationMode']).toBe('live');
  });

  it('conserva también la `sessionKey`: perderla fusionaría conversaciones de números distintos', async () => {
    sembrarNumeroQueVende();
    docs.set(assetPath(PNID_APAGADO), {
      id: PNID_APAGADO, tenantId: TENANT, connectionId: `wa_${PNID_APAGADO}`, assetType: 'whatsapp_phone_number',
      externalId: PNID_APAGADO, status: 'active', selected: false, automationMode: 'shadow', sessionKey: `wa_${PNID_APAGADO}`,
    });

    await disconnectMeta(TENANT);

    expect(docs.get(assetPath(PNID_APAGADO))?.['sessionKey']).toBe(`wa_${PNID_APAGADO}`);
  });

  it('el número deja de rutear mientras esté desconectado (el índice sí se borra)', async () => {
    sembrarNumeroQueVende();

    await disconnectMeta(TENANT);

    expect(docs.has(idxPath(PNID_QUE_VENDE)), 'sin índice el inbound no resuelve empresa').toBe(false);
  });

  it('el asset queda en un estado que NO se confunde con "un humano lo apagó"', async () => {
    sembrarNumeroQueVende();

    await disconnectMeta(TENANT);

    const status = docs.get(assetPath(PNID_QUE_VENDE))?.['status'];
    expect(status).not.toBe('active'); // ya no está operativo: no cuenta cupo ni resuelve credenciales
    expect(status).not.toBe('inactive'); // …pero tampoco es una revocación humana
  });

  it('lo que no es un número de WhatsApp se sigue borrando (la limpieza no se rompe)', async () => {
    sembrarNumeroQueVende();

    await disconnectMeta(TENANT);

    expect(docs.has(assetPath(WABA))).toBe(false);
  });

  it('la conexión queda not_connected y el secreto del token se borra (sin cambios)', async () => {
    sembrarNumeroQueVende();

    await disconnectMeta(TENANT);

    expect(docs.get(connPath)?.['status']).toBe('not_connected');
    expect(docs.get(connPath)?.['tokenSecretRef']).toBe('');
    expect(secretosBorrados).toEqual(['secret://tnt/meta-token']);
  });
});

/**
 * EL CICLO COMPLETO, que es lo único que prueba de verdad que el número vuelve a hablar: el click
 * de desconectar y la reconexión posterior con la MISMA cuenta de Meta.
 */
describe('desconectar + reconectar — el número que vende vuelve a `live` solo', () => {
  it('recupera su permiso sin que nadie tenga que volver a habilitarlo', async () => {
    sembrarNumeroQueVende();

    await disconnectMeta(TENANT);
    await writeDiscoveredAssets(TENANT, 'main', descubiertos(PNID_QUE_VENDE));

    const asset = docs.get(assetPath(PNID_QUE_VENDE))!;
    expect(asset['automationMode'], 'reconectar no puede dejar mudo al número que vende').toBe('live');
    expect(asset['status']).toBe('active');
  });

  it('vuelve a rutear: la entrada del índice se reescribe', async () => {
    sembrarNumeroQueVende();

    await disconnectMeta(TENANT);
    await writeDiscoveredAssets(TENANT, 'main', descubiertos(PNID_QUE_VENDE));

    expect(docs.get(idxPath(PNID_QUE_VENDE))?.['tenantId']).toBe(TENANT);
  });

  it('un número que un HUMANO apagó no resucita por desconectar y reconectar', async () => {
    sembrarNumeroQueVende();
    // Estado exacto que deja `deactivateWhatsappNumber`: apagado Y con el permiso REVOCADO.
    docs.set(assetPath(PNID_APAGADO), {
      id: PNID_APAGADO, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number',
      externalId: PNID_APAGADO, status: 'inactive', selected: false,
      automationMode: 'inactive', sessionKey: `wa_${PNID_APAGADO}`,
    });

    await disconnectMeta(TENANT);
    await writeDiscoveredAssets(TENANT, 'main', descubiertos(PNID_QUE_VENDE, PNID_APAGADO));

    const apagado = docs.get(assetPath(PNID_APAGADO))!;
    expect(apagado['automationMode'] ?? 'inactive', 'nadie decidió reencenderlo').toBe('inactive');
    expect(apagado['sessionKey'], 'su canal no se fusiona con el del que vende').toBe(`wa_${PNID_APAGADO}`);
  });

  it('un número que nunca tuvo permiso sigue sin tenerlo (el fail-closed no se afloja)', async () => {
    sembrarNumeroQueVende();
    docs.set(assetPath(PNID_APAGADO), {
      id: PNID_APAGADO, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number',
      externalId: PNID_APAGADO, status: 'active', selected: false, sessionKey: `wa_${PNID_APAGADO}`,
    });

    await disconnectMeta(TENANT);
    await writeDiscoveredAssets(TENANT, 'main', descubiertos(PNID_QUE_VENDE, PNID_APAGADO));

    expect(docs.get(assetPath(PNID_APAGADO))).not.toHaveProperty('automationMode');
  });
});
