/**
 * verify-fase5c-growth-c1.mjs — Promociones + tracking por callable (Hardening F5C-C1).
 * promotionUpsert/Delete (soft FINISHED) y trackingSourceUpsert/Delete (soft active=false): rol
 * manager+ (seller 403), validación (400), whitelist (descarta attribution/tenantId/server-only),
 * soft-delete conserva historial/rollup, auditoría. No cierra rules ni toca el frontend.
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

const admin = await signIn('superadmin@aiafg.com');
const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');

const T = 'gr-test';
await db.doc(`tenants/${T}`).set({ id: T, name: T, slug: T, status: 'ACTIVE', planId: 'free', createdAt: Timestamp.now(), updatedAt: Timestamp.now() });

// 1. promotionUpsert create + whitelist
const p1 = await callFn('promotionUpsert', { tenantId: T, data: { name: 'Verano', type: 'PERCENTAGE', discountValue: 20, status: 'ACTIVE', startDate: '2026-01-01T00:00:00Z', attribution: { x: 1 }, tenantId: 'evil' } }, admin);
const promo = await doc(`tenants/${T}/promotions/${p1.result?.id}`);
check('1. promotionUpsert create + whitelist (descarta attribution/tenantId)', p1.status === 200 && promo?.name === 'Verano' && promo?.tenantId === T && promo?.attribution === undefined && !!promo?.startDate, `status=${p1.status} attr=${promo?.attribution}`);

// 2. update
const p2 = await callFn('promotionUpsert', { tenantId: T, id: p1.result?.id, data: { discountValue: 30 } }, admin);
check('2. promotionUpsert update → ok', p2.status === 200 && (await doc(`tenants/${T}/promotions/${p1.result?.id}`))?.discountValue === 30, `status=${p2.status}`);

// 3. promotionDelete soft → FINISHED
const p3 = await callFn('promotionDelete', { tenantId: T, id: p1.result?.id }, admin);
check('3. promotionDelete → soft (status FINISHED)', p3.status === 200 && (await doc(`tenants/${T}/promotions/${p1.result?.id}`))?.status === 'FINISHED', `status=${p3.status}`);

// 4. seller → 403
const p4 = await callFn('promotionUpsert', { tenantId: T, data: { name: 'X', type: 'PERCENTAGE' } }, seller);
check('4. promotionUpsert vendedor → 403', p4.status === 403, `status=${p4.status}`);

// 5. payload inválido (sin type en create) → 400
const p5 = await callFn('promotionUpsert', { tenantId: T, data: { name: 'Sin tipo' } }, admin);
check('5. promotionUpsert payload inválido → 400', p5.status === 400, `status=${p5.status}`);

// 6. trackingSourceUpsert create + whitelist
const t1 = await callFn('trackingSourceUpsert', { tenantId: T, data: { name: 'QR Local', code: 'VERANO20', type: 'coupon', active: true, attribution: { x: 1 } } }, admin);
const ts = await doc(`tenants/${T}/trackingSources/${t1.result?.id}`);
check('6. trackingSourceUpsert create + whitelist (descarta attribution)', t1.status === 200 && ts?.code === 'VERANO20' && ts?.active === true && ts?.attribution === undefined, `status=${t1.status}`);

// 7. update
const t2 = await callFn('trackingSourceUpsert', { tenantId: T, id: t1.result?.id, data: { name: 'QR Local v2' } }, admin);
check('7. trackingSourceUpsert update → ok', t2.status === 200, `status=${t2.status}`);

// 8. trackingSourceDelete soft → active=false
const t3 = await callFn('trackingSourceDelete', { tenantId: T, id: t1.result?.id }, admin);
check('8. trackingSourceDelete → soft (active=false)', t3.status === 200 && (await doc(`tenants/${T}/trackingSources/${t1.result?.id}`))?.active === false, `status=${t3.status}`);

// 9. seller tracking → 403
const t4 = await callFn('trackingSourceUpsert', { tenantId: T, data: { name: 'X', code: 'C', type: 'qr' } }, seller);
check('9. trackingSourceUpsert vendedor → 403', t4.status === 403, `status=${t4.status}`);

// 10. owner (manager+) permitido + auditoría
const o1 = await callFn('promotionUpsert', { tenantId: 'perfumeria', data: { name: 'owner-promo-c1', type: 'FREE_SHIPPING' } }, owner);
const audits = await db.collection(`tenants/${T}/auditLogs`).get();
const actions = new Set(audits.docs.map((d) => d.data().action));
check('10. owner permitido + auditoría (promotion.finished + trackingSource.deactivated)', o1.status === 200 && actions.has('promotion.finished') && actions.has('trackingSource.deactivated'), `owner=${o1.status} actions=${[...actions].join(',')}`);

// --- Limpieza ---
for (const sub of ['promotions', 'trackingSources', 'auditLogs']) {
  for (const d of (await db.collection(`tenants/${T}/${sub}`).get()).docs) await d.ref.delete();
}
await db.doc(`tenants/${T}`).delete().catch(() => {});
if (o1.result?.id) await db.doc(`tenants/perfumeria/promotions/${o1.result.id}`).delete().catch(() => {});
for (const d of (await db.collection('tenants/perfumeria/auditLogs').get()).docs) await d.ref.delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO HARDENING F5C-C1 (promociones + tracking): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
