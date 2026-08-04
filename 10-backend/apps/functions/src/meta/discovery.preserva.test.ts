import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 (consecuencias) — RECONECTAR NO PUEDE DEJAR MUDO AL NÚMERO QUE VENDE.
 * ==============================================================================
 * `writeDiscoveredAssets` BORRA todos los assets del tenant y su índice, y los reescribe desde el
 * discovery. Antes de ADR-0017 eso solo costaba «se pierde el ruteo local un instante». Ahora el
 * permiso de automatización vive en el asset: reescribirlo sin conservarlo le saca el `live` al
 * número que está atendiendo clientes y lo deja callado hasta que alguien corra la migración de
 * nuevo. Por eso el ADR lo marca como REQUISITO DE DESPLIEGUE, no como una mejora.
 *
 * La otra mitad, igual de importante: preservar NO puede convertirse en inventar. Un número que
 * nunca tuvo el campo tiene que seguir sin tenerlo (⇒ `inactive` por fail-closed).
 */

const docs = new Map<string, Record<string, unknown>>();

/** Documentos hijos DIRECTOS de una colección (un solo segmento más). */
const hijosDe = (col: string) =>
  [...docs.entries()]
    .filter(([k]) => k.startsWith(`${col}/`) && !k.slice(col.length + 1).includes('/'))
    .map(([k, v]) => ({ id: k.split('/').pop()!, ref: { path: k }, data: () => v }));

interface Op {
  tipo: 'set' | 'delete';
  path: string;
  data?: Record<string, unknown>;
}

const ops: Op[] = [];

/** `writeDiscoveredAssets` pasó de batch a transacción para poder LEER (guard de propiedad del
 * PNID) en el mismo acto en que escribe; el doble acompaña ese cambio sin tocar lo que se afirma. */
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

