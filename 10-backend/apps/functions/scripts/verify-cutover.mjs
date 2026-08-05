/**
 * verify-cutover.mjs — Cutover reversible del número por defecto, de punta a punta (ADR-0017)
 * ============================================================================================
 * Ejercita contra el EMULADOR el ciclo completo que el runbook deja para el release, con la
 * MISMA herramienta que se usaría en producción (`cutover-whatsapp-number.mjs`, importada — no
 * reimplementada) y la MISMA migración del runbook (`migrate-whatsapp-automation-mode.mjs`):
 *
 *   1.  Estado inicial: el número actual queda seleccionado+`live` por la vía legítima del canal
 *       heredado (la migración del Paso 5, no una escritura a mano del campo).
 *   2.  Alta del nuevo con la forma EXACTA que deja `multiNumber` (conexión `wa_{pnid}`, asset
 *       `selected:false` + `sessionKey` propia, SIN `automationMode` ⇒ nace `inactive`).
 *   3.  El guard del panel: `selectMetaPhoneNumber` RECHAZA elegir el número que no automatiza
 *       (failed-precondition) y sigue aceptando al que está `live` (sin regresión).
 *   4.  `shadow` sin tocar el default (Paso 11): el actual sigue seleccionado+`live`.
 *   5.  Cutover: dry-run primero (firma), CONFLICTO en el medio (el asset cambió entre el dry-run
 *       y el apply ⇒ la precondición fresca lo aborta sin escribir), después el apply real.
 *   6.  Invariantes post-cutover con la función PURA de la herramienta + resumen enmascarado.
 *   7.  Rollback: dry-run, apply, y TODO vuelve al estado anterior byte a byte (data completa de
 *       assets e índices, no solo los campos tocados).
 *   8.  El kill-switch del runbook sigue disponible después de todo.
 *
 * Si la constante del árbol compartido (`SESIONES_POR_CANAL_MIGRADAS`) todavía bloquea `live`
 * sobre canal propio, el cutover devuelve `sesion_por_canal_no_migrada`: este script lo dice
 * EXPLÍCITO y sale con exit 3 (bloqueado por dependencia, ni éxito ni falla) para reintentar
 * cuando el otro agente cierre su parte.
 *
 * NUNCA toca graph.facebook.com ni producción. Fixtures con prefijo propio (tenant `cutover-e2e`,
 * PNIDs 9039…). Requiere: emulador con `--project demo-aiafg` (firestore; auth+functions para el
 * paso 3) + seed-users.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { migrarModoAutomatizacion } from './migrate-whatsapp-automation-mode.mjs';
import { cutoverNumeroWhatsapp, rollbackCutover, violacionesDeInvariantes, modoEfectivo } from './cutover-whatsapp-number.mjs';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';

/** Fixtures con prefijo EXCLUSIVO: nada colisiona con otros verify-*. */
const T = 'cutover-e2e';
/** El número que "hoy vende": canal heredado (`main`). */
const PNID_A = '903900000000001';
/** El número nuevo de Coexistence: canal propio. */
const PNID_B = '903900000000002';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };

const asset = async (pnid) => (await db.doc(`tenants/${T}/metaAssets/${pnid}`).get()).data() ?? null;
const indice = async (pnid) => (await db.doc(`metaExternalIndex/whatsapp_${pnid}`).get()).data() ?? null;
const registros = async () => (await db.collection(`tenants/${T}/whatsappCutovers`).get()).docs;

/** Canonicaliza data de Firestore para comparar byte a byte (claves ordenadas, Timestamps → ms). */
const canon = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v?.toMillis === 'function') return `ts:${v.toMillis()}`;
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
};
const foto = async () => JSON.stringify({
  a: canon(await asset(PNID_A)), b: canon(await asset(PNID_B)),
  ia: canon(await indice(PNID_A)), ib: canon(await indice(PNID_B)),
});

const signIn = async (email) => (await (await fetch(AUTH, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }),
})).json()).idToken;
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, result: body.result, err: body.error?.status ?? null, msg: body.error?.message ?? '' };
}

async function limpiar() {
  for (const pnid of [PNID_A, PNID_B]) {
    await db.doc(`tenants/${T}/metaAssets/${pnid}`).delete().catch(() => {});
    await db.doc(`metaExternalIndex/whatsapp_${pnid}`).delete().catch(() => {});
    await db.doc(`tenants/${T}/metaConnections/${pnid === PNID_A ? 'main' : `wa_${pnid}`}`).delete().catch(() => {});
  }
  for (const d of await registros()) await d.ref.delete().catch(() => {});
}

