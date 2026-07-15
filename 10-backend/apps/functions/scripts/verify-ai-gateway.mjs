/**
 * verify-ai-gateway.mjs — Sales agent de Claude Haiku en el bot real (AG-3).
 * Maneja al bot por el webhook real (metaWebhook → handleMessage) en modo MOCK. NUNCA llama a
 * api.anthropic.com: en el emulador el cliente de IA es SIEMPRE el Fake (lee aiTestFixtures/ai).
 * Cubre la matriz de AG-3:
 *   1. feature off (plan free) → fallback rule-based (no usa la IA aunque haya fixture).
 *   2. IA habilitada (plan starter) + fixture → la respuesta del bot es la del modelo (fake).
 *   3. aiRequests 'ok' → registra modelo/tokens/costo SIN prompt ni PII.
 *   4. fixture fail (Claude falla) → fallback rule-based.
 *   5. aiRequests 'error' → registra errorCode SIN prompt.
 *   6. presupuesto excedido (aiTokens sobre el límite) → fallback rule-based.
 *   7/8/9. reglas de aiRequests: vendedor 403, dueña 200, escritura de cliente 403.
 *
 * El caché de entitlements (30s, in-process en functions) se sortea reenviando el probe en un poll:
 * cada reenvío re-evalúa el plan; en frío resuelve al primer intento, en caliente espera ≤30s.
 *
 * Requiere el emulador (auth+firestore+functions) y los usuarios sembrados (seed-users) de perfumeria.
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
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';

const T = 'perfumeria';
const PNID = 'wa-ai-1';
const FIX = 'aiTestFixtures/ai';
const AI_MARK = '[fixture-ai]';
const FALLBACK_MARK = 'Puedo ayudarte a encontrar'; // texto del fallback rule-based del engine
const GREETING = 'hola';
const PROBE = '¿hacen envíos al interior del país?'; // cae al fallback del engine → elegible para IA

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const restGet = async (token, path) => (await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } })).status;

const waPayload = (from, body, mid) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: from, profile: { name: 'Test AI' } }],
    messages: [{ from, id: mid, timestamp: '1716750000', type: 'text', text: { body } }],
  } }] }],
});
let midSeq = 0;
const postMsg = (from, body) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(waPayload(from, body, `wamid.AI-${from}-${++midSeq}`)) });

/** Última respuesta saliente (bot) del cliente, o null. */
async function lastOut(from) {
  const cid = from.replace(/[^0-9]/g, '');
  const snap = await db.collection(`tenants/${T}/customers/${cid}/messages`).get();
  const outs = snap.docs.map((d) => d.data()).filter((m) => m.direction === 'out').sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  return outs.length ? outs[outs.length - 1].text : null;
}

/**
 * Saluda (1 vez) y reenvía el PROBE hasta que la última respuesta del bot cumpla `pred` (o timeout).
 * El reenvío re-evalúa el plan en cada intento → sortea el caché de entitlements de 30s.
 */
async function probeUntil(from, pred, maxMs = 42_000) {
  await postMsg(from, GREETING);
  for (let i = 0; i < 16; i++) { if (await lastOut(from)) break; await sleep(500); } // espera el saludo
  const end = Date.now() + maxMs;
  let txt = null;
  while (Date.now() < end) {
    await postMsg(from, PROBE);
    for (let i = 0; i < 6; i++) { txt = await lastOut(from); if (txt && pred(txt)) return txt; await sleep(700); }
    await sleep(1200);
  }
  return txt;
}

async function setPlan(planId) {
  await db.doc(`tenants/${T}`).set({
    planId,
    subscription: { status: 'active', currentPeriodStart: Timestamp.now() },
    usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: Timestamp.now() },
  }, { merge: true });
}
const setFixture = (data) => db.doc(FIX).set(data);

// ---- Snapshot para restaurar perfumeria al final (modo convivencia) ----
const before = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const testStart = Timestamp.now();

// ---- Ruteo del webhook a perfumeria + bot ON, modo MOCK (sin envío real) ----
const now = Timestamp.now();
const oldAssets = await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
for (const d of oldAssets.docs) await d.ref.delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ id: PNID, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: 'wa-ai', status: 'active', selected: true, createdAt: now, updatedAt: now });
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: now });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot AI' }, { merge: true });

const customers = [];
const fresh = (n) => { const f = `59599100${String(n).padStart(4, '0')}`; customers.push(f); return f; };

