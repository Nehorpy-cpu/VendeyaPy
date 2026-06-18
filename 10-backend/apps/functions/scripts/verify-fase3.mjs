/**
 * verify-fase3.mjs — Verificación en vivo del webhook real de Stripe (Fase 3).
 * Firma válida → confirma la orden (PAID) + registra Purchase; idempotente ante
 * duplicados; sin firma → 401. Order/sesión autocontenidos (no depende del seed).
 *
 * El emulador debe arrancarse con STRIPE_WEBHOOK_SECRET=whsec_demo_fase3.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { createHmac } from 'node:crypto';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const T = 'perfumeria';
const SECRET = 'whsec_demo_fase3';
const now = Timestamp.now();

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };

const orderId = 'f3-order';
const cid = 'f3cust';

// Orden + sesión autocontenidas en estado PENDING_PAYMENT.
await db.doc(`tenants/${T}/customers/${cid}/sessions/active`).set({
  id: 'active', tenantId: T, customerId: cid, state: 'AWAITING_PAYMENT',
  cart: { items: [], subtotal: 0 }, context: { pendingOrderId: orderId }, expiresAt: now, updatedAt: now,
});
await db.doc(`tenants/${T}/orders/${orderId}`).set({
  id: orderId, tenantId: T, customerId: cid, status: 'PENDING_PAYMENT', items: [], channel: 'WHATSAPP',
  totals: { subtotal: 100000, discount: 0, total: 100000, currency: 'PYG' },
  payment: { method: 'STRIPE', paymentId: '', paidAt: null }, createdAt: now, updatedAt: now,
});
await db.doc(`stripeWebhookEvents/evt_fase3`).delete().catch(() => {});
await db.doc(`tenants/${T}/businessEvents/purchase-${orderId}`).delete().catch(() => {});

function stripePost(eventId, type, metadata, sign = true) {
  const body = JSON.stringify({ id: eventId, type, data: { object: { metadata } } });
  const headers = { 'Content-Type': 'application/json' };
  if (sign) {
    const ts = Math.floor(Date.now() / 1000);
    headers['Stripe-Signature'] = `t=${ts},v1=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`;
  }
  return fetch(`${BASE}/stripeWebhook`, { method: 'POST', headers, body }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}

// 1. Sin firma → 401 (fail-closed)
const noSig = await stripePost('evt_fase3', 'checkout.session.completed', { tenantId: T, orderId }, false);
check('1. Sin firma → 401', noSig.status === 401, `HTTP ${noSig.status}`);

// 2. Firma inválida → 401
const badBody = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: { metadata: { tenantId: T, orderId } } } });
const badRes = await fetch(`${BASE}/stripeWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=9999999999,v1=deadbeef' }, body: badBody }).then((r) => r.status);
check('2. Firma inválida → 401', badRes === 401, `HTTP ${badRes}`);

// 3. Firma válida + metadata → 200 y confirma la orden
const r3 = await stripePost('evt_fase3', 'checkout.session.completed', { tenantId: T, orderId });
check('3. Webhook válido → 200', r3.status === 200, JSON.stringify(r3.json));
await new Promise((r) => setTimeout(r, 900));
const o = (await db.doc(`tenants/${T}/orders/${orderId}`).get()).data();
check('4. La orden quedó PAID', o?.status === 'PAID', `status=${o?.status}`);

// 5. Idempotencia: mismo eventId → duplicate, no reprocesa
const r5 = await stripePost('evt_fase3', 'checkout.session.completed', { tenantId: T, orderId });
check('5. Evento duplicado → ignorado', r5.json?.duplicate === true, JSON.stringify(r5.json));

// 6. Purchase business event registrado (idempotente)
const pe = await db.doc(`tenants/${T}/businessEvents/purchase-${orderId}`).get();
check('6. Evento Purchase registrado', pe.exists, `value=${pe.data()?.value}`);

// 7. Evento no relevante → ignorado (200)
const r7 = await stripePost('evt_other', 'invoice.created', {});
check('7. Tipo no relevante → ignorado', r7.status === 200 && r7.json?.ignored === 'invoice.created', JSON.stringify(r7.json));

// Limpieza
for (const p of [`orders/${orderId}`, `customers/${cid}/sessions/active`, `businessEvents/purchase-${orderId}`]) await db.doc(`tenants/${T}/${p}`).delete().catch(() => {});
await db.doc('stripeWebhookEvents/evt_fase3').delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO FASE 3 (Stripe): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
