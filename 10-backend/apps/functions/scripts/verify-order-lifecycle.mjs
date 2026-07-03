/**
 * verify-order-lifecycle.mjs — ORDER-1 end-to-end (emulador).
 * Writes directos a orders CERRADOS por rules; toda mutación por callables auditados que
 * hacen cumplir la máquina de estados (orders/lifecycle.ts):
 *   1-3.  update/delete directo por cliente (owner y seller) → 403 (rules).
 *   4.    seller no puede cancelar (callable manager+).
 *   5.    owner cancela UNPAID → CANCELLED + reason + audit order.cancelled.
 *   6.    cancelar PAID → failed-precondition (registro permanente).
 *   7.    orderUpdate: notes en UNPAID ok + audit; en PAID → failed-precondition; items → bloqueado.
 *   8.    seller confirma PENDING_VERIFICATION → PAID vía flujo REAL (confirmPayment): paidAt,
 *         sesión CHECKOUT_DONE, Purchase idempotente, audits payment.confirmed + manual.
 *   9.    cadena forward PAID→PREPARING→ASSIGNED→IN_TRANSIT→DELIVERED ok; retroceso → denied.
 *   10.   adminOrderCorrect: owner denied; sin motivo → invalid-argument; admin ok + audit before/after.
 *
 * Requiere: emulador (auth+firestore+functions) + seed-users (perfumeria).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const T = 'perfumeria';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;

/** Llama una callable onCall v2 por HTTP: POST {data} + Bearer idToken. */
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  return { http: res.status, result: body.result, errStatus: body.error?.status ?? null, errMsg: body.error?.message ?? '' };
}