// === 1. feature off (free) → fallback (aunque exista fixture de IA) ===
await setFixture({ text: `respuesta IA que NO debe verse ${AI_MARK}` });
await setPlan('free');
const r1 = await probeUntil(fresh(1), (t) => t.includes(FALLBACK_MARK));
check('1. plan free (aiAssistant off) → fallback rule-based, NO usa la IA', !!r1 && r1.includes(FALLBACK_MARK) && !r1.includes(AI_MARK), JSON.stringify(r1));

// === 2. IA habilitada (starter) + fixture → responde el modelo (fake) ===
await setPlan('starter');
await setFixture({ text: `¡Sí! Enviamos a todo el país 🚚 ${AI_MARK}` });
const r2 = await probeUntil(fresh(2), (t) => t.includes(AI_MARK));
check('2. plan starter + fixture → la respuesta del bot es la del modelo (fake)', !!r2 && r2.includes(AI_MARK), JSON.stringify(r2));

// === 3. aiRequests 'ok' → metadatos (modelo/tokens/costo) SIN prompt ni PII ===
const okSnap = await db.collection(`tenants/${T}/aiRequests`).where('status', '==', 'ok').get();
const okDoc = okSnap.docs.map((d) => d.data())[0];
const keys = okDoc ? Object.keys(okDoc) : [];
const SENSITIVE = ['prompt', 'prompts', 'messages', 'message', 'system', 'content', 'payload', 'text', 'body', 'pii']; // 'context' (= nombre del contexto) es metadato OK
const noPromptKeys = !keys.some((k) => SENSITIVE.includes(k.toLowerCase()));
const noProbeLeak = okDoc ? !JSON.stringify(okDoc).includes('envíos al interior') && !JSON.stringify(okDoc).includes(AI_MARK) : false;
check('3. aiRequests ok → registra modelo/tokens/costo SIN prompt ni PII',
  !!okDoc && okDoc.model === 'claude-haiku-4-5-20251001' && typeof okDoc.inputTokens === 'number' && typeof okDoc.costUsd === 'number' && noPromptKeys && noProbeLeak,
  `keys=${keys.join(',')}`);

// === 4. fixture fail (Claude falla) → fallback ===
await setFixture({ fail: true, failMessage: 'fixture: fallo simulado' });
const r4 = await probeUntil(fresh(4), (t) => t.includes(FALLBACK_MARK), 18_000);
check('4. Claude falla → fallback rule-based (el bot nunca queda mudo)', !!r4 && r4.includes(FALLBACK_MARK), JSON.stringify(r4));

// === 5. aiRequests 'error' → errorCode SIN prompt ===
const errSnap = await db.collection(`tenants/${T}/aiRequests`).where('status', '==', 'error').get();
const errDoc = errSnap.docs.map((d) => d.data())[0];
const errNoLeak = errDoc ? !JSON.stringify(errDoc).includes('fallo simulado') && !JSON.stringify(errDoc).includes('envíos al interior') : false;
check('5. aiRequests error → registra errorCode SIN cuerpo del error ni prompt',
  !!errDoc && typeof errDoc.errorCode === 'string' && errDoc.errorCode.length > 0 && errNoLeak, JSON.stringify(errDoc));

// === 6. presupuesto excedido → derivación honesta (AI-FALLBACK-HONESTO-1) ===
// Este script no configura vendedores reales (checkout queda en placeholder), así que la
// respuesta honesta esperada es el mensaje temporal SIN promesa de pase — nunca el fallback
// genérico ni la IA.
await setFixture({ text: `respuesta IA bloqueada por presupuesto ${AI_MARK}` });
await db.doc(`tenants/${T}`).set({ usage: { aiTokensThisMonth: 999_999, currentPeriodStart: Timestamp.now() } }, { merge: true });
const r6 = await probeUntil(fresh(6), (t) => t.includes('no puedo completar esta consulta'), 18_000);
check('6. presupuesto de IA excedido → respuesta honesta de IA-no-disponible (sin IA, sin promesa de pase)',
  !!r6 && r6.includes('no puedo completar esta consulta') && !r6.includes(AI_MARK) && !/te paso con/i.test(r6),
  JSON.stringify(r6));

