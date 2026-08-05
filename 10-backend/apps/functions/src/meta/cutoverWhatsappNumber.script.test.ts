import { describe, it, expect, beforeEach } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';

/**
 * HECHO 7 / test 10 del programa — NO EXISTÍA TRANSICIÓN ATÓMICA NI REVERSIBLE.
 * ==============================================================================
 * La secuencia manual «seleccionar acá (`selectMetaPhoneNumber`), migrar allá
 * (`migrate-whatsapp-automation-mode.mjs`)» son DOS escrituras independientes: entre una y otra
 * hay una ventana en la que o hay dos números respondiendo o ninguno — sobre el número que vende
 * EN PRODUCCIÓN. `cutover-whatsapp-number.mjs` es la herramienta release-only que hace la
 * transición completa en UNA transacción, con rollback exacto persistido.
 *
 * Invariantes del programa, cada uno con su test:
 *   1. nunca dos números seleccionados;
 *   2. nunca declarar éxito con el default en `inactive` (ni en `shadow`: no automatiza);
 *   3. nunca dos números `live` compartiendo un canal;
 *   4. sin ventana peligrosa: TODAS las escrituras del cutover en UNA transacción;
 *   5. precondiciones FRESCAS por `updateTime` sobre todos los documentos escritos;
 *   6. dry-run por defecto, `--apply` explícito (y atado a la `firma` del dry-run);
 *   7. resumen SANEADO y determinístico (números enmascarados);
 *   8. rollback disponible aunque una verificación secundaria falle;
 *   9. ningún token ni secreto interviene.
 *
 * Mismo molde que `migrateAutomationMode.script.test.ts`: se prueban las funciones exportadas
 * contra un Firestore de mentira que REGISTRA escrituras y en qué transacción ocurrieron.
 */
import {
  cutoverNumeroWhatsapp,
  rollbackCutover,
  violacionesDeInvariantes,
} from '../../scripts/cutover-whatsapp-number.mjs';

const TENANT = 'tnt_cutover';
const OTRO_TENANT = 'tnt_ajeno';
/** El proyecto EXPLÍCITO del apply: el cutover y su rollback quedan atados a él, no al ambiente. */
const PROYECTO = 'demo-cutover-test';
/** El número que HOY vende: canal heredado, seleccionado, `live` (post Paso 5 del runbook). */
const PNID_ANT = '111000111';
/** El número REAL de Coexistence: canal propio, no seleccionado, en `shadow` (post Paso 11). */
const PNID_NVO = '222000222';
const PNID_TER = '333000333';
const ASSET = (pnid: string) => `tenants/${TENANT}/metaAssets/${pnid}`;
const IDX = (pnid: string) => `metaExternalIndex/whatsapp_${pnid}`;
const CONN = (id: string) => `tenants/${TENANT}/metaConnections/${id}`;
/** La conexión destino del cutover y su credencial (solo EXISTENCIA: el valor jamás se lee). */
const CONN_NVO = CONN(`wa_${PNID_NVO}`);
const REF_CREDENCIAL = `secret://firestore/meta-token-${TENANT}-${PNID_NVO}`;
const DOC_CREDENCIAL = `secrets/meta-token-${TENANT}-${PNID_NVO}`;
const RECORDS = `tenants/${TENANT}/whatsappCutovers`;

// ---------------------------------------------------------------------------
// Firestore de mentira: documentos + registro de escrituras + transacciones.
// ---------------------------------------------------------------------------
interface Escritura { path: string; data: Record<string, unknown>; precondition?: unknown; tx: number; tipo: string }

const docs = new Map<string, { data: Record<string, unknown>; updateTime: unknown }>();
const escrituras: Escritura[] = [];
let txSeq = 0;
let txActual = 0; // 0 = fuera de transacción

const esBorrado = (v: unknown): boolean =>
  !!v && typeof (v as { isEqual?: unknown }).isEqual === 'function' &&
  (v as { isEqual: (o: unknown) => boolean }).isEqual(FieldValue.delete());

const aplicar = (path: string, data: Record<string, unknown>) => {
  const previo = docs.get(path) ?? { data: {}, updateTime: null };
  const nuevo = { ...previo.data };
  for (const [k, v] of Object.entries(data)) {
    if (esBorrado(v)) delete nuevo[k];
    else nuevo[k] = v;
  }
  docs.set(path, { data: nuevo, updateTime: previo.updateTime });
};

