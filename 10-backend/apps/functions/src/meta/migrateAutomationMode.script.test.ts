import { describe, it, expect, beforeEach } from 'vitest';

/**
 * ADR-0017 (consecuencias) — LA MIGRACIÓN CORRE ANTES QUE EL GATE.
 * ================================================================
 * «La migración del PNID actual a `live` corre ANTES de desplegar el gate. Al revés, el número que
 * vende leería el campo ausente, resolvería `inactive` y se quedaría callado hasta que alguien
 * corriera la migración.»
 *
 * O sea: este script se ejecuta sobre PRODUCCIÓN, contra el número que está atendiendo clientes, y
 * antes de que exista el código que lo lee. Lo que se prueba acá es exactamente lo que hace que
 * eso sea seguro:
 *
 *  · el modo es EXPLÍCITO: sin `--mode` no hay default (un tipeo no puede poner a un número a
 *    contestarle a clientes reales);
 *  · sin `--apply` no escribe NADA (el operador ve el plan antes de tocar nada);
 *  · escribe UN campo — un `set` del documento entero borraría `connectionId`, `selected` o el
 *    nombre del número y rompería el ruteo del inbound;
 *  · con PRECONDICIÓN FRESCA por `updateTime`: si alguien tocó el asset entre la lectura y la
 *    escritura (una reconexión, el panel), la escritura falla en vez de pisar;
 *  · solo bendice al asset que REALMENTE rutea el inbound de ese tenant;
 *  · el reporte no imprime el número.
 *
 * Se prueba la función exportada, igual que `deployEnv.test.ts` con `build-deploy.mjs`: el CLI es
 * una cáscara y la decisión es lo que hay que poder auditar.
 */
import { migrarModoAutomatizacion, enmascararPnid } from '../../scripts/migrate-whatsapp-automation-mode.mjs';

const TENANT = 'tnt_alpha';
const OTRO_TENANT = 'tnt_beta';
const PNID = '111222333';
const PNID_NUEVO = '444555666';
const RUTA = `tenants/${TENANT}/metaAssets/${PNID}`;
const RUTA_IDX = `metaExternalIndex/whatsapp_${PNID}`;

interface Escritura { path: string; data: Record<string, unknown>; precondition?: unknown }

const docs = new Map<string, { data: Record<string, unknown>; updateTime: unknown }>();
const escrituras: Escritura[] = [];
/** Si está seteado, todo `update` explota como lo haría una precondición vencida. */
let updateFalla: Error | null = null;

/** Documentos hijos DIRECTOS de una colección (un solo segmento más). */
const hijosDe = (col: string) =>
  [...docs.entries()]
    .filter(([k]) => k.startsWith(`${col}/`) && !k.slice(col.length + 1).includes('/'))
    .map(([k, v]) => ({ id: k.split('/').pop()!, data: () => v.data }));

const db = {
  doc: (path: string) => ({
    path,
    get: async () => {
      const d = docs.get(path);
      return { exists: !!d, data: () => d?.data, updateTime: d?.updateTime };
    },
    update: async (data: Record<string, unknown>, precondition?: unknown) => {
      escrituras.push({ path, data, precondition });
      if (updateFalla) throw updateFalla;
      const d = docs.get(path)!;
      docs.set(path, { data: { ...d.data, ...data }, updateTime: d.updateTime });
    },
  }),
  collection: (path: string) => ({
    where: (campo: string, _op: string, valor: unknown) => ({
      get: async () => ({ docs: hijosDe(path).filter((d) => (d.data() as Record<string, unknown>)[campo] === valor) }),
    }),
  }),
};

