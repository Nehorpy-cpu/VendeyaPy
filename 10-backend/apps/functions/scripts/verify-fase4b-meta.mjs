/**
 * verify-fase4b-meta.mjs — Conexión REAL de Meta por tenant (Hardening F4B).
 * Ejercita los callables (startMetaConnect/connectMeta/verifyMetaChannel/
 * selectMetaPhoneNumber/metaDisconnect) con un Graph FAKE por fixture (metaTestFixtures/graph)
 * — NUNCA llama a graph.facebook.com. Verifica: escritura de metaConnections/main, token en
 * SecretStore (no en claro), assets + metaExternalIndex, que 4A resuelve credenciales luego,
 * nonce de un solo uso, authz (owner ok / seller 403 / admin sin tenant invalid), preflight
 * (active/expired/permission_missing), selección de número, disconnect (limpia todo) y que
 * metaOAuthStates es Admin-only.
 *
 * — AUTOSERVICIO — (META-ONBOARDING-SELF-SERVICE-1, ADR-0020): tenant NUEVO con owner propio →
 * signup con DOS WABAs ⇒ waba_selection_required (selectionId + lista saneada, token en secreto
 * pendiente) → completeMetaConnectWaba ⇒ conectado y pendiente retirado → verify de main y de
 * wa_{pnid} (audita meta.verified) → reconexión con token inválido conserva la anterior →
 * reconexión válida ⇒ meta.reconnected → disconnect wa_ (owner, no toca main) → disconnect main
 * transaccional (asset del número marcado `disconnected`, índice y secreto retirados). El Graph
 * es SIEMPRE el fake por fixture: cero activos remotos tocados, nada se borra dentro de Meta.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'; // el signup simulado crea el owner por Admin SDK
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
/** Invoca un callable del emulador: devuelve { status, result, error }. */
async function callFn(fn, data, idToken) {
  const res = await fetch(`${BASE}/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}
const setFixture = (fx) => db.doc('metaTestFixtures/graph').set(fx);
const conn = () => db.doc(`tenants/${T}/metaConnections/main`).get().then((s) => s.data());

const PNID_1 = 'wa-real-1';
const PNID_2 = 'wa-real-2';
const WABA = 'waba-real-1';
const phone = (id, num) => ({ id, displayPhoneNumber: num, verifiedName: 'Perfumería', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED' });
const BASE_FIXTURE = {
  accessToken: 'EAAG-real-token',
  isValid: true,
  scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
  wabaIds: [WABA],
  tokenExpiresAtMs: Date.now() + 3_600_000,
  phoneNumbers: [phone(PNID_1, '+595 981 100100')],
};

const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');

// Estado limpio + fixture base
await setFixture(BASE_FIXTURE);
await db.doc(`tenants/${T}/config/channels`).delete().catch(() => {});

// PLAN-LIMITS-3A: el connect ahora gatea el conteo de números vs maxWhatsappNumbers. El test 11 conecta
// 2 números → fijamos perfumeria a un plan que los permite (growth=3) + settle del caché de entitlements.
const planBefore4b = (await db.doc(`tenants/${T}`).get()).data()?.planId;
await db.doc(`tenants/${T}`).set({ planId: 'growth' }, { merge: true });
await sleep(31_000);

// 1. startMetaConnect (owner) → nonce
const start = await callFn('startMetaConnect', {}, owner);
const nonce = start.result?.nonce;
check('1. startMetaConnect (owner) emite nonce', start.status === 200 && !!nonce, `status=${start.status}`);

// 2. connectMeta (owner) → conecta
const con = await callFn('connectMeta', { nonce, code: 'fakecode', wabaId: WABA, phoneNumberId: PNID_1, businessId: 'biz-real-1', businessName: 'Perfumería' }, owner);
check('2. connectMeta (owner) → status active', con.status === 200 && con.result?.status === 'active' && con.result?.phoneNumberId === PNID_1, JSON.stringify(con.result ?? con.error));

// 3. metaConnections/main escrito, token solo por referencia (sin token en claro)
const c1 = await conn();
check('3. metaConnections/main active + tokenSecretRef seguro (sin token en claro)',
  c1?.status === 'active' && typeof c1?.tokenSecretRef === 'string' && c1.tokenSecretRef.startsWith('secret://firestore/meta-token-perfumeria') && !('token' in (c1 ?? {})) && !('accessToken' in (c1 ?? {})),
  `ref=${c1?.tokenSecretRef}`);

// 4. Token en SecretStore (doc cifrado existe)
const secret = (await db.doc('secrets/meta-token-perfumeria').get()).data();
check('4. Token guardado en SecretStore (ciphertext, no plano)', !!secret?.ciphertext && !('value' in (secret ?? {})), `hasCt=${!!secret?.ciphertext}`);

// 5. Assets + índice escritos
const asset1 = (await db.doc(`tenants/${T}/metaAssets/${PNID_1}`).get()).data();
const idx1 = (await db.doc(`metaExternalIndex/whatsapp_${PNID_1}`).get()).data();
check('5. metaAsset whatsapp_phone_number seleccionado + metaExternalIndex → tenant',
  asset1?.assetType === 'whatsapp_phone_number' && asset1?.selected === true && idx1?.tenantId === T, `asset=${asset1?.selected} idx=${idx1?.tenantId}`);

// ADR-0017 §1: `connectMeta` escribe el asset SIN `automationMode` (conectar no autoriza). Este
// merge de UN campo es lo que hace `migrate-whatsapp-automation-mode.mjs` sobre el asset real antes
// del deploy; sin él, el inbound del check 6 se cierra `ignored` y nunca se resuelven credenciales.
await db.doc(`tenants/${T}/metaAssets/${PNID_1}`).set({ automationMode: 'live' }, { merge: true });

// 6. 4A resuelve credenciales luego de conectar (sin Graph): conectar → enviar
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'live' });
await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).delete().catch(() => {});
const from6 = '595900000601';
const mid6 = `wamid.F4B-${Date.now()}`;
await fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID_1 }, contacts: [{ wa_id: from6, profile: { name: 't' } }], messages: [{ from: from6, id: mid6, timestamp: '1716750000', type: 'text', text: { body: 'hola f4b' } }] } }] }] }) });
let dbg6 = null;
for (let i = 0; i < 15 && !dbg6; i++) { dbg6 = (await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).get()).data() ?? null; if (!dbg6) await sleep(1000); }
check('6. Tras conectar, 4A resuelve credenciales del tenant (phone + token)', dbg6?.phoneNumberId === PNID_1 && dbg6?.tokenPresent === true && dbg6?.mode === 'live', JSON.stringify(dbg6));

// 7. Nonce de un solo uso: reusarlo falla
const reuse = await callFn('connectMeta', { nonce, code: 'fakecode', wabaId: WABA, phoneNumberId: PNID_1 }, owner);
check('7. Nonce de un solo uso (reuso rechazado)', reuse.status !== 200 && !!reuse.error, `status=${reuse.status}`);

// 8. Preflight: token válido → active/ready
const pf1 = await callFn('verifyMetaChannel', {}, owner);
check('8. verifyMetaChannel (token válido) → ready/active', pf1.status === 200 && pf1.result?.ready === true && pf1.result?.status === 'active', JSON.stringify(pf1.result ?? pf1.error));

// 9. Preflight: token inválido → expired
await setFixture({ ...BASE_FIXTURE, isValid: false });
const pf2 = await callFn('verifyMetaChannel', {}, owner);
check('9. verifyMetaChannel (token inválido) → expired', pf2.result?.status === 'expired' && pf2.result?.ready === false, JSON.stringify(pf2.result ?? pf2.error));

// 10. Preflight: scopes faltantes → permission_missing
await setFixture({ ...BASE_FIXTURE, scopes: ['whatsapp_business_messaging'] });
const pf3 = await callFn('verifyMetaChannel', {}, owner);
check('10. verifyMetaChannel (scopes faltantes) → permission_missing', pf3.result?.status === 'permission_missing', JSON.stringify(pf3.result ?? pf3.error));

// 11. Reconectar con 2 números y seleccionar el segundo
await setFixture({ ...BASE_FIXTURE, phoneNumbers: [phone(PNID_1, '+595 981 100100'), phone(PNID_2, '+595 981 200200')] });
const start2 = await callFn('startMetaConnect', {}, owner);
// Code NUEVO: el 'fakecode' del check 2 ya fue reclamado (single-flight) y un replay se rechaza.
await callFn('connectMeta', { nonce: start2.result?.nonce, code: 'fakecode-11', wabaId: WABA, phoneNumberId: PNID_1, businessId: 'biz-real-1' }, owner);
// El guard de selección (ADR-0017) rechaza mover el default a un número que no automatiza
// mientras OTRO esté `live` (mover el default entre dos live es el cutover script, no el select).
// Acá se modela el caso legítimo del tenant SIN automatización activa: se apaga el live del
// check 2 con la HERRAMIENTA OFICIAL (apagar jamás se bloquea) y recién entonces se selecciona.
const { migrarModoAutomatizacion } = await import('./migrate-whatsapp-automation-mode.mjs');
const apagado = await migrarModoAutomatizacion(db, { tenantId: T, phoneNumberId: PNID_1, mode: 'inactive', apply: true });
if (!['written', 'already'].includes(apagado.outcome)) throw new Error(`fixture: no se pudo apagar el live previo (${apagado.outcome})`);
const sel = await callFn('selectMetaPhoneNumber', { phoneNumberId: PNID_2 }, owner);
const a1 = (await db.doc(`tenants/${T}/metaAssets/${PNID_1}`).get()).data();
const a2 = (await db.doc(`tenants/${T}/metaAssets/${PNID_2}`).get()).data();
check('11. selectMetaPhoneNumber cambia el número activo', sel.status === 200 && a2?.selected === true && a1?.selected === false, `a1=${a1?.selected} a2=${a2?.selected}`);

// 12. Authz: seller denegado
const sellerTry = await callFn('connectMeta', { nonce: 'x', code: 'y' }, seller);
check('12. Authz: vendedor NO puede conectar (403)', sellerTry.status === 403, `status=${sellerTry.status}`);

// 13. Authz: admin sin tenantId → invalid-argument
const adminNoTenant = await callFn('startMetaConnect', {}, admin);
check('13. Authz: admin sin tenantId → invalid-argument (400)', adminNoTenant.status === 400, `status=${adminNoTenant.status}`);

// 14. Authz: admin con tenant válido → ok
const adminOk = await callFn('startMetaConnect', { tenantId: T }, admin);
check('14. Authz: admin con tenant objetivo → ok', adminOk.status === 200 && !!adminOk.result?.nonce, `status=${adminOk.status}`);

// 15. metaOAuthStates es Admin-only (owner NO lee)
const ownerReadState = await fetch(`${FS}/metaOAuthStates/cualquiera`, { headers: { Authorization: `Bearer ${owner}` } });
check('15. metaOAuthStates Admin-only (owner 403)', ownerReadState.status === 403, `status=${ownerReadState.status}`);

// 16. Disconnect limpia conexión + índice + secreto. ADR-0017/ADR-0020: los assets de NÚMERO no se
// borran — se MARCAN `disconnected` (conservan permiso y canal para la reconexión); el resto sí se va.
await callFn('metaDisconnect', {}, owner);
const c2 = await conn();
const assetsAfter = await db.collection(`tenants/${T}/metaAssets`).get();
const soloNumerosMarcados = assetsAfter.docs.every((d) => d.data().assetType === 'whatsapp_phone_number' && d.data().status === 'disconnected');
const idxAfter = await db.collection('metaExternalIndex').where('tenantId', '==', T).get();
const secretAfter = await db.doc('secrets/meta-token-perfumeria').get();
check('16. Disconnect: conexión not_connected, números marcados disconnected, índice y secreto retirados',
  c2?.status === 'not_connected' && assetsAfter.size > 0 && soloNumerosMarcados && idxAfter.size === 0 && !secretAfter.exists,
  `status=${c2?.status} assets=${assetsAfter.size} marcados=${soloNumerosMarcados} idx=${idxAfter.size} secret=${secretAfter.exists}`);

// ═══════════════════════════════ — AUTOSERVICIO — (ADR-0020) ═══════════════════════════════
// Tenant NUEVO con su propio owner (signup simulado): nada del estado de perfumeria se reutiliza.
// El Graph sigue siendo el fake por fixture: NADA sale a Meta y nada remoto se toca ni se borra.
const T2 = 'autoservicio-e2e';
const OWNER2_EMAIL = 'owner@autoservicio-e2e.com';
const WABA_A = 'waba-auto-a';
const WABA_B = 'waba-auto-b';
const PNID_A1 = '59500000001'; // numéricos: adminAddWhatsappNumber y connectionId wa_\d+ los exigen
const PNID_EXTRA = '59500000002';
const conn2 = () => db.doc(`tenants/${T2}/metaConnections/main`).get().then((s) => s.data());
const audits2 = (action) => db.collection(`tenants/${T2}/auditLogs`).where('action', '==', action).get();

const authAdmin = getAuth();
let owner2User;
try { owner2User = await authAdmin.getUserByEmail(OWNER2_EMAIL); } catch { owner2User = await authAdmin.createUser({ email: OWNER2_EMAIL, password: 'test1234', displayName: 'Owner Autoservicio' }); }
await authAdmin.setCustomUserClaims(owner2User.uid, { role: 'TENANT_OWNER', tenantId: T2 });
await db.doc(`tenants/${T2}`).set({ name: 'Autoservicio E2E', slug: T2, status: 'ACTIVE', planId: 'growth', updatedAt: Timestamp.now() }, { merge: true });
const owner2 = await signIn(OWNER2_EMAIL);

// A1. Signup con DOS WABAs y sin elección ⇒ waba_selection_required (selectionId + lista saneada)
await setFixture({ ...BASE_FIXTURE, wabaIds: [WABA_A, WABA_B], wabaNames: { [WABA_A]: 'Cuenta A', [WABA_B]: 'Cuenta B' }, phoneNumbers: [phone(PNID_A1, '+595 981 300300')] });
const startA = await callFn('startMetaConnect', {}, owner2);
const conA = await callFn('connectMeta', { nonce: startA.result?.nonce, code: 'fakecode-auto-1', businessId: 'biz-auto-1', businessName: 'Autoservicio' }, owner2);
const detA = conA.error?.details;
check('A1. connectMeta con DOS WABAs ⇒ waba_selection_required con selectionId + wabas [{id,name}]',
  conA.status !== 200 && detA?.reason === 'waba_selection_required' && typeof detA?.selectionId === 'string'
    && Array.isArray(detA?.wabas) && detA.wabas.length === 2 && detA.wabas.some((w) => w.id === WABA_A && w.name === 'Cuenta A'),
  JSON.stringify(conA.error ?? conA.result));

// A2. El token quedó en el secreto PENDIENTE (cifrado) y main NO se conectó
const pend = (await db.doc(`secrets/meta-token-pending-${T2}`).get()).data();
const mainA = await conn2();
check('A2. Token en secreto pendiente (ciphertext) y main sin conexión activa',
  !!pend?.ciphertext && mainA?.status !== 'active', `pend=${!!pend?.ciphertext} main=${mainA?.status}`);

// A3. completeMetaConnectWaba ⇒ conectado y el pendiente RETIRADO
const comp = await callFn('completeMetaConnectWaba', { selectionId: detA?.selectionId, wabaId: WABA_A }, owner2);
const mainB = await conn2();
const pendAfter = await db.doc(`secrets/meta-token-pending-${T2}`).get();
check('A3. completeMetaConnectWaba → active, token por referencia y secreto pendiente retirado',
  comp.status === 200 && comp.result?.status === 'active' && comp.result?.phoneNumberId === PNID_A1
    && mainB?.status === 'active' && mainB?.tokenSecretRef?.startsWith('secret://firestore/') && !pendAfter.exists,
  JSON.stringify(comp.result ?? comp.error));

// A4. Replay del selectionId ⇒ rechazado (uso único)
const replayA = await callFn('completeMetaConnectWaba', { selectionId: detA?.selectionId, wabaId: WABA_B }, owner2);
check('A4. Replay del selectionId rechazado (uso único)', replayA.status !== 200 && !!replayA.error, `status=${replayA.status}`);

// A5. G11: el WABA quedó RECLAMADO en metaExternalIndex/waba_{id} para este tenant
const wabaIdx = (await db.doc(`metaExternalIndex/waba_${WABA_A}`).get()).data();
check('A5. G11: metaExternalIndex/waba_ reclamado por el tenant', wabaIdx?.tenantId === T2 && wabaIdx?.connectionId === 'main', JSON.stringify(wabaIdx));

// A6. verify de main ⇒ ready y audita meta.verified con actor
const verA = await callFn('verifyMetaChannel', {}, owner2);
const audVer = await audits2('meta.verified');
check('A6. verifyMetaChannel (main) → ready + audit meta.verified con actor y connectionId',
  verA.status === 200 && verA.result?.ready === true && audVer.size >= 1
    && audVer.docs.every((d) => !!d.data().actorUid && d.data().metadata?.connectionId === 'main'),
  `ready=${verA.result?.ready} audits=${audVer.size}`);

// A7. Número adicional (wa_) + verify por connectionId ⇒ ready, sin tocar main
await setFixture({ ...BASE_FIXTURE, wabaIds: [WABA_A], phoneNumbers: [phone(PNID_A1, '+595 981 300300'), phone(PNID_EXTRA, '+595 981 400400')] });
const add = await callFn('adminAddWhatsappNumber', { tenantId: T2, wabaId: WABA_A, phoneNumberId: PNID_EXTRA, displayPhoneNumber: '+595 981 400400', accessToken: 'EAAG-auto-extra' }, admin);
const verWa = await callFn('verifyMetaChannel', { connectionId: `wa_${PNID_EXTRA}` }, owner2);
const mainC = await conn2();
check('A7. verify de wa_{pnid} → ready sobre ESA conexión y main intacta',
  add.status === 200 && verWa.status === 200 && verWa.result?.ready === true && mainC?.status === 'active',
  `add=${add.status} verWa=${JSON.stringify(verWa.result ?? verWa.error)}`);

// A8. Reconexión con token INVÁLIDO ⇒ la conexión anterior queda operativa
const refAntes = mainC?.tokenSecretRef;
await setFixture({ ...BASE_FIXTURE, isValid: false, wabaIds: [WABA_A], phoneNumbers: [phone(PNID_A1, '+595 981 300300')] });
const startB = await callFn('startMetaConnect', {}, owner2);
const conBad = await callFn('connectMeta', { nonce: startB.result?.nonce, code: 'fakecode-auto-2', wabaId: WABA_A }, owner2);
const mainD = await conn2();
check('A8. Reconexión con token inválido: rechazada y la conexión previa sigue active con su token',
  conBad.status !== 200 && mainD?.status === 'active' && mainD?.tokenSecretRef === refAntes && !!mainD?.lastConnectError,
  `status=${conBad.status} conn=${mainD?.status} err=${mainD?.lastConnectError}`);

// A9. Reconexión VÁLIDA ⇒ audita meta.reconnected (no meta.connected)
await setFixture({ ...BASE_FIXTURE, wabaIds: [WABA_A], phoneNumbers: [phone(PNID_A1, '+595 981 300300'), phone(PNID_EXTRA, '+595 981 400400')] });
const startC = await callFn('startMetaConnect', {}, owner2);
const conRe = await callFn('connectMeta', { nonce: startC.result?.nonce, code: 'fakecode-auto-3', wabaId: WABA_A, phoneNumberId: PNID_A1 }, owner2);
const audRe = await audits2('meta.reconnected');
check('A9. Reconexión válida → active + audit meta.reconnected con actor',
  conRe.status === 200 && conRe.result?.status === 'active' && audRe.size >= 1 && audRe.docs.every((d) => !!d.data().actorUid),
  `status=${conRe.status} reconnected=${audRe.size}`);

// A10. Disconnect de wa_{pnid} por el OWNER: baja SOLO ese número, main intacta
const disWa = await callFn('metaDisconnect', { connectionId: `wa_${PNID_EXTRA}` }, owner2);
const assetExtra = (await db.doc(`tenants/${T2}/metaAssets/${PNID_EXTRA}`).get()).data();
const idxExtra = await db.doc(`metaExternalIndex/whatsapp_${PNID_EXTRA}`).get();
const connExtra = (await db.doc(`tenants/${T2}/metaConnections/wa_${PNID_EXTRA}`).get()).data();
const secretExtra = await db.doc(`secrets/meta-token-${T2}-${PNID_EXTRA}`).get();
const mainE = await conn2();
const audDeact = await audits2('meta.number_deactivated');
check('A10. metaDisconnect wa_ (owner): asset inactive, índice/conexión/secreto del número dados de baja, main intacta, audit con actor',
  disWa.status === 200 && assetExtra?.status === 'inactive' && !idxExtra.exists && connExtra?.status === 'not_connected'
    && !secretExtra.exists && mainE?.status === 'active' && (await db.doc(`metaExternalIndex/whatsapp_${PNID_A1}`).get()).exists
    && audDeact.size >= 1 && audDeact.docs.every((d) => !!d.data().actorUid),
  `dis=${disWa.status} asset=${assetExtra?.status} main=${mainE?.status} audit=${audDeact.size}`);

// A11. Disconnect de main (owner): transaccional — not_connected sin ref, números marcados
// `disconnected`, índice (whatsapp_ y waba_) y secreto retirados, audit con actor. El fake de
// Graph no expone NINGUNA operación de borrado: cero activos remotos tocados, por construcción.
const disMain = await callFn('metaDisconnect', {}, owner2);
const mainF = await conn2();
const assetA1 = (await db.doc(`tenants/${T2}/metaAssets/${PNID_A1}`).get()).data();
const idxT2 = await db.collection('metaExternalIndex').where('tenantId', '==', T2).get();
const secretMain2 = await db.doc(`secrets/meta-token-${T2}`).get();
const audDis = await audits2('meta.disconnected');
check('A11. metaDisconnect main: transaccional, número marcado disconnected, índice+secreto retirados, audit con actor',
  disMain.status === 200 && mainF?.status === 'not_connected' && mainF?.tokenSecretRef === ''
    && assetA1?.status === 'disconnected' && idxT2.size === 0 && !secretMain2.exists
    && audDis.size >= 1 && audDis.docs.every((d) => !!d.data().actorUid),
  `dis=${disMain.status} conn=${mainF?.status} asset=${assetA1?.status} idx=${idxT2.size} secret=${secretMain2.exists} audit=${audDis.size}`);

// --- Limpieza del tenant de autoservicio (no contaminar otras regresiones) ---
for (const col of ['metaAssets', 'metaConnections', 'auditLogs']) {
  for (const d of (await db.collection(`tenants/${T2}/${col}`).get()).docs) await d.ref.delete();
}
for (const d of (await db.collection('metaExternalIndex').where('tenantId', '==', T2).get()).docs) await d.ref.delete();
await db.doc(`tenants/${T2}`).delete().catch(() => {});

// --- Limpieza ---
for (const d of (await db.collection(`tenants/${T}/metaAssets`).get()).docs) await d.ref.delete(); // los números quedan marcados `disconnected`
await db.doc(`tenants/${T}`).set({ planId: planBefore4b ?? 'free' }, { merge: true }); // restaurar plan
await sleep(31_000); // settle del caché → no contaminar las regresiones siguientes
await db.doc('metaTestFixtures/graph').delete().catch(() => {});
await db.doc(`tenants/${T}/config/channels`).delete().catch(() => {});
await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).delete().catch(() => {});
for (const cid of ['595900000601']) {
  for (const m of (await db.collection(`tenants/${T}/customers/${cid}/messages`).get()).docs) await m.ref.delete();
  for (const s of (await db.collection(`tenants/${T}/customers/${cid}/sessions`).get()).docs) await s.ref.delete();
  await db.doc(`tenants/${T}/customers/${cid}`).delete().catch(() => {});
}

const ok = results.every((x) => x);
console.log(`\nRESULTADO HARDENING F4B (conexión real Meta): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
