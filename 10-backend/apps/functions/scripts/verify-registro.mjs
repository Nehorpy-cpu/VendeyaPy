/**
 * verify-registro.mjs — Registro self-service + onboarding (Fase registro, R-1).
 * Ejercita los callables registerTenantOwner / completeOnboarding + el provisionTenant admin
 * contra los emuladores, con usuarios efímeros (email verificado / no verificado / con claims).
 * Verifica: email no verificado bloquea; verificado crea tenant+user+claims; input malicioso
 * (role/planId/tenantId/ownerUid/ownerEmail) se ignora; slug duplicado → 409; caller con tenant/role
 * (incl. seller/owner/admin) → 400; nunca PLATFORM_ADMIN; completeOnboarding marca el flag;
 * cross-tenant bloqueado; provisionTenant admin sigue funcionando.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const auth = getAuth();
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
const ephemeralUids = [];
const tenantsToClean = new Set();
/** Usuario efímero SIN claims (recién registrado). emailVerified configurable. Devuelve {uid, token}. */
async function mkUser(email, emailVerified) {
  let u;
  try { u = await auth.getUserByEmail(email); } catch { u = await auth.createUser({ email, password: 'test1234', emailVerified }); }
  await auth.updateUser(u.uid, { emailVerified });
  await auth.setCustomUserClaims(u.uid, null); // sin role/tenantId
  ephemeralUids.push(u.uid);
  return { uid: u.uid, token: await signIn(email) };
}
const claimsOf = async (uid) => (await auth.getUser(uid)).customClaims ?? {};

// Usuarios seed con claims existentes.
const seller = await signIn('seller@perfumeria.com');
const owner = await signIn('owner@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');

// 1. email NO verificado → no crea (failed-precondition 400).
const uUnv = await mkUser('reg-unverified@test.com', false);
const r1 = await callFn('registerTenantOwner', { businessName: 'Reg No Verif' }, uUnv.token);
check('R1 email no verificado → 400 (no crea)', r1.status === 400 && !(await claimsOf(uUnv.uid)).tenantId, `status=${r1.status} err=${r1.error?.status}`);

// 2. verificado → crea tenant(ACTIVE,free,onboarding=false) + users/{uid}(OWNER) + claims.
const u1 = await mkUser('reg-uno@test.com', true);
const r2 = await callFn('registerTenantOwner', { businessName: 'Reg Co Uno', industry: 'perfumeria', country: 'PY', currency: 'PYG', phone: '+595981000000', ownerName: 'Ana' }, u1.token);
const tid2 = r2.result?.tenantId; if (tid2) tenantsToClean.add(tid2);
const t2 = tid2 ? (await db.doc(`tenants/${tid2}`).get()).data() : null;
const ud2 = (await db.doc(`users/${u1.uid}`).get()).data();
const cl2 = await claimsOf(u1.uid);
check('R2 verificado → crea tenant(ACTIVE/free/onboarding=false) + users(OWNER) + claims', r2.status === 200 && t2?.status === 'ACTIVE' && t2?.planId === 'free' && t2?.onboarding?.completed === false && ud2?.role === 'TENANT_OWNER' && ud2?.tenantId === tid2 && cl2.role === 'TENANT_OWNER' && cl2.tenantId === tid2, `status=${r2.status} tid=${tid2} role=${cl2.role}`);

// 3. input malicioso ignorado (role/planId/tenantId/ownerUid/ownerEmail).
const u3 = await mkUser('reg-mal@test.com', true);
const r3 = await callFn('registerTenantOwner', { businessName: 'Reg Mal Co', role: 'PLATFORM_ADMIN', planId: 'pro', tenantId: 'evil-tenant', ownerUid: 'someone-else', ownerEmail: 'victim@x.com' }, u3.token);
const tid3 = r3.result?.tenantId; if (tid3) tenantsToClean.add(tid3);
const t3 = tid3 ? (await db.doc(`tenants/${tid3}`).get()).data() : null;
const cl3 = await claimsOf(u3.uid);
const evilExists = (await db.doc('tenants/evil-tenant').get()).exists;
check('R3 input malicioso ignorado (OWNER/free, tenantId=slug≠evil, owner=caller)', r3.status === 200 && tid3 !== 'evil-tenant' && t3?.planId === 'free' && cl3.role === 'TENANT_OWNER' && cl3.tenantId === tid3 && !evilExists, `tid=${tid3} role=${cl3.role} evil=${evilExists}`);

