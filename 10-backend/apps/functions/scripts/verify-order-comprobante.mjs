/**
 * verify-order-comprobante.mjs — ORDER-1B reescrito bajo ADR-0016 (emulador, requiere STORAGE).
 * ==============================================================================================
 * El comprobante de pago por WhatsApp, de punta a punta, con el CONTRATO NUEVO:
 *   1. Imagen con contexto de pago DECLARADO (sesión AWAITING_PAYMENT + pendingOrderId propio) →
 *      el archivo se guarda como ADJUNTO y se PROPONE (`payment_receipt_candidate`).
 *      El pedido NO cambia de estado y el bot NO sale del chat.
 *   2. Imagen sin pedido pendiente → se guarda igual como medio normal; nada se adjunta al pedido.
 *   3. Imagen con MÚLTIPLES pendientes → cero elección automática; ninguna orden cambia.
 *   4. Una PERSONA autorizada vincula el comprobante → PENDING_VERIFICATION, y recién después
 *      confirma el pago por el callable de ORDER-1 → PAID. Nunca automático.
 *
 * POR QUÉ CAMBIÓ ESTE FIXTURE (ADR-0016 §2 y §4). Hasta la auditoría WHATSAPP-MEDIA-1A este
 * script afirmaba el comportamiento viejo: toda imagen de un cliente con pedido pendiente movía
 * la orden a PENDING_VERIFICATION, escribía `payment.comprobanteUrl`, creaba handoff y sacaba al
 * bot de la conversación. Ese era el defecto #1 de la auditoría —una foto de producto congelaba
 * el pedido— y el ADR lo revierte de forma deliberada: la ingesta es un hecho técnico y el pago
 * es una decisión humana. Las afirmaciones de acá se actualizaron a ese contrato, SIN aflojar
 * ninguna: lo que antes se exigía automático ahora se exige explícitamente humano, y se agrega la
 * exigencia de que el pedido NO se mueva solo. Los comprobantes históricos siguen abriendo con el
 * visor (ADR-0016 §7): eso lo cubre verify-ocv1.mjs.
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
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null, errMsg: body.error?.message ?? null };
}

// Ruteo del webhook a perfumeria (asset + índice), modo mock, bot on.
const now = Timestamp.now();
const oldAssets = await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
const oldAssetDocs = oldAssets.docs.map((d) => ({ id: d.id, data: d.data() }));
for (const d of oldAssets.docs) await d.ref.delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ id: PNID, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: 'wa-comp', status: 'active', selected: true, createdAt: now, updatedAt: now });
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: now });
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
// El gate corre con la config por DEFECTO del tenant (ventana 24 h, formatos del contrato).
await db.doc(`tenants/${T}/config/receiptGate`).delete().catch(() => {});

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
const msgsOf = async (from) => (await db.collection(`tenants/${T}/customers/${from}/messages`).get()).docs
  .map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
async function lastOut(from) {
  const outs = (await msgsOf(from)).filter((m) => m.direction === 'out');
  return outs.length ? outs[outs.length - 1].text : null;
}
/** ADR-0016: el adjunto vive en la raíz del tenant, con identidad propia. */
const adjuntosDe = async (from) => (await db.collection(`tenants/${T}/attachments`).where('customerId', '==', from).get()).docs.map((d) => d.data());
async function waitAdjunto(from, maxMs = 25_000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const [a] = await adjuntosDe(from);
    if (a && ['stored', 'rejected', 'download_failed'].includes(a.ingestState) && a.classification?.value !== 'unclassified') return a;
    await sleep(600);
  }
  return (await adjuntosDe(from))[0] ?? null;
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

