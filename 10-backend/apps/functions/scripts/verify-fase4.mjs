/**
 * verify-fase4.mjs — Verificación en vivo del SaaS multiempresa (Fase 4).
 * Alta de empresa desde cero (callable, solo admin) → tenant+owner+claims+plan; el
 * owner ve SU empresa y no otra; el vendedor no ve finanzas; invitar usuario;
 * billing de plataforma suspende/reactiva la empresa.
 *
 * El emulador debe arrancarse con STRIPE_WEBHOOK_SECRET=whsec_demo_fase3.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createHmac } from 'node:crypto';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const SECRET = 'whsec_demo_fase3';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email, password = 'test1234') =>
  (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) })).json()).idToken;
const callable = async (name, data, token) => {
  const r = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const readDoc = async (path, token) => (await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } })).status;
const billingPost = (eventId, type, tenantId, status) => {
  const body = JSON.stringify({ id: eventId, type, data: { object: { id: 'sub_1', status, customer: 'cus_1', metadata: { tenantId } } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v1=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`;
  return fetch(`${BASE}/platformBillingWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
};

// Limpieza previa
await db.doc('tenants/kiosco-test').delete().catch(() => {});

const admin = await signIn('superadmin@aiafg.com');
check('0. Login Super Admin', !!admin);

// 1. Alta de empresa desde cero (solo admin)
const prov = await callable('provisionTenant', { name: 'Kiosco Test', slug: 'kiosco-test', ownerEmail: 'owner@kiosco-test.com', ownerName: 'Dueño Kiosco', ownerPassword: 'test1234', industry: 'default', planId: 'free' }, admin);
check('1. Empresa creada desde cero (callable admin)', prov.status === 200 && prov.json?.result?.tenantId === 'kiosco-test', JSON.stringify(prov.json?.result ?? prov.json));

// 2. Tenant con plan + límites + estado
const t = (await db.doc('tenants/kiosco-test').get()).data();
check('2. Tenant con plan free + límites + ACTIVE', t?.planId === 'free' && t?.limits?.maxProducts === 20 && t?.status === 'ACTIVE', `limits.maxProducts=${t?.limits?.maxProducts}`);

// 3. Planes del SaaS sembrados
check('3. Planes del SaaS sembrados (4)', (await db.collection('plans').get()).size === 4);

// 4-5. Owner ve SU empresa pero NO otra (aislamiento)
const owner = await signIn('owner@kiosco-test.com');
check('4. Owner lee su empresa (200)', (await readDoc('tenants/kiosco-test', owner)) === 200);
check('5. Owner NO lee otra empresa (403)', (await readDoc('tenants/perfumeria', owner)) === 403);

// 6. Vendedor NO ve finanzas (P6, re-confirmación)
const seller = await signIn('seller@perfumeria.com');
check('6. Vendedor NO ve finanzas (403)', (await readDoc('tenants/perfumeria/orderFinancials/demo-o1', seller)) === 403);

// 7-8. Invitar un vendedor a la nueva empresa (como owner)
const inv = await callable('inviteUser', { tenantId: 'kiosco-test', email: 'vendedor@kiosco-test.com', role: 'SELLER', name: 'Vendedor Kiosco' }, owner);
check('7. Owner invita un vendedor', inv.status === 200 && !!inv.json?.result?.uid, JSON.stringify(inv.json?.result ?? inv.json));
const invDoc = inv.json?.result?.uid ? (await db.doc(`users/${inv.json.result.uid}`).get()).data() : null;
check('8. Usuario invitado con rol + tenant correctos', invDoc?.role === 'SELLER' && invDoc?.tenantId === 'kiosco-test');

// 9. Un vendedor NO puede invitar usuarios
const invBad = await callable('inviteUser', { tenantId: 'kiosco-test', email: 'x@y.com', role: 'SELLER' }, seller);
check('9. Vendedor NO puede invitar (denegado)', invBad.status === 403 || invBad.json?.error?.status === 'PERMISSION_DENIED', `HTTP ${invBad.status}`);

// 10-11. Billing: suscripción cancelada → empresa SUSPENDED
check('10. Billing cancelado → 200', (await billingPost('evt_bill_del', 'customer.subscription.deleted', 'kiosco-test', 'canceled')).status === 200);
await new Promise((r) => setTimeout(r, 600));
check('11. Empresa SUSPENDED por billing', (await db.doc('tenants/kiosco-test').get()).data()?.status === 'SUSPENDED');

// 12-13. Billing: suscripción activa → empresa ACTIVE (reactivación)
check('12. Billing activo → 200', (await billingPost('evt_bill_upd', 'customer.subscription.updated', 'kiosco-test', 'active')).status === 200);
await new Promise((r) => setTimeout(r, 600));
check('13. Empresa REACTIVADA (ACTIVE)', (await db.doc('tenants/kiosco-test').get()).data()?.status === 'ACTIVE');

// Limpieza
await db.doc('tenants/kiosco-test/config/agent').delete().catch(() => {});
await db.doc('tenants/kiosco-test').delete().catch(() => {});
for (const id of ['evt_bill_del', 'evt_bill_upd']) await db.doc(`platformBillingEvents/${id}`).delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO FASE 4 (SaaS multiempresa): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