// === 7/8/9. Reglas de aiRequests (con auth real, vía REST) ===
const anyDocId = okSnap.docs[0]?.id ?? errSnap.docs[0]?.id;
const seller = await signIn('seller@perfumeria.com');
const owner = await signIn('owner@perfumeria.com');
check('7. vendedor NO lee aiRequests (403) — contiene costos', anyDocId ? (await restGet(seller, `tenants/${T}/aiRequests/${anyDocId}`)) === 403 : false);
check('8. dueña SÍ lee aiRequests (200)', anyDocId ? (await restGet(owner, `tenants/${T}/aiRequests/${anyDocId}`)) === 200 : false);
const writeStatus = (await fetch(`${FS}/tenants/${T}/aiRequests?documentId=hack-${Date.now()}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` },
  body: JSON.stringify({ fields: { status: { stringValue: 'ok' } } }),
})).status;
check('9. escritura de cliente a aiRequests bloqueada (no 200)', writeStatus !== 200, `status=${writeStatus}`);

// ============================================================================
// AG-3B — recomendaciones de la IA ↔ estado conversacional (lastShownSkus)
// ============================================================================
async function sessionDoc(from) {
  const cid = from.replace(/[^0-9]/g, '');
  const snap = await db.collection(`tenants/${T}/customers/${cid}/sessions`).get();
  return snap.docs[0]?.data() ?? null;
}
const shownOf = async (from) => (await sessionDoc(from))?.context?.lastShownSkus ?? [];
/** Envía UN mensaje (turno transaccional/determinista) y espera la respuesta del bot. */
async function sendOnceAndPoll(from, body, pred, maxMs = 10_000) {
  await postMsg(from, body);
  const end = Date.now() + maxMs;
  let txt = null;
  while (Date.now() < end) { txt = await lastOut(from); if (txt && pred(txt)) return txt; await sleep(600); }
  return txt;
}
/** Fixture de 2 rondas: el modelo llama buscar_productos y luego responde con texto. */
const showFixture = (marker, input = {}) => setFixture({ responses: [
  { toolUses: [{ id: 'tu1', name: 'buscar_productos', input }] },
  { text: `Te muestro estas opciones ✨ ${marker}` },
] });

// Habilitar IA con presupuesto disponible y conocer el catálogo real de perfumeria.
await db.doc(`tenants/${T}`).set({ usage: { aiTokensThisMonth: 0, messagesThisMonth: 0, currentPeriodStart: Timestamp.now() } }, { merge: true });
const catSnap = await db.collection(`tenants/${T}/products`).get();
const catIds = catSnap.docs.map((d) => d.id);
const prodName = (id) => catSnap.docs.find((d) => d.id === id)?.data()?.name ?? null;
// Producto de OTRO tenant (boutique) para el caso cross-tenant.
const XTEN = 'XTEN-BOUTIQUE-1';
await db.doc(`tenants/boutique-demo/products/${XTEN}`).set({ id: XTEN, tenantId: 'boutique-demo', name: 'Cross Tenant Test', price: 1000, currency: 'PYG', status: 'ACTIVE', inventory: { stock: 5 }, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });

// === 10. IA usa buscar_productos → lastShownSkus actualizado con productos REALES del tenant ===
await showFixture(AI_MARK);
const c10 = fresh(10);
const r10 = await probeUntil(c10, (t) => t.includes(AI_MARK), 18_000);
const sk10 = await shownOf(c10);
check('10. IA usa buscar_productos → lastShownSkus = productos reales del tenant (del backend, no del texto)',
  !!r10 && r10.includes(AI_MARK) && sk10.length > 0 && sk10.every((id) => catIds.includes(id)),
  `shown=${JSON.stringify(sk10)} cat=${JSON.stringify(catIds)}`);

// === 11. "el primero" → el motor rule-based selecciona el producto correcto y lo agrega ===
const firstId = sk10[0];
const firstName = prodName(firstId);
const r11 = await sendOnceAndPoll(c10, 'el primero', (t) => t.includes('Agregué'));
const cart11 = (await sessionDoc(c10))?.cart;
check('11. "el primero" → selección rule-based correcta + carrito con 1 ítem (= primer SKU mostrado)',
  !!r11 && (firstName ? r11.includes(firstName) : true) && cart11?.items?.length === 1 && cart11.items[0]?.productId === firstId,
  `reply=${JSON.stringify(r11)} firstId=${firstId} cart=${JSON.stringify(cart11?.items)}`);

