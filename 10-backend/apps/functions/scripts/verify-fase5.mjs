/**
 * verify-fase5.mjs — Verificación en vivo de operación/observabilidad (Fase 5).
 * Health check; audit logs de provisioning, producto, pago y billing; reglas de
 * lectura de la bitácora (manager+ sí, vendedor no).
 *
 * El emulador debe arrancarse con STRIPE_WEBHOOK_SECRET=whsec_demo_fase3.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { createHmac } from 'node:crypto';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const SECRET = 'whsec_demo_fase3';
const T = 'perfumeria';
const now = Timestamp.now();

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email, password = 'test1234') =>
  (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) })).json()).idToken;
const callable = async (name, data, token) => {
  const r = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const listStatus = async (path, token) => (await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } })).status;
const auditHas = async (tenantId, action, targetId) => {
  let q = db.collection(`tenants/${tenantId}/auditLogs`).where('action', '==', action);
  if (targetId) q = q.where('targetId', '==', targetId);
  return !(await q.limit(1).get()).empty;
};
const stripePost = (name, eventId, type, body) => {
  const payload = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v1=${createHmac('sha256', SECRET).update(`${ts}.${payload}`).digest('hex')}`;
  return fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body: payload }).then((r) => r.status);
};

// 1. Health check
const h = await fetch(`${BASE}/healthCheck`).then(async (r) => ({ status: r.status, json: await r.json() }));
check('1. Health check OK + firestore ok', h.status === 200 && h.json?.status === 'ok' && h.json?.checks?.firestore === 'ok', JSON.stringify(h.json?.checks));

// 2. Provisioning audita tenant.provisioned
const admin = await signIn('superadmin@aiafg.com');
await db.doc('tenants/kiosco5').delete().catch(() => {});
const prov = await callable('provisionTenant', { name: 'Kiosco F5', slug: 'kiosco5', ownerEmail: 'owner@kiosco5.com', ownerName: 'Dueño', ownerPassword: 'test1234', planId: 'free' }, admin);
await sleep(400);
check('2. Audit tenant.provisioned', prov.status === 200 && (await auditHas('kiosco5', 'tenant.provisioned')));

// 3. Cambio de producto audita product.created (trigger)
await db.doc(`tenants/${T}/products/f5-prod`).set({ id: 'f5-prod', tenantId: T, name: 'Producto F5', price: 99000, status: 'ACTIVE', createdAt: now, updatedAt: now });
await sleep(1200);
check('3. Audit product.created (trigger)', await auditHas(T, 'product.created', 'f5-prod'));

// 4. Pago confirmado audita payment.confirmed (via Stripe webhook)
const cid = 'f5cust';
await db.doc(`tenants/${T}/customers/${cid}/sessions/active`).set({ id: 'active', tenantId: T, customerId: cid, state: 'AWAITING_PAYMENT', cart: { items: [], subtotal: 0 }, context: { pendingOrderId: 'f5-order' }, updatedAt: now });
await db.doc(`tenants/${T}/orders/f5-order`).set({ id: 'f5-order', tenantId: T, customerId: cid, status: 'PENDING_PAYMENT', items: [], channel: 'WHATSAPP', totals: { subtotal: 50000, discount: 0, total: 50000, currency: 'PYG' }, payment: { method: 'STRIPE', paymentId: '', paidAt: null }, createdAt: now, updatedAt: now });
const ps = await stripePost('stripeWebhook', 'evt_f5_pay', 'checkout.session.completed', { id: 'evt_f5_pay', type: 'checkout.session.completed', data: { object: { metadata: { tenantId: T, orderId: 'f5-order' } } } });
await sleep(700);
check('4. Audit payment.confirmed', ps === 200 && (await auditHas(T, 'payment.confirmed', 'f5-order')));

// 5. Billing suspende → audita tenant.suspended
const bs = await stripePost('platformBillingWebhook', 'evt_f5_bill', 'customer.subscription.deleted', { id: 'evt_f5_bill', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled', metadata: { tenantId: 'kiosco5' } } } });
await sleep(600);
check('5. Audit tenant.suspended (billing)', bs === 200 && (await auditHas('kiosco5', 'tenant.suspended')));

// 6-7. Reglas: owner lee la bitácora, vendedor NO
const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
check('6. Owner/manager lee auditLogs (200)', (await listStatus(`tenants/${T}/auditLogs`, owner)) === 200);
check('7. Vendedor NO lee auditLogs (403)', (await listStatus(`tenants/${T}/auditLogs`, seller)) === 403);

// Limpieza
for (const p of [`products/f5-prod`, `orders/f5-order`, `customers/${cid}/sessions/active`]) await db.doc(`tenants/${T}/${p}`).delete().catch(() => {});
await db.doc('tenants/kiosco5').delete().catch(() => {});
for (const id of ['evt_f5_pay', 'evt_f5_bill']) { await db.doc(`stripeWebhookEvents/${id}`).delete().catch(() => {}); await db.doc(`platformBillingEvents/${id}`).delete().catch(() => {}); }

const ok = results.every((x) => x);
console.log(`\nRESULTADO FASE 5 (operación/observabilidad): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