/** El estado COHERENTE: el asset del número + la entrada de índice que lo rutea a este tenant. */
const sembrarAsset = (extra: Record<string, unknown> = {}, updateTime: unknown = { seconds: 1000, nanos: 0 }) => {
  docs.set(RUTA, {
    data: { id: PNID, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: '+595 ...', status: 'active', selected: true, ...extra },
    updateTime,
  });
  docs.set(RUTA_IDX, {
    data: { id: `whatsapp_${PNID}`, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active' },
    updateTime: null,
  });
};

/** Otro número del MISMO tenant (el vecino de canal). */
const sembrarOtroNumero = (extra: Record<string, unknown> = {}) => {
  docs.set(`tenants/${TENANT}/metaAssets/${PNID_NUEVO}`, {
    data: { id: PNID_NUEVO, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID_NUEVO, status: 'active', selected: false, ...extra },
    updateTime: null,
  });
};

const modoEscrito = () => docs.get(RUTA)?.data['automationMode'];

beforeEach(() => {
  docs.clear();
  escrituras.length = 0;
  updateFalla = null;
});

/**
 * DEFECTO 4 — el default era `live`. Es lo contrario del fail-closed que gobierna todo el ADR:
 * `--mode` sin valor, o directamente ausente, ponía a un número a contestarle a clientes reales.
 */
describe('migrarModoAutomatizacion — el modo es OBLIGATORIO y explícito', () => {
  it('sin modo NO hay default: aborta sin escribir', async () => {
    sembrarAsset();
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, apply: true });

    expect(r.outcome).toBe('invalid_mode');
    expect(escrituras).toEqual([]);
    expect(modoEscrito()).toBeUndefined();
  });

  it('un modo ausente, vacío o que parece otra bandera también aborta', async () => {
    sembrarAsset();
    for (const malo of [undefined, null, '', '--apply', 'LIVE', 'activo', 'on', 'true', 1, true]) {
      const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: malo, apply: true });
      expect(r.outcome, String(malo)).toBe('invalid_mode');
    }
    expect(escrituras).toEqual([]);
    expect(modoEscrito()).toBeUndefined();
  });

  it('el dry-run tampoco inventa un modo: no se puede reportar `would_write` de la nada', async () => {
    sembrarAsset();
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID });
    expect(r.outcome).toBe('invalid_mode');
  });

  it('con el modo declarado sí trabaja: dice qué haría y no escribe', async () => {
    sembrarAsset();
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live' });

    expect(r.outcome).toBe('would_write');
    expect(r.modoPrevio).toBe('inactive'); // campo ausente ⇒ fail-closed
    expect(r.modoNuevo).toBe('live');
    expect(escrituras).toEqual([]);
  });

  it('acepta `shadow` para la promoción intermedia', async () => {
    sembrarAsset();
    await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'shadow', apply: true });
    expect(modoEscrito()).toBe('shadow');
  });

  it('sin tenant o sin pnid no hace nada (no hay tenant por defecto en este repo)', async () => {
    sembrarAsset();
    const m = { mode: 'live', apply: true };
    expect((await migrarModoAutomatizacion(db, { phoneNumberId: PNID, ...m })).outcome).toBe('invalid_args');
    expect((await migrarModoAutomatizacion(db, { tenantId: TENANT, ...m })).outcome).toBe('invalid_args');
    expect((await migrarModoAutomatizacion(db, { tenantId: '', phoneNumberId: '', ...m })).outcome).toBe('invalid_args');
    expect(escrituras).toEqual([]);
  });
});

describe('migrarModoAutomatizacion — la escritura', () => {
  it('toca UN SOLO campo: nada del ruteo del número puede perderse', async () => {
    sembrarAsset();
    await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });

    expect(escrituras).toHaveLength(1);
    expect(Object.keys(escrituras[0]!.data)).toEqual(['automationMode']);
    // Y el resto del documento sigue intacto (un `set` lo habría borrado).
    const asset = docs.get(RUTA)!.data;
    expect(asset['connectionId']).toBe('main');
    expect(asset['selected']).toBe(true);
    expect(asset['status']).toBe('active');
  });

  it('la escritura lleva PRECONDICIÓN por el `updateTime` que se leyó', async () => {
    const updateTime = { seconds: 12345, nanos: 6789 };
    sembrarAsset({}, updateTime);
    await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });
    expect(escrituras[0]!.precondition).toEqual({ lastUpdateTime: updateTime });
  });

  it('si el asset cambió entre la lectura y la escritura, la migración FALLA en vez de pisar', async () => {
    sembrarAsset();
    updateFalla = Object.assign(new Error('failed precondition'), { code: 9 });
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });
    expect(r.outcome).toBe('precondition_failed');
  });

  it('idempotente: si ya está en el modo pedido, no reescribe', async () => {
    sembrarAsset({ automationMode: 'live' });
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });
    expect(r.outcome).toBe('already');
    expect(escrituras).toEqual([]);
  });

  it('un asset inexistente no se crea: migrar no es dar de alta un número', async () => {
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });
    expect(r.outcome).toBe('not_found');
    expect(escrituras).toEqual([]);
  });

  it('un asset que no es un número de WhatsApp se rechaza', async () => {
    sembrarAsset({ assetType: 'instagram_account' });
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });
    expect(r.outcome).toBe('not_a_phone_number');
    expect(escrituras).toEqual([]);
  });

  it('degradar también funciona: el rollback de emergencia es la misma herramienta', async () => {
    sembrarAsset({ automationMode: 'live' });
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'inactive', apply: true });
    expect(r.outcome).toBe('written');
    expect(modoEscrito()).toBe('inactive');
  });
});

/**
 * DEFECTO 8 — el script bendecía un asset sin comprobar que fuera el que RUTEA el inbound. Un
 * asset huérfano (sin índice, o con el índice apuntando a otro tenant) se migraba igual, y el
 * número que de verdad recibe quedaba sin migrar: mudo el día del despliegue del gate.
 */
