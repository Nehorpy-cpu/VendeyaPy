/**
 * verify-rules-onboarding.mjs — Cierre de rules de onboarding (Fase registro, R-2).
 * Verifica que `onboarding` quedó como clave sensible del doc raíz tenants/{tenantId}: el cliente
 * NO puede escribirla por write directo (PATCH REST → 403), ni siquiera el PLATFORM_ADMIN; solo el
 * callable completeOnboarding (Admin SDK) la marca. Confirma además que: las claves sensibles
 * preexistentes siguen bloqueadas (planId), los updates NO sensibles del owner siguen permitidos,
 * cross-tenant sigue bloqueado, el admin conserva acceso (callable + update no sensible) y la
 * lectura del doc no cambia. Usa tenants/usuarios EFÍMEROS (no toca perfumeria — convivencia).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const auth = getAuth();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTHURL = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';

const TA = 'rules-onb-a';
const TB = 'rules-onb-b';

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
// Valor REST tipado para PATCH de `onboarding` (mapValue).
const ONB = (completed) => ({ onboarding: { mapValue: { fields: { completed: { booleanValue: completed }, completedAt: { nullValue: null } } } } });

const ephemeralUids = [];
async function mkUser(email, role, tenantId) {
  let u;
  try { u = await auth.getUserByEmail(email); } catch { u = await auth.createUser({ email, password: 'test1234', emailVerified: true }); }
  await auth.setCustomUserClaims(u.uid, { role, tenantId });
  ephemeralUids.push(u.uid);
  return signIn(email); // idToken fresco con los claims recién seteados
}
async function mkTenant(tid) {
  await db.doc(`tenants/${tid}`).set({
    status: 'ACTIVE', planId: 'free', displayName: 'Rules Onb', isDemo: false,
    onboarding: { completed: false, completedAt: null }, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
  });
}

await mkTenant(TA);
await mkTenant(TB);
const ownerA = await mkUser('rules-onb-owner-a@test.com', 'TENANT_OWNER', TA);
const sellerA = await mkUser('rules-onb-seller-a@test.com', 'SELLER', TA);
const ownerB = await mkUser('rules-onb-owner-b@test.com', 'TENANT_OWNER', TB);
const admin = await signIn('superadmin@aiafg.com');

// 1. owner NO puede escribir onboarding directo por Firestore → 403 (clave sensible nueva).
const w1 = await restPatch(`tenants/${TA}`, ONB(true), ownerA);
const onb1 = (await db.doc(`tenants/${TA}`).get()).data()?.onboarding?.completed;
check('R2.1 owner write directo de tenant.onboarding → 403 (no lo marca)', w1 === 403 && onb1 === false, `status=${w1} completed=${onb1}`);

// 2. clave sensible preexistente sigue bloqueada (no rompimos la lista, la ampliamos).
const w2 = await restPatch(`tenants/${TA}`, { planId: { stringValue: 'pro' } }, ownerA);
const plan2 = (await db.doc(`tenants/${TA}`).get()).data()?.planId;
check('R2.2 owner write directo de planId → 403 (sensibles preexistentes intactos)', w2 === 403 && plan2 === 'free', `status=${w2} planId=${plan2}`);

// 3. update NO sensible del owner sigue permitido (no sobre-restringimos).
const w3 = await restPatch(`tenants/${TA}`, { displayName: { stringValue: 'Owner Editó' } }, ownerA);
const name3 = (await db.doc(`tenants/${TA}`).get()).data()?.displayName;
check('R2.3 owner write directo de campo NO sensible (displayName) → 200', w3 === 200 && name3 === 'Owner Editó', `status=${w3} name=${name3}`);

// 4. miembro no-owner (seller) tampoco puede escribir onboarding directo → 403.
const w4 = await restPatch(`tenants/${TA}`, ONB(true), sellerA);
check('R2.4 seller write directo de tenant.onboarding → 403', w4 === 403, `status=${w4}`);

// 5. el callable completeOnboarding (owner, Admin SDK) SÍ marca onboarding.completed.
const r5 = await callFn('completeOnboarding', {}, ownerA);
const onb5 = (await db.doc(`tenants/${TA}`).get()).data()?.onboarding?.completed;
check('R2.5 completeOnboarding (owner) → 200 y onboarding.completed=true', r5.status === 200 && onb5 === true, `status=${r5.status} completed=${onb5}`);

// 6. cross-tenant: owner de A NO escribe onboarding de B por write directo → 403 (B intacto).
const w6 = await restPatch(`tenants/${TB}`, ONB(true), ownerA);
const onb6 = (await db.doc(`tenants/${TB}`).get()).data()?.onboarding?.completed;
check('R2.6 cross-tenant: owner de A write directo de onboarding de B → 403 (B sigue false)', w6 === 403 && onb6 === false, `status=${w6} B.completed=${onb6}`);

// 7. PLATFORM_ADMIN tampoco escribe onboarding directo → 403 (es callable-only para todos).
const w7 = await restPatch(`tenants/${TA}`, ONB(false), admin);
check('R2.7 PLATFORM_ADMIN write directo de tenant.onboarding → 403 (callable-only)', w7 === 403, `status=${w7}`);

// 8. PLATFORM_ADMIN conserva acceso vía callable: completeOnboarding(tenantId=B) → 200.
const r8 = await callFn('completeOnboarding', { tenantId: TB }, admin);
const onb8 = (await db.doc(`tenants/${TB}`).get()).data()?.onboarding?.completed;
check('R2.8 PLATFORM_ADMIN completeOnboarding(tenantId=B) → 200 y B.completed=true', r8.status === 200 && onb8 === true, `status=${r8.status} B.completed=${onb8}`);

// 9. PLATFORM_ADMIN conserva el update NO sensible directo → 200.
const w9 = await restPatch(`tenants/${TA}`, { displayName: { stringValue: 'Admin Editó' } }, admin);
const name9 = (await db.doc(`tenants/${TA}`).get()).data()?.displayName;
check('R2.9 PLATFORM_ADMIN write directo de campo NO sensible → 200 (acceso esperado)', w9 === 200 && name9 === 'Admin Editó', `status=${w9} name=${name9}`);

// 10. lectura del doc sin cambios: owner y seller (miembros) leen → 200.
const rOwner = await restGet(`tenants/${TA}`, ownerA);
const rSeller = await restGet(`tenants/${TA}`, sellerA);
check('R2.10 lectura del tenant sin cambios: owner y seller → 200', rOwner === 200 && rSeller === 200, `owner=${rOwner} seller=${rSeller}`);

// --- Limpieza ---
for (const tid of [TA, TB]) {
  for (const d of (await db.collection(`tenants/${tid}/auditLogs`).get()).docs) await d.ref.delete().catch(() => {});
  await db.doc(`tenants/${tid}`).delete().catch(() => {});
}
for (const uid of ephemeralUids) { await db.doc(`users/${uid}`).delete().catch(() => {}); await auth.deleteUser(uid).catch(() => {}); }

const ok = results.every((x) => x);
console.log(`\nRESULTADO CIERRE RULES ONBOARDING — R-2 tenant.onboarding write:false (callable-only): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