// 4. slug duplicado → already-exists (409); no crea ni setea claims.
const u4 = await mkUser('reg-dup@test.com', true);
const r4 = await callFn('registerTenantOwner', { businessName: 'Reg Co Uno' }, u4.token);
check('R4 slug duplicado → 409 (no crea, sin claims)', r4.status === 409 && !(await claimsOf(u4.uid)).tenantId, `status=${r4.status} msg=${r4.error?.message}`);

// 5. caller que YA tiene tenant (u1, token fresco con claims) → 400.
const u1token2 = await signIn('reg-uno@test.com');
const r5 = await callFn('registerTenantOwner', { businessName: 'Otra Empresa' }, u1token2);
check('R5 caller con tenant/role → 400 (no crea 2do tenant)', r5.status === 400, `status=${r5.status}`);

// 6. seller/owner/admin (ya tienen role) → 400; nunca PLATFORM_ADMIN por este flujo.
const rS = await callFn('registerTenantOwner', { businessName: 'X1' }, seller);
const rO = await callFn('registerTenantOwner', { businessName: 'X2' }, owner);
const rA = await callFn('registerTenantOwner', { businessName: 'X3' }, admin);
check('R6 seller/owner/admin (con role) NO crean tenant → 400', rS.status === 400 && rO.status === 400 && rA.status === 400, `s=${rS.status} o=${rO.status} a=${rA.status}`);

// 7. completeOnboarding por el owner del tenant nuevo → flag true; campos sensibles intactos.
const r7 = await callFn('completeOnboarding', {}, u1token2);
const t2b = (await db.doc(`tenants/${tid2}`).get()).data();
check('R7 completeOnboarding (owner) → onboarding.completed=true; plan/status intactos', r7.status === 200 && t2b?.onboarding?.completed === true && t2b?.planId === 'free' && t2b?.status === 'ACTIVE', `status=${r7.status} completed=${t2b?.onboarding?.completed}`);

// 8. cross-tenant: u1 (owner de tid2) intenta completar el onboarding de tid3 → opera el SUYO, tid3 intacto.
await callFn('completeOnboarding', { tenantId: tid3 }, u1token2);
const t3b = (await db.doc(`tenants/${tid3}`).get()).data();
check('R8 cross-tenant: owner no completa onboarding de otro tenant (tid3 sigue false)', t3b?.onboarding?.completed === false, `tid3.completed=${t3b?.onboarding?.completed}`);

// 9. provisionTenant admin sigue funcionando (crea owner por email).
const r9 = await callFn('provisionTenant', { name: 'Reg Admin Co', ownerEmail: 'reg-admin-owner@test.com', ownerName: 'Owner Admin' }, admin);
const tid9 = r9.result?.tenantId; if (tid9) tenantsToClean.add(tid9);
const t9 = tid9 ? (await db.doc(`tenants/${tid9}`).get()).data() : null;
check('R9 provisionTenant admin sigue creando empresa (ACTIVE/free)', r9.status === 200 && t9?.status === 'ACTIVE' && t9?.planId === 'free', `status=${r9.status} tid=${tid9}`);

// 10. provisionTenant admin con nombre duplicado → 409 (reserva atómica).
const r10 = await callFn('provisionTenant', { name: 'Reg Admin Co', ownerEmail: 'otro-owner@test.com' }, admin);
check('R10 provisionTenant admin nombre duplicado → 409', r10.status === 409, `status=${r10.status}`);

// --- Limpieza ---
try { ephemeralUids.push((await auth.getUserByEmail('reg-admin-owner@test.com')).uid); } catch { /* noop */ }
for (const tid of tenantsToClean) {
  for (const sub of ['config', 'auditLogs']) for (const d of (await db.collection(`tenants/${tid}/${sub}`).get()).docs) await d.ref.delete().catch(() => {});
  await db.doc(`tenants/${tid}`).delete().catch(() => {});
}
await db.doc('tenants/evil-tenant').delete().catch(() => {});
for (const uid of ephemeralUids) { await db.doc(`users/${uid}`).delete().catch(() => {}); await auth.deleteUser(uid).catch(() => {}); }

const ok = results.every((x) => x);
console.log(`\nRESULTADO REGISTRO SELF-SERVICE (R-1): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
