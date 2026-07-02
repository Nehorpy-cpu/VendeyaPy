/**
 * verify-f1-grounding.mjs — WHATSAPP-AGENT-GROUNDING-F1 end-to-end (emulador).
 * Cubre los DOS caminos nuevos de F1 y que los fallbacks siguen intactos:
 *   1. Router angostado: un pedido genérico de compra ("quiero un perfume") ya NO lo captura el
 *      catálogo rule-based → se delega al sales agent IA (fixture).
 *   2. Rescate de catálogo vacío: pedido explícito de catálogo con filtro imposible (precio) →
 *      searchCatalog da 0 → en vez del canned "no encontré", responde la IA (fixture).
 *   3. Reglas intactas: "mostrame el catálogo" sin filtros → lista numerada rule-based (sin IA).
 *   4. IA caída (fixture fail) → el rescate degrada al canned "no encontré" (el bot nunca queda mudo).
 *
 * Requiere: emulador (auth+firestore+functions) + seed-users + load-catalog (tenant perfumeria).
 * Igual que verify-ai-gateway: el caché de entitlements (30s) se sortea reenviando el probe en un poll.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';

const T = 'perfumeria';
const PNID = 'wa-f1-1';
const FIX = 'aiTestFixtures/ai';
const AI_MARK = '[fixture-f1]';
const CANNED_EMPTY = 'no encontré algo que encaje';
const GREETING = 'hola';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waPayload = (from, body, mid) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: from, profile: { name: 'Test F1' } }],
    messages: [{ from, id: mid, timestamp: '1716750000', type: 'text', text: { body } }],
  } }] }],
});
let midSeq = 0;
const postMsg = (from, body) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(waPayload(from, body, `wamid.F1-${from}-${++midSeq}`)) });

async function lastOut(from) {
  const cid = from.replace(/[^0-9]/g, '');
  const snap = await db.collection(`tenants/${T}/customers/${cid}/messages`).get();
  const outs = snap.docs.map((d) => d.data()).filter((m) => m.direction === 'out').sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  return outs.length ? outs[outs.length - 1].text : null;
}

/** Saluda 1 vez y reenvía `body` hasta que la última respuesta cumpla `pred` (sortea caché 30s). */
async function probeUntil(from, body, pred, maxMs = 42_000) {
  await postMsg(from, GREETING);
  for (let i = 0; i < 16; i++) { if (await lastOut(from)) break; await sleep(500); }
  const end = Date.now() + maxMs;
  let txt = null;
  while (Date.now() < end) {
    await postMsg(from, body);
    for (let i = 0; i < 6; i++) { txt = await lastOut(from); if (txt && pred(txt)) return txt; await sleep(700); }
    await sleep(1200);
  }
  return txt;
}

const setFixture = (data) => db.doc(FIX).set(data);

// ---- Snapshot para restaurar perfumeria al final (modo convivencia) ----
const before = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;

// ---- Ruteo del webhook a perfumeria + bot ON, modo MOCK + plan starter (IA habilitada) ----
const now = Timestamp.now();
const oldAssets = await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
const oldAssetDocs = oldAssets.docs.map((d) => ({ id: d.id, data: d.data() }));
for (const d of oldAssets.docs) await d.ref.delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ id: PNID, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: 'wa-f1', status: 'active', selected: true, createdAt: now, updatedAt: now });
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: now });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot F1' }, { merge: true });
await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: now },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now },
}, { merge: true });

const customers = [];
const fresh = (n) => { const f = `59599200${String(n).padStart(4, '0')}`; customers.push(f); return f; };

// === 1. Router F1: pedido genérico → IA (antes lo capturaba el catálogo rule-based) ===
await setFixture({ text: `Tengo el perfume ideal para vos ✨ ${AI_MARK}` });
{
  const from = fresh(1);
  const txt = await probeUntil(from, 'quiero un perfume', (t) => t.includes(AI_MARK));
  check('1. "quiero un perfume" → responde la IA (router angostado delega)', !!txt && txt.includes(AI_MARK), JSON.stringify(txt));
}