const aplicarOps = (): void => {
  // Una transacción real aplica EN ORDEN: el delete previo y el set posterior sobre el mismo path
  // terminan en el set. Reproducirlo es lo único que hace honesto a este test.
  for (const op of ops) {
    if (op.tipo === 'delete') docs.delete(op.path);
    else docs.set(op.path, op.data!);
  }
  ops.length = 0;
};

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({ path, get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }) }),
    collection: (path: string) => consulta(path),
    batch: () => ({
      set: (ref: { path: string }, data: Record<string, unknown>) => ops.push({ tipo: 'set', path: ref.path, data }),
      delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      commit: async () => aplicarOps(),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: leer,
        set: (ref: { path: string }, data: Record<string, unknown>) => ops.push({ tipo: 'set', path: ref.path, data }),
        delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      };
      const r = await fn(tx);
      aplicarOps();
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

const TENANT = 'tnt_alpha';
const OTRO_TENANT = 'tnt_beta';
const PNID_ACTUAL = '111222333';
const PNID_NUEVO = '444555666';
const WABA = 'waba_1';

const assetPath = (t: string, id: string) => `tenants/${t}/metaAssets/${id}`;
const idxPath = (id: string) => `metaExternalIndex/whatsapp_${id}`;

const numeros = (...ids: string[]): DiscoveredAsset[] => [
  { externalId: WABA, assetType: 'whatsapp_business_account', name: 'WhatsApp Business', selected: true },
  ...ids.map((id, i) => ({ externalId: id, assetType: 'whatsapp_phone_number' as const, name: `+595 ${id}`, selected: i === 0 })),
];

beforeEach(() => {
  docs.clear();
  ops.length = 0;
});

describe('writeDiscoveredAssets — la reconexión conserva el permiso de automatización', () => {
  it('un número en `live` sigue en `live` después de reconectar', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), {
      id: PNID_ACTUAL, tenantId: TENANT, assetType: 'whatsapp_phone_number', externalId: PNID_ACTUAL,
      status: 'active', selected: true, automationMode: 'live',
    });
    docs.set(idxPath(PNID_ACTUAL), { id: `whatsapp_${PNID_ACTUAL}`, tenantId: TENANT, externalId: PNID_ACTUAL, status: 'active' });

    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL));

    expect(docs.get(assetPath(TENANT, PNID_ACTUAL))?.['automationMode']).toBe('live');
  });

  it('conserva también la `sessionKey` del canal (o el número nuevo se llevaría la conversación del viejo)', async () => {
    docs.set(assetPath(TENANT, PNID_NUEVO), {
      id: PNID_NUEVO, tenantId: TENANT, assetType: 'whatsapp_phone_number', externalId: PNID_NUEVO,
      status: 'active', selected: false, automationMode: 'shadow', sessionKey: `wa_${PNID_NUEVO}`,
    });

    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL, PNID_NUEVO));

    const asset = docs.get(assetPath(TENANT, PNID_NUEVO))!;
    expect(asset['automationMode']).toBe('shadow');
    expect(asset['sessionKey']).toBe(`wa_${PNID_NUEVO}`);
  });

  it('el índice también conserva el modo si lo tenía declarado', async () => {
    docs.set(idxPath(PNID_ACTUAL), { id: `whatsapp_${PNID_ACTUAL}`, tenantId: TENANT, externalId: PNID_ACTUAL, status: 'active', automationMode: 'shadow' });

    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL));

    expect(docs.get(idxPath(PNID_ACTUAL))?.['automationMode']).toBe('shadow');
  });

  /** Preservar no es inventar: un número sin el campo NO puede salir de acá habilitado. */
  it('un número que nunca tuvo el campo sigue sin tenerlo (fail-closed intacto)', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), {
      id: PNID_ACTUAL, tenantId: TENANT, assetType: 'whatsapp_phone_number', externalId: PNID_ACTUAL, status: 'active', selected: true,
    });

    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL));

    expect(docs.get(assetPath(TENANT, PNID_ACTUAL))).not.toHaveProperty('automationMode');
  });

  it('un número DESCUBIERTO por primera vez nace sin permiso', async () => {
    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL, PNID_NUEVO));
    expect(docs.get(assetPath(TENANT, PNID_NUEVO))).not.toHaveProperty('automationMode');
  });

  it('un valor irreconocible no se propaga: no se conserva basura', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), { externalId: PNID_ACTUAL, status: 'active', automationMode: 'LIVE' });
    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL));
    expect(docs.get(assetPath(TENANT, PNID_ACTUAL))).not.toHaveProperty('automationMode');
  });

  it('el resto del discovery sigue igual: se reescriben nombre, selección y estado', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), { externalId: PNID_ACTUAL, status: 'inactive', selected: false, name: 'viejo', automationMode: 'live' });

    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL, PNID_NUEVO));

    const asset = docs.get(assetPath(TENANT, PNID_ACTUAL))!;
    expect(asset['status']).toBe('active');
    expect(asset['selected']).toBe(true);
    expect(asset['name']).toBe(`+595 ${PNID_ACTUAL}`);
    expect(asset['connectionId']).toBe('main');
    expect(docs.get(idxPath(PNID_NUEVO))?.['tenantId']).toBe(TENANT);
  });

  it('los assets de OTRO tenant no se leen ni se tocan (aislamiento)', async () => {
    docs.set(assetPath(OTRO_TENANT, PNID_ACTUAL), { externalId: PNID_ACTUAL, status: 'active', automationMode: 'live' });

    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL));

    expect(docs.get(assetPath(OTRO_TENANT, PNID_ACTUAL))?.['automationMode']).toBe('live');
  });

  it('un asset viejo de ESTA conexión que ya no existe en Meta se sigue borrando (la limpieza no se rompe)', async () => {
    docs.set(assetPath(TENANT, 'viejo_pnid'), { externalId: 'viejo_pnid', assetType: 'whatsapp_phone_number', status: 'active', automationMode: 'live' });

    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL));

    expect(docs.has(assetPath(TENANT, 'viejo_pnid'))).toBe(false);
  });
});

/**
 * DEFECTO 6 — desactivar un número es una decisión HUMANA. Preservar el modo al reconectar es
 * correcto para el número que vende, pero no puede resucitar en `live` a uno que alguien apagó:
 * el asset queda `status:'inactive'` y una reconexión posterior lo reescribía `active` con su
 * `automationMode` viejo intacto ⇒ volvía a contestarle a clientes sin que nadie lo decidiera.
 */
describe('writeDiscoveredAssets — reconectar no resucita un número apagado', () => {
  it('un asset desactivado NO recupera su permiso al reconectar', async () => {
    docs.set(assetPath(TENANT, PNID_NUEVO), {
      id: PNID_NUEVO, tenantId: TENANT, assetType: 'whatsapp_phone_number', externalId: PNID_NUEVO,
      status: 'inactive', selected: false, automationMode: 'live', sessionKey: `wa_${PNID_NUEVO}`,
    });

    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL, PNID_NUEVO));

    const asset = docs.get(assetPath(TENANT, PNID_NUEVO))!;
    expect(asset).not.toHaveProperty('automationMode');
    // La `sessionKey` SÍ se conserva: perderla fusionaría su conversación con la del que vende.
    expect(asset['sessionKey']).toBe(`wa_${PNID_NUEVO}`);
  });

  it('el número que vende (asset activo) conserva su `live` como hasta ahora', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), {
      id: PNID_ACTUAL, tenantId: TENANT, assetType: 'whatsapp_phone_number', externalId: PNID_ACTUAL,
      status: 'active', selected: true, automationMode: 'live',
    });

    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL));

    expect(docs.get(assetPath(TENANT, PNID_ACTUAL))?.['automationMode']).toBe('live');
  });
});

