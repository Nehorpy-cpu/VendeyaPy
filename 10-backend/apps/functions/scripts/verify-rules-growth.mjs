/**
 * verify-rules-growth.mjs — Cierre de rules de growth (Hardening F5C, paso B).
 * Verifica que las escrituras directas desde cliente están bloqueadas y los callables siguen
 * funcionando, sin romper lecturas por rol. Crece por cierre:
 *   G-0 (deliveryPersons): write directo manager+ → 403; deliveryPersonUpsert/Delete (Admin SDK) → ok;
 *     delete con entregas activas → 400 (failed-precondition); lectura viewer+ → 200 (seller no es
 *     viewer → 403, sin cambios); seller NO puede deliveryPersonUpsert.
 *   G-2 (promotions): write directo manager+ → 403; promotionUpsert/Delete (Admin SDK) → ok; delete
 *     SOFT (status='FINISHED'); lectura staff (incl. seller) → 200 (sin cambios); seller NO puede
 *     promotionUpsert/Delete; aislamiento de tenant (boutique no escribe promos de perfumeria).
 *   G-3 (trackingSources): write directo manager+ → 403; trackingSourceUpsert/Delete (Admin SDK) → ok;
 *     el backend normaliza el code (' verano20 ' → 'VERANO20'); delete SOFT (active=false); lectura
 *     staff → 200 (sin cambios); seller NO puede; aislamiento de tenant.
 *   G-4 (winningReplies): write directo manager+ → 403; winningReplyUpsert/Delete (Admin SDK) → ok;
 *     create fuerza source='manual'/status='ACTIVE'; delete SOFT (status='ARCHIVED'); editar una reply
 *     source='auto' → failed-precondition; lectura staff → 200 (sin cambios); seller NO puede; aislamiento.
 *   (G-5 agentTestCases se agrega en su commit.)
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
const boutiqueOwner = await signIn('owner@boutique.com');

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

// ===== Cierre G-2 — promotions =====

// 1. promotionUpsert owner (create) sigue funcionando (Admin SDK).
const pUp = await callFn('promotionUpsert', { tenantId: T, data: { name: 'Rules Promo', type: 'PERCENTAGE', discountValue: 15, status: 'ACTIVE' } }, owner);
const pid = pUp.result?.id;
const promo = pid ? (await db.doc(`tenants/${T}/promotions/${pid}`).get()).data() : null;
check('G2.1 promotionUpsert owner (create) → ok (vía callable)', pUp.status === 200 && promo?.name === 'Rules Promo' && promo?.status === 'ACTIVE', `status=${pUp.status}`);

// 2. write directo del owner (manager+) a promotions → 403 (write cerrado).
const wPromo = await restPatch(`tenants/${T}/promotions/${pid}`, { discountValue: { integerValue: '99' } }, owner);
check('G2.2 write directo owner a promotions → 403', wPromo === 403, `status=${wPromo}`);

// 3. promotionUpsert owner (update) sigue funcionando.
const pUpd = await callFn('promotionUpsert', { tenantId: T, id: pid, data: { discountValue: 25 } }, owner);
check('G2.3 promotionUpsert owner (update) → ok', pUpd.status === 200 && (await db.doc(`tenants/${T}/promotions/${pid}`).get()).data()?.discountValue === 25, `status=${pUpd.status}`);

// 4. promotionDelete owner → soft (status FINISHED).
const pDel = await callFn('promotionDelete', { tenantId: T, id: pid }, owner);
check('G2.4 promotionDelete owner → soft (status FINISHED)', pDel.status === 200 && (await db.doc(`tenants/${T}/promotions/${pid}`).get()).data()?.status === 'FINISHED', `status=${pDel.status}`);

// 5. lectura de promotions: read sin cambios. owner y seller (staff) → 200.
const rOwnerP = await restGet(`tenants/${T}/promotions/${pid}`, owner);
const rSellerP = await restGet(`tenants/${T}/promotions/${pid}`, seller);
check('G2.5 owner/seller (staff) leen promotions → 200 (read sin cambios)', rOwnerP === 200 && rSellerP === 200, `owner=${rOwnerP} seller=${rSellerP}`);

// 6. seller NO puede promotionUpsert ni promotionDelete (authz manager+).
const sellerPU = await callFn('promotionUpsert', { tenantId: T, data: { name: 'X', type: 'PERCENTAGE' } }, seller);
const sellerPD = await callFn('promotionDelete', { tenantId: T, id: pid }, seller);
check('G2.6 seller NO puede promotionUpsert/Delete → 403', sellerPU.status === 403 && sellerPD.status === 403, `up=${sellerPU.status} del=${sellerPD.status}`);

// 7. aislamiento de tenant: owner de boutique con tenantId=perfumeria NO escribe en perfumeria
//    (resolvePanelAuth ignora el tenantId pedido y usa el del token → crea en boutique-demo).
const bPromo = await callFn('promotionUpsert', { tenantId: T, data: { name: 'Cross', type: 'PERCENTAGE' } }, boutiqueOwner);
const bid = bPromo.result?.id;
const inPerfu = bid ? (await db.doc(`tenants/${T}/promotions/${bid}`).get()).exists : true;
const inBoutique = bid ? (await db.doc(`tenants/boutique-demo/promotions/${bid}`).get()).exists : false;
check('G2.7 cross-tenant: boutique NO crea promo en perfumeria (la crea en su tenant)', bPromo.status === 200 && !inPerfu && inBoutique, `perfu=${inPerfu} boutique=${inBoutique}`);

// ===== Cierre G-3 — trackingSources =====

// 1. trackingSourceUpsert owner (create) + el backend NORMALIZA el code (' verano20 ' → 'VERANO20').
const tUp = await callFn('trackingSourceUpsert', { tenantId: T, data: { name: 'Rules Track', code: ' verano20 ', type: 'coupon', active: true } }, owner);
const tid = tUp.result?.id;
const tsrc = tid ? (await db.doc(`tenants/${T}/trackingSources/${tid}`).get()).data() : null;
check('G3.1 trackingSourceUpsert owner (create) + normaliza code (" verano20 " → "VERANO20")', tUp.status === 200 && tsrc?.code === 'VERANO20' && tsrc?.active === true, `status=${tUp.status} code=${tsrc?.code}`);

// 2. write directo del owner (manager+) a trackingSources → 403 (write cerrado).
const wTrack = await restPatch(`tenants/${T}/trackingSources/${tid}`, { code: { stringValue: 'HACK' } }, owner);
check('G3.2 write directo owner a trackingSources → 403', wTrack === 403, `status=${wTrack}`);

// 3. trackingSourceUpsert owner (update) sigue funcionando.
const tUpd = await callFn('trackingSourceUpsert', { tenantId: T, id: tid, data: { name: 'Rules Track v2' } }, owner);
check('G3.3 trackingSourceUpsert owner (update) → ok', tUpd.status === 200 && (await db.doc(`tenants/${T}/trackingSources/${tid}`).get()).data()?.name === 'Rules Track v2', `status=${tUpd.status}`);

// 4. trackingSourceDelete owner → soft (active=false).
const tDel = await callFn('trackingSourceDelete', { tenantId: T, id: tid }, owner);
check('G3.4 trackingSourceDelete owner → soft (active=false)', tDel.status === 200 && (await db.doc(`tenants/${T}/trackingSources/${tid}`).get()).data()?.active === false, `status=${tDel.status}`);

// 5. lectura: read sin cambios. owner y seller (staff) → 200.
const rOwnerT = await restGet(`tenants/${T}/trackingSources/${tid}`, owner);
const rSellerT = await restGet(`tenants/${T}/trackingSources/${tid}`, seller);
check('G3.5 owner/seller (staff) leen trackingSources → 200 (read sin cambios)', rOwnerT === 200 && rSellerT === 200, `owner=${rOwnerT} seller=${rSellerT}`);

// 6. seller NO puede trackingSourceUpsert ni trackingSourceDelete (authz manager+).
const sellerTU = await callFn('trackingSourceUpsert', { tenantId: T, data: { name: 'X', code: 'NOPE1', type: 'qr' } }, seller);
const sellerTD = await callFn('trackingSourceDelete', { tenantId: T, id: tid }, seller);
check('G3.6 seller NO puede trackingSourceUpsert/Delete → 403', sellerTU.status === 403 && sellerTD.status === 403, `up=${sellerTU.status} del=${sellerTD.status}`);

// 7. aislamiento de tenant: owner de boutique con tenantId=perfumeria crea en boutique, NO en perfumeria.
const bTrack = await callFn('trackingSourceUpsert', { tenantId: T, data: { name: 'Cross', code: 'CROSS1', type: 'link' } }, boutiqueOwner);
const btid = bTrack.result?.id;
const tInPerfu = btid ? (await db.doc(`tenants/${T}/trackingSources/${btid}`).get()).exists : true;
const tInBoutique = btid ? (await db.doc(`tenants/boutique-demo/trackingSources/${btid}`).get()).exists : false;
check('G3.7 cross-tenant: boutique NO crea trackingSource en perfumeria (la crea en su tenant)', bTrack.status === 200 && !tInPerfu && tInBoutique, `perfu=${tInPerfu} boutique=${tInBoutique}`);

// ===== Cierre G-4 — winningReplies =====

// 1. winningReplyUpsert owner (create) → backend fuerza source='manual', conversions=0, status='ACTIVE'.
const wUp = await callFn('winningReplyUpsert', { tenantId: T, data: { text: '¡Gracias por tu compra!', category: 'cierre' } }, owner);
const wid = wUp.result?.id;
const wrep = wid ? (await db.doc(`tenants/${T}/winningReplies/${wid}`).get()).data() : null;
check('G4.1 winningReplyUpsert owner (create) → ok (source=manual, status=ACTIVE, conversions=0)', wUp.status === 200 && wrep?.source === 'manual' && wrep?.status === 'ACTIVE' && wrep?.conversions === 0, `status=${wUp.status} source=${wrep?.source}`);

// 2. write directo del owner (manager+) a winningReplies → 403 (write cerrado).
const wWin = await restPatch(`tenants/${T}/winningReplies/${wid}`, { text: { stringValue: 'HACK' } }, owner);
check('G4.2 write directo owner a winningReplies → 403', wWin === 403, `status=${wWin}`);

// 3. winningReplyUpsert owner (update) sigue funcionando.
const wUpd = await callFn('winningReplyUpsert', { tenantId: T, id: wid, data: { category: 'objeción' } }, owner);
check('G4.3 winningReplyUpsert owner (update) → ok', wUpd.status === 200 && (await db.doc(`tenants/${T}/winningReplies/${wid}`).get()).data()?.category === 'objeción', `status=${wUpd.status}`);

// 4. winningReplyDelete owner → soft (status ARCHIVED).
const wDel = await callFn('winningReplyDelete', { tenantId: T, id: wid }, owner);
check('G4.4 winningReplyDelete owner → soft (status ARCHIVED)', wDel.status === 200 && (await db.doc(`tenants/${T}/winningReplies/${wid}`).get()).data()?.status === 'ARCHIVED', `status=${wDel.status}`);

// 5. editar una reply source='auto' (minada) vía callable → failed-precondition (400).
await db.doc(`tenants/${T}/winningReplies/g4-auto`).set({ id: 'g4-auto', tenantId: T, text: 'auto', category: 'x', source: 'auto', conversions: 5, status: 'ACTIVE', createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const wAuto = await callFn('winningReplyUpsert', { tenantId: T, id: 'g4-auto', data: { text: 'editada' } }, owner);
check('G4.5 editar reply source=auto vía callable → 400 (failed-precondition)', wAuto.status === 400, `status=${wAuto.status} err=${wAuto.error?.status}`);

// 6. lectura: read sin cambios. owner y seller (staff) → 200.
const rOwnerW = await restGet(`tenants/${T}/winningReplies/${wid}`, owner);
const rSellerW = await restGet(`tenants/${T}/winningReplies/${wid}`, seller);
check('G4.6 owner/seller (staff) leen winningReplies → 200 (read sin cambios)', rOwnerW === 200 && rSellerW === 200, `owner=${rOwnerW} seller=${rSellerW}`);

// 7. seller NO puede winningReplyUpsert ni winningReplyDelete (authz manager+).
const sellerWU = await callFn('winningReplyUpsert', { tenantId: T, data: { text: 'X', category: 'y' } }, seller);
const sellerWD = await callFn('winningReplyDelete', { tenantId: T, id: wid }, seller);
check('G4.7 seller NO puede winningReplyUpsert/Delete → 403', sellerWU.status === 403 && sellerWD.status === 403, `up=${sellerWU.status} del=${sellerWD.status}`);

// 8. aislamiento de tenant: owner de boutique con tenantId=perfumeria crea en boutique, NO en perfumeria.
const bWin = await callFn('winningReplyUpsert', { tenantId: T, data: { text: 'Cross', category: 'z' } }, boutiqueOwner);
const bwid = bWin.result?.id;
const wInPerfu = bwid ? (await db.doc(`tenants/${T}/winningReplies/${bwid}`).get()).exists : true;
const wInBoutique = bwid ? (await db.doc(`tenants/boutique-demo/winningReplies/${bwid}`).get()).exists : false;
check('G4.8 cross-tenant: boutique NO crea reply en perfumeria (la crea en su tenant)', bWin.status === 200 && !wInPerfu && wInBoutique, `perfu=${wInPerfu} boutique=${wInBoutique}`);

// --- Limpieza ---
if (did) await db.doc(`tenants/${T}/deliveryPersons/${did}`).delete().catch(() => {});
await db.doc(`tenants/${T}/deliveryPersons/rules-hack`).delete().catch(() => {}); // por si el create directo hubiera pasado
if (pid) await db.doc(`tenants/${T}/promotions/${pid}`).delete().catch(() => {});
if (bid) await db.doc(`tenants/boutique-demo/promotions/${bid}`).delete().catch(() => {});
if (tid) await db.doc(`tenants/${T}/trackingSources/${tid}`).delete().catch(() => {});
if (btid) await db.doc(`tenants/boutique-demo/trackingSources/${btid}`).delete().catch(() => {});
if (wid) await db.doc(`tenants/${T}/winningReplies/${wid}`).delete().catch(() => {});
await db.doc(`tenants/${T}/winningReplies/g4-auto`).delete().catch(() => {});
if (bwid) await db.doc(`tenants/boutique-demo/winningReplies/${bwid}`).delete().catch(() => {});
await db.doc(`tenants/${T}`).update({ limitOverrides: {} }).catch(() => {});
for (const d of (await db.collection(`tenants/${T}/auditLogs`).get()).docs) await d.ref.delete().catch(() => {});
for (const d of (await db.collection('tenants/boutique-demo/auditLogs').get()).docs) await d.ref.delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO CIERRE RULES GROWTH — G-0 deliveryPersons + G-2 promotions + G-3 trackingSources + G-4 winningReplies: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
