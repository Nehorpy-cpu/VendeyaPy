/**
 * verify-fase5b-billing.mjs — Stripe price→plan + gracia + entitlements (Hardening F5B-i).
 * Postea eventos de suscripción FIRMADOS (HMAC, sin SDK) al platformBillingWebhook y verifica:
 * sync de plan/límites/estado/período, idempotencia, firma inválida (401), ventana de gracia de
 * past_due (premium durante gracia / bloqueado al vencer), canceled (premium bloqueado pero cuenta
 * ACTIVE + datos preservados), recuperación y precio no mapeado. Sin Stripe real.
 *
 * Nota: el emulador corre funciones en procesos separados → la invalidación de caché de
 * entitlements es por-proceso. Por eso cada chequeo "premium" usa un TENANT DISTINTO (se resuelve
 * una sola vez, sin caché stale). En prod la caché es por instancia + TTL 30s.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { createHmac } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTHURL = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_demo_fase3';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTHURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, idToken) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data }) });
  return { status: res.status };
}

let evtSeq = 0;
const subEvent = (type, tenantId, { status, priceId, periodEnd = 1_900_000_000, eventId } = {}) => ({
  id: eventId ?? `evt_${++evtSeq}`,
  type,
  data: { object: { id: `sub_${tenantId}`, status, customer: `cus_${tenantId}`, current_period_end: periodEnd, metadata: { tenantId }, items: { data: [{ price: { id: priceId } }] } } },
});
async function postWebhook(event, { secret = SECRET } = {}) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const res = await fetch(`${BASE}/platformBillingWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body });
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

// 1. created (price growth) → sincroniza plan/estado/límites/período/customer
await mkTenant('bill-sync');
const e1 = await postWebhook(subEvent('customer.subscription.created', 'bill-sync', { status: 'active', priceId: 'price_growth_test' }));
const t1 = await tenant('bill-sync');
check('1. created → planId growth + estado + límites denormalizados (1000) + período/customer',
  e1.status === 200 && t1?.planId === 'growth' && t1?.subscription?.status === 'active' && t1?.subscription?.planId === 'growth' && t1?.limits?.maxProducts === 1000 && !!t1?.subscription?.currentPeriodEnd && t1?.subscription?.stripeCustomerId === 'cus_bill-sync',
  `planId=${t1?.planId} maxProducts=${t1?.limits?.maxProducts}`);

// 2. Firma inválida → 401
const bad = await postWebhook(subEvent('customer.subscription.updated', 'bill-sync', { status: 'active', priceId: 'price_growth_test' }), { secret: 'secreto-malo' });
check('2. Firma inválida → 401', bad.status === 401, `status=${bad.status}`);

// 3. Idempotencia
const dupEvt = subEvent('customer.subscription.updated', 'bill-sync', { status: 'active', priceId: 'price_growth_test', eventId: 'evt_dup_1' });
await postWebhook(dupEvt);
const dup2 = await postWebhook(dupEvt);
check('3. Idempotencia: evento duplicado ignorado', dup2.json?.duplicate === true, JSON.stringify(dup2.json));

// 4. Cambio de plan growth → starter (límites re-derivados a 200)
await postWebhook(subEvent('customer.subscription.updated', 'bill-sync', { status: 'active', priceId: 'price_starter_test' }));
const t4 = await tenant('bill-sync');
check('4. Cambio de plan → starter (límites denormalizados a 200)', t4?.planId === 'starter' && t4?.limits?.maxProducts === 200, `planId=${t4?.planId} maxProducts=${t4?.limits?.maxProducts}`);

// 5. Precio no mapeado → conserva el plan
await postWebhook(subEvent('customer.subscription.updated', 'bill-sync', { status: 'active', priceId: 'price_desconocido' }));
check('5. Precio no mapeado → conserva el plan (no lo borra)', (await tenant('bill-sync'))?.planId === 'starter', `planId=${(await tenant('bill-sync'))?.planId}`);

// 6. past_due DENTRO de gracia → premium permitido (tenant fresco)
await mkTenant('bill-grace');
await postWebhook(subEvent('customer.subscription.created', 'bill-grace', { status: 'active', priceId: 'price_growth_test' }));
await postWebhook(subEvent('customer.subscription.updated', 'bill-grace', { status: 'past_due', priceId: 'price_growth_test' }));
const g1 = await callFn('runTenantJob', { tenantId: 'bill-grace', action: 'metaAdsSync' }, admin);
check('6. past_due en gracia → premium activo (job no bloqueado, != 400)', g1.status !== 400, `status=${g1.status}`);

// 7. past_due FUERA de gracia (pastDueSince 8 días atrás) → premium bloqueado (tenant fresco)
await mkTenant('bill-expired');
await postWebhook(subEvent('customer.subscription.created', 'bill-expired', { status: 'active', priceId: 'price_growth_test' }));
await postWebhook(subEvent('customer.subscription.updated', 'bill-expired', { status: 'past_due', priceId: 'price_growth_test' }));
await db.doc('tenants/bill-expired').set({ subscription: { pastDueSince: Timestamp.fromMillis(Date.now() - 8 * 86_400_000) } }, { merge: true });
const g2 = await callFn('runTenantJob', { tenantId: 'bill-expired', action: 'metaAdsSync' }, admin);
check('7. past_due vencido → premium bloqueado (400)', g2.status === 400, `status=${g2.status}`);

// 8. canceled → premium bloqueado, cuenta ACTIVE, datos preservados (tenant fresco)
await mkTenant('bill-cancel');
await postWebhook(subEvent('customer.subscription.created', 'bill-cancel', { status: 'active', priceId: 'price_growth_test' }));
await postWebhook(subEvent('customer.subscription.deleted', 'bill-cancel', { status: 'canceled', priceId: 'price_growth_test' }));
const t8 = await tenant('bill-cancel');
const c1 = await callFn('runTenantJob', { tenantId: 'bill-cancel', action: 'metaAdsSync' }, admin);
check('8. canceled → premium bloqueado (400), cuenta ACTIVE, planId conservado',
  c1.status === 400 && t8?.subscription?.status === 'canceled' && t8?.status === 'ACTIVE' && t8?.planId === 'growth',
  `jobStatus=${c1.status} subStatus=${t8?.subscription?.status} tenantStatus=${t8?.status} planId=${t8?.planId}`);

// 9. Recuperación (active) → pastDueSince limpio (chequeo de datos, determinístico)
await mkTenant('bill-recover');
await postWebhook(subEvent('customer.subscription.updated', 'bill-recover', { status: 'past_due', priceId: 'price_growth_test' }));
const rPast = await tenant('bill-recover');
await postWebhook(subEvent('customer.subscription.updated', 'bill-recover', { status: 'active', priceId: 'price_growth_test' }));
const rActive = await tenant('bill-recover');
check('9. Recuperación: past_due setea pastDueSince y active lo limpia',
  !!rPast?.subscription?.pastDueSince && !rActive?.subscription?.pastDueSince && rActive?.subscription?.status === 'active',
  `pastDue(antes)=${!!rPast?.subscription?.pastDueSince} pastDue(después)=${rActive?.subscription?.pastDueSince}`);

// --- Limpieza ---
for (const id of created) {
  for (const sub of ['metaCampaigns', 'metaAdsets', 'metaAds', 'metaAdInsightsDaily', 'auditLogs']) {
    for (const d of (await db.collection(`tenants/${id}/${sub}`).get()).docs) await d.ref.delete();
  }
  await db.doc(`tenants/${id}`).delete().catch(() => {});
}
for (const d of (await db.collection('platformBillingEvents').get()).docs) await d.ref.delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO HARDENING F5B-i (Stripe price→plan + gracia): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
