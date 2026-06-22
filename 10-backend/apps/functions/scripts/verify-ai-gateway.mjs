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
  !!okDoc && okDoc.model === 'claude-haiku-4-5' && typeof okDoc.inputTokens === 'number' && typeof okDoc.costUsd === 'number' && noPromptKeys && noProbeLeak,
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

// === 6. presupuesto excedido (aiTokens sobre el límite) → fallback ===
await setFixture({ text: `respuesta IA bloqueada por presupuesto ${AI_MARK}` });
await db.doc(`tenants/${T}`).set({ usage: { aiTokensThisMonth: 999_999, currentPeriodStart: Timestamp.now() } }, { merge: true });
const r6 = await probeUntil(fresh(6), (t) => t.includes(FALLBACK_MARK), 18_000);
check('6. presupuesto de IA excedido → fallback rule-based', !!r6 && r6.includes(FALLBACK_MARK) && !r6.includes(AI_MARK), JSON.stringify(r6));

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

// ---- Limpieza: borrar test data y restaurar perfumeria como estaba ----
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

const ok = results.every((x) => x);
console.log(`\nRESULTADO AG-3 (sales agent Claude Haiku en el bot real): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