// === 12. Injection: el modelo inventa un SKU en el texto (sin tool) → NO entra ===
await setFixture({ text: `Te recomiendo el producto SKU-FAKE-999 ✨ ${AI_MARK}` });
const c12 = fresh(12);
const r12 = await probeUntil(c12, (t) => t.includes(AI_MARK), 18_000);
const sk12 = await shownOf(c12);
check('12. injection: SKU inventado por el modelo NO entra a lastShownSkus (solo del backend)',
  !!r12 && r12.includes('SKU-FAKE-999') && !sk12.includes('SKU-FAKE-999') && sk12.length === 0,
  `reply=${JSON.stringify(r12)} shown=${JSON.stringify(sk12)}`);

// === 13. Cross-tenant: el producto de boutique NUNCA entra al estado de perfumeria ===
await showFixture(AI_MARK);
const c13 = fresh(13);
const r13 = await probeUntil(c13, (t) => t.includes(AI_MARK), 18_000);
const sk13 = await shownOf(c13);
check('13. cross-tenant: producto de otro tenant (boutique) NO entra; todo SKU ∈ catálogo de perfumeria',
  !!r13 && sk13.length > 0 && !sk13.includes(XTEN) && sk13.every((id) => catIds.includes(id)),
  `shown=${JSON.stringify(sk13)} XTEN=${XTEN}`);

// === 14. Tool sin resultados → NO pisa lastShownSkus (conserva la lista previa) ===
const c14 = fresh(14);
await showFixture('[shown-a]');
await probeUntil(c14, (t) => t.includes('[shown-a]'), 18_000);
const before14 = await shownOf(c14);
await setFixture({ responses: [
  { toolUses: [{ id: 'tu', name: 'buscar_productos', input: { precioMax: 1 } }] }, // precio absurdo → 0 resultados
  { text: 'no encontré nada bajo ese precio ✨ [empty-b]' },
] });
await probeUntil(c14, (t) => t.includes('[empty-b]'), 18_000);
const after14 = await shownOf(c14);
check('14. buscar_productos sin resultados → NO pisa lastShownSkus (conserva la lista previa)',
  before14.length > 0 && JSON.stringify(after14) === JSON.stringify(before14),
  `before=${JSON.stringify(before14)} after=${JSON.stringify(after14)}`);

// ---- Limpieza: borrar test data y restaurar perfumeria como estaba ----
await db.doc(`tenants/boutique-demo/products/${XTEN}`).delete().catch(() => {});
for (const from of customers) {
  const cid = from.replace(/[^0-9]/g, '');
  for (const m of (await db.collection(`tenants/${T}/customers/${cid}/messages`).get()).docs) await m.ref.delete();
  for (const s of (await db.collection(`tenants/${T}/customers/${cid}/sessions`).get()).docs) await s.ref.delete();
  await db.doc(`tenants/${T}/customers/${cid}`).delete().catch(() => {});
}
for (const d of (await db.collection(`tenants/${T}/aiRequests`).where('createdAt', '>=', testStart).get()).docs) await d.ref.delete().catch(() => {});
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete().catch(() => {});
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete().catch(() => {});
await db.doc(FIX).delete().catch(() => {});
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete().catch(() => {});
if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent); else await db.doc(`tenants/${T}/config/agent`).delete().catch(() => {});
await db.doc(`tenants/${T}`).set({
  planId: before.planId ?? 'free',
  subscription: before.subscription ?? FieldValue.delete(),
  usage: before.usage ?? FieldValue.delete(),
}, { merge: true });

// Settle: este script mutó el plan de perfumeria (free↔starter). El caché de entitlements del proceso
// de functions (30s) podría seguir sirviendo 'starter' y contaminar la regresión siguiente (p.ej.
// fase4 caso 6 asume perfumeria en su plan sembrado). Esperamos a que expire → suite order-independent.
await sleep(31_000);

// Limpiar las notifications de handoff generadas por el check 6 (AI-FALLBACK-HONESTO-1) para
// no contaminar los conteos de los verifies que corren después en la misma sesión de emulador.
{
  const notifs = await db.collection(`tenants/${T}/notifications`).get();
  for (const d of notifs.docs) { if ((d.data().category ?? '') === 'handoff') await d.ref.delete().catch(() => {}); }
}

const ok = results.every((x) => x);
console.log(`\nRESULTADO AG-3/AG-3B (sales agent + lastShownSkus): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
