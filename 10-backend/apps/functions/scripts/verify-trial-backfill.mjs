/**
 * verify-trial-backfill.mjs — Migración de free trials legacy (TRIAL-ENFORCEMENT-1C).
 * Importa `backfillFreeTrials` y la ejecuta sobre tenants EFÍMEROS acotados por `--prefix` (NO toca
 * perfumeria/boutique ni ningún seed). Cubre dry-run, apply, idempotencia, exclusiones y que el trial
 * migrado sea enforceable por el backend (1A). Cero red externa.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { backfillFreeTrials } from './backfill-free-trials.mjs';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const RUN = Date.now();
const DAY = 86_400_000;
const P = `tb-${RUN}-`;       // prefijo de los casos 1-7
const PX = `tbx-${RUN}-`;     // prefijo aislado del caso 8 (migración a vencido)

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, token) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data }) });
  return { status: res.status, error: (await res.json().catch(() => ({}))).error };
}
const now = Timestamp.now();
const created = [];
async function mkTenant(id, extra) {
  created.push(id);
  await db.doc(`tenants/${id}`).set({ id, name: id, slug: id, status: 'ACTIVE', planId: 'free', createdAt: now, updatedAt: now, deletedAt: null, ...extra }, { merge: true });
}
const trialOf = async (id) => (await db.doc(`tenants/${id}`).get()).data()?.trial;

// ---- Setup: casos 1-7 (prefijo P) ----
await mkTenant(`${P}free`, {}); // free legacy sin trial → elegible
await mkTenant(`${P}paid`, { planId: 'growth', subscription: { status: 'active', planId: 'growth' } }); // pago
await mkTenant(`${P}manualwa`, { planId: 'growth', subscription: { status: 'active', planId: 'growth' }, paymentProvider: 'manual_whatsapp' }); // activación manual
await mkTenant(`${P}demo`, { isDemo: true }); // demo
await mkTenant(`${P}hastrial`, { trial: { startedAt: now, endsAt: Timestamp.fromMillis(now.toMillis() + 5 * DAY) } }); // ya migrado
await mkTenant(`${P}suspended`, { status: 'SUSPENDED' }); // free pero suspendido → inactivo
await mkTenant(`${P}canceled`, { subscription: { status: 'canceled', planId: 'growth' } }); // tuvo plan pago (cancelado)

// ===== 1. DRY-RUN: reporta elegible pero NO escribe =====
const dry = await backfillFreeTrials(db, { prefix: P, apply: false });
const freeTrialAfterDry = await trialOf(`${P}free`);
check('1. dry-run → reporta 1 elegible y 0 updated, y NO escribe (free sigue sin trial)',
  dry.scanned === 7 && dry.eligible === 1 && dry.updated === 0 && dry.skippedPaid === 3 && dry.skippedDemo === 1 && dry.skippedAlreadyHasTrial === 1 && dry.skippedInactive === 1 && !freeTrialAfterDry,
  JSON.stringify(dry));

// ===== 2. APPLY: escribe startedAt/endsAt (7 días) al elegible =====
const ap = await backfillFreeTrials(db, { prefix: P, apply: true });
const ft = await trialOf(`${P}free`);
const days = ft ? Math.round((ft.endsAt.toMillis() - ft.startedAt.toMillis()) / DAY) : null;
check('2. --apply → escribe trial (startedAt/endsAt a 7 días) al free legacy',
  ap.updated === 1 && !!ft && days === 7 && ft.endsAt.toMillis() > now.toMillis(), `updated=${ap.updated} días=${days}`);

// ===== 3. IDEMPOTENTE: correr apply dos veces no extiende el trial existente =====
const endsBefore = (await trialOf(`${P}free`)).endsAt.toMillis();
const ap2 = await backfillFreeTrials(db, { prefix: P, apply: true });
const endsAfter = (await trialOf(`${P}free`)).endsAt.toMillis();
check('3. --apply 2da vez → 0 updated y NO extiende el trial existente',
  ap2.updated === 0 && ap2.skippedAlreadyHasTrial === 2 && endsAfter === endsBefore, `updated=${ap2.updated} endsBefore=${endsBefore} endsAfter=${endsAfter}`);

// ===== 4-7. Exclusiones: pago / manual_whatsapp / demo / con trial → NO tocados =====
check('4. tenant pago active → NO migrado (sin trial)', !(await trialOf(`${P}paid`)));
check('5. tenant manual_whatsapp active → NO migrado (sin trial)', !(await trialOf(`${P}manualwa`)));
check('6. tenant demo → NO migrado (sin trial)', !(await trialOf(`${P}demo`)));
const ht = await trialOf(`${P}hastrial`);
check('7. tenant con trial existente → intacto (endsAt sin cambios)', !!ht && ht.endsAt.toMillis() === now.toMillis() + 5 * DAY, `endsAt=${ht?.endsAt?.toMillis()}`);
check('7b. tenant suspendido → NO migrado (skippedInactive, sin trial)', !(await trialOf(`${P}suspended`)));
check('7c. tenant con suscripción cancelada → NO migrado (skippedPaid, sin trial)', !(await trialOf(`${P}canceled`)));

// ===== 8. Migrado a VENCIDO (--as-of pasado) → bloqueable por el enforcement de 1A =====
await mkTenant(`${PX}legacy`, {}); // free legacy aislado
const apX = await backfillFreeTrials(db, { prefix: PX, apply: true, asOfMs: now.toMillis() - 10 * DAY }); // endsAt = now-3d → vencido
const admin = await signIn('superadmin@aiafg.com');
const blocked = await callFn('productUpsert', { tenantId: `${PX}legacy`, data: { name: `P-${RUN}` } }, admin);
check('8. tenant legacy migrado a vencido → el backend lo bloquea (productUpsert failed-precondition 400)',
  apX.updated === 1 && blocked.status === 400 && /prueba|trial/i.test(blocked.error?.message ?? ''), `updated=${apX.updated} status=${blocked.status}`);

// ---- Limpieza ----
for (const id of created) {
  for (const sub of ['products', 'auditLogs']) for (const d of (await db.collection(`tenants/${id}/${sub}`).get()).docs) await d.ref.delete().catch(() => {});
  await db.doc(`tenants/${id}`).delete().catch(() => {});
}

const ok = results.every((x) => x);
console.log(`\nRESULTADO TRIAL-ENFORCEMENT-1C (backfill de free trials legacy): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exitCode = ok ? 0 : 1;
