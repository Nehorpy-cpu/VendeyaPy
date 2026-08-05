/**
 * cutover-whatsapp-number.mjs — Transición ATÓMICA y REVERSIBLE del número por defecto (ADR-0017)
 * ================================================================================================
 * HERRAMIENTA RELEASE-ONLY. El panel NO hace cutover: `selectMetaPhoneNumber` solo mueve
 * `selected` y ahora rechaza dejar de default un número que no automatiza. La transición completa
 * —nuevo seleccionado+`live`, anterior degradado— es de acá, porque hecha «a mano» son DOS
 * escrituras independientes (seleccionar en un lado, migrar en el otro) con una ventana en el
 * medio en la que o hay dos números respondiendo o ninguno, sobre el número que vende EN
 * PRODUCCIÓN.
 *
 * INVARIANTES (cada uno con test en `cutoverWhatsappNumber.script.test.ts`):
 *   1. nunca dos números seleccionados;
 *   2. nunca declarar éxito con el default sin automatizar (`inactive` o `shadow`);
 *   3. nunca dos números `live` compartiendo un canal;
 *   4. sin ventana peligrosa: TODAS las escrituras en UNA transacción (assets + índices que
 *      declaren + registro de reversa);
 *   5. precondiciones FRESCAS: la FIRMA del dry-run ata el apply al estado que el operador miró
 *      (estado + updateTimes + la decisión de degradación), se re-verifica DENTRO de la
 *      transacción, y cada update lleva además su `lastUpdateTime`;
 *   6. dry-run por defecto; `--apply` explícito y exige `--firma`;
 *   7. resumen SANEADO y determinístico (números enmascarados, sin timestamps);
 *   8. el rollback depende SOLO del registro persistido (misma transacción que el cutover): una
 *      verificación secundaria rota no lo bloquea;
 *   9. ningún token ni secreto interviene: este script no mira Secret Manager ni credenciales.
 *
 * QUÉ ESCRIBE (y nada más):
 *   · asset nuevo:    { selected: true,  automationMode: 'live' }
 *   · asset anterior: { selected: false, automationMode: <--degradar-anterior> }
 *   · índice de cada uno SOLO si DECLARA un modo distinto (la ausencia no vota, igual que en
 *     `migrate-whatsapp-automation-mode.mjs`);
 *   · `tenants/{t}/whatsappCutovers/{id}`: el registro con la reversa EXACTA (presencia y valor
 *     de cada campo tocado). Las Rules cierran esa subcolección por el default deny final.
 *   · NO toca `updatedAt`: una transición de release no es una edición humana (mismo criterio que
 *     la migración de `automationMode`).
 *
 * PROMOCIÓN: antes de encender nada se consulta (dry-run) la MISMA herramienta del runbook,
 * `migrarModoAutomatizacion`, para heredar sus guardas (`sesion_por_canal_no_migrada`,
 * `asset_inactivo`, …) sin duplicarlas. Su único veto que acá NO bloquea es
 * `no_es_el_numero_por_defecto`: el cutover arregla la selección en la MISMA transacción — esa es
 * exactamente su razón de existir.
 *
 * EL CICLO que cubre (runbook §Paso 11–13): anterior seleccionado+`live` · nuevo no-seleccionado
 * en `shadow` (el smoke de shadow es un paso, no se salta de `inactive` a `live`) · cutover ·
 * rollback que restaura la situación anterior EXACTA (un campo que no existía vuelve a no
 * existir).
 *
 * USO:
 *   node scripts/cutover-whatsapp-number.mjs --tenant <id> --nuevo <pnid> --degradar-anterior shadow|inactive
 *   node scripts/cutover-whatsapp-number.mjs --tenant <id> --nuevo <pnid> --degradar-anterior shadow --firma <hex> --apply
 *   node scripts/cutover-whatsapp-number.mjs --tenant <id> --rollback <cutoverId>            (dry-run)
 *   node scripts/cutover-whatsapp-number.mjs --tenant <id> --rollback <cutoverId> --apply
 */
import { createHash } from 'node:crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { parseAutomationMode, declaredAutomationMode, masRestrictivo, permiteAutomatizacion } from '@vpw/shared';
// La MISMA vara del runbook: se importa, no se reimplementa (y NO se edita desde acá).
import { enmascararPnid, canalDeclarado, migrarModoAutomatizacion } from './migrate-whatsapp-automation-mode.mjs';

