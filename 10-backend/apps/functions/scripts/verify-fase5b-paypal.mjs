/**
 * verify-fase5b-paypal.mjs — Billing PayPal (Hardening F5B-ii).
 * Usa el FakePayPalBillingProvider (emulador) — NUNCA llama a PayPal real. Verifica:
 * createPayPalSubscriptionSession (approvalUrl + estado provisional), authz (seller 403), webhook
 * ACTIVATED (sync plan/límites), firma inválida (401), idempotencia, premium activo, CANCELLED
 * (premium bloqueado, cuenta ACTIVE), resolución por externalSubscriptionId, y syncPayPalSubscription.
 *
 * Nota: como en 5B-i, los chequeos "premium" usan tenants distintos (caché de entitlements por-proceso).
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

let evtSeq = 0;
const ppEvent = (event_type, { tenantId, status, planId = 'P-GROWTH', subId, eventId, withCustom = true } = {}) => ({
  id: eventId ?? `WH-${++evtSeq}`,
  event_type,
  resource: { id: subId, status, plan_id: planId, ...(withCustom ? { custom_id: tenantId } : {}), subscriber: { payer_id: 'PAYER1' }, billing_info: { next_billing_time: '2026-06-01T00:00:00Z' } },
});
async function postPayPalWebhook(event, { valid = true } = {}) {
  const res = await fetch(`${BASE}/paypalBillingWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paypal-test-valid': valid ? 'true' : 'false' }, body: JSON.stringify(event) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const tenant = (id) => db.doc(`tenants/${id}`).get().then((s) => s.data());
const created = [];
async function mkTenant(id) {
  created.push(id);
  await db.doc(`tenants/${id}`).set({ id, name: id, slug: id, status: 'ACTIVE', planId: 'free', usage: { messagesThisMonth: 0, ordersThisMonth: 0, jobsThisMonth: 0, adSyncsThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: Timestamp.now() }, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
}

const admin = await signIn('superadmin@aiafg.com');
const seller = await signIn('seller@perfumeria.com');

// 1. createPayPalSubscriptionSession → approvalUrl + estado provisional (incomplete)
await mkTenant('pp-test');
const s1 = await callFn('createPayPalSubscriptionSession', { tenantId: 'pp-test', planId: 'growth' }, admin);
const t1 = await tenant('pp-test');
check('1. createPayPalSubscriptionSession → approvalUrl + estado provisional incomplete',
  s1.status === 200 && typeof s1.result?.approvalUrl === 'string' && s1.result.approvalUrl.includes('paypal') && t1?.subscription?.externalSubscriptionId === 'sub_pp-test' && t1?.subscription?.status === 'incomplete' && t1?.subscription?.paymentProvider === 'paypal' && t1?.subscription?.externalPlanRef === 'P-GROWTH',
  `url=${s1.result?.approvalUrl} ext=${t1?.subscription?.externalSubscriptionId}`);

// 2. Authz: vendedor NO puede crear sesión
const s2 = await callFn('createPayPalSubscriptionSession', { tenantId: 'perfumeria', planId: 'growth' }, seller);
check('2. Authz: vendedor → 403', s2.status === 403, `status=${s2.status}`);

// 3. webhook ACTIVATED → sync plan/límites
const w3 = await postPayPalWebhook(ppEvent('BILLING.SUBSCRIPTION.ACTIVATED', { tenantId: 'pp-test', status: 'ACTIVE', subId: 'sub_pp-test' }));
const t3 = await tenant('pp-test');
check('3. webhook ACTIVATED → planId growth + límites + sub active + provider paypal',
  w3.status === 200 && t3?.planId === 'growth' && t3?.limits?.maxProducts === 1000 && t3?.subscription?.status === 'active' && t3?.subscription?.paymentProvider === 'paypal',
  `planId=${t3?.planId} maxProducts=${t3?.limits?.maxProducts} status=${t3?.subscription?.status}`);

// 4. Firma inválida → 401
const w4 = await postPayPalWebhook(ppEvent('BILLING.SUBSCRIPTION.UPDATED', { tenantId: 'pp-test', status: 'ACTIVE', subId: 'sub_pp-test' }), { valid: false });
check('4. webhook firma inválida → 401', w4.status === 401, `status=${w4.status}`);

// 5. Idempotencia
const dup = ppEvent('BILLING.SUBSCRIPTION.UPDATED', { tenantId: 'pp-test', status: 'ACTIVE', subId: 'sub_pp-test', eventId: 'WH-DUP-1' });
await postPayPalWebhook(dup);
const dup2 = await postPayPalWebhook(dup);
check('5. webhook duplicado ignorado', dup2.json?.duplicate === true, JSON.stringify(dup2.json));

// 6. Premium activo tras ACTIVATED (tenant fresco)
await mkTenant('pp-active');
await postPayPalWebhook(ppEvent('BILLING.SUBSCRIPTION.ACTIVATED', { tenantId: 'pp-active', status: 'ACTIVE', subId: 'sub_pp-active' }));
const g1 = await callFn('runTenantJob', { tenantId: 'pp-active', action: 'metaAdsSync' }, admin);
check('6. Entitlements reflejan plan PayPal: premium activo (job != 400)', g1.status !== 400, `status=${g1.status}`);

// 7. CANCELLED → premium bloqueado, cuenta ACTIVE, datos preservados (tenant fresco)
await mkTenant('pp-cancel');
await postPayPalWebhook(ppEvent('BILLING.SUBSCRIPTION.ACTIVATED', { tenantId: 'pp-cancel', status: 'ACTIVE', subId: 'sub_pp-cancel' }));
await postPayPalWebhook(ppEvent('BILLING.SUBSCRIPTION.CANCELLED', { tenantId: 'pp-cancel', status: 'CANCELLED', subId: 'sub_pp-cancel' }));
const t7 = await tenant('pp-cancel');
const c1 = await callFn('runTenantJob', { tenantId: 'pp-cancel', action: 'metaAdsSync' }, admin);
check('7. CANCELLED → premium bloqueado (400), cuenta ACTIVE, planId conservado',
  c1.status === 400 && t7?.subscription?.status === 'canceled' && t7?.status === 'ACTIVE' && t7?.planId === 'growth',
  `jobStatus=${c1.status} subStatus=${t7?.subscription?.status} tenantStatus=${t7?.status}`);

// 8. Resolución por externalSubscriptionId (sin custom_id)
const w8 = await postPayPalWebhook(ppEvent('BILLING.SUBSCRIPTION.SUSPENDED', { status: 'SUSPENDED', subId: 'sub_pp-test', withCustom: false }));
const t8 = await tenant('pp-test');
check('8. Webhook sin custom_id → resuelve por externalSubscriptionId y aplica',
  w8.status === 200 && t8?.subscription?.status === 'past_due' && !!t8?.subscription?.pastDueSince,
  `status=${t8?.subscription?.status} pastDue=${!!t8?.subscription?.pastDueSince}`);

// 9. syncPayPalSubscription reconcilia (fixture ACTIVE)
await db.doc('paypalTestFixtures/sub').set({ status: 'ACTIVE', plan_id: 'P-GROWTH', custom_id: 'pp-test', payer_id: 'PAYER1', next_billing_time: '2026-07-01T00:00:00Z' });
const sync = await callFn('syncPayPalSubscription', { tenantId: 'pp-test' }, admin);
const t9 = await tenant('pp-test');
check('9. syncPayPalSubscription reconcilia → active', sync.status === 200 && sync.result?.status === 'active' && t9?.subscription?.status === 'active', `status=${sync.result?.status}`);

// --- Limpieza ---
await db.doc('paypalTestFixtures/sub').delete().catch(() => {});
for (const id of created) {
  for (const sub of ['metaCampaigns', 'metaAdsets', 'metaAds', 'metaAdInsightsDaily', 'auditLogs']) {
    for (const d of (await db.collection(`tenants/${id}/${sub}`).get()).docs) await d.ref.delete();
  }
  await db.doc(`tenants/${id}`).delete().catch(() => {});
}
for (const d of (await db.collection('platformBillingEvents').get()).docs) await d.ref.delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO HARDENING F5B-ii (PayPal Subscriptions): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
