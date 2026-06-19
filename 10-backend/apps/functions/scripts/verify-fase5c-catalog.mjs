/**
 * verify-fase5c-catalog.mjs — Catálogo por callable (Hardening F5C-B).
 * productUpsert (+financials, whitelist, cuota), productDelete (soft-archive, conserva costos),
 * categoryUpsert/Delete (bloqueo si hay productos). Rol manager+ (seller 403). Auditoría.
 * Usa tenants frescos (admin) para create/cuota; owner@perfumeria para el rol-allowed.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTHURL = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTHURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, idToken) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}
const doc = (p) => db.doc(p).get().then((s) => s.data());
const created = [];
async function mkTenant(id, extra = {}) {
  created.push(id);
  await db.doc(`tenants/${id}`).set({ id, name: id, slug: id, status: 'ACTIVE', planId: 'free', usage: { messagesThisMonth: 0, ordersThisMonth: 0, jobsThisMonth: 0, adSyncsThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: Timestamp.now() }, ...extra, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
}

const admin = await signIn('superadmin@aiafg.com');
const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');

await mkTenant('cat-test');

// 1. create con financials + whitelist (descarta sync/planId/tenantId)
const p1 = await callFn('productUpsert', { tenantId: 'cat-test', data: { name: 'Perfume X', price: 100, currency: 'PYG', status: 'ACTIVE', metaProductItemId: 'm1', syncToMeta: true, tenantId: 'evil', planId: 'pro' }, financials: { costPrice: 40 } }, admin);
const pid = p1.result?.id;
const prod = await doc(`tenants/cat-test/products/${pid}`);
const fin = await doc(`tenants/cat-test/productFinancials/${pid}`);
check('1. productUpsert create + financials; whitelist descarta sync/planId; tenantId server',
  p1.status === 200 && prod?.name === 'Perfume X' && prod?.tenantId === 'cat-test' && prod?.metaProductItemId === undefined && prod?.syncToMeta === undefined && prod?.planId === undefined && fin?.costPrice === 40,
  `status=${p1.status} cost=${fin?.costPrice} meta=${prod?.metaProductItemId}`);

// 2. cuota maxProducts (override 0) → 429
await mkTenant('cat-quota', { limitOverrides: { maxProducts: 0 } });
const p2 = await callFn('productUpsert', { tenantId: 'cat-quota', data: { name: 'Y' } }, admin);
check('2. productUpsert sobre cuota maxProducts → 429', p2.status === 429, `status=${p2.status}`);

// 3. seller → 403
const p3 = await callFn('productUpsert', { tenantId: 'cat-test', data: { name: 'Z' } }, seller);
check('3. productUpsert vendedor → 403', p3.status === 403, `status=${p3.status}`);

// 4. payload inválido → 400
const p4 = await callFn('productUpsert', { tenantId: 'cat-test', data: { name: 'Bad', price: -5 } }, admin);
check('4. productUpsert payload inválido → 400', p4.status === 400, `status=${p4.status}`);

// 5. update (sin cuota)
const p5 = await callFn('productUpsert', { tenantId: 'cat-test', id: pid, data: { price: 99 } }, admin);
check('5. productUpsert update → ok', p5.status === 200 && (await doc(`tenants/cat-test/products/${pid}`))?.price === 99, `status=${p5.status}`);

// 6. productDelete = soft-archive; financials se conserva
const d6 = await callFn('productDelete', { tenantId: 'cat-test', id: pid }, admin);
const prodA = await doc(`tenants/cat-test/products/${pid}`);
const finA = await doc(`tenants/cat-test/productFinancials/${pid}`);
check('6. productDelete → ARCHIVED + financials conservado', d6.status === 200 && prodA?.status === 'ARCHIVED' && finA?.costPrice === 40, `status=${prodA?.status} finCost=${finA?.costPrice}`);

// 7. categoryUpsert + categoryDelete (sin productos)
const c7 = await callFn('categoryUpsert', { tenantId: 'cat-test', data: { name: 'Sin productos' } }, admin);
const c7d = await callFn('categoryDelete', { tenantId: 'cat-test', id: c7.result?.id }, admin);
check('7. categoryUpsert + categoryDelete (vacía) → ok', c7.status === 200 && c7d.status === 200, `up=${c7.status} del=${c7d.status}`);

// 8. categoryDelete con productos → 400
const c8 = await callFn('categoryUpsert', { tenantId: 'cat-test', data: { name: 'Con productos' } }, admin);
await callFn('productUpsert', { tenantId: 'cat-test', data: { name: 'En categoría', categoryId: c8.result?.id } }, admin);
const c8d = await callFn('categoryDelete', { tenantId: 'cat-test', id: c8.result?.id }, admin);
check('8. categoryDelete con productos asociados → 400 (failed-precondition)', c8d.status === 400, `status=${c8d.status}`);

// 9. owner (manager+) permitido (categoryUpsert sin cuota)
const c9 = await callFn('categoryUpsert', { tenantId: 'perfumeria', data: { name: 'owner-cat-5cb' } }, owner);
check('9. owner puede gestionar catálogo (categoryUpsert) → ok', c9.status === 200, `status=${c9.status}`);

// 10. Auditoría
const audits = await db.collection('tenants/cat-test/auditLogs').get();
const actions = new Set(audits.docs.map((d) => d.data().action));
check('10. Auditoría (product.archived + category.deleted)', actions.has('product.archived') && actions.has('category.deleted'), `actions=${[...actions].join(',')}`);

// --- Limpieza ---
for (const id of created) {
  for (const sub of ['products', 'productFinancials', 'categories', 'auditLogs']) {
    for (const d of (await db.collection(`tenants/${id}/${sub}`).get()).docs) await d.ref.delete();
  }
  await db.doc(`tenants/${id}`).delete().catch(() => {});
}
if (c9.result?.id) await db.doc(`tenants/perfumeria/categories/${c9.result.id}`).delete().catch(() => {});
for (const d of (await db.collection('tenants/perfumeria/auditLogs').get()).docs) await d.ref.delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO HARDENING F5C-B (catálogo por callable): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
