/**
 * verify-f4.mjs — WHATSAPP-AGENT-F4 end-to-end (emulador).
 * Los dos bugs del smoke real post-F3 + saludo con intención:
 *  1-3. "Sí, agrégalo porfa" AGREGA el único candidato (la cortesía es relleno) → pagar → orden.
 *  4.   Reclamo "no agregaste nada, yo quería el Supremacy": el MOTOR responde con el estado
 *       real (carrito vacío, sin inventar "ya lo agregué") y deja la oferta lista → "sí" agrega.
 *  5.   "mejor otro porfa" no agrega y descarta la oferta.
 *  6.   "Hola, quiero algo rico para regalar" NO se queda en el saludo: procesa la intención (IA).
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
const PNID = 'wa-f4-1';
const FIX = 'aiTestFixtures/ai';
const MARK = '[fixture-f4]';
const GREETING = 'hola';
const SUP_ID = 'f4-supremacy';
const ODY_ID = 'f4-odyssey';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waPayload = (from, body, mid) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: from, profile: { name: 'Test F4' } }],
    messages: [{ from, id: mid, timestamp: '1716750000', type: 'text', text: { body } }],
  } }] }],
});
let midSeq = 0;
const postMsg = (from, body) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(waPayload(from, body, `wamid.F4-${Date.now()}-${++midSeq}`)) });

const cid = (from) => from.replace(/[^0-9]/g, '');
async function lastOut(from) {
  const snap = await db.collection(`tenants/${T}/customers/${cid(from)}/messages`).get();
  const outs = snap.docs.map((d) => d.data()).filter((m) => m.direction === 'out').sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  return outs.length ? outs[outs.length - 1].text : null;
}
const sessionDoc = async (from) => (await db.doc(`tenants/${T}/customers/${cid(from)}/sessions/active`).get()).data();
const pendingOf = async (from) => (await sessionDoc(from))?.context?.pendingCartConfirmation ?? null;

async function sendAndWait(from, body, pred, maxMs = 15000) {
  const prev = await lastOut(from);
  await postMsg(from, body);
  const end = Date.now() + maxMs;
  let txt = null;
  while (Date.now() < end) { txt = await lastOut(from); if (txt && txt !== prev && pred(txt)) return txt; await sleep(600); }
  return txt;
}
async function probeUntil(from, body, pred, maxMs = 42000) {
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

// ---- Snapshot + setup (convivencia) ----
const before = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const now = Timestamp.now();
const oldAssets = await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
const oldAssetDocs = oldAssets.docs.map((d) => ({ id: d.id, data: d.data() }));
for (const d of oldAssets.docs) await d.ref.delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ id: PNID, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: 'wa-f4', status: 'active', selected: true, createdAt: now, updatedAt: now });
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: now });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot F4' }, { merge: true });
await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: now },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now },
}, { merge: true });

const mkProd = (id, name, brand) => ({
  id, tenantId: T, name, description: `${name} — prueba F4`, price: 250000, compareAtPrice: null,
  currency: 'PYG', status: 'ACTIVE', featured: false, categoryId: null, imageUrl: '', aiNotes: '',
  inventory: { trackStock: true, stock: 10, lowStockThreshold: 3, sku: id },
  perfume: { brand, gender: 'Unisex', styleTags: ['intenso'] },
  createdAt: now, updatedAt: now,
});
await db.doc(`tenants/${T}/products/${SUP_ID}`).set(mkProd(SUP_ID, 'Perfume Supremacy Not Only Intense', 'Afnan'));
await db.doc(`tenants/${T}/products/${ODY_ID}`).set(mkProd(ODY_ID, 'Armaf Odyssey Mega', 'Armaf'));

const customers = [];
const fresh = (n) => { const f = `59599370${String(n).padStart(4, '0')}`; customers.push(f); return f; };

// === 1-3. "Sí, agrégalo porfa" agrega → pagar → orden con Supremacy ===
{
  const from = fresh(1);
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-f4-1', name: 'buscar_productos', input: { consulta: 'supremacy' } }] },
    { text: `Tengo el **Perfume Supremacy Not Only Intense** (Afnan), $250.000. ¿Querés que te lo agregue? ${MARK}` },
  ] });
  const t1 = await probeUntil(from, 'Tenés el Supremacy?', (t) => t.includes(MARK));
  const t2 = await sendAndWait(from, 'Sí, agrégalo porfa', (t) => t.includes('Agregué'));
  const s2 = await sessionDoc(from);
  check('1. BUG REAL: "Sí, agrégalo porfa" AGREGA el único candidato (la cortesía es relleno)',
    !!t1 && !!t2 && t2.includes('Supremacy') && s2?.cart?.items?.[0]?.productId === SUP_ID,
    JSON.stringify((t2 ?? '').slice(0, 50)));

  const t3 = await sendAndWait(from, 'Quiero pagar', (t) => t.includes('transferir'));
  const orderId = (await sessionDoc(from))?.context?.pendingOrderId;
  const order = orderId ? (await db.doc(`tenants/${T}/orders/${orderId}`).get()).data() : null;
  check('2. "Quiero pagar" → orden con Supremacy',
    !!t3 && (order?.items ?? []).some((i) => i.productId === SUP_ID), `order=${orderId}`);
  if (orderId) await db.doc(`tenants/${T}/orders/${orderId}`).delete();
}

// === 4. Reclamo: el motor responde con estado REAL y deja la oferta lista ===
{
  const from = fresh(2);
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-f4-2', name: 'buscar_productos', input: { consulta: 'supremacy' } }] },
    { text: `Te recomiendo el **Perfume Supremacy Not Only Intense**. ¿Te lo agrego? ${MARK}` },
  ] });
  await probeUntil(from, 'busco algo rico', (t) => t.includes(MARK));
  // Vencer la oferta para simular el caso real (reclamo con contexto perdido y carrito vacío).
  const sref = db.doc(`tenants/${T}/customers/${cid(from)}/sessions/active`);
  const pc = (await sref.get()).data()?.context?.pendingCartConfirmation;
  if (pc) await sref.set({ context: { pendingCartConfirmation: { ...pc, expiresAtMs: Date.now() - 1000 } } }, { merge: true });

  const t1 = await sendAndWait(from, 'no agregaste nada, yo quería el Supremacy', (t) => t.includes('Todavía no agregué'));
  const okHonesto = !!t1 && t1.includes('Todavía no agregué nada') && t1.includes('Supremacy') && !t1.includes('✅ Agregué');
  check('3a. reclamo con carrito VACÍO → el MOTOR responde el estado real (jamás "ya lo agregué")',
    okHonesto, JSON.stringify((t1 ?? '').slice(0, 70)));
  const p1 = await pendingOf(from);
  check('3b. el reclamo que nombra al producto deja la oferta lista', p1?.primaryProductId === SUP_ID, `pending=${p1?.primaryProductId}`);

  const t2 = await sendAndWait(from, 'sí', (t) => t.includes('Agregué'));
  const s2 = await sessionDoc(from);
  check('3c. "sí" después del reclamo → agrega SUPREMACY de verdad',
    !!t2 && t2.includes('Supremacy') && s2?.cart?.items?.[0]?.productId === SUP_ID, JSON.stringify((t2 ?? '').slice(0, 50)));

  // Reclamo con producto YA en el carrito → estado real + ofrecer pagar.
  const t3 = await sendAndWait(from, 'no agregaste el supremacy', (t) => t.includes('está en tu carrito'));
  check('3d. reclamo con el producto YA en el carrito → lo confirma con estado real y ofrece pagar',
    !!t3 && t3.includes('está en tu carrito') && t3.toLowerCase().includes('pagar'), JSON.stringify((t3 ?? '').slice(0, 60)));
}

// === 5. "mejor otro porfa" no agrega y descarta la oferta ===
{
  const from = fresh(3);
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-f4-3', name: 'buscar_productos', input: { consulta: 'supremacy' } }] },
    { text: `El **Perfume Supremacy Not Only Intense** es ideal. ¿Te lo agrego? ${MARK}` },
  ] });
  await probeUntil(from, 'busco un regalo lindo', (t) => t.includes(MARK));
  const pAntes = await pendingOf(from);
  await postMsg(from, 'mejor otro porfa');
  await sleep(8000);
  const s = await sessionDoc(from);
  const pDespues = await pendingOf(from);
  const ultimo = await lastOut(from);
  // La oferta VIEJA se descarta y la IA puede re-recomendar (oferta NUEVA legítima) — lo
  // prohibido es AGREGAR o afirmar que se agregó.
  const ofertaViejaDescartada = pDespues === null || pDespues.createdAtMs > (pAntes?.createdAtMs ?? Infinity);
  check('4. "mejor otro porfa" NO agrega (la oferta vieja se descarta; la IA puede ofrecer otra)',
    (s?.cart?.items?.length ?? 0) === 0 && !String(ultimo ?? '').includes('✅ Agregué') && ofertaViejaDescartada,
    `pendingNuevo=${pDespues ? 'sí (re-recomendación)' : 'no'}`);
}

// === 6. Saludo + intención: no se queda en la bienvenida ===
{
  const from = fresh(4);
  await setFixture({ text: `¡Hola! Tengo justo lo que buscás para regalar ✨ ${MARK}` });
  // Cliente EXISTENTE (primero un saludo puro para crear la sesión).
  await postMsg(from, GREETING);
  for (let i = 0; i < 16; i++) { if (await lastOut(from)) break; await sleep(500); }
  const t1 = await sendAndWait(from, 'Hola, quiero algo rico para regalar', (t) => t.includes(MARK), 30000);
  check('5. "Hola, quiero algo rico para regalar" NO se queda en el saludo → procesa la intención (IA)',
    !!t1 && t1.includes(MARK) && !t1.includes('¡Hola de nuevo!'), JSON.stringify((t1 ?? '').slice(0, 60)));
}

// ---- Restaurar (convivencia) ----
await db.doc(`tenants/${T}/products/${SUP_ID}`).delete();
await db.doc(`tenants/${T}/products/${ODY_ID}`).delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete();
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete();
for (const d of oldAssetDocs) await db.doc(`tenants/${T}/metaAssets/${d.id}`).set(d.data);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();
if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent);
await db.doc(`tenants/${T}`).set(before);
await db.doc(FIX).delete();
for (const f of customers) {
  const c = cid(f);
  for (const d of (await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs) await d.ref.delete();
  await db.doc(`tenants/${T}/customers/${c}/sessions/active`).delete().catch(() => {});
  await db.doc(`tenants/${T}/customers/${c}`).delete();
}

const ok = results.every(Boolean);
console.log(`\nRESULTADO F4 (cortesía + anti-mentiras + saludo con intención): ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
