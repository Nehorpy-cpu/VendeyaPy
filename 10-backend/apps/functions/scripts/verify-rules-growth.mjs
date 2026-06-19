/**
 * verify-rules-growth.mjs — Cierre de rules de growth (Hardening F5C, paso B).
 * Verifica que las escrituras directas desde cliente están bloqueadas y los callables siguen
 * funcionando, sin romper lecturas por rol. Crece por cierre:
 *   G-0 (deliveryPersons): write directo manager+ → 403; deliveryPersonUpsert/Delete (Admin SDK) → ok;
 *     delete con entregas activas → 400 (failed-precondition); lectura viewer+ → 200 (seller no es
 *     viewer → 403, sin cambios); seller NO puede deliveryPersonUpsert.
 *   (G-2 promotions, G-3 trackingSources, G-4 winningReplies, G-5 agentTestCases se agregan en su commit.)
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTHURL = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTHURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, idToken) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}
const restGet = (path, token) => fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
const restPatch = (path, fields, token) => fetch(`${FS}/${path}?${Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join('&')}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ fields }) }).then((r) => r.status);

const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');

// Evitar tope de cuota de repartidores en perfumeria durante el test (override alto; se limpia al final).
await db.doc(`tenants/${T}`).set({ limitOverrides: { maxDeliveryPersons: 999999 } }, { merge: true });

// ===== Cierre G-0 — deliveryPersons =====

// 1. deliveryPersonUpsert owner (create) sigue funcionando (Admin SDK escribe el repartidor).
const up = await callFn('deliveryPersonUpsert', { tenantId: T, data: { name: 'Rules Driver', whatsappPhone: '+595981000000' } }, owner);
const did = up.result?.id;
const drv = did ? (await db.doc(`tenants/${T}/deliveryPersons/${did}`).get()).data() : null;
check('G0.1 deliveryPersonUpsert owner (create) → ok (Admin SDK; isActive/OFFLINE server-set)', up.status === 200 && drv?.isActive === true && drv?.status === 'OFFLINE', `status=${up.status} isActive=${drv?.isActive}`);

// 2. write directo del owner (manager+) a deliveryPersons → 403 (write cerrado).
const wDirect = await restPatch(`tenants/${T}/deliveryPersons/${did}`, { status: { stringValue: 'AVAILABLE' } }, owner);
check('G0.2 write directo owner (update) a deliveryPersons → 403', wDirect === 403, `status=${wDirect}`);

// 3. create directo del owner a un doc nuevo de deliveryPersons → 403 (la rule cubre create).
const wCreate = await restPatch(`tenants/${T}/deliveryPersons/rules-hack`, { name: { stringValue: 'Hack' } }, owner);
check('G0.3 create directo owner a deliveryPersons → 403', wCreate === 403, `status=${wCreate}`);

// 4. deliveryPersonUpsert owner (update) sigue funcionando vía callable.
const upd = await callFn('deliveryPersonUpsert', { tenantId: T, id: did, data: { area: 'Centro' } }, owner);
check('G0.4 deliveryPersonUpsert owner (update) → ok', upd.status === 200 && (await db.doc(`tenants/${T}/deliveryPersons/${did}`).get()).data()?.area === 'Centro', `status=${upd.status}`);

// 5. deliveryPersonDelete con entregas activas → 400 (failed-precondition, no se da de baja con entregas).
await db.doc(`tenants/${T}/deliveryPersons/${did}`).set({ activeDeliveryIds: ['del-1'] }, { merge: true });
const delBlocked = await callFn('deliveryPersonDelete', { tenantId: T, id: did }, owner);
check('G0.5 deliveryPersonDelete con entregas activas → 400 (bloqueado)', delBlocked.status === 400 && (await db.doc(`tenants/${T}/deliveryPersons/${did}`).get()).data()?.isActive !== false, `status=${delBlocked.status} err=${delBlocked.error?.status}`);

// 6. deliveryPersonDelete sin entregas → ok (soft: isActive=false, OFFLINE).
await db.doc(`tenants/${T}/deliveryPersons/${did}`).set({ activeDeliveryIds: [] }, { merge: true });
const delOk = await callFn('deliveryPersonDelete', { tenantId: T, id: did }, owner);
const drvA = (await db.doc(`tenants/${T}/deliveryPersons/${did}`).get()).data();
check('G0.6 deliveryPersonDelete sin entregas → ok (soft isActive=false, OFFLINE)', delOk.status === 200 && drvA?.isActive === false && drvA?.status === 'OFFLINE', `status=${delOk.status} isActive=${drvA?.isActive}`);

// 7. lectura: read sin cambios. owner (viewer+) → 200; seller (no es viewer) → 403.
const rOwner = await restGet(`tenants/${T}/deliveryPersons/${did}`, owner);
const rSeller = await restGet(`tenants/${T}/deliveryPersons/${did}`, seller);
check('G0.7 owner (viewer+) lee deliveryPersons → 200; seller → 403 (read sin cambios)', rOwner === 200 && rSeller === 403, `owner=${rOwner} seller=${rSeller}`);

// 8. seller NO puede deliveryPersonUpsert (authz manager+).
const sellerUp = await callFn('deliveryPersonUpsert', { tenantId: T, data: { name: 'Nope', whatsappPhone: '1' } }, seller);
check('G0.8 seller NO puede deliveryPersonUpsert → 403', sellerUp.status === 403, `status=${sellerUp.status}`);

// --- Limpieza ---
if (did) await db.doc(`tenants/${T}/deliveryPersons/${did}`).delete().catch(() => {});
await db.doc(`tenants/${T}/deliveryPersons/rules-hack`).delete().catch(() => {}); // por si el create directo hubiera pasado
await db.doc(`tenants/${T}`).update({ limitOverrides: {} }).catch(() => {});
for (const d of (await db.collection(`tenants/${T}/auditLogs`).get()).docs) await d.ref.delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO CIERRE RULES GROWTH — G-0 deliveryPersons: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