const hijosDe = (col: string) =>
  [...docs.entries()]
    .filter(([k]) => k.startsWith(`${col}/`) && !k.slice(col.length + 1).includes('/'))
    .map(([k, v]) => ({ id: k.split('/').pop()!, data: () => v.data, updateTime: v.updateTime }));

const docRef = (path: string) => ({
  path,
  get: async () => {
    const d = docs.get(path);
    return { exists: !!d, data: () => d?.data, updateTime: d?.updateTime };
  },
  update: async (data: Record<string, unknown>, precondition?: unknown) => {
    escrituras.push({ path, data, precondition, tx: txActual, tipo: 'update' });
    if (!docs.has(path)) throw Object.assign(new Error('not found'), { code: 5 });
    aplicar(path, data);
  },
  set: async (data: Record<string, unknown>) => {
    escrituras.push({ path, data, tx: txActual, tipo: 'set' });
    aplicar(path, data);
  },
  create: async (data: Record<string, unknown>) => {
    escrituras.push({ path, data, tx: txActual, tipo: 'create' });
    if (docs.has(path)) throw Object.assign(new Error('already exists'), { code: 6 });
    aplicar(path, data);
  },
});

const db = {
  doc: docRef,
  collection: (path: string) => ({
    where: (campo: string, _op: string, valor: unknown) => ({
      get: async () => ({ docs: hijosDe(path).filter((d) => (d.data() as Record<string, unknown>)[campo] === valor) }),
    }),
  }),
  runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    txSeq += 1;
    txActual = txSeq;
    const tx = {
      get: async (x: { get: () => Promise<unknown> }) => x.get(),
      update: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>, pre?: unknown) => ref.update(data, pre),
      set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>) => ref.set(data),
      create: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>) => ref.create(data),
    };
    try {
      return await fn(tx);
    } finally {
      txActual = 0;
    }
  },
};

// ---------------------------------------------------------------------------
// Semillas: el estado del runbook (Paso 5 hecho, Paso 11 hecho) listo para el cutover.
// ---------------------------------------------------------------------------
const sembrarAnterior = (extra: Record<string, unknown> = {}, updateTime: unknown = { seconds: 100, nanoseconds: 0 }) => {
  docs.set(ASSET(PNID_ANT), {
    data: {
      id: PNID_ANT, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number',
      externalId: PNID_ANT, name: '+595 …', status: 'active', selected: true, automationMode: 'live', ...extra,
    },
    updateTime,
  });
  docs.set(IDX(PNID_ANT), {
    data: { id: `whatsapp_${PNID_ANT}`, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID_ANT, status: 'active' },
    updateTime: { seconds: 101, nanoseconds: 0 },
  });
};

const sembrarNuevo = (extra: Record<string, unknown> = {}, updateTime: unknown = { seconds: 200, nanoseconds: 0 }) => {
  docs.set(ASSET(PNID_NVO), {
    data: {
      id: PNID_NVO, tenantId: TENANT, connectionId: `wa_${PNID_NVO}`, assetType: 'whatsapp_phone_number',
      externalId: PNID_NVO, name: '+595 …', status: 'active', selected: false, sessionKey: `wa_${PNID_NVO}`,
      automationMode: 'shadow', ...extra,
    },
    updateTime,
  });
  docs.set(IDX(PNID_NVO), {
    data: { id: `whatsapp_${PNID_NVO}`, tenantId: TENANT, connectionId: `wa_${PNID_NVO}`, assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID_NVO, status: 'active' },
    updateTime: { seconds: 201, nanoseconds: 0 },
  });
  // La conexión DESTINO con su credencial: lo que el cutover tiene que verificar antes de degradar
  // al número que vende. El secreto se siembra solo como documento — el valor no se mira nunca.
  docs.set(CONN_NVO, {
    data: { id: `wa_${PNID_NVO}`, tenantId: TENANT, status: 'active', tokenSecretRef: REF_CREDENCIAL, source: 'embedded_signup' },
    updateTime: { seconds: 210, nanoseconds: 0 },
  });
  docs.set(DOC_CREDENCIAL, {
    data: { name: `meta-token-${TENANT}-${PNID_NVO}`, ciphertext: 'cifrado-de-prueba' },
    updateTime: { seconds: 211, nanoseconds: 0 },
  });
};

const sembrarCiclo = () => { sembrarAnterior(); sembrarNuevo(); };

/** El probe inyectable: en unit tests no se depende de la constante del OTRO agente. */
const probeOk = { probarPromocion: async () => ({ outcome: 'no_es_el_numero_por_defecto' }) };

