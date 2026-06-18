/**
 * verify-entitlements.mjs — Entitlements, límites, metering y gates (Hardening F5A).
 * Verifica gates de cuota (productos/usuarios/números), feature gating por plan, suspensión
 * premium por billing, lazy-reset del uso, protección de campos de entitlements en rules, y
 * auditoría de bloqueos. Usa tenants de prueba distintos por escenario (evita caché stale) y
 * callables vía PLATFORM_ADMIN. Graph fake por fixture (no llama a Meta).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const adminAuth = getAuth();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTHURL = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTHURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, idToken) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}

const NOW = Timestamp.now();
const TWO_MONTHS_AGO = Timestamp.fromMillis(Date.now() - 75 * 86_400_000);
const ZERO_USAGE = { ordersThisMonth: 0, messagesThisMonth: 0, jobsThisMonth: 0, adSyncsThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: NOW };
const createdTenants = [];
const createdEmails = [];

async function mkTenant(id, { planId = 'free', limitOverrides, subscription, usage } = {}) {
  createdTenants.push(id);
  await db.doc(`tenants/${id}`).set({
    id, name: id, slug: id, status: 'ACTIVE', planId,
    usage: { ...ZERO_USAGE, ...(usage ?? {}) },
    ...(limitOverrides ? { limitOverrides } : {}),
    ...(subscription ? { subscription } : {}),
    createdAt: NOW, updatedAt: NOW,
  }, { merge: true });
}

const admin = await signIn('superadmin@aiafg.com');
const owner = await signIn('owner@perfumeria.com');

// Fixture Graph (para el connect entitled)
await db.doc('metaTestFixtures/graph').set({
  accessToken: 'EAAG-ent', isValid: true, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
  wabaIds: ['waba-ent'], tokenExpiresAtMs: Date.now() + 3_600_000,
  phoneNumbers: [{ id: 'wa-ent-1', displayPhoneNumber: '+595 981 900900', verifiedName: 'Ent', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED' }],
});

// 1-2. Productos: ok (fresh free) vs bloqueado (override maxProducts 0)
await mkTenant('ent-prod-ok');
const p1 = await callFn('productUpsert', { tenantId: 'ent-prod-ok', data: { name: 'Perfume X' } }, admin);
check('1. productUpsert dentro de cuota → creado', p1.status === 200 && p1.result?.created === true, `status=${p1.status}`);

await mkTenant('ent-prod-block', { limitOverrides: { maxProducts: 0 } });
const p2 = await callFn('productUpsert', { tenantId: 'ent-prod-block', data: { name: 'Perfume Y' } }, admin);
check('2. productUpsert sobre cuota → 429 (resource-exhausted)', p2.status === 429, `status=${p2.status}`);

// 3-4. Usuarios: bloqueado (override maxUsers 0) vs ok (free, 0 usuarios)
await mkTenant('ent-users-block', { limitOverrides: { maxUsers: 0 } });
const u1 = await callFn('inviteUser', { tenantId: 'ent-users-block', email: 'block@ent.test', role: 'SELLER' }, admin);
check('3. inviteUser sobre cuota → 429', u1.status === 429, `status=${u1.status}`);

await mkTenant('ent-users-ok');
createdEmails.push('ok@ent.test');
const u2 = await callFn('inviteUser', { tenantId: 'ent-users-ok', email: 'ok@ent.test', role: 'SELLER' }, admin);
check('4. inviteUser dentro de cuota → ok', u2.status === 200 && !!u2.result?.uid, `status=${u2.status}`);

// 5-6. Números WhatsApp: bloqueado (maxWhatsappNumbers 0) vs entitled (free=1, connect completo)
await mkTenant('ent-wa-block', { limitOverrides: { maxWhatsappNumbers: 0 } });
const w1 = await callFn('connectMeta', { tenantId: 'ent-wa-block', nonce: 'x', code: 'y' }, admin);
check('5. connectMeta sin entitlement de número → bloqueado por plan', w1.status === 400 && /plan no incluye/i.test(w1.error?.message ?? ''), `status=${w1.status} msg=${w1.error?.message}`);

await mkTenant('ent-wa-ok');
const start = await callFn('startMetaConnect', { tenantId: 'ent-wa-ok' }, admin);
const w2 = await callFn('connectMeta', { tenantId: 'ent-wa-ok', nonce: start.result?.nonce, code: 'fakecode', wabaId: 'waba-ent', phoneNumberId: 'wa-ent-1' }, admin);
check('6. connectMeta con entitlement (free=1) → conecta', w2.status === 200 && w2.result?.status === 'active', `status=${w2.status} ${JSON.stringify(w2.result ?? w2.error)}`);

// 7. Feature gating: metaAdsSync requiere marketingAutomation (free no lo tiene)
await mkTenant('ent-free-job');
const j1 = await callFn('runTenantJob', { tenantId: 'ent-free-job', action: 'metaAdsSync' }, admin);
check('7. runTenantJob(metaAdsSync) en Free → bloqueado por feature (400)', j1.status === 400 && /plan no incluye/i.test(j1.error?.message ?? ''), `status=${j1.status} msg=${j1.error?.message}`);

// 8. Cuota adSyncs: growth con override 0 → 429
await mkTenant('ent-ads-quota', { planId: 'growth', limitOverrides: { maxAdSyncsPerMonth: 0 } });
const j2 = await callFn('runTenantJob', { tenantId: 'ent-ads-quota', action: 'metaAdsSync' }, admin);
check('8. runTenantJob(metaAdsSync) sobre cuota adSyncs → 429', j2.status === 429, `status=${j2.status}`);

// 9. Billing premium suspendido: growth canceled → feature premium bloqueada
await mkTenant('ent-canceled', { planId: 'growth', subscription: { status: 'canceled', planId: 'growth', stripeCustomerId: null, stripeSubscriptionId: null, currentPeriodEnd: null, updatedAt: NOW } });
const j3 = await callFn('runTenantJob', { tenantId: 'ent-canceled', action: 'catalogSync' }, admin);
check('9. Billing canceled → función premium suspendida (400)', j3.status === 400 && /pago|premium/i.test(j3.error?.message ?? ''), `status=${j3.status} msg=${j3.error?.message}`);

// 10. Lazy reset: período viejo + uso alto → al pasar por el gate se reinicia
await mkTenant('ent-reset', { planId: 'growth', limitOverrides: { maxAdSyncsPerMonth: 10 }, usage: { adSyncsThisMonth: 999, currentPeriodStart: TWO_MONTHS_AGO } });
await callFn('runTenantJob', { tenantId: 'ent-reset', action: 'metaAdsSync' }, admin);
const resetUsage = (await db.doc('tenants/ent-reset').get()).data()?.usage;
check('10. Lazy-reset del uso al cambiar de período', (resetUsage?.adSyncsThisMonth ?? 999) < 999, `adSyncsThisMonth=${resetUsage?.adSyncsThisMonth}`);

// 11. Rules: el owner NO puede escribir campos de entitlements (isDemo) directamente
const patch = await fetch(`${FS}/tenants/perfumeria?updateMask.fieldPaths=isDemo`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` }, body: JSON.stringify({ fields: { isDemo: { booleanValue: true } } }) });
check('11. Rules: owner NO puede escribir isDemo/entitlements (403)', patch.status === 403, `status=${patch.status}`);

// 12. Auditoría del bloqueo
const audits = await db.collection('tenants/ent-prod-block/auditLogs').where('action', '==', 'entitlement.blocked').get();
check('12. Bloqueo auditado (entitlement.blocked)', audits.size >= 1, `audits=${audits.size}`);

// --- Limpieza ---
await db.doc('metaTestFixtures/graph').delete().catch(() => {});
for (const email of createdEmails) {
  try { const u = await adminAuth.getUserByEmail(email); await adminAuth.deleteUser(u.uid); await db.doc(`users/${u.uid}`).delete().catch(() => {}); } catch { /* noop */ }
}
for (const id of createdTenants) {
  for (const sub of ['metaAssets', 'auditLogs', 'products', 'metaConnections']) {
    for (const d of (await db.collection(`tenants/${id}/${sub}`).get()).docs) await d.ref.delete();
  }
  await db.doc(`tenants/${id}`).delete().catch(() => {});
}
for (const d of (await db.collection('metaExternalIndex').where('externalId', '==', 'wa-ent-1').get()).docs) await d.ref.delete();
await db.doc('secrets/meta-token-ent-wa-ok').delete().catch(() => {});
// usuarios SELLER creados con tenantId de prueba (por si quedaron)
for (const d of (await db.collection('users').where('email', 'in', ['ok@ent.test']).get()).docs) await d.ref.delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO HARDENING F5A (entitlements/límites/usage): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