describe('migrarModoAutomatizacion — solo se bendice el asset que RUTEA', () => {
  it('sin entrada en el índice, ese asset no recibe nada: no se promueve', async () => {
    sembrarAsset();
    docs.delete(RUTA_IDX);
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });

    expect(r.outcome).toBe('sin_ruteo');
    expect(escrituras).toEqual([]);
  });

  it('si el índice rutea ese número a OTRO tenant, no se promueve (aislamiento)', async () => {
    sembrarAsset();
    docs.set(RUTA_IDX, { data: { id: `whatsapp_${PNID}`, tenantId: OTRO_TENANT, externalId: PNID, status: 'active' }, updateTime: null });
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });

    expect(r.outcome).toBe('ruteo_de_otro_tenant');
    expect(escrituras).toEqual([]);
  });

  it('un asset desactivado no se promueve: apagarlo fue una decisión humana', async () => {
    sembrarAsset({ status: 'inactive' });
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'shadow', apply: true });

    expect(r.outcome).toBe('asset_inactivo');
    expect(escrituras).toEqual([]);
  });

  it('`live` exige que sea el número por defecto del tenant', async () => {
    sembrarAsset({ selected: false });
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });

    expect(r.outcome).toBe('no_es_el_numero_por_defecto');
    expect(escrituras).toEqual([]);
  });

  /** Fail-closed es «cuesta encender», nunca «cuesta apagar»: el rollback no se bloquea jamás. */
  it('apagar SIEMPRE se puede, aunque el ruteo esté roto y el asset desactivado', async () => {
    sembrarAsset({ status: 'inactive', selected: false, automationMode: 'live' });
    docs.delete(RUTA_IDX);
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'inactive', apply: true });

    expect(r.outcome).toBe('written');
    expect(modoEscrito()).toBe('inactive');
  });
});

/**
 * DEFECTO 5 (relacionado) — ADR-0017: «Hay ~25 lugares que hoy asumen `sessions/active`;
 * migrarlos es CONDICIÓN para pasar a `live`». El script no puede confiar en que el operador se
 * acuerde: si el número vive en un canal propio, `live` se rechaza.
 */
describe('migrarModoAutomatizacion — `live` solo sobre un canal que el código sabe leer', () => {
  it('un número con canal propio NO puede pasar a `live`', async () => {
    sembrarAsset({ sessionKey: `wa_${PNID}` });
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });

    expect(r.outcome).toBe('sesion_por_canal_no_migrada');
    expect(escrituras).toEqual([]);
  });

  it('pero SÍ puede pasar a `shadow`: mirar no comparte carrito, takeover ni pedido', async () => {
    sembrarAsset({ sessionKey: `wa_${PNID}`, selected: false });
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'shadow', apply: true });

    expect(r.outcome).toBe('written');
    expect(modoEscrito()).toBe('shadow');
  });

  it('un número de una conexión ADICIONAL sin `sessionKey` tampoco es el canal heredado', async () => {
    sembrarAsset({ connectionId: `wa_${PNID}` });
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });

    expect(r.outcome).toBe('sesion_por_canal_no_migrada');
  });

  /** Dos números automatizados en el MISMO canal = un solo carrito, un solo takeover. */
  it('rechaza automatizar un canal que otro número ya está automatizando', async () => {
    sembrarAsset();
    sembrarOtroNumero({ automationMode: 'live' }); // vecino en el canal heredado
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });

    expect(r.outcome).toBe('canal_compartido');
    expect(escrituras).toEqual([]);
  });

  it('un vecino con su PROPIO canal no bloquea nada', async () => {
    sembrarAsset();
    sembrarOtroNumero({ automationMode: 'live', sessionKey: `wa_${PNID_NUEVO}`, connectionId: `wa_${PNID_NUEVO}` });
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });

    expect(r.outcome).toBe('written');
  });

  it('un vecino dormido (sin permiso declarado) tampoco bloquea', async () => {
    sembrarAsset();
    sembrarOtroNumero();
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });

    expect(r.outcome).toBe('written');
  });

  it('el vecino de OTRO tenant es irrelevante (aislamiento)', async () => {
    sembrarAsset();
    docs.set(`tenants/${OTRO_TENANT}/metaAssets/${PNID_NUEVO}`, {
      data: { assetType: 'whatsapp_phone_number', externalId: PNID_NUEVO, status: 'active', automationMode: 'live' },
      updateTime: null,
    });
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });

    expect(r.outcome).toBe('written');
  });
});

describe('el reporte es SANEADO', () => {
  it('el número nunca se imprime entero', () => {
    expect(enmascararPnid(PNID)).toBe('…2333');
    expect(enmascararPnid(PNID)).not.toContain('111');
    expect(enmascararPnid('')).toBe('…');
  });

  it('el resultado no lleva el PNID ni el nombre del número', async () => {
    sembrarAsset();
    const r = await migrarModoAutomatizacion(db, { tenantId: TENANT, phoneNumberId: PNID, mode: 'live', apply: true });
    expect(JSON.stringify(r)).not.toContain(PNID);
    expect(JSON.stringify(r)).not.toContain('+595');
  });
});