// ---------------------------------------------------------------------------
// 0) Semillas: tenant + el número que hoy vende, con la forma de PRODUCCIÓN (sin automationMode).
// ---------------------------------------------------------------------------
await limpiar();
const now = Timestamp.now();
await db.doc(`tenants/${T}`).set({
  name: 'Cutover E2E', planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: now },
  limitOverrides: { maxWhatsappNumbers: 2 },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, currentPeriodStart: now },
}, { merge: true });
await db.doc(`tenants/${T}/metaAssets/${PNID_A}`).set({
  id: PNID_A, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number',
  externalId: PNID_A, name: '+595 (test A)', status: 'active', selected: true, createdAt: now, updatedAt: now,
});
await db.doc(`metaExternalIndex/whatsapp_${PNID_A}`).set({
  id: `whatsapp_${PNID_A}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number',
  platform: 'whatsapp', externalId: PNID_A, status: 'active', updatedAt: now,
});

// ---------------------------------------------------------------------------
// 1) Estado inicial por la VÍA LEGÍTIMA: la migración del Paso 5 pone el canal heredado en `live`.
// ---------------------------------------------------------------------------
const m1 = await migrarModoAutomatizacion(db, { tenantId: T, phoneNumberId: PNID_A, mode: 'live', apply: true });
check('1. El número actual pasa a `live` por la migración del runbook (canal heredado)', m1.outcome === 'written', m1.outcome);
check('1b. Y sigue seleccionado: la migración no toca el ruteo', (await asset(PNID_A))?.selected === true && (await asset(PNID_A))?.automationMode === 'live');

// ---------------------------------------------------------------------------
// 2) Alta del nuevo con la forma EXACTA de multiNumber: nace sin permiso y sin selección.
// ---------------------------------------------------------------------------
await db.doc(`tenants/${T}/metaConnections/wa_${PNID_B}`).set({
  id: `wa_${PNID_B}`, tenantId: T, status: 'active', source: 'coexistence', tokenSecretRef: '', updatedAt: now,
});
await db.doc(`tenants/${T}/metaAssets/${PNID_B}`).set({
  id: PNID_B, tenantId: T, connectionId: `wa_${PNID_B}`, assetType: 'whatsapp_phone_number',
  externalId: PNID_B, name: '+595 (test B)', status: 'active', selected: false,
  sessionKey: `wa_${PNID_B}`, createdAt: now, updatedAt: now,
});
await db.doc(`metaExternalIndex/whatsapp_${PNID_B}`).set({
  id: `whatsapp_${PNID_B}`, tenantId: T, connectionId: `wa_${PNID_B}`, assetType: 'whatsapp_phone_number',
  platform: 'whatsapp', externalId: PNID_B, status: 'active', updatedAt: now,
});
{
  const b = await asset(PNID_B);
  check('2. El nuevo nace NO seleccionado y `inactive` (campo ausente ⇒ fail-closed)',
    b?.selected === false && b?.automationMode === undefined && modoEfectivo(b, await indice(PNID_B)) === 'inactive');
}

// ---------------------------------------------------------------------------
// 3) El guard del panel (callable REAL, emulador de functions): test 9 del programa.
// ---------------------------------------------------------------------------
try {
  const token = await signIn('superadmin@aiafg.com');
  const rechazo = await call('selectMetaPhoneNumber', token, { tenantId: T, phoneNumberId: PNID_B });
  check('3. `selectMetaPhoneNumber` RECHAZA dejar de default un número que no automatiza',
    rechazo.err === 'FAILED_PRECONDITION', `err=${rechazo.err} msg=${rechazo.msg.slice(0, 60)}`);
  const ok = await call('selectMetaPhoneNumber', token, { tenantId: T, phoneNumberId: PNID_A });
  check('3b. Y sigue aceptando al número `live` (sin regresión del uso legítimo)', ok.result?.ok === true, ok.err ?? '');
  check('3c. El rechazo no escribió nada: el default sigue siendo el número que vende',
    (await asset(PNID_A))?.selected === true && (await asset(PNID_B))?.selected === false);
} catch (e) {
  check('3. Guard del panel (¿emulador de functions/auth levantado?)', false, String(e).slice(0, 80));
}

// ---------------------------------------------------------------------------
// 4) Paso 11: el nuevo pasa a `shadow` SIN tocar el default.
// ---------------------------------------------------------------------------
const m2 = await migrarModoAutomatizacion(db, { tenantId: T, phoneNumberId: PNID_B, mode: 'shadow', apply: true });
check('4. El nuevo pasa a `shadow` con la migración del runbook', m2.outcome === 'written', m2.outcome);
check('4b. Sin alterar el default: el actual sigue seleccionado+`live`',
  (await asset(PNID_A))?.selected === true && (await asset(PNID_A))?.automationMode === 'live' && (await asset(PNID_B))?.selected === false);

// ---------------------------------------------------------------------------
// 5) El cutover: dry-run → conflicto (precondición fresca) → apply real.
// ---------------------------------------------------------------------------
const argsCutover = { tenantId: T, phoneNumberId: PNID_B, degradarAnterior: 'shadow' };
const dry1 = await cutoverNumeroWhatsapp(db, argsCutover);
if (dry1.outcome === 'sesion_por_canal_no_migrada') {
  console.log('\n⏳ ESPERANDO: `SESIONES_POR_CANAL_MIGRADAS` sigue en false (árbol compartido con otro agente).');
  console.log('   El cutover a `live` sobre canal propio está bloqueado POR DISEÑO hasta que esa parte cierre.');
  console.log('   Reintentar este script cuando el flag esté en true. Exit 3 (bloqueado, ni éxito ni falla).');
  process.exit(3);
}
check('5. Dry-run del cutover: `would_write` + firma', dry1.outcome === 'would_write' && typeof dry1.firma === 'string', dry1.outcome);
check('5b. El dry-run no escribió nada', (await asset(PNID_B))?.selected === false && (await registros()).length === 0);

// CONFLICTO: alguien toca el asset entre el dry-run y el apply → la firma vieja aborta.
// Tiene que ser un cambio REAL (como el que deja una reconexión, que reescribe el asset): una
// escritura no-op con el mismo valor no mueve `updateTime` en el emulador — y un no-op genuino
// tampoco es un conflicto, porque el estado sigue siendo exactamente el que el operador aprobó.
await db.doc(`tenants/${T}/metaAssets/${PNID_B}`).update({ name: '+595 (test B, reconectado)' });
const fotoAntesConflicto = await foto();
const conflicto = await cutoverNumeroWhatsapp(db, { ...argsCutover, apply: true, firma: dry1.firma });
check('5c. CONFLICTO: el asset cambió entre dry-run y apply ⇒ aborta (precondición fresca)',
  conflicto.outcome === 'firma_no_coincide', conflicto.outcome);
check('5d. Y no escribió NADA: ni assets/índices (byte a byte) ni registro de reversa',
  (await foto()) === fotoAntesConflicto && (await registros()).length === 0);

// Apply real, con la firma de un dry-run fresco.
const fotoPreCutover = await foto();
const dry2 = await cutoverNumeroWhatsapp(db, argsCutover);
const aplicado = await cutoverNumeroWhatsapp(db, { ...argsCutover, apply: true, firma: dry2.firma });
check('5e. Cutover aplicado', aplicado.outcome === 'written', aplicado.outcome);

// ---------------------------------------------------------------------------
// 6) Invariantes post-cutover.
// ---------------------------------------------------------------------------
{
  const a = await asset(PNID_A); const b = await asset(PNID_B);
  check('6. Nuevo seleccionado+`live`; anterior degradado a `shadow` y deseleccionado',
    b?.selected === true && b?.automationMode === 'live' && a?.selected === false && a?.automationMode === 'shadow');
  const violaciones = violacionesDeInvariantes([a, b], { [PNID_A]: await indice(PNID_A), [PNID_B]: await indice(PNID_B) });
  check('6b. Cero violaciones de invariantes (un seleccionado, default automatiza, canales sanos)', violaciones.length === 0, violaciones.join(','));
  const recs = await registros();
  check('6c. El registro de reversa quedó persistido (misma transacción que el cutover)',
    recs.length === 1 && recs[0].data().estado === 'aplicado' && recs[0].id === aplicado.cutoverId);
  const texto = JSON.stringify(aplicado);
  check('6d. El resumen está SANEADO: números enmascarados, sin tokens', !texto.includes(PNID_A) && !texto.includes(PNID_B) && !/token|secret/i.test(texto));
}

// ---------------------------------------------------------------------------
// 7) Rollback: dry-run → apply → byte a byte contra el estado pre-cutover.
// ---------------------------------------------------------------------------
const rbDry = await rollbackCutover(db, { tenantId: T, cutoverId: aplicado.cutoverId });
check('7. Dry-run del rollback: `would_write` sin escribir', rbDry.outcome === 'would_write' && (await asset(PNID_B))?.selected === true, rbDry.outcome);
const rb = await rollbackCutover(db, { tenantId: T, cutoverId: aplicado.cutoverId, apply: true });
check('7b. Rollback aplicado', rb.outcome === 'written', rb.outcome);
check('7c. TODO volvió al estado anterior EXACTO (data completa de assets e índices, byte a byte)', (await foto()) === fotoPreCutover);
check('7d. El registro quedó marcado `revertido` y no se puede repetir',
  (await registros())[0]?.data()?.estado === 'revertido' && (await rollbackCutover(db, { tenantId: T, cutoverId: aplicado.cutoverId, apply: true })).outcome === 'ya_revertido');

// ---------------------------------------------------------------------------
// 8) El kill-switch del runbook sigue disponible (apagar nunca se bloquea).
// ---------------------------------------------------------------------------
const ks = await migrarModoAutomatizacion(db, { tenantId: T, phoneNumberId: PNID_B, mode: 'inactive', apply: true });
check('8. `--mode inactive` sobre el nuevo sigue funcionando después de todo el ciclo', ks.outcome === 'written', ks.outcome);

await limpiar();
const total = results.length; const okCount = results.filter(Boolean).length;
console.log(`\n${okCount}/${total} checks OK`);
process.exitCode = okCount === total ? 0 : 1;
