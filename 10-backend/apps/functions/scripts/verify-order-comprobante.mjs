/**
 * verify-order-comprobante.mjs — ORDER-1B end-to-end (emulador, requiere STORAGE emulator).
 * Comprobantes por imagen de WhatsApp:
 *   1. Imagen con session.pendingOrderId → media stub a Storage + orden PENDING_VERIFICATION
 *      + payment.comprobanteUrl (path, no URL firmada) + handoff + audit + respuesta al cliente.
 *      NUNCA PAID automático.
 *   2. Imagen sin orden pendiente → respuesta segura, nada se adjunta.
 *   3. Imagen con MÚLTIPLES pendientes → pide aclaración, no adjunta a ciegas.
 *   4. El staff confirma DESPUÉS por callable ORDER-1 (orderUpdateStatus → PAID vía confirmPayment).
 *
 * Requiere: emulador (auth+firestore+functions+storage) + seed-users.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

initializeApp({ projectId: 'demo-aiafg', storageBucket: 'demo-aiafg.appspot.com' });
const db = getFirestore();
const bucket = getStorage().bucket();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
const PNID = 'wa-comp-1';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;

// Ruteo del webhook a perfumeria (asset + índice), modo mock, bot on.
const now = Timestamp.now();
const oldAssets = await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
const oldAssetDocs = oldAssets.docs.map((d) => ({ id: d.id, data: d.data() }));
for (const d of oldAssets.docs) await d.ref.delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ id: PNID, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: 'wa-comp', status: 'active', selected: true, createdAt: now, updatedAt: now });
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: now });
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });

let midSeq = 0;
const sentMids = [];
async function postImage(from, mediaId, caption) {
  const mid = `wamid.COMP-${Date.now()}-${++midSeq}`; // único por corrida (el inbox es idempotente por messageId)
  sentMids.push(mid);
  const payload = { object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: from, profile: { name: 'Comp' } }],
    messages: [{ from, id: mid, timestamp: '1716750000', type: 'image', image: { id: mediaId, mime_type: 'image/jpeg', ...(caption ? { caption } : {}) } }],
  } }] }] };
  return (await fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).status;
}
async function lastOut(from) {
  const snap = await db.collection(`tenants/${T}/customers/${from}/messages`).get();
  const outs = snap.docs.map((d) => d.data()).filter((m) => m.direction === 'out').sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  return outs.length ? outs[outs.length - 1].text : null;
}
async function waitOut(from, maxMs = 20000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) { const t = await lastOut(from); if (t) return t; await sleep(800); }
  return null;
}
let seq = 0;
const createdOrders = [];
async function mkOrder(customerId, status) {
  const id = `ordcomp_${Date.now()}_${++seq}`;
  await db.doc(`tenants/${T}/orders/${id}`).set({
    id, tenantId: T, customerId, status,
    items: [{ itemId: 'i1', productId: 'lattafa-yara', productName: 'Yara', unitPrice: 180000, quantity: 1, subtotal: 180000 }],
    totals: { subtotal: 180000, discount: 0, total: 180000, currency: 'PYG' },
    payment: { method: 'BANCARD', paymentId: '', paidAt: null, comprobanteUrl: null },
    delivery: { deliveryId: null, address: { street: '', houseNumber: '', city: '', neighborhood: '', reference: '', coordinates: null } },
    invoice: { invoiceId: null, number: null }, channel: 'WHATSAPP', sellerId: null, source: 'verify-comprobante', notes: '',
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
  });
  createdOrders.push({ id, customerId });
  return id;
}
const orderDoc = async (id) => (await db.doc(`tenants/${T}/orders/${id}`).get()).data();

// === 1. Imagen con pendingOrderId → comprobante adjuntado, PENDING_VERIFICATION, nunca PAID ===
const C1 = '595993330001';
{
  const orderId = await mkOrder(C1, 'PENDING_PAYMENT');
  await db.doc(`tenants/${T}/customers/${C1}/sessions/active`).set({
    id: 'active', tenantId: T, customerId: C1, state: 'AWAITING_PAYMENT',
    cart: { items: [], subtotal: 0 }, context: { pendingOrderId: orderId }, updatedAt: Timestamp.now(),
  });
  const st = await postImage(C1, 'MEDIA-E2E-1', 'pago del pedido');
  const reply = await waitOut(C1);
  await sleep(1500);
  const o = await orderDoc(orderId);
  const compPath = o?.payment?.comprobanteUrl ?? '';
  const [fileExists] = compPath.startsWith('tenants/') ? await bucket.file(compPath).exists() : [false];
  const handoff = (await db.doc(`tenants/${T}/handoffs/${orderId}`).get()).exists;
  const audits = (await db.collection(`tenants/${T}/auditLogs`).where('action', '==', 'order.comprobante_received').get()).docs
    .map((d) => d.data()).filter((a) => a.targetId === orderId);
  check('1a. webhook imagen 200 + respuesta al cliente', st === 200 && !!reply, JSON.stringify((reply ?? '').slice(0, 60)));
  check('1b. orden → PENDING_VERIFICATION (nunca PAID automático)', o?.status === 'PENDING_VERIFICATION' && !o?.payment?.paidAt, `status=${o?.status}`);
  check('1c. comprobanteUrl = PATH de Storage (no URL firmada) y el archivo EXISTE', compPath.startsWith(`tenants/${T}/orders/${orderId}/comprobantes/`) && fileExists, compPath);
  check('1d. handoff creado (cola del vendedor) + audit order.comprobante_received', handoff && audits.length === 1, `handoff=${handoff} audits=${audits.length}`);
}

// === 2. Imagen sin orden pendiente → respuesta segura, nada adjuntado ===
const C2 = '595993330002';
{
  const st = await postImage(C2, 'MEDIA-E2E-2');
  const reply = await waitOut(C2);
  check('2. sin pedido pendiente → respuesta segura ("no encuentro un pedido")', st === 200 && !!reply && reply.includes('no encuentro un pedido'), JSON.stringify((reply ?? '').slice(0, 70)));
}

// === 3. Múltiples pendientes → pide aclaración, NO adjunta ===
const C3 = '595993330003';
{
  const a = await mkOrder(C3, 'PENDING_PAYMENT');
  const b = await mkOrder(C3, 'PENDING_PAYMENT');
  await postImage(C3, 'MEDIA-E2E-3');
  const reply = await waitOut(C3);
  await sleep(1000);
  const oa = await orderDoc(a); const ob = await orderDoc(b);
  check('3. múltiples pendientes → aclaración, ninguna orden cambia',
    !!reply && reply.includes('más de un pedido') && oa?.status === 'PENDING_PAYMENT' && ob?.status === 'PENDING_PAYMENT',
    `a=${oa?.status} b=${ob?.status}`);
}

// === 4. El staff confirma DESPUÉS por callable ORDER-1 (flujo completo) ===
{
  const seller = await signIn('seller@perfumeria.com');
  const orderId = createdOrders[0].id; // la de caso 1, ya PENDING_VERIFICATION
  const res = await fetch(`${BASE}/orderUpdateStatus`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seller}` },
    body: JSON.stringify({ data: { orderId, to: 'PAID' } }),
  });
  const body = await res.json().catch(() => ({}));
  const o = await orderDoc(orderId);
  check('4. seller confirma el comprobante → PAID vía callable (confirmPayment real)',
    body.result?.ok === true && o?.status === 'PAID' && !!o?.payment?.paidAt, `status=${o?.status}`);
}

// ---- Limpieza (órdenes/sesiones/mensajes sintéticos + archivos de storage) ----
for (const { id, customerId } of createdOrders) {
  const compFiles = await bucket.getFiles({ prefix: `tenants/${T}/orders/${id}/comprobantes/` }).then(([f]) => f).catch(() => []);
  for (const f of compFiles) await f.delete().catch(() => {});
  await db.doc(`tenants/${T}/orders/${id}`).delete().catch(() => {});
  await db.doc(`tenants/${T}/handoffs/${id}`).delete().catch(() => {});
  await db.doc(`tenants/${T}/businessEvents/purchase-${id}`).delete().catch(() => {});
}
for (const c of [C1, C2, C3]) {
  const msgs = await db.collection(`tenants/${T}/customers/${c}/messages`).get();
  for (const d of msgs.docs) await d.ref.delete();
  await db.doc(`tenants/${T}/customers/${c}/sessions/active`).delete().catch(() => {});
  await db.doc(`tenants/${T}/customers/${c}`).delete().catch(() => {});
}
for (const mid of sentMids) await db.doc(`metaWebhookInbox/whatsapp_${mid}`).delete().catch(() => {});
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete();
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete();
for (const d of oldAssetDocs) await db.doc(`tenants/${T}/metaAssets/${d.id}`).set(d.data);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();

const ok = results.every(Boolean);
console.log(`\nRESULTADO ORDER-1B (comprobantes por imagen): ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