const args = (extra: Record<string, unknown> = {}) =>
  ({ tenantId: TENANT, phoneNumberId: PNID_NVO, degradarAnterior: 'shadow', projectId: PROYECTO, ...extra });

const asset = (pnid: string) => docs.get(ASSET(pnid))?.data ?? {};
const indice = (pnid: string) => docs.get(IDX(pnid))?.data ?? {};
const registro = (id: string) => docs.get(`${RECORDS}/${id}`)?.data;

const dryRun = async (extra: Record<string, unknown> = {}) => cutoverNumeroWhatsapp(db, args(extra), probeOk);
const aplicarCutover = async (extra: Record<string, unknown> = {}) => {
  const plan = await dryRun(extra);
  expect(plan.outcome).toBe('would_write');
  const r = await cutoverNumeroWhatsapp(db, args({ ...extra, apply: true, firma: plan.firma }), probeOk);
  return { plan, r };
};

beforeEach(() => {
  docs.clear();
  escrituras.length = 0;
  txSeq = 0;
  txActual = 0;
});

// ---------------------------------------------------------------------------
// Invariante 6 — dry-run por defecto; `--apply` explícito y atado a la firma.
// ---------------------------------------------------------------------------
describe('cutover — dry-run por defecto', () => {
  it('sin `apply` NO escribe nada y dice qué haría, con la firma del estado leído', async () => {
    sembrarCiclo();
    const r = await dryRun();
    expect(r.outcome).toBe('would_write');
    expect(typeof r.firma).toBe('string');
    expect((r.firma as string).length).toBeGreaterThan(7);
    expect(escrituras).toEqual([]);
    expect(txSeq).toBe(0); // ni siquiera abre una transacción
  });

  it('`apply` sin firma se rechaza: aplicar exige haber mirado el dry-run', async () => {
    sembrarCiclo();
    const r = await cutoverNumeroWhatsapp(db, args({ apply: true }), probeOk);
    expect(r.outcome).toBe('falta_firma');
    expect(escrituras).toEqual([]);
  });

  it('sin tenant o sin pnid no hace nada', async () => {
    sembrarCiclo();
    expect((await cutoverNumeroWhatsapp(db, { phoneNumberId: PNID_NVO, degradarAnterior: 'shadow' }, probeOk)).outcome).toBe('invalid_args');
    expect((await cutoverNumeroWhatsapp(db, { tenantId: TENANT, degradarAnterior: 'shadow' }, probeOk)).outcome).toBe('invalid_args');
    expect(escrituras).toEqual([]);
  });

  it('`degradarAnterior` es OBLIGATORIO y exacto: ni ausente, ni `live`, ni mayúsculas', async () => {
    sembrarCiclo();
    for (const malo of [undefined, null, '', 'live', 'LIVE', 'INACTIVE', 'off', 'on', 1, true]) {
      const r = await cutoverNumeroWhatsapp(db, args({ degradarAnterior: malo }), probeOk);
      expect(r.outcome, String(malo)).toBe('invalid_degradar');
    }
    expect(escrituras).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Invariante 5 — precondiciones FRESCAS: el estado del dry-run es el que se aplica.
// ---------------------------------------------------------------------------
describe('cutover — la firma ata el apply al estado que el operador aprobó', () => {
  it('CONFLICTO (E2E-espejo): el asset cambió entre el dry-run y el apply ⇒ aborta sin escribir', async () => {
    sembrarCiclo();
    const plan = await dryRun();
    // Alguien tocó el asset nuevo en el medio (una reconexión, el panel): cambia su updateTime.
    docs.set(ASSET(PNID_NVO), { ...docs.get(ASSET(PNID_NVO))!, updateTime: { seconds: 999, nanoseconds: 0 } });
    const r = await cutoverNumeroWhatsapp(db, args({ apply: true, firma: plan.firma }), probeOk);
    expect(r.outcome).toBe('firma_no_coincide');
    expect(escrituras).toEqual([]);
    expect(asset(PNID_ANT)['selected']).toBe(true); // el mundo quedó como estaba
    expect(asset(PNID_NVO)['automationMode']).toBe('shadow');
  });

  it('la firma también ata la DECISIÓN: un dry-run con otro `degradarAnterior` no autoriza este apply', async () => {
    sembrarCiclo();
    const plan = await dryRun({ degradarAnterior: 'inactive' });
    const r = await cutoverNumeroWhatsapp(db, args({ degradarAnterior: 'shadow', apply: true, firma: plan.firma }), probeOk);
    expect(r.outcome).toBe('firma_no_coincide');
    expect(escrituras).toEqual([]);
  });

  it('cada update de la transacción lleva precondición por el `updateTime` leído', async () => {
    sembrarCiclo();
    await aplicarCutover();
    const updates = escrituras.filter((e) => e.tipo === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    for (const u of updates) expect(u.precondition, u.path).toBeTruthy();
    expect(updates.find((u) => u.path === ASSET(PNID_NVO))?.precondition).toEqual({ lastUpdateTime: { seconds: 200, nanoseconds: 0 } });
    expect(updates.find((u) => u.path === ASSET(PNID_ANT))?.precondition).toEqual({ lastUpdateTime: { seconds: 100, nanoseconds: 0 } });
  });
});

// ---------------------------------------------------------------------------
// Invariante 4 — sin ventana peligrosa: TODO en UNA transacción.
// ---------------------------------------------------------------------------
describe('cutover — una sola transacción, ninguna escritura suelta', () => {
  it('DEFECTO (test 10): todas las escrituras del cutover comparten UNA transacción', async () => {
    sembrarCiclo();
    await aplicarCutover();
    expect(escrituras.length).toBeGreaterThanOrEqual(3); // dos assets + el registro de reversa
    const txs = new Set(escrituras.map((e) => e.tx));
    expect(txs.size).toBe(1);
    expect([...txs][0]).toBeGreaterThan(0); // y esa transacción existe (no es «fuera de tx»)
  });

  it('el desenlace del cutover: nuevo seleccionado+`live`, anterior degradado según la decisión', async () => {
    sembrarCiclo();
    const { r } = await aplicarCutover();
    expect(r.outcome).toBe('written');
    expect(asset(PNID_NVO)['selected']).toBe(true);
    expect(asset(PNID_NVO)['automationMode']).toBe('live');
    expect(asset(PNID_ANT)['selected']).toBe(false);
    expect(asset(PNID_ANT)['automationMode']).toBe('shadow');
    // Y nada más del documento se tocó: el ruteo sobrevive.
    expect(asset(PNID_NVO)['connectionId']).toBe(`wa_${PNID_NVO}`);
    expect(asset(PNID_NVO)['sessionKey']).toBe(`wa_${PNID_NVO}`);
    expect(asset(PNID_ANT)['connectionId']).toBe('main');
  });

  it('`--degradar-anterior inactive` es la otra decisión válida del operador', async () => {
    sembrarCiclo();
    const { r } = await aplicarCutover({ degradarAnterior: 'inactive' });
    expect(r.outcome).toBe('written');
    expect(asset(PNID_ANT)['automationMode']).toBe('inactive');
    expect(asset(PNID_NVO)['automationMode']).toBe('live');
  });

  it('un índice que DECLARA otro modo se corrige en la MISMA transacción (nunca queda mudo)', async () => {
    sembrarCiclo();
    // El estado que deja una recuperación post-OFFBOARDED: los índices declaran el modo viejo.
    docs.get(IDX(PNID_NVO))!.data['automationMode'] = 'shadow';
    docs.get(IDX(PNID_ANT))!.data['automationMode'] = 'live';
    await aplicarCutover();
    expect(indice(PNID_NVO)['automationMode']).toBe('live');
    expect(indice(PNID_ANT)['automationMode']).toBe('shadow');
    expect(new Set(escrituras.map((e) => e.tx)).size).toBe(1);
    const idxWrite = escrituras.find((e) => e.path === IDX(PNID_NVO));
    expect(idxWrite?.precondition).toEqual({ lastUpdateTime: { seconds: 201, nanoseconds: 0 } });
    expect(Object.keys(idxWrite!.data)).toEqual(['automationMode']);
  });

  it('un índice que NO opina no se toca: la ausencia no vota y no se escribe de más', async () => {
    sembrarCiclo();
    await aplicarCutover();
    expect(escrituras.find((e) => e.path === IDX(PNID_NVO))).toBeUndefined();
    expect(escrituras.find((e) => e.path === IDX(PNID_ANT))).toBeUndefined();
    expect(indice(PNID_NVO)['automationMode']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Invariantes 1–3 — los prechequeos que no dejan ni empezar un cutover inseguro.
// ---------------------------------------------------------------------------
describe('cutover — prechequeos del ciclo', () => {
  it('el nuevo tiene que existir', async () => {
    sembrarAnterior();
    const r = await dryRun();
    expect(r.outcome).toBe('not_found');
  });

  it('el nuevo tiene que estar en `shadow`: de `inactive` no se salta a `live` (el smoke es un paso)', async () => {
    sembrarAnterior();
    sembrarNuevo({ automationMode: 'inactive' });
    expect((await dryRun()).outcome).toBe('nuevo_no_esta_en_shadow');
    docs.get(ASSET(PNID_NVO))!.data['automationMode'] = undefined;
    delete docs.get(ASSET(PNID_NVO))!.data['automationMode'];
    expect((await dryRun()).outcome).toBe('nuevo_no_esta_en_shadow');
    expect(escrituras).toEqual([]);
  });

  it('el default actual tiene que estar `live` de verdad: este cutover es del release, no del mundo pre-migración', async () => {
    sembrarNuevo();
    sembrarAnterior({ automationMode: undefined });
    delete docs.get(ASSET(PNID_ANT))!.data['automationMode'];
    const r = await dryRun();
    expect(r.outcome).toBe('anterior_no_esta_live');
  });

  it('invariante 1 (pre): con DOS seleccionados no se opera — ese estado se arregla a mano primero', async () => {
    sembrarCiclo();
    docs.get(ASSET(PNID_NVO))!.data['selected'] = true;
    const r = await dryRun();
    expect(r.outcome).toBe('mas_de_un_numero_seleccionado');
  });

  it('sin ningún seleccionado tampoco: no hay «anterior» que degradar', async () => {
    sembrarCiclo();
    docs.get(ASSET(PNID_ANT))!.data['selected'] = false;
    const r = await dryRun();
    expect(r.outcome).toBe('sin_numero_por_defecto');
  });

  it('el nuevo tiene que RUTEAR: sin índice, o con el índice de otro tenant, no hay cutover', async () => {
    sembrarCiclo();
    docs.delete(IDX(PNID_NVO));
    expect((await dryRun()).outcome).toBe('sin_ruteo');
    sembrarNuevo();
    docs.get(IDX(PNID_NVO))!.data['tenantId'] = OTRO_TENANT;
    expect((await dryRun()).outcome).toBe('ruteo_de_otro_tenant');
    expect(escrituras).toEqual([]);
  });

  it('invariante 3 (pre): un tercero `live` en el MISMO canal del nuevo bloquea el cutover', async () => {
    sembrarCiclo();
    docs.set(ASSET(PNID_TER), {
      data: {
        id: PNID_TER, tenantId: TENANT, connectionId: `wa_${PNID_TER}`, assetType: 'whatsapp_phone_number',
        externalId: PNID_TER, status: 'active', selected: false, sessionKey: `wa_${PNID_NVO}`, automationMode: 'live',
      },
      updateTime: { seconds: 300, nanoseconds: 0 },
    });
    const r = await dryRun();
    expect(r.outcome).toBe('canal_compartido');
    expect(escrituras).toEqual([]);
  });

  it('el veto del probe de promoción se PROPAGA: la deuda de sesiones por canal bloquea acá también', async () => {
    sembrarCiclo();
    const r = await cutoverNumeroWhatsapp(db, args(), { probarPromocion: async () => ({ outcome: 'sesion_por_canal_no_migrada' }) });
    expect(r.outcome).toBe('sesion_por_canal_no_migrada');
    expect(escrituras).toEqual([]);
  });

  it('con un registro previo del mismo estado no se re-aplica: `cutover_ya_registrado`', async () => {
    sembrarCiclo();
    const plan = await dryRun();
    docs.set(`${RECORDS}/${plan.cutoverId as string}`, { data: { id: plan.cutoverId }, updateTime: null });
    const r = await cutoverNumeroWhatsapp(db, args({ apply: true, firma: plan.firma }), probeOk);
    expect(r.outcome).toBe('cutover_ya_registrado');
    expect(escrituras.filter((e) => e.tipo !== 'create')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rollback — restaura la situación anterior EXACTA, y siempre está disponible.
// ---------------------------------------------------------------------------
describe('rollback — la vuelta atrás es exacta', () => {
  it('dry-run del rollback: dice qué restauraría y no escribe', async () => {
    sembrarCiclo();
    const { r } = await aplicarCutover();
    escrituras.length = 0;
    const rb = await rollbackCutover(db, { tenantId: TENANT, cutoverId: r.cutoverId as string });
    expect(rb.outcome).toBe('would_write');
    expect(escrituras).toEqual([]);
  });

  it('restaura EXACTO: selected y automationMode vuelven byte a byte, en UNA transacción', async () => {
    sembrarCiclo();
    const antes = {
      ant: JSON.stringify(asset(PNID_ANT)),
      nvo: JSON.stringify(asset(PNID_NVO)),
    };
    const { r } = await aplicarCutover();
    escrituras.length = 0;
    const rb = await rollbackCutover(db, { tenantId: TENANT, cutoverId: r.cutoverId as string, apply: true, projectId: PROYECTO });
    expect(rb.outcome).toBe('written');
    expect(JSON.stringify(asset(PNID_ANT))).toBe(antes.ant);
    expect(JSON.stringify(asset(PNID_NVO))).toBe(antes.nvo);
    const deDocs = escrituras.filter((e) => e.path.startsWith('tenants/') || e.path.startsWith('metaExternalIndex/'));
    expect(new Set(deDocs.map((e) => e.tx)).size).toBe(1);
    expect([...new Set(deDocs.map((e) => e.tx))][0]).toBeGreaterThan(0);
  });

  it('un campo que NO existía vuelve a NO existir (no queda un `selected:false` inventado)', async () => {
    sembrarAnterior();
    sembrarNuevo();
    delete docs.get(ASSET(PNID_NVO))!.data['selected']; // el asset nunca declaró `selected`
    const { r } = await aplicarCutover();
    expect(asset(PNID_NVO)['selected']).toBe(true);
    const rb = await rollbackCutover(db, { tenantId: TENANT, cutoverId: r.cutoverId as string, apply: true, projectId: PROYECTO });
    expect(rb.outcome).toBe('written');
    expect('selected' in asset(PNID_NVO)).toBe(false);
  });

  it('los índices corregidos por el cutover también vuelven a su valor anterior', async () => {
    sembrarCiclo();
    docs.get(IDX(PNID_NVO))!.data['automationMode'] = 'shadow';
    docs.get(IDX(PNID_ANT))!.data['automationMode'] = 'live';
    const { r } = await aplicarCutover();
    const rb = await rollbackCutover(db, { tenantId: TENANT, cutoverId: r.cutoverId as string, apply: true, projectId: PROYECTO });
    expect(rb.outcome).toBe('written');
    expect(indice(PNID_NVO)['automationMode']).toBe('shadow');
    expect(indice(PNID_ANT)['automationMode']).toBe('live');
  });

  it('invariante 8: el rollback NO depende de que el ruteo esté sano (verificación secundaria rota)', async () => {
    sembrarCiclo();
    const { r } = await aplicarCutover();
    docs.delete(IDX(PNID_NVO)); // una verificación posterior fallaría: el índice desapareció
    const rb = await rollbackCutover(db, { tenantId: TENANT, cutoverId: r.cutoverId as string, apply: true, projectId: PROYECTO });
    expect(rb.outcome).toBe('written');
    expect(asset(PNID_ANT)['selected']).toBe(true);
    expect(asset(PNID_ANT)['automationMode']).toBe('live');
  });

  it('si alguien movió el mundo después del cutover (kill-switch), el rollback NO lo pisa', async () => {
    sembrarCiclo();
    const { r } = await aplicarCutover();
    // Kill-switch del runbook sobre el nuevo: migrar --mode inactive.
    docs.get(ASSET(PNID_NVO))!.data['automationMode'] = 'inactive';
    escrituras.length = 0;
    const rb = await rollbackCutover(db, { tenantId: TENANT, cutoverId: r.cutoverId as string, apply: true, projectId: PROYECTO });
    expect(rb.outcome).toBe('estado_inesperado');
    expect(escrituras).toEqual([]);
    expect(asset(PNID_NVO)['automationMode']).toBe('inactive'); // la decisión humana queda
  });

  it('un rollback ya hecho no se repite; un registro inexistente no restaura nada', async () => {
    sembrarCiclo();
    const { r } = await aplicarCutover();
    await rollbackCutover(db, { tenantId: TENANT, cutoverId: r.cutoverId as string, apply: true, projectId: PROYECTO });
    expect((await rollbackCutover(db, { tenantId: TENANT, cutoverId: r.cutoverId as string, apply: true, projectId: PROYECTO })).outcome).toBe('ya_revertido');
    expect((await rollbackCutover(db, { tenantId: TENANT, cutoverId: 'co_inexistente', apply: true, projectId: PROYECTO })).outcome).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// Invariantes 2 y 7 y 9 — éxito honesto, resumen saneado, cero secretos.
// ---------------------------------------------------------------------------
describe('cutover — éxito honesto y reporte saneado', () => {
  it('invariante 2: el desenlace del cutover deja al default automatizando (verificado con la pura)', async () => {
    sembrarCiclo();
    await aplicarCutover();
    const assets = [asset(PNID_ANT), asset(PNID_NVO)];
    const indices = { [PNID_ANT]: indice(PNID_ANT), [PNID_NVO]: indice(PNID_NVO) };
    expect(violacionesDeInvariantes(assets, indices)).toEqual([]);
  });

  it('violacionesDeInvariantes detecta los tres desastres', () => {
    const base = { assetType: 'whatsapp_phone_number', status: 'active' };
    // dos seleccionados
    expect(violacionesDeInvariantes([
      { ...base, externalId: PNID_ANT, selected: true, automationMode: 'live', connectionId: 'main' },
      { ...base, externalId: PNID_NVO, selected: true, automationMode: 'live', sessionKey: `wa_${PNID_NVO}`, connectionId: `wa_${PNID_NVO}` },
    ], {})).toContain('mas_de_un_numero_seleccionado');
    // default sin automatizar
    expect(violacionesDeInvariantes([
      { ...base, externalId: PNID_ANT, selected: true, automationMode: 'inactive', connectionId: 'main' },
    ], {})).toContain('default_sin_automatizar');
    // dos live compartiendo canal
    expect(violacionesDeInvariantes([
      { ...base, externalId: PNID_ANT, selected: true, automationMode: 'live', connectionId: 'main' },
      { ...base, externalId: PNID_NVO, selected: false, automationMode: 'live', connectionId: 'main' },
    ], {})).toContain('dos_live_comparten_canal');
  });

  it('invariante 7: el resumen enmascara los números y es determinístico', async () => {
    sembrarCiclo();
    const a = await dryRun();
    const b = await dryRun();
    expect(a).toEqual(b);
    const texto = JSON.stringify(a);
    expect(texto).not.toContain(PNID_NVO);
    expect(texto).not.toContain(PNID_ANT);
    expect(texto).toContain(PNID_NVO.slice(-4));
  });

  it('invariante 9: ni el resumen ni el registro persistido llevan tokens ni secretos', async () => {
    sembrarCiclo();
    const { r } = await aplicarCutover();
    expect(JSON.stringify(r)).not.toMatch(/token|secret/i);
    const rec = registro(r.cutoverId as string)!;
    expect(JSON.stringify(rec)).not.toMatch(/token|secret/i);
  });

  it('el registro persiste la reversa completa en la MISMA transacción que el cutover', async () => {
    sembrarCiclo();
    const { r } = await aplicarCutover();
    const rec = registro(r.cutoverId as string)!;
    expect(rec).toBeTruthy();
    const creacion = escrituras.find((e) => e.tipo === 'create');
    expect(creacion?.tx).toBe(escrituras.find((e) => e.path === ASSET(PNID_NVO))?.tx);
  });
});

// ---------------------------------------------------------------------------
// Correctivo release-safety — CIERRE COMPLETO del destino antes de degradar al que vende.
// Cada test de acá DEMOSTRÓ un defecto contra 2798296 (el cutover seguía con `would_write`).
// ---------------------------------------------------------------------------
describe('cutover — cierre completo: índice del anterior, conexión destino y credencial', () => {
  it('DEFECTO: el índice del ANTERIOR perteneciente a OTRO tenant bloquea (jamás mutar un índice ajeno)', async () => {
    sembrarCiclo();
    // El estado que deja un cutover/offboarding parcial en el índice global: la entrada del número
    // anterior quedó a nombre de otro tenant. Corregirle el `automationMode` desde ACÁ sería una
    // escritura cross-tenant — exactamente lo que el aislamiento multi-tenant prohíbe.
    docs.get(IDX(PNID_ANT))!.data['tenantId'] = OTRO_TENANT;
    docs.get(IDX(PNID_ANT))!.data['automationMode'] = 'live'; // declara ⇒ el cutover lo tocaría
    const r = await dryRun();
    expect(r.outcome).toBe('ruteo_anterior_de_otro_tenant');
    expect(escrituras).toEqual([]);
  });

  it('DEFECTO: sin conexión destino no hay cutover (promover una ruta sin credencial es un apagón)', async () => {
    sembrarCiclo();
    docs.delete(CONN_NVO);
    const r = await dryRun();
    expect(r.outcome).toBe('sin_conexion_destino');
    expect(escrituras).toEqual([]);
  });

  it('DEFECTO: una conexión destino que NO está activa bloquea', async () => {
    sembrarCiclo();
    docs.get(CONN_NVO)!.data['status'] = 'error';
    expect((await dryRun()).outcome).toBe('conexion_destino_invalida');
    docs.get(CONN_NVO)!.data['status'] = 'pending_review';
    expect((await dryRun()).outcome).toBe('conexion_destino_invalida');
    expect(escrituras).toEqual([]);
  });

  it('DEFECTO: un índice que rutea a OTRA conexión que la del asset destino bloquea', async () => {
    sembrarCiclo();
    // El inbound saldría por una conexión distinta de la que se verificó: ruteo partido.
    docs.get(IDX(PNID_NVO))!.data['connectionId'] = 'main';
    expect((await dryRun()).outcome).toBe('conexion_destino_invalida');
    expect(escrituras).toEqual([]);
  });

  it('DEFECTO: la credencial referenciada tiene que EXISTIR (sin descifrarla ni imprimirla)', async () => {
    sembrarCiclo();
    docs.delete(DOC_CREDENCIAL);
    const r = await dryRun();
    expect(r.outcome).toBe('credencial_destino_ausente');
    expect(escrituras).toEqual([]);
  });

  it('DEFECTO: una conexión sin referencia de credencial también bloquea', async () => {
    sembrarCiclo();
    docs.get(CONN_NVO)!.data['tokenSecretRef'] = '';
    expect((await dryRun()).outcome).toBe('credencial_destino_ausente');
    expect(escrituras).toEqual([]);
  });

  it('DEFECTO: si la credencial desaparece ENTRE el dry-run y el apply, el apply no escribe', async () => {
    sembrarCiclo();
    const plan = await dryRun();
    expect(plan.outcome).toBe('would_write');
    docs.delete(DOC_CREDENCIAL);
    const r = await cutoverNumeroWhatsapp(db, args({ apply: true, firma: plan.firma }), probeOk);
    expect(r.outcome).toBe('credencial_destino_ausente');
    expect(escrituras).toEqual([]);
    expect(asset(PNID_ANT)['automationMode']).toBe('live'); // el que vende sigue intacto
  });
});

describe('cutover — el apply y el rollback quedan atados al proyecto EXACTO', () => {
  it('DEFECTO: el apply sin `projectId` explícito se rechaza (el destino no puede ser ambiental)', async () => {
    sembrarCiclo();
    const plan = await dryRun();
    const a = args({ apply: true, firma: plan.firma });
    delete (a as Record<string, unknown>)['projectId'];
    const r = await cutoverNumeroWhatsapp(db, a, probeOk);
    expect(r.outcome).toBe('falta_project');
    expect(escrituras).toEqual([]);
  });

  it('DEFECTO: el registro persiste el projectId y el rollback exige EL MISMO', async () => {
    sembrarCiclo();
    const { r } = await aplicarCutover();
    expect(registro(r.cutoverId as string)!['projectId']).toBe(PROYECTO);
    escrituras.length = 0;

    // Otro proyecto: la reversa de un mundo no es la reversa de otro.
    const otro = await rollbackCutover(db, { tenantId: TENANT, cutoverId: r.cutoverId as string, apply: true, projectId: 'demo-otro' });
    expect(otro.outcome).toBe('proyecto_no_coincide');
    // Sin proyecto: apply del rollback también lo exige.
    const sin = await rollbackCutover(db, { tenantId: TENANT, cutoverId: r.cutoverId as string, apply: true });
    expect(sin.outcome).toBe('falta_project');
    expect(escrituras).toEqual([]);
    expect(asset(PNID_NVO)['selected']).toBe(true); // nada se restauró

    // Con el proyecto EXACTO del registro, el rollback sigue disponible (invariante 8 intacto).
    const ok = await rollbackCutover(db, { tenantId: TENANT, cutoverId: r.cutoverId as string, apply: true, projectId: PROYECTO });
    expect(ok.outcome).toBe('written');
    expect(asset(PNID_ANT)['selected']).toBe(true);
  });

  it('el dry-run del rollback avisa la discrepancia de proyecto sin escribir', async () => {
    sembrarCiclo();
    const { r } = await aplicarCutover();
    escrituras.length = 0;
    const rb = await rollbackCutover(db, { tenantId: TENANT, cutoverId: r.cutoverId as string, projectId: 'demo-otro' });
    expect(rb.outcome).toBe('proyecto_no_coincide');
    expect(escrituras).toEqual([]);
  });
});
