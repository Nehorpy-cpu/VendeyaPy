/**
 * verify-rules-catalog.mjs — Cierre de rules del módulo catálogo (Hardening F5C, paso B).
 * Verifica que las escrituras directas desde cliente están bloqueadas y los callables siguen
 * funcionando, sin romper lecturas por rol. Crece por cierre:
 *   Cierre 1 (productFinancials): write directo owner → 403; productUpsert con financials → ok;
 *     owner/manager leen; seller NO lee; seller NO puede productUpsert.
 *   Cierre 2 (products): write directo owner → 403; productUpsert/productDelete owner → ok;
 *     viewer/seller leen products; seller NO puede productUpsert.
 *   Cierre 3 (categories): write directo owner → 403; categoryUpsert owner (create/update) → ok;
 *     owner/viewer leen categories; categoryDelete bloquea con productos asociados (failed-precondition)
 *     y borra sin ellos; seller NO puede categoryUpsert.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

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

// Evitar tope de cuota en perfumeria durante el test (override alto; se limpia al final).
await db.doc(`tenants/${T}`).set({ limitOverrides: { maxProducts: 999999 } }, { merge: true });

// ===== Cierre 1 — productFinancials =====

// 2. productUpsert con financials.costPrice sigue funcionando (Admin SDK escribe el costo).
const up = await callFn('productUpsert', { tenantId: T, data: { name: 'Rules Test', price: 100, currency: 'PYG', categoryId: 'cat-x', status: 'ACTIVE' }, financials: { costPrice: 55 } }, owner);
const pid = up.result?.id;
const fin = pid ? (await db.doc(`tenants/${T}/productFinancials/${pid}`).get()).data() : null;
check('C1.2 productUpsert con financials.costPrice → ok (costo escrito vía callable)', up.status === 200 && fin?.costPrice === 55, `status=${up.status} cost=${fin?.costPrice}`);

// 1. write directo del owner a productFinancials → 403 (write cerrado).
const wDirect = await restPatch(`tenants/${T}/productFinancials/${pid}`, { costPrice: { integerValue: '1' } }, owner);
check('C1.1 write directo owner a productFinancials → 403', wDirect === 403, `status=${wDirect}`);

// 3. lectura privada: owner (manager+) SÍ lee.
const rOwner = await restGet(`tenants/${T}/productFinancials/${pid}`, owner);
check('C1.3 owner/manager lee productFinancials → 200', rOwner === 200, `status=${rOwner}`);

// 4. lectura privada: seller NO lee.
const rSeller = await restGet(`tenants/${T}/productFinancials/${pid}`, seller);
check('C1.4 seller NO lee productFinancials → 403', rSeller === 403, `status=${rSeller}`);

// 5. seller NO puede productUpsert (authz).
const sellerUp = await callFn('productUpsert', { tenantId: T, data: { name: 'X', price: 1 } }, seller);
check('C1.5 seller NO puede productUpsert → 403', sellerUp.status === 403, `status=${sellerUp.status}`);

// ===== Cierre 2 — products =====

// 1. write directo del owner a products → 403 (write cerrado).
const wProd = await restPatch(`tenants/${T}/products/${pid}`, { price: { integerValue: '1' } }, owner);
check('C2.1 write directo owner a products → 403', wProd === 403, `status=${wProd}`);

// 2. productUpsert owner (update) sigue funcionando.
const upd = await callFn('productUpsert', { tenantId: T, id: pid, data: { price: 120 } }, owner);
check('C2.2 productUpsert owner (update) → ok', upd.status === 200 && (await db.doc(`tenants/${T}/products/${pid}`).get()).data()?.price === 120, `status=${upd.status}`);

// 3. lectura de products: seller y owner SÍ leen.
const rSellerProd = await restGet(`tenants/${T}/products/${pid}`, seller);
const rOwnerProd = await restGet(`tenants/${T}/products/${pid}`, owner);
check('C2.3 viewer/seller leen products → 200', rSellerProd === 200 && rOwnerProd === 200, `seller=${rSellerProd} owner=${rOwnerProd}`);

// 4. productDelete owner sigue archivando (soft).
const del = await callFn('productDelete', { tenantId: T, id: pid }, owner);
check('C2.4 productDelete owner → archive (status ARCHIVED)', del.status === 200 && (await db.doc(`tenants/${T}/products/${pid}`).get()).data()?.status === 'ARCHIVED', `status=${del.status}`);

// 5. seller NO puede productUpsert.
const sellerUp2 = await callFn('productUpsert', { tenantId: T, data: { name: 'Y', price: 1 } }, seller);
check('C2.5 seller NO puede productUpsert → 403', sellerUp2.status === 403, `status=${sellerUp2.status}`);

// ===== Cierre 3 — categories =====

// 1. categoryUpsert owner (create) sigue funcionando (Admin SDK escribe la categoría).
const catUp = await callFn('categoryUpsert', { tenantId: T, data: { name: 'Rules Cat', position: 1 } }, owner);
const catId = catUp.result?.id;
check('C3.1 categoryUpsert owner (create) → ok', catUp.status === 200 && !!catId && (await db.doc(`tenants/${T}/categories/${catId}`).get()).exists, `status=${catUp.status} id=${catId}`);

// 2. write directo del owner a categories → 403 (write cerrado).
const wCat = await restPatch(`tenants/${T}/categories/${catId}`, { name: { stringValue: 'Hack' } }, owner);
check('C3.2 write directo owner a categories → 403', wCat === 403, `status=${wCat}`);

// 3. categoryUpsert owner (update) sigue funcionando vía callable.
const catUpd = await callFn('categoryUpsert', { tenantId: T, id: catId, data: { name: 'Rules Cat 2' } }, owner);
check('C3.3 categoryUpsert owner (update) → ok', catUpd.status === 200 && (await db.doc(`tenants/${T}/categories/${catId}`).get()).data()?.name === 'Rules Cat 2', `status=${catUpd.status}`);

// 4. lectura de categories: read sin cambios (back-office). owner (viewer+) SÍ lee → 200;
//    seller (front-line) NO lee → 403, igual que antes del cierre (no es regresión).
const rOwnerCat = await restGet(`tenants/${T}/categories/${catId}`, owner);
const rSellerCat = await restGet(`tenants/${T}/categories/${catId}`, seller);
check('C3.4 owner (viewer+) lee categories → 200; seller (back-office) → 403 (read sin cambios)', rOwnerCat === 200 && rSellerCat === 403, `owner=${rOwnerCat} seller=${rSellerCat}`);

// 5. categoryDelete BLOQUEA si hay productos con ese categoryId → failed-precondition (400).
const prodInCat = await callFn('productUpsert', { tenantId: T, data: { name: 'In Cat', price: 10, currency: 'PYG', categoryId: catId, status: 'ACTIVE' } }, owner);
const prodInCatId = prodInCat.result?.id;
const delBlocked = await callFn('categoryDelete', { tenantId: T, id: catId }, owner);
check('C3.5 categoryDelete con productos asociados → 400 (bloqueado, no deja huérfanos)', delBlocked.status === 400 && (await db.doc(`tenants/${T}/categories/${catId}`).get()).exists, `status=${delBlocked.status} err=${delBlocked.error?.status}`);

// 6. categoryDelete SIN productos asociados → ok (borra). Categoría vacía aparte.
const catEmpty = await callFn('categoryUpsert', { tenantId: T, data: { name: 'Empty Cat', position: 2 } }, owner);
const catEmptyId = catEmpty.result?.id;
const delOk = await callFn('categoryDelete', { tenantId: T, id: catEmptyId }, owner);
check('C3.6 categoryDelete sin productos → ok (borrada)', delOk.status === 200 && !(await db.doc(`tenants/${T}/categories/${catEmptyId}`).get()).exists, `status=${delOk.status}`);

// 7. seller NO puede categoryUpsert (authz).
const sellerCat = await callFn('categoryUpsert', { tenantId: T, data: { name: 'Nope' } }, seller);
check('C3.7 seller NO puede categoryUpsert → 403', sellerCat.status === 403, `status=${sellerCat.status}`);

// --- Limpieza ---
if (pid) {
  await db.doc(`tenants/${T}/products/${pid}`).delete().catch(() => {});
  await db.doc(`tenants/${T}/productFinancials/${pid}`).delete().catch(() => {});
}
if (catId) await db.doc(`tenants/${T}/categories/${catId}`).delete().catch(() => {});
if (prodInCatId) {
  await db.doc(`tenants/${T}/products/${prodInCatId}`).delete().catch(() => {});
  await db.doc(`tenants/${T}/productFinancials/${prodInCatId}`).delete().catch(() => {});
}
await db.doc(`tenants/${T}`).update({ limitOverrides: {} }).catch(() => {});
for (const d of (await db.collection(`tenants/${T}/auditLogs`).get()).docs) await d.ref.delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO CIERRE RULES CATÁLOGO — C1 productFinancials + C2 products + C3 categories: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
