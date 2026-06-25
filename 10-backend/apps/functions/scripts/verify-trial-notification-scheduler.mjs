/**
 * verify-trial-notification-scheduler.mjs — Core del job de notificaciones del trial (TRIAL-NOTIFICATIONS-3).
 * Prueba `runTrialNotificationsJob` (el core que comparten el callable y la scheduled function) SIN depender
 * del reloj real de Cloud Scheduler: lo importa y lo corre directo. Tenants/usuarios efímeros (prefijo único
 * → no toca perfumeria/seed). Cero red externa (no envía WhatsApp/email/push).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { runTrialNotificationsJob } from '../lib/trial/runTrialNotificationsJob.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const adminAuth = getAuth();
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const RUN = Date.now();
const DAY = 86_400_000;
const P = `tns-${RUN}-`;

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
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
const trialIn = (ms) => ({ trial: { startedAt: now, endsAt: Timestamp.fromMillis(now.toMillis() + ms) } });
const notifs = async (id) => (await db.collection(`tenants/${id}/notifications`).get()).docs.map((d) => d.data());
const typeOf = async (id) => (await notifs(id))[0]?.type;
const T = (s) => `${P}${s}`;

// ---- Setup: soon / expired / pago / datos-raros ----
await mkTenant(T('soon'), trialIn(3 * DAY));
await mkTenant(T('exp'), trialIn(-1 * DAY));
await mkTenant(T('paid'), { planId: 'growth', subscription: { status: 'active', planId: 'growth' }, ...trialIn(-1 * DAY) });
// endsAt no parseable → computeTrialNotificationState lo trata como sin-trial → SKIP (no error). El try/catch
// por-tenant del core aísla ADEMÁS throws reales (errors++), verificado por inspección (no se fuerza acá).
await mkTenant(T('bad'), { trial: { endsAt: { garbage: 1 } } });

// ===== 1. Core (scan-all) genera las notificaciones esperadas =====
const s1 = await runTrialNotificationsJob(db, { nowMs: now.toMillis() });
const okExpected = (await typeOf(T('soon'))) === 'trial_ending_soon' && (await typeOf(T('exp'))) === 'trial_expired'
  && (await notifs(T('paid'))).length === 0 && (await notifs(T('bad'))).length === 0;
check('1. core (scan-all) genera las esperadas (soon→soon, exp→expired; pago/datos-raros sin notif)',
  s1.created >= 2 && s1.byType.trial_ending_soon >= 1 && s1.byType.trial_expired >= 1 && s1.errors === 0 && okExpected,
  `created=${s1.created} errors=${s1.errors}`);

// ===== 4. El tenant con datos raros NO tumbó el job (los demás SÍ se procesaron) =====
check('4. tenant con trial malformado → SKIP (errors=0, sin notif), el job NO se tumba y procesó a los demás',
  s1.errors === 0 && (await notifs(T('bad'))).length === 0 && (await notifs(T('soon'))).length === 1);

// ===== 2. Re-ejecutar el core NO duplica =====
const s2 = await runTrialNotificationsJob(db, { nowMs: now.toMillis() });
check('2. re-ejecutar el core → NO duplica (created=0; cada tenant sigue con 1 notif)',
  s2.created === 0 && (await notifs(T('soon'))).length === 1 && (await notifs(T('exp'))).length === 1, `created=${s2.created}`);

// ===== 3. Dry-run NO escribe =====
await mkTenant(T('dry'), trialIn(3 * DAY)); // fresco, NO tocado por los scan-all anteriores
const s3 = await runTrialNotificationsJob(db, { nowMs: now.toMillis(), tenantId: T('dry'), dryRun: true });
check('3. dry-run → cuenta lo que crearía (created=1) pero NO escribe (sin notif)',
  s3.created === 1 && s3.scanned === 1 && (await notifs(T('dry'))).length === 0, `created=${s3.created}`);

// ===== 5. La scheduled function existe y apunta al core =====
const schedSrc = await readFile(join(__dirname, '..', 'src', 'functions', 'scheduled', 'trialNotifications.ts'), 'utf8');
const indexSrc = await readFile(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
check('5. scheduled export existe, usa onSchedule + el core, timezone Asuncion, registrado en index',
  /onSchedule/.test(schedSrc) && /runTrialNotificationsJob/.test(schedSrc) && /America\/Asuncion/.test(schedSrc) && /trialNotificationsDaily/.test(indexSrc),
  '');

// ===== 6. Rules intactas: owner lee, cliente no crea =====
const ownerExp = await mkUser(`owner-tns-${RUN}@test.com`, 'TENANT_OWNER', T('exp'));
const ownerRead = (await fetch(`${FS}/tenants/${T('exp')}/notifications/trial_expired`, { headers: { Authorization: `Bearer ${ownerExp}` } })).status;
const ownerCreate = (await fetch(`${FS}/tenants/${T('exp')}/notifications/hack-${RUN}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerExp}` }, body: JSON.stringify({ fields: { type: { stringValue: 'fake' } } }) })).status;
check('6. rules: owner LEE (200) · nadie crea desde el cliente (create if false → 403)', ownerRead === 200 && ownerCreate === 403, `read=${ownerRead} create=${ownerCreate}`);

// ---- Limpieza ----
for (const email of emails) { try { const u = await adminAuth.getUserByEmail(email); await adminAuth.deleteUser(u.uid); await db.doc(`users/${u.uid}`).delete().catch(() => {}); } catch { /* noop */ } }
for (const id of created) {
  for (const sub of ['notifications', 'auditLogs']) for (const d of (await db.collection(`tenants/${id}/${sub}`).get()).docs) await d.ref.delete().catch(() => {});
  await db.doc(`tenants/${id}`).delete().catch(() => {});
}

const ok = results.every((x) => x);
console.log(`\nRESULTADO TRIAL-NOTIFICATIONS-3 (scheduler del job de notificaciones): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exitCode = ok ? 0 : 1;