/** Las DOS degradaciones válidas del anterior. `live` no está: dos `live` es el desastre 3. */
export const DEGRADACIONES_VALIDAS = Object.freeze(['shadow', 'inactive']);

/** Veredictos del probe de promoción que NO bloquean el cutover (ver cabecera). */
const PROBE_ACEPTABLE = Object.freeze(['would_write', 'already', 'no_es_el_numero_por_defecto']);

const esPreconditionFailed = (e) =>
  e?.code === 9 || e?.code === 'failed-precondition' || /precondition|update time/i.test(String(e?.message ?? e));
const esAlreadyExists = (e) => e?.code === 6 || /already exists/i.test(String(e?.message ?? e));

const pnidDe = (data, id) => String(data?.externalId ?? id ?? '');

/**
 * El modo EFECTIVO de un número con el criterio del gate: entre lo que DECLARAN asset e índice
 * gana el más restrictivo; si nadie declara, fail-closed (`inactive`). La ausencia no vota.
 */
export function modoEfectivo(assetData, idxData) {
  const declarados = [assetData?.automationMode, idxData?.automationMode]
    .map(declaredAutomationMode)
    .filter((m) => m !== null);
  return declarados.length ? masRestrictivo(...declarados) : parseAutomationMode(undefined);
}

/**
 * Los TRES invariantes de estado, como función PURA para que el E2E y la transacción midan lo
 * mismo. `assets` son documentos crudos de números; `indices` mapea pnid → doc del índice (o
 * null/ausente). Devuelve la lista de violaciones (vacía = sano).
 */