// === 1. Imagen con contexto de pago DECLARADO → adjunto PROPUESTO; el pedido NO se mueve ===
const C1 = '595993330001';
let adjunto1 = null;
let orden1 = null;
{
  orden1 = await mkOrder(C1, 'PENDING_PAYMENT');
  await db.doc(`tenants/${T}/customers/${C1}/sessions/active`).set({
    id: 'active', tenantId: T, customerId: C1, state: 'AWAITING_PAYMENT',
    cart: { items: [], subtotal: 0 }, context: { pendingOrderId: orden1 }, updatedAt: Timestamp.now(),
  });
  const st = await postImage(C1, 'MEDIA-E2E-1', 'pago del pedido');
  adjunto1 = await waitAdjunto(C1);
  const reply = await lastOut(C1);
  const o = await orderDoc(orden1);
  const path = adjunto1?.storage?.path ?? '';
  const [fileExists] = path.startsWith('tenants/') ? await bucket.file(path).exists() : [false];
  const handoff = (await db.doc(`tenants/${T}/handoffs/${orden1}`).get()).exists;
  check('1a. webhook imagen 200 + el archivo se GUARDA con identidad propia (nunca se pierde)',
    st === 200 && adjunto1?.ingestState === 'stored' && path.startsWith(`tenants/${T}/attachments/`) && fileExists,
    `status=${st} ingest=${adjunto1?.ingestState} archivo=${fileExists}`);
  check('1b. queda PROPUESTO como comprobante y EL PEDIDO NO CAMBIA DE ESTADO (ADR-0016 §2)',
    adjunto1?.classification?.value === 'payment_receipt_candidate' && adjunto1?.orderCandidateId === orden1 &&
    o?.status === 'PENDING_PAYMENT' && !o?.payment?.paidAt,
    `class=${adjunto1?.classification?.value} status=${o?.status}`);
  check('1c. el candidato se ACUMULA en el pedido y no hay comprobante vinculado todavía',
    (o?.receiptAttachments?.candidateIds ?? []).includes(adjunto1?.attachmentId) &&
    (o?.receiptAttachments?.linkedIds ?? []).length === 0 && (o?.receiptAttachments?.statusDrivenBy ?? null) === null,
    `candidatos=${(o?.receiptAttachments?.candidateIds ?? []).length}`);
  check('1d. se le responde al cliente SIN sacar al bot del chat ni crear handoff automático',
    !!reply && /comprobante/i.test(reply) && !/confirmad/i.test(reply) && !handoff,
    `handoff=${handoff} reply=${JSON.stringify((reply ?? '').slice(0, 50))}`);
}

// === 2. Imagen sin orden pendiente → se guarda como medio normal; nada se adjunta ===
const C2 = '595993330002';
{
  const st = await postImage(C2, 'MEDIA-E2E-2');
  const adj = await waitAdjunto(C2);
  const msgs = await msgsOf(C2);
  check('2. sin pedido pendiente el archivo se conserva como medio normal (antes se perdía)',
    st === 200 && adj?.ingestState === 'stored' && adj?.classification?.value === 'generic_media' &&
    adj?.orderCandidateId === null && msgs.some((m) => (m.attachmentIds ?? []).includes(adj?.attachmentId)),
    `ingest=${adj?.ingestState} class=${adj?.classification?.value}`);
}

// === 3. Múltiples pendientes → cero elección automática; ninguna orden cambia ===
const C3 = '595993330003';
{
  const a = await mkOrder(C3, 'PENDING_PAYMENT');
  const b = await mkOrder(C3, 'PENDING_PAYMENT');
  await db.doc(`tenants/${T}/customers/${C3}/sessions/active`).set({
    id: 'active', tenantId: T, customerId: C3, state: 'AWAITING_PAYMENT',
    cart: { items: [], subtotal: 0 }, context: { pendingOrderId: null }, updatedAt: Timestamp.now(),
  });
  await postImage(C3, 'MEDIA-E2E-3');
  const adj = await waitAdjunto(C3);
  const oa = await orderDoc(a); const ob = await orderDoc(b);
  check('3. múltiples pendientes → el gate NO elige, ninguna orden cambia y el archivo se conserva',
    adj?.classification?.value === 'generic_media' && adj?.orderCandidateId === null &&
    oa?.status === 'PENDING_PAYMENT' && ob?.status === 'PENDING_PAYMENT' &&
    (oa?.receiptAttachments?.candidateIds ?? []).length === 0 && (ob?.receiptAttachments?.candidateIds ?? []).length === 0,
    `class=${adj?.classification?.value} a=${oa?.status} b=${ob?.status}`);
}

