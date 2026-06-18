/**
 * verify-fase4b-meta.mjs — Conexión REAL de Meta por tenant (Hardening F4B).
 * Ejercita los callables (startMetaConnect/connectMeta/verifyMetaChannel/
 * selectMetaPhoneNumber/metaDisconnect) con un Graph FAKE por fixture (metaTestFixtures/graph)
 * — NUNCA llama a graph.facebook.com. Verifica: escritura de metaConnections/main, token en
 * SecretStore (no en claro), assets + metaExternalIndex, que 4A resuelve credenciales luego,
 * nonce de un solo uso, authz (owner ok / seller 403 / admin sin tenant invalid), preflight
 * (active/expired/permission_missing), selección de número, disconnect (limpia todo) y que
 * metaOAuthStates es Admin-only.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
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
await callFn('connectMeta', { nonce: start2.result?.nonce, code: 'fakecode', wabaId: WABA, phoneNumberId: PNID_1, businessId: 'biz-real-1' }, owner);
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

// 16. Disconnect limpia conexión + assets + índice + secreto
await callFn('metaDisconnect', {}, owner);
const c2 = await conn();
const assetsAfter = await db.collection(`tenants/${T}/metaAssets`).get();
const idxAfter = await db.collection('metaExternalIndex').where('tenantId', '==', T).get();
const secretAfter = await db.doc('secrets/meta-token-perfumeria').get();
check('16. Disconnect limpia conexión/assets/índice/secreto',
  c2?.status === 'not_connected' && assetsAfter.size === 0 && idxAfter.size === 0 && !secretAfter.exists,
  `status=${c2?.status} assets=${assetsAfter.size} idx=${idxAfter.size} secret=${secretAfter.exists}`);

// --- Limpieza ---
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