/**
 * DEFECTO 7 — `writeDiscoveredAssets` borraba TODOS los assets del tenant y su índice. Un número
 * ADICIONAL vive en su propia conexión (`wa_{pnid}`) y su propio token: el discovery del principal
 * no lo devuelve, así que reconectar el principal lo borraba del índice y lo dejaba MUDO aunque
 * estuviera vendiendo. La limpieza tiene que ser de la conexión que se está reescribiendo.
 */
describe('writeDiscoveredAssets — reconectar el principal no deja mudo a otro número', () => {
  const sembrarAdicional = () => {
    docs.set(assetPath(TENANT, PNID_NUEVO), {
      id: PNID_NUEVO, tenantId: TENANT, connectionId: `wa_${PNID_NUEVO}`, assetType: 'whatsapp_phone_number',
      externalId: PNID_NUEVO, status: 'active', selected: false, automationMode: 'live', sessionKey: `wa_${PNID_NUEVO}`,
    });
    docs.set(idxPath(PNID_NUEVO), {
      id: `whatsapp_${PNID_NUEVO}`, tenantId: TENANT, connectionId: `wa_${PNID_NUEVO}`, platform: 'whatsapp',
      externalId: PNID_NUEVO, status: 'active',
    });
  };

  it('el asset del número adicional sobrevive a la reconexión del principal', async () => {
    sembrarAdicional();

    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL));

    const asset = docs.get(assetPath(TENANT, PNID_NUEVO));
    expect(asset).toBeDefined();
    expect(asset?.['automationMode']).toBe('live');
    expect(asset?.['connectionId']).toBe(`wa_${PNID_NUEVO}`);
  });

  it('y su entrada de índice también: sin ella el inbound de ese número no rutea a nadie', async () => {
    sembrarAdicional();

    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL));

    expect(docs.has(idxPath(PNID_NUEVO))).toBe(true);
    expect(docs.get(idxPath(PNID_NUEVO))?.['tenantId']).toBe(TENANT);
  });
});

/**
 * DEFECTO 5 — el alta por discovery no escribía `sessionKey`, y ausente ⇒ canal heredado. Un
 * número descubierto que no es el principal terminaría compartiendo carrito, checkout y takeover
 * con el que vende. Estrena canal SOLO si es un asset NUEVO: mudarle el canal a uno que ya existía
 * abandonaría sus conversaciones en curso (ADR-0017 §2: «no se migra nada»).
 */
describe('writeDiscoveredAssets — un número descubierto por primera vez estrena canal', () => {
  it('un número NUEVO que no es el principal nace con su propia `sessionKey`', async () => {
    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL, PNID_NUEVO));

    expect(docs.get(assetPath(TENANT, PNID_NUEVO))?.['sessionKey']).toBe(`wa_${PNID_NUEVO}`);
  });

  it('el número por defecto conserva el canal heredado: sus conversaciones no se mudan', async () => {
    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL, PNID_NUEVO));

    expect(docs.get(assetPath(TENANT, PNID_ACTUAL))).not.toHaveProperty('sessionKey');
  });

  it('un asset que YA existía no se muda de canal', async () => {
    docs.set(assetPath(TENANT, PNID_NUEVO), {
      id: PNID_NUEVO, tenantId: TENANT, assetType: 'whatsapp_phone_number', externalId: PNID_NUEVO, status: 'active', selected: false,
    });

    await writeDiscoveredAssets(TENANT, 'main', numeros(PNID_ACTUAL, PNID_NUEVO));

    expect(docs.get(assetPath(TENANT, PNID_NUEVO))).not.toHaveProperty('sessionKey');
  });

  it('lo que no es un número de WhatsApp no estrena canal (Instagram/Messenger no tienen PNID)', async () => {
    await writeDiscoveredAssets(TENANT, 'main', [
      { externalId: 'ig_1', assetType: 'instagram_account', name: 'IG', selected: false },
    ]);

    expect(docs.get(assetPath(TENANT, 'ig_1'))).not.toHaveProperty('sessionKey');
  });
});