// === 4. El comprobante lo vincula una PERSONA; el pago se confirma después por ORDER-1 ===
{
  const seller = await signIn('seller@perfumeria.com');
  const marcado = await call('attachmentMarkAsReceipt', seller, { attachmentId: adjunto1?.attachmentId, orderId: orden1 });
  const oMarcada = await orderDoc(orden1);
  check('4a. el vendedor vincula el comprobante → PENDING_VERIFICATION, y NUNCA PAID por este camino',
    marcado.result?.ok === true && oMarcada?.status === 'PENDING_VERIFICATION' && !oMarcada?.payment?.paidAt,
    `err=${marcado.err} status=${oMarcada?.status}`);
  const res = await call('orderUpdateStatus', seller, { orderId: orden1, to: 'PAID' });
  const o = await orderDoc(orden1);
  check('4b. seller confirma el pago → PAID vía callable ORDER-1 (confirmPayment real)',
    res.result?.ok === true && o?.status === 'PAID' && !!o?.payment?.paidAt, `status=${o?.status}`);
  const audits = (await db.collection(`tenants/${T}/auditLogs`).where('action', '==', 'order.receipt_marked').get())
    .docs.map((d) => d.data()).filter((a) => a.targetId === orden1);
  check('4c. la vinculación quedó auditada con `paymentConfirmed:false` (marcar ≠ cobrar)',
    audits.length === 1 && audits[0].metadata?.paymentConfirmed === false, `audits=${audits.length}`);
}

// ---- Limpieza (órdenes/sesiones/mensajes/adjuntos sintéticos + archivos de storage) ----
for (const c of [C1, C2, C3]) {
  for (const a of await adjuntosDe(c)) {
    if (a.storage?.path) await bucket.file(a.storage.path).delete().catch(() => {});
    await db.doc(`tenants/${T}/attachments/${a.attachmentId}`).delete().catch(() => {});
  }
  const msgs = await db.collection(`tenants/${T}/customers/${c}/messages`).get();
  for (const d of msgs.docs) await d.ref.delete();
  await db.doc(`tenants/${T}/customers/${c}/sessions/active`).delete().catch(() => {});
  await db.doc(`tenants/${T}/customers/${c}`).delete().catch(() => {});
}
for (const { id } of createdOrders) {
  const compFiles = await bucket.getFiles({ prefix: `tenants/${T}/orders/${id}/comprobantes/` }).then(([f]) => f).catch(() => []);
  for (const f of compFiles) await f.delete().catch(() => {});
  const audits = await db.collection(`tenants/${T}/auditLogs`).where('targetId', '==', id).get();
  for (const d of audits.docs) await d.ref.delete().catch(() => {});
  await db.doc(`tenants/${T}/orders/${id}`).delete().catch(() => {});
  await db.doc(`tenants/${T}/handoffs/${id}`).delete().catch(() => {});
  await db.doc(`tenants/${T}/businessEvents/purchase-${id}`).delete().catch(() => {});
}
for (const mid of sentMids) await db.doc(`metaWebhookInbox/whatsapp_${mid}`).delete().catch(() => {});
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete();
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete();
for (const d of oldAssetDocs) await db.doc(`tenants/${T}/metaAssets/${d.id}`).set(d.data);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();

const ok = results.every(Boolean);
console.log(`\nRESULTADO ORDER-1B (comprobante por imagen, contrato ADR-0016): ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
