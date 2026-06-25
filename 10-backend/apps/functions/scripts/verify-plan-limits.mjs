/**
 * verify-plan-limits.mjs — Gates de bloqueo por plan (PLAN-LIMITS-3A).
 * Part A: límite de órdenes (`orders`) en el flujo "pagar" del bot (webhook real, fake AI/Graph).
 * Part B: conteo real de números de WhatsApp (`whatsappNumbers`) en el connect (Graph fake por fixture).
 * NUNCA llama a Anthropic/Graph real. perfumeria se fija a `free` (maxOrders=50, maxWhatsappNumbers=1)
 * con settle del caché de entitlements (30s) → determinista. Restaura perfumeria al final.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
const OTHER = 'boutique-demo';
const PNID = 'wa-pl-1';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, idToken) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}
const setFixture = (fx) => db.doc('metaTestFixtures/graph').set(fx);
const ordersCount = async (t) => (await db.collection(`tenants/${t}/orders`).get()).size;
const ordersUsage = async (t) => (await db.doc(`tenants/${t}`).get()).data()?.usage?.ordersThisMonth ?? 0;
const lastOut = async (cid) => {
  const snap = await db.collection(`tenants/${T}/customers/${cid}/messages`).get();
  const outs = snap.docs.map((d) => d.data()).filter((m) => m.direction === 'out').sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  return outs.length ? outs[outs.length - 1].text : null;
};
const waPayload = (from, body, mid) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, contacts: [{ wa_id: from, profile: { name: 'PL' } }], messages: [{ from, id: mid, timestamp: '1716750000', type: 'text', text: { body } }] } }] }] });
// messageId único por corrida: metaWebhook deduplica por (platform, messageId) con un doc
// determinístico en `inbox` que NO se limpia entre corridas. Sin el nonce de corrida, la 2da
// corrida reusaría el wamid de la 1ra → metaWebhook lo descarta como duplicado → el bot nunca
// procesa el "pagar" (falso negativo). El nonce garantiza un wamid nuevo en cada ejecución.
const RUN = Date.now();
let midSeq = 0;
const postMsg = (from, body) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(waPayload(from, body, `wamid.PL-${from}-${RUN}-${++midSeq}`)) });

// ---- Snapshot + fijar perfumeria a free (determinista) + settle ----
const before = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const owner = await signIn('owner@perfumeria.com');
await db.doc(`tenants/${T}`).set({ planId: 'free', subscription: FieldValue.delete(), usage: { ordersThisMonth: 0, messagesThisMonth: 0, currentPeriodStart: Timestamp.now() } }, { merge: true });
console.log('→ settle del caché de entitlements (30s)…');
await sleep(31_000);

// ============================ PART A — ORDERS ============================
// Ruteo del webhook a perfumeria (mock send) + bot ON.
const now = Timestamp.now();
const oldAssets = await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
for (const d of oldAssets.docs) await d.ref.delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ id: PNID, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: 'wa-pl', status: 'active', selected: true, createdAt: now, updatedAt: now });
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: now });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola PL' }, { merge: true });

const CID = '595990123001';
const seedCart = async () => db.doc(`tenants/${T}/customers/${CID}/sessions/active`).set({
  id: 'active', tenantId: T, customerId: CID, state: 'CART',
  cart: { items: [{ productId: 'lattafa-yara', name: 'Yara', price: 180000, quantity: 1, imageUrl: '' }], subtotal: 180000 },
  context: { lastMessageAt: now, currentPage: 0, currentCategoryId: null, pendingOrderId: null, pendingPaymentId: null, lastShownSkus: [], humanTakeover: false },
  expiresAt: Timestamp.fromMillis(now.toMillis() + 86_400_000), updatedAt: now,
});

// usage justo debajo del límite free trial (maxOrdersPerMonth=10): ordersThisMonth=9 → 1 orden entra, la 2da no.
await db.doc(`tenants/${T}`).set({ usage: { ordersThisMonth: 9, messagesThisMonth: 0, currentPeriodStart: Timestamp.now() } }, { merge: true });
await seedCart();
const ordersBefore = await ordersCount(T);
await postMsg(CID, 'pagar');
let r1 = null; for (let i = 0; i < 18; i++) { r1 = await lastOut(CID); if (r1 && /transferencia|transferí|datos para|Total/i.test(r1)) break; await sleep(700); }
const ordersAfter1 = await ordersCount(T);
const usageAfter1 = await ordersUsage(T);
check('1. dentro del límite → crea la orden + mide (ordersThisMonth 9→10)',
  ordersAfter1 === ordersBefore + 1 && usageAfter1 === 10, `orders ${ordersBefore}→${ordersAfter1} usage=${usageAfter1}`);

// 2da orden: ahora ordersThisMonth=10 (al tope del free trial) → bloqueada.
await postMsg(CID, 'pagar');
let r2 = null; for (let i = 0; i < 18; i++) { r2 = await lastOut(CID); if (r2 && /asesor/i.test(r2)) break; await sleep(700); }
const ordersAfter2 = await ordersCount(T);
const usageAfter2 = await ordersUsage(T);
const safeReply = !!r2 && /asesor/i.test(r2) && !/plan|cupo|límite|super/i.test(r2);
check('2. sobre el límite → NO crea orden, NO incrementa usage, mensaje SEGURO al cliente',
  ordersAfter2 === ordersAfter1 && usageAfter2 === 10 && safeReply, `orders=${ordersAfter2} usage=${usageAfter2} reply=${JSON.stringify(r2)}`);

// ============================ PART B — WHATSAPP NUMBERS ============================
const WABA = 'waba-pl-1';
const PH1 = 'wa-pl-num-1';
const PH2 = 'wa-pl-num-2';
const phone = (id, num) => ({ id, displayPhoneNumber: num, verifiedName: 'Perf', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED' });
const FIX = (phones) => ({ accessToken: 'EAA-pl', isValid: true, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], wabaIds: [WABA], tokenExpiresAtMs: Date.now() + 3_600_000, phoneNumbers: phones });

// 4. Primer número permitido (free=1, WABA con 1 número → ok).
await setFixture(FIX([phone(PH1, '+595 981 111000')]));
const start1 = await callFn('startMetaConnect', {}, owner);
const con1 = await callFn('connectMeta', { nonce: start1.result?.nonce, code: 'c', wabaId: WABA, phoneNumberId: PH1, businessId: 'biz-pl' }, owner);
check('4. WhatsApp: primer número permitido (free=1, 1 número) → status active', con1.status === 200 && con1.result?.status === 'active', JSON.stringify(con1.result ?? con1.error));

// 5. Re-CONECTAR el mismo WABA (1 número) → permitido, conteo idempotente (gate allow-path).
const reStart = await callFn('startMetaConnect', {}, owner);
const reconn = await callFn('connectMeta', { nonce: reStart.result?.nonce, code: 'c', wabaId: WABA, phoneNumberId: PH1, businessId: 'biz-pl' }, owner);
const numsReconn = (await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get()).size;
check('5. re-conectar el MISMO WABA (1 número) → permitido + conteo idempotente (sigue en 1)',
  reconn.status === 200 && reconn.result?.status === 'active' && numsReconn === 1, `status=${reconn.status} nums=${numsReconn}`);

// 5b. Re-seleccionar el mismo número → ok y queda seleccionado (no agrega assets, no consume cupo).
const sel = await callFn('selectMetaPhoneNumber', { phoneNumberId: PH1 }, owner);
const selAsset = (await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get()).docs.find((d) => d.data().externalId === PH1)?.data();
check('5b. re-seleccionar el mismo número → ok y queda seleccionado (sin agregar assets)', sel.status === 200 && selAsset?.selected === true, `status=${sel.status} selected=${selAsset?.selected}`);

// 6. Conectar un WABA con 2 números en free (=1) → falla failed-precondition; no rompe la conexión previa.
await setFixture(FIX([phone(PH1, '+595 981 111000'), phone(PH2, '+595 981 222000')]));
const start2 = await callFn('startMetaConnect', {}, owner);
const con2 = await callFn('connectMeta', { nonce: start2.result?.nonce, code: 'c', wabaId: WABA, phoneNumberId: PH1, businessId: 'biz-pl' }, owner);
const connStill = (await db.doc(`tenants/${T}/metaConnections/main`).get()).data();
check('6. número nuevo por encima del límite → failed-precondition (400) y conexión previa intacta',
  con2.status === 400 && con2.error?.status === 'FAILED_PRECONDITION' && connStill?.status === 'active', `status=${con2.status} err=${con2.error?.status} conn=${connStill?.status}`);

// 7. Cross-tenant: los números de perfumeria NO cuentan para boutique (conteo tenant-scoped).
const perfNums = (await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get()).docs.map((d) => d.id);
const otherNums = (await db.collection(`tenants/${OTHER}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get()).docs.map((d) => d.id);
check('7. cross-tenant: el número de perfumeria no aparece en boutique (conteos no se mezclan)',
  perfNums.includes(PH1) && !otherNums.includes(PH1), `perf=[${perfNums}] other=[${otherNums}]`);

// ---- Limpieza + restaurar perfumeria + settle ----
await callFn('metaDisconnect', {}, owner).catch(() => {});
await db.doc('metaTestFixtures/graph').delete().catch(() => {});
for (const m of (await db.collection(`tenants/${T}/customers/${CID}/messages`).get()).docs) await m.ref.delete();
for (const s of (await db.collection(`tenants/${T}/customers/${CID}/sessions`).get()).docs) await s.ref.delete();
await db.doc(`tenants/${T}/customers/${CID}`).delete().catch(() => {});
for (const o of (await db.collection(`tenants/${T}/orders`).get()).docs) await o.ref.delete().catch(() => {});
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete().catch(() => {});
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete().catch(() => {});
await db.doc(`tenants/${T}/config/channels`).delete().catch(() => {});
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true }, { merge: true });
await db.doc(`tenants/${T}`).set({ planId: before.planId ?? 'free', subscription: before.subscription ?? FieldValue.delete(), usage: before.usage ?? FieldValue.delete() }, { merge: true });
await sleep(31_000); // settle: no contaminar las regresiones siguientes

const ok = results.every((x) => x);
console.log(`\nRESULTADO PLAN-LIMITS-3A (gates orders + whatsappNumbers): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
