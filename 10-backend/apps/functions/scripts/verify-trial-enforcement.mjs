/**
 * verify-trial-enforcement.mjs — Enforcement del free trial de 7 días (TRIAL-ENFORCEMENT-1A).
 * El plan `free` es una prueba de 7 días; vencido (`trial.endsAt < now`), el backend bloquea ACCIONES DE
 * USO (órdenes/bot/IA/marketing/writes con cuota) pero deja al owner pedir activación y al admin activar.
 * Tenants/usuarios EFÍMEROS (no toca perfumeria). NUNCA llama a Anthropic/Meta real (devSimulateInbound).
 * Anti-flake: ids únicos por corrida; cada tenant fresco → caché de entitlements limpio (sin settle).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const adminAuth = getAuth();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const RUN = Date.now();
const DAY = 86_400_000;

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, token) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}
const now = Timestamp.now();
const ZERO_USAGE = { ordersThisMonth: 0, messagesThisMonth: 0, jobsThisMonth: 0, adSyncsThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now };
const createdTenants = [];
const createdEmails = [];
const createdIndex = [];
const createdEvents = [];

async function mkTenant(id, { planId = 'free', trial, usage } = {}) {
  createdTenants.push(id);
  await db.doc(`tenants/${id}`).set({
    id, name: id, slug: id, status: 'ACTIVE', planId,
    subscription: { status: 'none', planId, stripeCustomerId: null, stripeSubscriptionId: null, currentPeriodEnd: null, updatedAt: now },
    usage: { ...ZERO_USAGE, ...(usage ?? {}) },
    ...(trial ? { trial } : {}),
    createdAt: now, updatedAt: now,
  }, { merge: true });
}
async function mkUser(email, role, tenantId) {
  createdEmails.push(email);
  let u; try { u = await adminAuth.getUserByEmail(email); } catch { u = await adminAuth.createUser({ email, password: 'test1234', emailVerified: true }); }
  await adminAuth.setCustomUserClaims(u.uid, { role, tenantId });
  return { uid: u.uid, token: await signIn(email) };
}
const product = (tenantId, token) => callFn('productUpsert', { tenantId, data: { name: `P-${RUN}` } }, token);
// PATCH directo del campo `trial` por client SDK (REST) → debe dar 403 por rules.
async function patchTrial(tenantId, token) {
  const r = await fetch(`${FS}/tenants/${tenantId}?updateMask.fieldPaths=trial`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: { trial: { mapValue: { fields: { endsAt: { timestampValue: '2020-01-01T00:00:00Z' } } } } } }),
  });
  return r.status;
}

const admin = await signIn('superadmin@aiafg.com');

// ===== 1. Provisioning real (admin) crea trial de 7 días =====
const provEmail = `prov-${RUN}@trial.test`; createdEmails.push(provEmail);
const prov = await callFn('provisionTenant', { name: `Trial Prov ${RUN}`, ownerEmail: provEmail, planId: 'free' }, admin);
const provTid = prov.result?.tenantId; if (provTid) createdTenants.push(provTid);
const provTenant = provTid ? (await db.doc(`tenants/${provTid}`).get()).data() : null;
const tr = provTenant?.trial;
const days = tr ? Math.round((tr.endsAt.toMillis() - tr.startedAt.toMillis()) / DAY) : null;
check('1. Tenant nuevo (provision admin) nace con trial.startedAt + trial.endsAt a 7 días',
  prov.status === 200 && !!tr && days === 7 && tr.endsAt.toMillis() > now.toMillis(), `status=${prov.status} días=${days}`);

// ===== 2. Trial ACTIVO permite una acción free válida =====
const tActive = `te-active-${RUN}`; await mkTenant(tActive, { trial: { startedAt: now, endsAt: Timestamp.fromMillis(now.toMillis() + 5 * DAY) } });
const ownerActive = await mkUser(`owner-active-${RUN}@trial.test`, 'TENANT_OWNER', tActive);
const a2 = await product(tActive, ownerActive.token);
check('2. Trial ACTIVO → acción free dentro de límites permitida (productUpsert 200)', a2.status === 200 && a2.result?.created === true, `status=${a2.status}`);

// ===== 3-9. Tenant con trial VENCIDO =====
const tExp = `te-expired-${RUN}`; await mkTenant(tExp, { trial: { startedAt: Timestamp.fromMillis(now.toMillis() - 10 * DAY), endsAt: Timestamp.fromMillis(now.toMillis() - 1 * DAY) } });
const ownerExp = await mkUser(`owner-exp-${RUN}@trial.test`, 'TENANT_OWNER', tExp);
const sellerExp = await mkUser(`seller-exp-${RUN}@trial.test`, 'TENANT_SELLER', tExp);
const managerExp = await mkUser(`manager-exp-${RUN}@trial.test`, 'TENANT_MANAGER', tExp);
const viewerExp = await mkUser(`viewer-exp-${RUN}@trial.test`, 'TENANT_VIEWER', tExp);

// 3. acción de uso bloqueada
const a3 = await product(tExp, ownerExp.token);
check('3. Trial VENCIDO → acción de uso backend BLOQUEADA (productUpsert failed-precondition 400)',
  a3.status === 400 && /prueba|trial/i.test(a3.error?.message ?? ''), `status=${a3.status} msg=${a3.error?.message}`);

// 4. bot/inbound bloqueado sin filtrar info al cliente
const ext = `wa-trial-${RUN}`; createdIndex.push(`whatsapp_${ext}`);
await db.doc(`metaExternalIndex/whatsapp_${ext}`).set({ id: `whatsapp_${ext}`, tenantId: tExp, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: ext, status: 'active', updatedAt: now });
const cliPhone = '595' + (900000000 + (RUN % 99999999));
const inb = await fetch(`${BASE}/devSimulateInbound`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'whatsapp', externalId: ext, from: cliPhone, text: 'hola quiero comprar' }) }).then((r) => r.json());
createdEvents.push(inb.eventId);
let inbStatus = 'timeout', inbErr = '';
for (let i = 0; i < 18; i++) { const d = (await db.doc(`metaWebhookInbox/${inb.eventId}`).get()).data(); if (d && d.processingStatus !== 'received' && d.processingStatus !== 'processing') { inbStatus = d.processingStatus; inbErr = d.errorMessage ?? ''; break; } await sleep(1000); }
const outMsgs = (await db.collection(`tenants/${tExp}/customers/${cliPhone}/messages`).get()).docs.map((d) => d.data()).filter((m) => m.direction === 'out');
const noLeak = !/plan|prueba|trial|venc/i.test(JSON.stringify(outMsgs));
check('4. Trial VENCIDO → bot/inbound NO procesa (ignored) y NO envía nada al cliente (sin filtrar info)',
  inbStatus === 'ignored' && outMsgs.length === 0 && noLeak, `inbox=${inbStatus} outMsgs=${outMsgs.length}`);

// 5. owner puede pedir activación manual aunque esté vencido
const a5 = await callFn('requestManualPlanActivation', { tenantId: tExp, planId: 'growth', method: 'transferencia' }, ownerExp.token);
const reqId = a5.result?.requestId;
check('5. Trial VENCIDO → requestManualPlanActivation (owner) SIGUE funcionando', a5.status === 200 && !!reqId, `status=${a5.status}`);

// 6. admin activa un plan pago sobre el tenant vencido
const a6 = await callFn('manualBillingActivate', { tenantId: tExp, requestId: reqId, paymentReference: `ref-${RUN}` }, admin);
const planAfter = (await db.doc(`tenants/${tExp}`).get()).data()?.planId;
check('6. Admin activa manualmente un plan pago sobre tenant vencido (planId → growth)', a6.status === 200 && planAfter === 'growth', `status=${a6.status} plan=${planAfter}`);

// 7. tras activación, la acción antes bloqueada vuelve a pasar. La activación invalida el caché de
// entitlements (best-effort, por instancia); si la instancia que atiende tenía un caché stale, se absorbe
// esperando el TTL (30s). Reintento hasta 200 (los intentos 400 NO crean producto → solo el exitoso cuenta).
let a7 = { status: 0 };
for (let i = 0; i < 18; i++) { a7 = await product(tExp, ownerExp.token); if (a7.status === 200) break; await sleep(2000); }
check('7. Tras activación paga → la acción antes bloqueada vuelve a pasar (productUpsert 200)', a7.status === 200 && a7.result?.created === true, `status=${a7.status}`);

// 8. owner NO puede escribir `trial` directo por rules
check('8. Owner NO puede escribir `trial` directo (Firestore rules → 403)', (await patchTrial(tExp, ownerExp.token)) === 403);

// 9. seller/manager/viewer no pueden manipular trial
const sStatus = await patchTrial(tExp, sellerExp.token);
const mStatus = await patchTrial(tExp, managerExp.token);
const vStatus = await patchTrial(tExp, viewerExp.token);
check('9. Seller/Manager/Viewer NO pueden manipular `trial` (403/403/403)', sStatus === 403 && mStatus === 403 && vStatus === 403, `${sStatus}/${mStatus}/${vStatus}`);

// ===== 10. Tenant LEGACY sin `trial` no rompe ni se bloquea =====
const tLegacy = `te-legacy-${RUN}`; await mkTenant(tLegacy, { planId: 'free' }); // sin trial
const ownerLegacy = await mkUser(`owner-legacy-${RUN}@trial.test`, 'TENANT_OWNER', tLegacy);
const a10 = await product(tLegacy, ownerLegacy.token);
check('10. Tenant legacy sin `trial` → NO se bloquea (productUpsert 200); migración a decidir en prod',
  a10.status === 200 && a10.result?.created === true, `status=${a10.status}`);

// ===== Limpieza =====
for (const email of createdEmails) { try { const u = await adminAuth.getUserByEmail(email); await adminAuth.deleteUser(u.uid); await db.doc(`users/${u.uid}`).delete().catch(() => {}); } catch { /* noop */ } }
for (const id of createdTenants) {
  for (const sub of ['products', 'auditLogs', 'metaAssets', 'metaConnections', 'manualActivationRequests', 'config', 'customers']) {
    for (const d of (await db.collection(`tenants/${id}/${sub}`).get()).docs) await d.ref.delete().catch(() => {});
  }
  await db.doc(`tenants/${id}`).delete().catch(() => {});
}
for (const idx of createdIndex) await db.doc(`metaExternalIndex/${idx}`).delete().catch(() => {});
for (const ev of createdEvents) if (ev) await db.doc(`metaWebhookInbox/${ev}`).delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO TRIAL-ENFORCEMENT-1A (free trial 7d, enforcement por fecha): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exitCode = ok ? 0 : 1;
