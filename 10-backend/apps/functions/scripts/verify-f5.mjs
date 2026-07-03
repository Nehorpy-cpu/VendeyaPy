/**
 * verify-f5.mjs — WHATSAPP-AGENT-F5 IDEMPOTENT-CHECKOUT end-to-end (emulador).
 * El bug real: "Para pagar cual es" 17 s después de "quiero pagar" duplicó la orden.
 *  1. agregar → "quiero pagar" crea la orden A.
 *  2. "Para pagar cual es" → REENVÍA la orden A (misma id, sin duplicar).
 *  3. "quiero pagar" de nuevo → sigue una sola orden.
 *  4. puntero pendingOrderId PERDIDO → reusa la PENDING_PAYMENT reciente y repara el puntero.
 *  5. orden en PENDING_VERIFICATION → "comprobante en revisión", sin crear.
 *  6. orden PAID → "ya figura pagado", sin crear.
 *  7. orden CANCELLED → un nuevo "pagar" SÍ crea una orden nueva.
 *  8. carrito CAMBIADO → orden nueva con aviso.
 *
 * Requiere: emulador (auth+firestore+functions) + seed-users + load-catalog (tenant perfumeria).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const T = 'perfumeria';
const PNID = 'wa-f5-1';
const CUST = '595993800001';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mid = 0;
const postMsg = (body) => fetch(`${BASE}/metaWebhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: CUST, profile: { name: 'Test F5' } }],
    messages: [{ from: CUST, id: `wamid.F5-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }],
  } }] }] }),
});
async function lastOut() {
  const snap = await db.collection(`tenants/${T}/customers/${CUST}/messages`).get();
  const outs = snap.docs.map((d) => d.data()).filter((m) => m.direction === 'out').sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  return outs.length ? outs[outs.length - 1].text : null;
}
const session = async () => (await db.doc(`tenants/${T}/customers/${CUST}/sessions/active`).get()).data();
const orderIds = async () => (await db.collection(`tenants/${T}/orders`).where('customerId', '==', CUST).get()).docs.map((d) => d.id);
async function sendAndWait(body, pred, maxMs = 15000) {
  const prev = await lastOut();
  await postMsg(body);
  const end = Date.now() + maxMs;
  let txt = null;
  while (Date.now() < end) { txt = await lastOut(); if (txt && txt !== prev && pred(txt)) return txt; await sleep(600); }
  return txt;
}

// ---- Snapshot + setup (convivencia) ----
const before = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const now = Timestamp.now();
const oldAssets = await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
const oldAssetDocs = oldAssets.docs.map((d) => ({ id: d.id, data: d.data() }));
for (const d of oldAssets.docs) await d.ref.delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ id: PNID, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: 'wa-f5', status: 'active', selected: true, createdAt: now, updatedAt: now });
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: now });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot F5' }, { merge: true });
await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: now },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now },
}, { merge: true });

// ===== 1. Flujo: agregar → pagar crea la orden A =====
await postMsg('hola');
for (let i = 0; i < 16; i++) { if (await lastOut()) break; await sleep(500); }
await sendAndWait('agregá la belle', (t) => t.includes('Agregué'));
await sendAndWait('quiero pagar', (t) => t.includes('transferir'));
const idsA = await orderIds();
const orderA = (await session())?.context?.pendingOrderId;
check('1. "quiero pagar" creó UNA orden', idsA.length === 1 && idsA[0] === orderA, `orders=${idsA.length} A=${orderA}`);

// ===== 2. BUG REAL: "Para pagar cual es" reenvía, NO duplica =====
const t2 = await sendAndWait('Para pagar cual es', (t) => t.includes('transferir'));
const ids2 = await orderIds();
check('2. "Para pagar cual es" → REENVÍA la misma orden (sin duplicar) con aviso de pendiente',
  ids2.length === 1 && (await session())?.context?.pendingOrderId === orderA && t2.includes('pedido pendiente'),
  `orders=${ids2.length}`);

// ===== 3. "quiero pagar" repetido → sigue una sola =====
await sendAndWait('quiero pagar', (t) => t.includes('transferir'));
check('3. "quiero pagar" repetido → sigue habiendo UNA sola orden', (await orderIds()).length === 1);

// ===== 4. Puntero perdido → reusa y repara =====
await db.doc(`tenants/${T}/customers/${CUST}/sessions/active`).set({ context: { pendingOrderId: null } }, { merge: true });
await sendAndWait('quiero pagar', (t) => t.includes('transferir'));
const ses4 = await session();
check('4. pendingOrderId PERDIDO → reusa la PENDING_PAYMENT reciente y REPARA el puntero',
  (await orderIds()).length === 1 && ses4?.context?.pendingOrderId === orderA, `ptr=${ses4?.context?.pendingOrderId}`);

// ===== 5. PENDING_VERIFICATION → en revisión, sin crear =====
await db.doc(`tenants/${T}/orders/${orderA}`).update({ status: 'PENDING_VERIFICATION' });
const t5 = await sendAndWait('quiero pagar', (t) => t.includes('revisión'));
check('5. orden PENDING_VERIFICATION → "comprobante en revisión", sin orden nueva',
  !!t5 && t5.includes('revisión') && (await orderIds()).length === 1, JSON.stringify((t5 ?? '').slice(0, 60)));

// ===== 6. PAID (mismo carrito) → ya figura pagado + LIMPIA puntero y carrito (sin deadlock) =====
await db.doc(`tenants/${T}/orders/${orderA}`).update({ status: 'PAID' });
const t6 = await sendAndWait('quiero pagar', (t) => t.includes('pagado'));
const ses6 = await session();
check('6. orden PAID → "ya figura pagado" + puntero y carrito LIMPIOS (review: sin loop de bloqueo)',
  !!t6 && t6.includes('pagado') && (await orderIds()).length === 1 &&
  (ses6?.context?.pendingOrderId ?? null) === null && (ses6?.cart?.items?.length ?? 0) === 0,
  `ptr=${ses6?.context?.pendingOrderId} cart=${ses6?.cart?.items?.length}`);

// ===== 7. Después del pagado, el cliente puede comprar de NUEVO =====
await sendAndWait('agregá la belle', (t) => t.includes('Agregué'));
const t7 = await sendAndWait('quiero pagar', (t) => t.includes('transferir'));
const ids7 = await orderIds();
const orderB = (await session())?.context?.pendingOrderId;
check('7. compra NUEVA después del pedido pagado → crea orden nueva (cliente nunca queda clavado)',
  !!t7 && ids7.length === 2 && orderB && orderB !== orderA, `B=${orderB}`);

// ===== 7b. CANCELLED → nuevo "pagar" SÍ crea =====
await db.doc(`tenants/${T}/orders/${orderB}`).update({ status: 'CANCELLED' });
const t7b = await sendAndWait('quiero pagar', (t) => t.includes('transferir'));
const ids7b = await orderIds();
const orderB2 = (await session())?.context?.pendingOrderId;
check('7b. orden CANCELLED → un nuevo "pagar" crea una orden NUEVA', !!t7b && ids7b.length === 3 && orderB2 !== orderB, `B2=${orderB2}`);

// ===== 8. Carrito CAMBIADO → nueva orden con aviso =====
await sendAndWait('agregá la belle', (t) => t.includes('Agregué')); // qty 1→2: carrito ≠ orden B2
const t8 = await sendAndWait('quiero pagar', (t) => t.includes('transferir'));
const ids8 = await orderIds();
const orderC = (await session())?.context?.pendingOrderId;
check('8. carrito cambiado → orden NUEVA con aviso "carrito cambió"',
  ids8.length === 4 && orderC !== orderB2 && t8.includes('carrito cambió'), `C=${orderC} n=${ids8.length}`);

// ---- Cleanup (convivencia) ----
for (const id of await orderIds()) {
  await db.doc(`tenants/${T}/orders/${id}`).delete();
  await db.doc(`tenants/${T}/orderFinancials/${id}`).delete().catch(() => {});
}
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete();
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete();
for (const d of oldAssetDocs) await db.doc(`tenants/${T}/metaAssets/${d.id}`).set(d.data);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();
if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent);
await db.doc(`tenants/${T}`).set(before);
for (const d of (await db.collection(`tenants/${T}/customers/${CUST}/messages`).get()).docs) await d.ref.delete();
await db.doc(`tenants/${T}/customers/${CUST}/sessions/active`).delete().catch(() => {});
await db.doc(`tenants/${T}/customers/${CUST}`).delete();

const ok = results.every(Boolean);
console.log(`\nRESULTADO F5 (checkout idempotente): ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
