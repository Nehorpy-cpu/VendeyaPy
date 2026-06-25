/**
 * verify-trial-notifications.mjs — Notificaciones internas del free trial (TRIAL-NOTIFICATIONS-1).
 * Genera notificaciones internas (NO envía WhatsApp/email/push real) según los días restantes / vencimiento,
 * idempotente, con exclusiones (pago/demo/legacy). Tenants/usuarios EFÍMEROS (no toca perfumeria). El callable
 * `generateTrialNotifications` se llama targeteado por tenantId (admin). Cero red externa.
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
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, token) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data }) });
  return { status: res.status, result: (await res.json().catch(() => ({}))).result };
}
const now = Timestamp.now();
const created = [];
const emails = [];
async function mkTenant(id, extra) {
  created.push(id);
  await db.doc(`tenants/${id}`).set({ id, name: id, slug: id, status: 'ACTIVE', planId: 'free', subscription: { status: 'none' }, createdAt: now, updatedAt: now, deletedAt: null, ...extra }, { merge: true });
}
async function mkUser(email, role, tenantId) {
  emails.push(email);
  let u; try { u = await adminAuth.getUserByEmail(email); } catch { u = await adminAuth.createUser({ email, password: 'test1234', emailVerified: true }); }
  await adminAuth.setCustomUserClaims(u.uid, { role, tenantId });
  return await signIn(email);
}
const trialEndsIn = (ms) => ({ trial: { startedAt: now, endsAt: Timestamp.fromMillis(now.toMillis() + ms) } });
const notifs = async (id) => (await db.collection(`tenants/${id}/notifications`).get()).docs.map((d) => d.data());
const gen = (tenantId, token) => callFn('generateTrialNotifications', { tenantId }, token);
const restGet = async (token, path) => (await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } })).status;

const T = (s) => `tn-${RUN}-${s}`;
const admin = await signIn('superadmin@aiafg.com');

// ---- Setup ----
await mkTenant(T('d5'), trialEndsIn(5 * DAY));
await mkTenant(T('d3'), trialEndsIn(3 * DAY));
await mkTenant(T('today'), trialEndsIn(0.5 * DAY));
await mkTenant(T('exp'), trialEndsIn(-1 * DAY));
await mkTenant(T('paid'), { planId: 'growth', subscription: { status: 'active', planId: 'growth' }, ...trialEndsIn(-1 * DAY) });
await mkTenant(T('demo'), { isDemo: true, ...trialEndsIn(-1 * DAY) });
await mkTenant(T('legacy'), {}); // free sin trial

// ===== 1-4. Umbrales =====
const g5 = await gen(T('d5'), admin);
check('1. trial con 5 días → NO crea notificación', g5.result?.created === 0 && (await notifs(T('d5'))).length === 0, JSON.stringify(g5.result));

const g3 = await gen(T('d3'), admin);
const n3 = await notifs(T('d3'));
check('2. trial con 3 días → crea trial_ending_soon', g3.result?.created === 1 && n3.length === 1 && n3[0].type === 'trial_ending_soon', `${n3[0]?.type}`);

const gt = await gen(T('today'), admin);
const nt = await notifs(T('today'));
check('3. trial termina hoy → crea trial_ending_today', gt.result?.created === 1 && nt[0]?.type === 'trial_ending_today', `${nt[0]?.type}`);

const ge = await gen(T('exp'), admin);
const ne = await notifs(T('exp'));
check('4. trial vencido → crea trial_expired', ge.result?.created === 1 && ne[0]?.type === 'trial_expired', `${ne[0]?.type}`);

// ===== 5. Idempotente: re-ejecutar no duplica =====
const ge2 = await gen(T('exp'), admin);
check('5. re-ejecutar el job → NO duplica (created=0, sigue 1 notificación)', ge2.result?.created === 0 && (await notifs(T('exp'))).length === 1, JSON.stringify(ge2.result));

// ===== 6-8. Exclusiones =====
await gen(T('paid'), admin);
check('6. tenant pago → NO notifica', (await notifs(T('paid'))).length === 0);
await gen(T('demo'), admin);
check('7. tenant demo → NO notifica', (await notifs(T('demo'))).length === 0);
await gen(T('legacy'), admin);
check('8. tenant legacy sin trial → NO notifica', (await notifs(T('legacy'))).length === 0);

// ===== 9. Rules: owner lee; seller NO; cliente no escribe =====
const ownerExp = await mkUser(`owner-tn-${RUN}@test.com`, 'TENANT_OWNER', T('exp'));
const sellerExp = await mkUser(`seller-tn-${RUN}@test.com`, 'TENANT_SELLER', T('exp'));
const ownerRead = await restGet(ownerExp, `tenants/${T('exp')}/notifications/trial_expired`);
const sellerRead = await restGet(sellerExp, `tenants/${T('exp')}/notifications/trial_expired`);
const ownerCreate = (await fetch(`${FS}/tenants/${T('exp')}/notifications/hack-${RUN}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerExp}` }, body: JSON.stringify({ fields: { type: { stringValue: 'fake' } } }) })).status;
// El owner tampoco puede editar campos arbitrarios de una notificación existente (update solo read/readAt).
const ownerEditArbitrary = (await fetch(`${FS}/tenants/${T('exp')}/notifications/trial_expired?updateMask.fieldPaths=title`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerExp}` }, body: JSON.stringify({ fields: { title: { stringValue: 'editado' } } }) })).status;
check('9. rules: OWNER lee (200) · SELLER NO (403) · cliente NO crea (403) · OWNER no edita campos arbitrarios (403)',
  ownerRead === 200 && sellerRead === 403 && ownerCreate === 403 && ownerEditArbitrary === 403, `owner=${ownerRead} seller=${sellerRead} create=${ownerCreate} edit=${ownerEditArbitrary}`);

// ===== 10. Audit sin PII =====
const audits = (await db.collection(`tenants/${T('exp')}/auditLogs`).where('action', '==', 'trial.notification_created').get()).docs.map((d) => d.data());
const auditOk = audits.length >= 1 && audits[0].metadata?.type === 'trial_expired' && !/cliente|whatsapp|@|token|secret/i.test(JSON.stringify(audits[0]));
check('10. audit log trial.notification_created creado, sin PII/mensajes externos', auditOk, `audits=${audits.length}`);

// ---- Limpieza ----
for (const email of emails) { try { const u = await adminAuth.getUserByEmail(email); await adminAuth.deleteUser(u.uid); await db.doc(`users/${u.uid}`).delete().catch(() => {}); } catch { /* noop */ } }
for (const id of created) {
  for (const sub of ['notifications', 'auditLogs']) for (const d of (await db.collection(`tenants/${id}/${sub}`).get()).docs) await d.ref.delete().catch(() => {});
  await db.doc(`tenants/${id}`).delete().catch(() => {});
}

const ok = results.every((x) => x);
console.log(`\nRESULTADO TRIAL-NOTIFICATIONS-1 (notificaciones internas del free trial): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exitCode = ok ? 0 : 1;