// === 2. Rescate F1: catálogo explícito con 0 resultados → IA en vez del canned ===
{
  const from = fresh(2);
  const txt = await probeUntil(from, 'mostrame el catálogo hasta 1 mil', (t) => t.includes(AI_MARK));
  check('2. catálogo vacío (precio imposible) → responde la IA, no el canned "no encontré"', !!txt && txt.includes(AI_MARK) && !txt.includes(CANNED_EMPTY), JSON.stringify(txt));
}

// === 3. Reglas intactas: catálogo con resultados → lista numerada rule-based (sin IA) ===
{
  const from = fresh(3);
  const txt = await probeUntil(from, 'mostrame el catálogo', (t) => t.includes('Mirá, te elegí'));
  check('3. "mostrame el catálogo" → lista rule-based con productos reales (sin IA)', !!txt && txt.includes('Mirá, te elegí') && !txt.includes(AI_MARK), (txt ?? '').slice(0, 90));
}

// === 4. IA caída → el rescate de catálogo vacío degrada al canned (nunca mudo) ===
await setFixture({ fail: true, failMessage: 'fixture: fallo simulado F1' });
{
  const from = fresh(4);
  const txt = await probeUntil(from, 'mostrame el catálogo hasta 1 mil', (t) => t.includes(CANNED_EMPTY));
  check('4. catálogo vacío + IA caída → canned "no encontré" (fallback intacto)', !!txt && txt.includes(CANNED_EMPTY), JSON.stringify(txt));
}

// === 5. F1B: consulta con nombre → el producto consultado viene PRIMERO (pinning real) ===
const sessionDoc = async (from) => {
  const cid = from.replace(/[^0-9]/g, '');
  return (await db.doc(`tenants/${T}/customers/${cid}/sessions/active`).get()).data();
};
{
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-f1b', name: 'buscar_productos', input: { consulta: 'Good Girl' } }] },
    { text: `¡Sí, la tenemos! ✨ ${AI_MARK}` },
  ] });
  const from = fresh(5);
  const txt = await probeUntil(from, 'tienen la good girl?', (t) => t.includes(AI_MARK));
  const shown = (await sessionDoc(from))?.context?.lastShownSkus ?? [];
  check('5. F1B: consulta="Good Girl" → pinned primero en resultados (lastShownSkus[0])',
    !!txt && txt.includes(AI_MARK) && shown[0] === 'carolina-herrera-good-girl',
    `shown=${JSON.stringify(shown)}`);
}

// === 6. F1B: agregar por nombre PARCIAL (rule-based, sin nombre completo) ===
{
  const from = fresh(6);
  await postMsg(from, GREETING);
  for (let i = 0; i < 16; i++) { if (await lastOut(from)) break; await sleep(500); }
  await postMsg(from, 'agregá la belle');
  let txt = null;
  for (let i = 0; i < 20; i++) { txt = await lastOut(from); if (txt && txt.includes('Agregué')) break; await sleep(600); }
  check('6. F1B: "agregá la belle" → agrega "La Vie Est Belle" por nombre parcial',
    !!txt && txt.includes('Agregué') && txt.includes('La Vie Est Belle'),
    JSON.stringify(txt));
}

// ---- Restaurar estado previo de perfumeria (modo convivencia) ----
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete();
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete();
for (const d of oldAssetDocs) await db.doc(`tenants/${T}/metaAssets/${d.id}`).set(d.data);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();
if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent);
await db.doc(`tenants/${T}`).set(before);
await db.doc(FIX).delete();
for (const f of customers) {
  const cid = f.replace(/[^0-9]/g, '');
  const msgs = await db.collection(`tenants/${T}/customers/${cid}/messages`).get();
  for (const d of msgs.docs) await d.ref.delete();
  await db.doc(`tenants/${T}/customers/${cid}/sessions/active`).delete().catch(() => {});
  await db.doc(`tenants/${T}/customers/${cid}`).delete();
}

const ok = results.every(Boolean);
console.log(`\nRESULTADO F1 (grounding: router + rescate catálogo vacío): ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