/** Write directo por REST de Firestore con token de USUARIO (pasa por rules). */
async function clientPatchStatus(token, orderId, status) {
  const res = await fetch(`${FS}/tenants/${T}/orders/${orderId}?updateMask.fieldPaths=status&updateMask.fieldPaths=updatedAt`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: { status: { stringValue: status }, updatedAt: { timestampValue: new Date().toISOString() } } }),
  });
  return res.status;
}
const clientDelete = async (token, orderId) =>
  (await fetch(`${FS}/tenants/${T}/orders/${orderId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status;

let seq = 0;
const createdOrders = [];
/** Crea una orden sintética por Admin SDK (la creación por bot la cubre verify-f1-grounding 7b). */
async function mkOrder(status) {
  const id = `ordvl_${Date.now()}_${++seq}`;
  const now = Timestamp.now();
  const customerId = '595990009999';
  await db.doc(`tenants/${T}/orders/${id}`).set({
    id, tenantId: T, customerId, status,
    items: [{ itemId: 'i1', productId: 'lattafa-yara', productName: 'Yara', unitPrice: 180000, quantity: 1, subtotal: 180000 }],
    totals: { subtotal: 180000, discount: 0, total: 180000, currency: 'PYG' },
    payment: { method: 'BANCARD', paymentId: '', paidAt: null, comprobanteUrl: null },
    delivery: { deliveryId: null, address: { street: '', houseNumber: '', city: '', neighborhood: '', reference: '', coordinates: null } },
    invoice: { invoiceId: null, number: null },
    channel: 'WHATSAPP', sellerId: null, source: 'verify-order-lifecycle', notes: '',
    createdAt: now, updatedAt: now,
  });
  // confirmPayment actualiza la SESIÓN del cliente (en flujo real siempre existe) → asegurarla.
  await db.doc(`tenants/${T}/customers/${customerId}/sessions/active`).set({
    id: 'active', tenantId: T, customerId, state: 'AWAITING_PAYMENT',
    cart: { items: [], subtotal: 0 }, context: { pendingOrderId: id }, updatedAt: now,
  }, { merge: true });
  createdOrders.push(id);
  return id;
}
const orderDoc = async (id) => (await db.doc(`tenants/${T}/orders/${id}`).get()).data();
const auditFor = async (action, targetId) => {
  const snap = await db.collection(`tenants/${T}/auditLogs`).where('action', '==', action).get();
  return snap.docs.map((d) => d.data()).filter((a) => a.targetId === targetId);
};

// ============================== RUN ==============================
const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');

// 1-3. Rules: update/delete directo cerrado para TODOS los roles del cliente
{
  const id = await mkOrder('PENDING_PAYMENT');
  const s1 = await clientPatchStatus(owner, id, 'PAID');
  const s2 = await clientPatchStatus(seller, id, 'PAID');
  const s3 = await clientDelete(owner, id);
  const s4 = await clientDelete(admin, id);
  check('1. update directo (owner) → 403 por rules', s1 === 403, `http=${s1}`);
  check('2. update directo (seller) → 403 por rules', s2 === 403, `http=${s2}`);
  check('3. hard-delete directo (owner y admin) → 403 por rules', s3 === 403 && s4 === 403, `owner=${s3} admin=${s4}`);
  const still = await orderDoc(id);
  check('3b. la orden sigue intacta (PENDING_PAYMENT)', still?.status === 'PENDING_PAYMENT');
}

// 4-6. orderCancel: roles + matriz de estado
{
  const id = await mkOrder('PENDING_PAYMENT');
  const rSeller = await call('orderCancel', seller, { orderId: id, reason: 'prueba' });
  check('4. seller NO puede cancelar (permission-denied)', rSeller.errStatus === 'PERMISSION_DENIED', `err=${rSeller.errStatus}`);

  const rNoReason = await call('orderCancel', owner, { orderId: id });
  check('5a. cancelar sin motivo → invalid-argument', rNoReason.errStatus === 'INVALID_ARGUMENT', `err=${rNoReason.errStatus}`);

  const rOk = await call('orderCancel', owner, { orderId: id, reason: 'cliente se arrepintió' });
  const doc5 = await orderDoc(id);
  const audits5 = await auditFor('order.cancelled', id);
  check('5b. owner cancela UNPAID → CANCELLED + reason + audit',
    rOk.result?.ok === true && doc5?.status === 'CANCELLED' && doc5?.cancellation?.reason === 'cliente se arrepintió' && audits5.length === 1,
    `status=${doc5?.status} audits=${audits5.length}`);

  const idPaid = await mkOrder('PAID');
  const rPaid = await call('orderCancel', owner, { orderId: idPaid, reason: 'intento inválido' });
  check('6. cancelar PAID → failed-precondition (registro permanente)', rPaid.errStatus === 'FAILED_PRECONDITION', `err=${rPaid.errStatus}`);
}

// 7. orderUpdate: datos permitidos solo en UNPAID; items bloqueados
{
  const id = await mkOrder('PENDING_PAYMENT');
  const rOk = await call('orderUpdate', owner, { orderId: id, data: { notes: 'entregar después de las 18' } });
  const doc7 = await orderDoc(id);
  const audits7 = await auditFor('order.updated', id);
  check('7a. orderUpdate notes en UNPAID → ok + audit', rOk.result?.ok === true && doc7?.notes === 'entregar después de las 18' && audits7.length === 1);

  const rItems = await call('orderUpdate', owner, { orderId: id, data: { items: [] } });
  check('7b. editar items → bloqueado (failed-precondition)', rItems.errStatus === 'FAILED_PRECONDITION', `err=${rItems.errStatus}`);

  const idPaid = await mkOrder('DELIVERED');
  const rPaid = await call('orderUpdate', owner, { orderId: idPaid, data: { notes: 'x' } });
  check('7c. editar post-pago/terminal → failed-precondition', rPaid.errStatus === 'FAILED_PRECONDITION', `err=${rPaid.errStatus}`);
}

// 8. Confirmación manual: PENDING_VERIFICATION → PAID vía confirmPayment REAL
{
  const id = await mkOrder('PENDING_VERIFICATION');
  const r = await call('orderUpdateStatus', seller, { orderId: id, to: 'PAID' });
  const doc8 = await orderDoc(id);
  const sess = (await db.doc(`tenants/${T}/customers/595990009999/sessions/active`).get()).data();
  const purchase = (await db.doc(`tenants/${T}/businessEvents/purchase-${id}`).get()).exists;
  const aPaid = await auditFor('payment.confirmed', id);
  const aManual = await auditFor('order.payment_confirmed_manual', id);
  check('8. seller confirma pago → flujo confirmPayment completo (paidAt + sesión + Purchase + 2 audits)',
    r.result?.ok === true && doc8?.status === 'PAID' && doc8?.payment?.paidAt && sess?.state === 'CHECKOUT_DONE' && purchase && aPaid.length === 1 && aManual.length === 1,
    `status=${doc8?.status} purchase=${purchase} audits=${aPaid.length}/${aManual.length}`);
}

// 9. Cadena forward + retrocesos
{
  const id = await mkOrder('PAID');
  let ok = true;
  for (const to of ['PREPARING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED']) {
    const r = await call('orderUpdateStatus', seller, { orderId: id, to });
    if (r.result?.ok !== true) { ok = false; break; }
  }
  const doc9 = await orderDoc(id);
  const audits9 = await auditFor('order.status_changed', id);
  check('9a. PAID→PREPARING→ASSIGNED→IN_TRANSIT→DELIVERED por seller → ok + 4 audits',
    ok && doc9?.status === 'DELIVERED' && audits9.length === 4, `status=${doc9?.status} audits=${audits9.length}`);

  const rBack = await call('orderUpdateStatus', seller, { orderId: id, to: 'PAID' });
  check('9b. retroceso DELIVERED→PAID → failed-precondition', rBack.errStatus === 'FAILED_PRECONDITION', `err=${rBack.errStatus}`);

  const id2 = await mkOrder('PAID');
  const rCancelVia = await call('orderUpdateStatus', owner, { orderId: id2, to: 'CANCELLED' });
  check('9c. CANCELLED vía updateStatus → bloqueado (va por orderCancel)', rCancelVia.errStatus === 'FAILED_PRECONDITION', `err=${rCancelVia.errStatus}`);
}

// 10. adminOrderCorrect: solo PLATFORM_ADMIN, motivo obligatorio, audit before/after
{
  const id = await mkOrder('DELIVERED');
  const rOwner = await call('adminOrderCorrect', owner, { tenantId: T, orderId: id, reason: 'no soy admin', set: { status: 'PAID' } });
  check('10a. owner NO puede corregir (permission-denied)', rOwner.errStatus === 'PERMISSION_DENIED', `err=${rOwner.errStatus}`);

  const rNoReason = await call('adminOrderCorrect', admin, { tenantId: T, orderId: id, set: { status: 'REFUNDED' } });
  check('10b. admin sin motivo → invalid-argument', rNoReason.errStatus === 'INVALID_ARGUMENT', `err=${rNoReason.errStatus}`);

  const rOk = await call('adminOrderCorrect', admin, { tenantId: T, orderId: id, reason: 'reembolso acordado con la clienta', set: { status: 'REFUNDED' } });
  const doc10 = await orderDoc(id);
  const audits10 = await auditFor('order.admin_corrected', id);
  const meta = audits10[0]?.metadata ?? {};
  check('10c. admin corrige DELIVERED→REFUNDED con motivo → ok + audit before/after',
    rOk.result?.ok === true && doc10?.status === 'REFUNDED' && audits10.length === 1 && meta.before?.status === 'DELIVERED' && meta.after?.status === 'REFUNDED' && !!meta.reason,
    `status=${doc10?.status} before=${meta.before?.status} after=${meta.after?.status}`);
}

// ---- Limpieza: borrar órdenes sintéticas + sesión + eventos de prueba (Admin SDK) ----
for (const id of createdOrders) {
  await db.doc(`tenants/${T}/orders/${id}`).delete().catch(() => {});
  await db.doc(`tenants/${T}/businessEvents/purchase-${id}`).delete().catch(() => {});
}
await db.doc(`tenants/${T}/customers/595990009999/sessions/active`).delete().catch(() => {});
await db.doc(`tenants/${T}/customers/595990009999`).delete().catch(() => {});

const ok = results.every(Boolean);
console.log(`\nRESULTADO ORDER-1 (ciclo de vida de pedidos): ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
