/**
 * verify-fase5c-growth-c2.mjs — Repartidores + winningReplies + agentTestCases (Hardening F5C-C2).
 * deliveryPerson (cuota maxDeliveryPersons activos; delete bloquea si hay entregas activas, si no
 * soft-deactivate), winningReply (solo manual; rechaza editar auto; delete soft-archive),
 * agentTestCase (definición; delete hard). Rol manager+ (seller 403), validación/whitelist, auditoría.
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
  await db.doc(`tenants/${id}`).set({ id, name: id, slug: id, status: 'ACTIVE', planId: 'free', ...extra, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
}

const admin = await signIn('superadmin@aiafg.com');
const seller = await signIn('seller@perfumeria.com');

await mkTenant('gr2-test');

// 1. deliveryPersonUpsert create + whitelist
const d1 = await callFn('deliveryPersonUpsert', { tenantId: 'gr2-test', data: { name: 'Juan', whatsappPhone: '+595981000000', status: 'AVAILABLE', isActive: true, stats: { x: 1 }, activeDeliveryIds: ['x'] } }, admin);
const drv = await doc(`tenants/gr2-test/deliveryPersons/${d1.result?.id}`);
check('1. deliveryPersonUpsert create + whitelist (descarta stats/activeDeliveryIds)', d1.status === 200 && drv?.name === 'Juan' && JSON.stringify(drv?.stats) === JSON.stringify({ deliveriesToday: 0, deliveriesTotal: 0, successRate: 0, rating: 0 }) && Array.isArray(drv?.activeDeliveryIds) && drv.activeDeliveryIds.length === 0, `status=${d1.status}`);

// 2. cuota maxDeliveryPersons (override 0) → 429
await mkTenant('gr2-quota', { limitOverrides: { maxDeliveryPersons: 0 } });
const d2 = await callFn('deliveryPersonUpsert', { tenantId: 'gr2-quota', data: { name: 'A', whatsappPhone: '1' } }, admin);
check('2. deliveryPersonUpsert sobre cuota → 429', d2.status === 429, `status=${d2.status}`);

// 3. cupo activo: con maxDeliveryPersons=1, el 2do bloquea; al desactivar el 1ro se libera cupo
await mkTenant('gr2-cupo', { limitOverrides: { maxDeliveryPersons: 1 } });
const a = await callFn('deliveryPersonUpsert', { tenantId: 'gr2-cupo', data: { name: 'A', whatsappPhone: '1' } }, admin);
const bBlocked = await callFn('deliveryPersonUpsert', { tenantId: 'gr2-cupo', data: { name: 'B', whatsappPhone: '2' } }, admin);
await callFn('deliveryPersonDelete', { tenantId: 'gr2-cupo', id: a.result?.id }, admin); // desactiva A
const bOk = await callFn('deliveryPersonUpsert', { tenantId: 'gr2-cupo', data: { name: 'B', whatsappPhone: '2' } }, admin);
check('3. La cuota cuenta solo activos (desactivar libera cupo)', bBlocked.status === 429 && bOk.status === 200, `bloqueado=${bBlocked.status} liberado=${bOk.status}`);

// 4. deliveryPersonDelete con entregas activas → 400
await db.doc(`tenants/gr2-test/deliveryPersons/${d1.result?.id}`).set({ activeDeliveryIds: ['del-1'] }, { merge: true });
const d4 = await callFn('deliveryPersonDelete', { tenantId: 'gr2-test', id: d1.result?.id }, admin);
check('4. deliveryPersonDelete con entregas activas → 400 (block)', d4.status === 400, `status=${d4.status}`);

// 5. sin entregas activas → soft-deactivate
await db.doc(`tenants/gr2-test/deliveryPersons/${d1.result?.id}`).set({ activeDeliveryIds: [] }, { merge: true });
const d5 = await callFn('deliveryPersonDelete', { tenantId: 'gr2-test', id: d1.result?.id }, admin);
const drvA = await doc(`tenants/gr2-test/deliveryPersons/${d1.result?.id}`);
check('5. deliveryPersonDelete sin entregas → soft (isActive=false, OFFLINE)', d5.status === 200 && drvA?.isActive === false && drvA?.status === 'OFFLINE', `status=${d5.status} isActive=${drvA?.isActive}`);

// 6. seller → 403
const d6 = await callFn('deliveryPersonUpsert', { tenantId: 'gr2-test', data: { name: 'X', whatsappPhone: '1' } }, seller);
check('6. deliveryPersonUpsert vendedor → 403', d6.status === 403, `status=${d6.status}`);

// 7. winningReplyUpsert create → manual + conversions 0 (whitelist descarta source/conversions)
const w1 = await callFn('winningReplyUpsert', { tenantId: 'gr2-test', data: { text: '¡Gracias por tu compra!', category: 'cierre', source: 'auto', conversions: 99 } }, admin);
const rep = await doc(`tenants/gr2-test/winningReplies/${w1.result?.id}`);
check('7. winningReplyUpsert create → source=manual, conversions=0', w1.status === 200 && rep?.source === 'manual' && rep?.conversions === 0, `status=${w1.status} source=${rep?.source}`);

// 8. update sobre reply 'auto' → 400
await db.doc(`tenants/gr2-test/winningReplies/auto-1`).set({ id: 'auto-1', tenantId: 'gr2-test', text: 'auto', source: 'auto', conversions: 5, status: 'ACTIVE', createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const w2 = await callFn('winningReplyUpsert', { tenantId: 'gr2-test', id: 'auto-1', data: { text: 'editada' } }, admin);
check('8. winningReplyUpsert update sobre auto → 400', w2.status === 400, `status=${w2.status}`);

// 9. winningReplyDelete → soft-archive
const w3 = await callFn('winningReplyDelete', { tenantId: 'gr2-test', id: w1.result?.id }, admin);
check('9. winningReplyDelete → soft (status ARCHIVED)', w3.status === 200 && (await doc(`tenants/gr2-test/winningReplies/${w1.result?.id}`))?.status === 'ARCHIVED', `status=${w3.status}`);

// 10. agentTestCaseUpsert create → UNTESTED + sin lastResult del cliente
const a1 = await callFn('agentTestCaseUpsert', { tenantId: 'gr2-test', data: { name: 'Caso pide descuento', scenario: 's', userMessage: 'dame descuento', expectedBehavior: 'ofrecer alternativa', lastResult: 'hack', lastRunAt: 123 } }, admin);
const tc = await doc(`tenants/gr2-test/agentTestCases/${a1.result?.id}`);
check('10. agentTestCaseUpsert create → UNTESTED, sin lastResult del cliente', a1.status === 200 && tc?.status === 'UNTESTED' && tc?.lastResult === '' && tc?.lastRunAt === null, `status=${a1.status} last=${tc?.lastResult}`);

// 11. agentTestCaseDelete → hard-delete
const a2 = await callFn('agentTestCaseDelete', { tenantId: 'gr2-test', id: a1.result?.id }, admin);
check('11. agentTestCaseDelete → hard-delete (doc eliminado)', a2.status === 200 && !(await db.doc(`tenants/gr2-test/agentTestCases/${a1.result?.id}`).get()).exists, `status=${a2.status}`);

// 12. Auditoría
const audits = await db.collection('tenants/gr2-test/auditLogs').get();
const actions = new Set(audits.docs.map((d) => d.data().action));
check('12. Auditoría (deliveryPerson.deactivated + winningReply.archived + agentTestCase.deleted)', actions.has('deliveryPerson.deactivated') && actions.has('winningReply.archived') && actions.has('agentTestCase.deleted'), `actions=${[...actions].join(',')}`);

// --- Limpieza ---
for (const id of created) {
  for (const sub of ['deliveryPersons', 'winningReplies', 'agentTestCases', 'auditLogs']) {
    for (const d of (await db.collection(`tenants/${id}/${sub}`).get()).docs) await d.ref.delete();
  }
  await db.doc(`tenants/${id}`).delete().catch(() => {});
}

const ok = results.every((x) => x);
console.log(`\nRESULTADO HARDENING F5C-C2 (delivery + winningReplies + agentTestCases): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