export function violacionesDeInvariantes(assets, indices = {}) {
  const v = [];
  const numeros = (assets ?? []).filter((a) => (a?.assetType ?? 'whatsapp_phone_number') === 'whatsapp_phone_number');
  const seleccionados = numeros.filter((a) => a.selected === true);
  if (seleccionados.length > 1) v.push('mas_de_un_numero_seleccionado');
  if (seleccionados.length === 0) v.push('sin_numero_por_defecto');
  for (const s of seleccionados) {
    if (!permiteAutomatizacion(modoEfectivo(s, indices[pnidDe(s, s.id)]))) v.push('default_sin_automatizar');
  }
  const canales = new Set();
  for (const a of numeros) {
    if (modoEfectivo(a, indices[pnidDe(a, a.id)]) !== 'live') continue;
    const canal = canalDeclarado(a, pnidDe(a, a.id));
    if (canales.has(canal)) v.push('dos_live_comparten_canal');
    canales.add(canal);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Lectura del estado y firma. La MISMA lectura corre fuera (plan) y dentro (tx) — el lector se
// inyecta — para que la firma compare exactamente lo mismo en los dos momentos.
// ---------------------------------------------------------------------------

const rutaAsset = (t, pnid) => `tenants/${t}/metaAssets/${pnid}`;
const rutaIdx = (pnid) => `metaExternalIndex/whatsapp_${pnid}`;
const rutaRegistro = (t, id) => `tenants/${t}/whatsappCutovers/${id}`;

async function leerEstado(db, tenantId, phoneNumberId, leer) {
  const snap = await leer(db.collection(`tenants/${tenantId}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number'));
  const assets = (snap.docs ?? [])
    .map((d) => ({ id: d.id, data: d.data() ?? {}, updateTime: d.updateTime ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seleccionados = assets.filter((a) => a.data.selected === true);
  const anteriorId = seleccionados.length === 1 ? seleccionados[0].id : null;
  const leerIdx = async (pnid) => {
    if (!pnid) return { exists: false, data: {}, updateTime: null };
    const s = await leer(db.doc(rutaIdx(pnid)));
    return { exists: !!s.exists, data: s.data() ?? {}, updateTime: s.updateTime ?? null };
  };
  const idxNuevo = await leerIdx(phoneNumberId);
  const idxAnterior = anteriorId && anteriorId !== phoneNumberId ? await leerIdx(anteriorId) : { exists: false, data: {}, updateTime: null };
  return { assets, seleccionados, anteriorId, idxNuevo, idxAnterior };
}

/** Un valor CRUDO apto para serializar en la firma (nada exótico puede romper el hash). */
const crudo = (v) => (v === undefined || v === null ? null : typeof v === 'object' ? String(v) : v);
const serialTs = (t) => (t ? `${crudo(t.seconds)}|${crudo(t.nanoseconds)}` : 'ausente');
const serialIdx = (i) => ({ existe: i.exists, modo: crudo(i.data.automationMode), tenant: crudo(i.data.tenantId), ut: serialTs(i.updateTime) });

/**
 * La FIRMA: hash del estado relevante + updateTimes + la DECISIÓN (tenant, nuevo, degradación).
 * Determinística. Atar la decisión importa: un dry-run con `--degradar-anterior inactive` no
 * puede autorizar un apply con `shadow`.
 */
export function firmaDeEstado(tenantId, phoneNumberId, degradarAnterior, estado) {
  const cuerpo = JSON.stringify({
    v: 1,
    tenantId,
    nuevo: phoneNumberId,
    degradarAnterior,
    assets: estado.assets.map((a) => ({
      id: a.id,
      sel: a.data.selected === true,
      modo: crudo(a.data.automationMode),
      conn: crudo(a.data.connectionId),
      sk: crudo(a.data.sessionKey),
      st: crudo(a.data.status),
      ut: serialTs(a.updateTime),
    })),
    idxNuevo: serialIdx(estado.idxNuevo),
    idxAnterior: serialIdx(estado.idxAnterior),
  });
  return createHash('sha256').update(cuerpo).digest('hex').slice(0, 24);
}

/** Prechequeos PROPIOS del cutover (los del probe se heredan aparte). Motivo o `null`. */
function motivoDeBloqueo(estado, tenantId, phoneNumberId) {
  const nuevo = estado.assets.find((a) => a.id === phoneNumberId);
  if (!nuevo) return 'not_found';
  if (estado.seleccionados.length > 1) return 'mas_de_un_numero_seleccionado';
  if (estado.seleccionados.length === 0) return 'sin_numero_por_defecto';
  if (estado.anteriorId === phoneNumberId) {
    return modoEfectivo(nuevo.data, estado.idxNuevo.data) === 'live' ? 'already' : 'nuevo_ya_es_el_default';
  }
  const anterior = estado.assets.find((a) => a.id === estado.anteriorId);
  // El ciclo del runbook: de `inactive` no se salta a `live` — el smoke de `shadow` es un paso.
  if (modoEfectivo(nuevo.data, estado.idxNuevo.data) !== 'shadow') return 'nuevo_no_esta_en_shadow';
  // Y el default actual tiene que estar `live` DE VERDAD: si no lo está, esto no es el cutover
  // del release (el Paso 5 no corrió, o alguien ya apagó todo) y hace falta un humano, no un tool.
  if (modoEfectivo(anterior.data, estado.idxAnterior.data) !== 'live') return 'anterior_no_esta_live';
  // El nuevo tiene que RUTEAR el inbound de ESTE tenant (mismo criterio que la migración).
  if (!estado.idxNuevo.exists) return 'sin_ruteo';
  if (estado.idxNuevo.data.tenantId !== tenantId) return 'ruteo_de_otro_tenant';
  // Canales: el nuevo no puede compartir canal con el anterior ni con ningún otro `live`.
  const canalNuevo = canalDeclarado(nuevo.data, phoneNumberId);
  if (canalDeclarado(anterior.data, estado.anteriorId) === canalNuevo) return 'canal_compartido';
  for (const a of estado.assets) {
    if (a.id === phoneNumberId || a.id === estado.anteriorId) continue;
    if (declaredAutomationMode(a.data.automationMode) !== 'live') continue;
    if (canalDeclarado(a.data, pnidDe(a.data, a.id)) === canalNuevo) return 'canal_compartido';
  }
  return null;
}

/** Presencia y valor EXACTOS de un campo, para poder restaurarlo byte a byte (o borrarlo). */
const fotoDeCampo = (data, campo) =>
  Object.prototype.hasOwnProperty.call(data ?? {}, campo) ? { presente: true, valor: data[campo] } : { presente: false };

/**
 * El CUTOVER. Dry-run salvo `apply: true` (que exige la `firma` del dry-run). Devuelve un resumen
 * SANEADO. `deps.probarPromocion` existe para los tests; en producción es el dry-run real de
 * `migrarModoAutomatizacion`.
 */
export async function cutoverNumeroWhatsapp(db, opts = {}, deps = {}) {
  const { tenantId, phoneNumberId, degradarAnterior, apply = false, firma = null, cutoverId = null } = opts;
  const degradarValido = DEGRADACIONES_VALIDAS.includes(degradarAnterior);
  const base = {
    tenant: tenantId ?? null,
    numeroNuevo: enmascararPnid(phoneNumberId),
    numeroAnterior: null,
    degradarAnterior: degradarValido ? degradarAnterior : null,
    apply,
  };
  if (!tenantId || !phoneNumberId) return { ...base, outcome: 'invalid_args' };
  if (!degradarValido) return { ...base, outcome: 'invalid_degradar' };
  if (apply && !firma) return { ...base, outcome: 'falta_firma' };

  const estado = await leerEstado(db, tenantId, phoneNumberId, (x) => x.get());
  base.numeroAnterior = estado.anteriorId ? enmascararPnid(estado.anteriorId) : null;

  const bloqueo = motivoDeBloqueo(estado, tenantId, phoneNumberId);
  if (bloqueo) return { ...base, outcome: bloqueo };

  // Las guardas de promoción del runbook, heredadas por dry-run (ver cabecera).
  const probar = deps.probarPromocion ?? ((d, a) => migrarModoAutomatizacion(d, { ...a, apply: false }));
  const probe = await probar(db, { tenantId, phoneNumberId, mode: 'live' });
  if (!PROBE_ACEPTABLE.includes(probe?.outcome)) return { ...base, outcome: probe?.outcome ?? 'probe_ilegible' };

  const firmaCalculada = firmaDeEstado(tenantId, phoneNumberId, degradarAnterior, estado);
  const id = cutoverId || `co_${firmaCalculada.slice(0, 16)}`;
  const nuevo = estado.assets.find((a) => a.id === phoneNumberId);
  const anterior = estado.assets.find((a) => a.id === estado.anteriorId);
  const declaraIdxNuevo = declaredAutomationMode(estado.idxNuevo.data.automationMode);
  const declaraIdxAnterior = declaredAutomationMode(estado.idxAnterior.data.automationMode);
  const resumen = {
    ...base,
    modoPrevioNuevo: parseAutomationMode(nuevo.data.automationMode),
    modoPrevioAnterior: parseAutomationMode(anterior.data.automationMode),
    indiceNuevo: declaraIdxNuevo === null ? 'no_declara' : declaraIdxNuevo === 'live' ? 'coincide' : 'corregir',
    indiceAnterior: declaraIdxAnterior === null ? 'no_declara' : declaraIdxAnterior === degradarAnterior ? 'coincide' : 'corregir',
    cutoverId: id,
    firma: firmaCalculada,
  };

  const regRef = db.doc(rutaRegistro(tenantId, id));
  if ((await regRef.get()).exists) return { ...resumen, outcome: 'cutover_ya_registrado' };
  if (!apply) return { ...resumen, outcome: 'would_write' };
  if (firma !== firmaCalculada) return { ...resumen, outcome: 'firma_no_coincide' };

  try {
    const fin = await db.runTransaction(async (tx) => {
      // TODAS las lecturas primero (Firestore lo exige) y la firma se RE-verifica acá adentro:
      // lo que se escribe es exactamente lo que el operador aprobó, o no se escribe nada.
      const e2 = await leerEstado(db, tenantId, phoneNumberId, (x) => tx.get(x));
      if (firmaDeEstado(tenantId, phoneNumberId, degradarAnterior, e2) !== firma) return 'precondition_failed';
      if ((await tx.get(regRef)).exists) return 'cutover_ya_registrado';

      const nuevo2 = e2.assets.find((a) => a.id === phoneNumberId);
      const anterior2 = e2.assets.find((a) => a.id === e2.anteriorId);
      const escribir = [
        { ref: db.doc(rutaAsset(tenantId, nuevo2.id)), campos: { selected: true, automationMode: 'live' }, ut: nuevo2.updateTime },
        { ref: db.doc(rutaAsset(tenantId, anterior2.id)), campos: { selected: false, automationMode: degradarAnterior }, ut: anterior2.updateTime },
      ];
      const reversa = {
        assets: {
          [nuevo2.id]: { selected: fotoDeCampo(nuevo2.data, 'selected'), automationMode: fotoDeCampo(nuevo2.data, 'automationMode') },
          [anterior2.id]: { selected: fotoDeCampo(anterior2.data, 'selected'), automationMode: fotoDeCampo(anterior2.data, 'automationMode') },
        },
        indices: {},
      };
      const escrito = {
        assets: {
          [nuevo2.id]: { selected: true, automationMode: 'live' },
          [anterior2.id]: { selected: false, automationMode: degradarAnterior },
        },
        indices: {},
      };
      // El índice SOLO si declara otra cosa: dejarlo declarando el modo viejo dejaría al número
      // mudo (o encendido) por el desempate del más restrictivo.
      const corregirIdx = (idx, pnid, destino) => {
        if (!idx.exists || declaredAutomationMode(idx.data.automationMode) === null) return;
        if (idx.data.automationMode === destino) return;
        escribir.push({ ref: db.doc(rutaIdx(pnid)), campos: { automationMode: destino }, ut: idx.updateTime });
        reversa.indices[pnid] = { automationMode: fotoDeCampo(idx.data, 'automationMode') };
        escrito.indices[pnid] = { automationMode: destino };
      };
      corregirIdx(e2.idxNuevo, phoneNumberId, 'live');
      corregirIdx(e2.idxAnterior, e2.anteriorId, degradarAnterior);

      // Cinturón: el estado RESULTANTE se verifica con la misma función pura del E2E. Si el plan
      // dejara dos seleccionados, un default que no automatiza o dos `live` en un canal, no se
      // escribe nada.
      const post = e2.assets.map((a) => ({
        ...a.data,
        ...(a.id === nuevo2.id ? { selected: true, automationMode: 'live' } : {}),
        ...(a.id === anterior2.id ? { selected: false, automationMode: degradarAnterior } : {}),
      }));
      const idxPost = {
        [nuevo2.id]: { ...e2.idxNuevo.data, ...(escrito.indices[nuevo2.id] ?? {}) },
        [anterior2.id]: { ...e2.idxAnterior.data, ...(escrito.indices[anterior2.id] ?? {}) },
      };
      if (violacionesDeInvariantes(post, idxPost).length > 0) return 'invariantes_violadas';

      for (const w of escribir) tx.update(w.ref, w.campos, w.ut ? { lastUpdateTime: w.ut } : undefined);
      tx.create(regRef, {
        id,
        tenantId,
        tipo: 'whatsapp_cutover',
        estado: 'aplicado',
        numeroNuevo: phoneNumberId,
        numeroAnterior: e2.anteriorId,
        degradarAnterior,
        firma,
        reversa,
        escrito,
        creadoEn: Timestamp.now(),
        revertidoEn: null,
      });
      return 'written';
    });
    return { ...resumen, outcome: fin };
  } catch (e) {
    if (esPreconditionFailed(e)) return { ...resumen, outcome: 'precondition_failed' };
    if (esAlreadyExists(e)) return { ...resumen, outcome: 'cutover_ya_registrado' };
    throw e;
  }
}

/**
 * El ROLLBACK: restaura la situación anterior EXACTA desde el registro persistido. No pasa por el
 * probe ni exige ruteo sano (invariante 8): su única fuente es la reversa, y su única precondición
 * es que el mundo siga como el cutover lo dejó — si alguien lo movió después (p. ej. el
 * kill-switch del runbook), NO se pisa esa decisión (`estado_inesperado`).
 */
export async function rollbackCutover(db, opts = {}) {
  const { tenantId, cutoverId, apply = false } = opts;
  const base = { tenant: tenantId ?? null, cutoverId: cutoverId ?? null, apply };
  if (!tenantId || !cutoverId) return { ...base, outcome: 'invalid_args' };

  const regRef = db.doc(rutaRegistro(tenantId, cutoverId));
  const regSnap = await regRef.get();
  if (!regSnap.exists) return { ...base, outcome: 'not_found' };
  const reg = regSnap.data() ?? {};
  if (reg.estado === 'revertido') return { ...base, outcome: 'ya_revertido' };
  const resumen = {
    ...base,
    numeroNuevo: enmascararPnid(reg.numeroNuevo),
    numeroAnterior: enmascararPnid(reg.numeroAnterior),
  };

  /** Documentos a restaurar: [ruta, foto previa (reversa), foto escrita (escrito)]. */
  const objetivos = [
    ...Object.entries(reg.reversa?.assets ?? {}).map(([pnid, campos]) => ({
      ruta: rutaAsset(tenantId, pnid), campos, escrito: reg.escrito?.assets?.[pnid] ?? {},
    })),
    ...Object.entries(reg.reversa?.indices ?? {}).map(([pnid, campos]) => ({
      ruta: rutaIdx(pnid), campos, escrito: reg.escrito?.indices?.[pnid] ?? {},
    })),
  ];

  /** ¿El documento sigue EXACTAMENTE como el cutover lo dejó? Compara solo los campos escritos. */
  const coincideConLoEscrito = (snap, escrito) => {
    if (!snap.exists) return false;
    const data = snap.data() ?? {};
    return Object.entries(escrito).every(([k, v]) => data[k] === v);
  };

  const leerYVerificar = async (leer) => {
    const lecturas = [];
    for (const o of objetivos) {
      const snap = await leer(db.doc(o.ruta));
      if (!coincideConLoEscrito(snap, o.escrito)) return { ok: false };
      lecturas.push({ ...o, updateTime: snap.updateTime ?? null });
    }
    return { ok: true, lecturas };
  };

  const plan = await leerYVerificar((x) => x.get());
  if (!plan.ok) return { ...resumen, outcome: 'estado_inesperado' };
  if (!apply) return { ...resumen, outcome: 'would_write' };

  try {
    const fin = await db.runTransaction(async (tx) => {
      const regTx = await tx.get(regRef);
      if (!regTx.exists) return 'not_found';
      if ((regTx.data() ?? {}).estado === 'revertido') return 'ya_revertido';
      const enTx = await leerYVerificar((x) => tx.get(x));
      if (!enTx.ok) return 'estado_inesperado';
      for (const o of enTx.lecturas) {
        const restaurar = {};
        for (const [campo, foto] of Object.entries(o.campos)) {
          // Byte a byte: el valor exacto si existía; si NO existía, el campo se BORRA — un
          // `selected: false` inventado no es «la situación anterior».
          restaurar[campo] = foto.presente ? foto.valor : FieldValue.delete();
        }
        tx.update(db.doc(o.ruta), restaurar, o.updateTime ? { lastUpdateTime: o.updateTime } : undefined);
      }
      tx.update(regRef, { estado: 'revertido', revertidoEn: Timestamp.now() }, regTx.updateTime ? { lastUpdateTime: regTx.updateTime } : undefined);
      return 'written';
    });
    return { ...resumen, outcome: fin };
  } catch (e) {
    if (esPreconditionFailed(e)) return { ...resumen, outcome: 'precondition_failed' };
    throw e;
  }
}

// ----------------------------- CLI (solo cuando se ejecuta directo) -----------------------------
const isMain = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/cutover-whatsapp-number.mjs');
if (isMain) {
  const arg = (nombre) => {
    const i = process.argv.indexOf(`--${nombre}`);
    const valor = i >= 0 ? (process.argv[i + 1] ?? '') : '';
    return valor.startsWith('--') ? '' : valor;
  };
  const tenantId = arg('tenant');
  const rollbackId = arg('rollback');
  const phoneNumberId = arg('nuevo');
  const degradarAnterior = arg('degradar-anterior');
  const firma = arg('firma');
  const cutoverId = arg('id');
  const apply = process.argv.includes('--apply');

  if (!tenantId || (!rollbackId && !phoneNumberId)) {
    console.log('uso: node scripts/cutover-whatsapp-number.mjs --tenant <id> --nuevo <pnid> --degradar-anterior shadow|inactive [--firma <hex> --apply]');
    console.log('     node scripts/cutover-whatsapp-number.mjs --tenant <id> --rollback <cutoverId> [--apply]');
    console.log('     dry-run por defecto. --apply exige la --firma que imprimió el dry-run.');
    process.exit(2);
  }

  process.env.GCLOUD_PROJECT ??= 'demo-aiafg';
  const onEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  const db = getFirestore();

  console.log(
    `cutover-whatsapp-number — ${rollbackId ? 'ROLLBACK' : 'CUTOVER'} · modo: ${apply ? 'APPLY (escribe)' : 'DRY-RUN (no escribe)'} · ` +
      `${onEmulator ? 'EMULADOR' : '⚠️ NO-EMULADOR (¿producción?)'} · tenant="${tenantId}"` +
      (rollbackId ? ` · registro=${rollbackId}` : ` · nuevo=${enmascararPnid(phoneNumberId)} · degradar-anterior=${degradarAnterior || '(FALTA)'}`),
  );
  if (!apply) console.log('  (dry-run: usá --apply con la --firma impresa abajo; en prod, guardá este resumen antes de aplicar)');

  const r = rollbackId
    ? await rollbackCutover(db, { tenantId, cutoverId: rollbackId, apply })
    : await cutoverNumeroWhatsapp(db, { tenantId, phoneNumberId, degradarAnterior, apply, firma: firma || null, cutoverId: cutoverId || null });
  console.log('RESUMEN:', JSON.stringify(r, null, 2));
  process.exitCode = ['written', 'would_write', 'already'].includes(r.outcome) ? 0 : 1;
}
