/**
 * verify-f3-cart-targeting.mjs — WHATSAPP-AGENT-F3 end-to-end (emulador).
 * Reproduce EL BUG REAL del live smoke (2026-07-03) y verifica el fix completo:
 * la tool devuelve [Odyssey, Supremacy] pero la IA presenta SOLO Supremacy → antes "sí" y
 * "el primero" agregaban Odyssey; ahora la oferta es LO QUE EL CLIENTE LEYÓ.
 *
 *  1. Consulta por Supremacy → IA (fixture) lo recomienda; la oferta queda alineada al texto.
 *  2. "sí" → agrega SUPREMACY (no Odyssey, aunque el buscador lo devolvió primero).
 *  3. "Quiero pagar" → la preorden contiene Supremacy; la oferta se limpia (checkout).
 *  4. Multi-oferta: IA presenta 2 → "si" NO adivina: pide elegir (lista numerada del motor).
 *  5. "el segundo" → agrega el 2° DE LA LISTA PRESENTADA.
 *  6. Contexto viejo: oferta con Odyssey primero + "agregame el supremacy" → gana el NOMBRE.
 *  7. Negativa: "no gracias" → no agrega y limpia la oferta.
 *  8. Oferta VENCIDA + "sí" → repregunta, jamás agrega contexto viejo.
 *  9. pendingOrderId stale (orden cancelada) NO contamina el flujo nuevo.
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
const PNID = 'wa-f3-1';
const FIX = 'aiTestFixtures/ai';
const MARK = '[fixture-f3]';
const GREETING = 'hola';

const SUP_ID = 'f3-supremacy';
const ODY_ID = 'f3-odyssey';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waPayload = (from, body, mid) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: from, profile: { name: 'Test F3' } }],
    messages: [{ from, id: mid, timestamp: '1716750000', type: 'text', text: { body } }],
  } }] }],
});
let midSeq = 0;
const postMsg = (from, body) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(waPayload(from, body, `wamid.F3-${Date.now()}-${++midSeq}`)) });

const cid = (from) => from.replace(/[^0-9]/g, '');
async function lastOut(from) {
  const snap = await db.collection(`tenants/${T}/customers/${cid(from)}/messages`).get();
  const outs = snap.docs.map((d) => d.data()).filter((m) => m.direction === 'out').sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  return outs.length ? outs[outs.length - 1].text : null;
}
const sessionDoc = async (from) => (await db.doc(`tenants/${T}/customers/${cid(from)}/sessions/active`).get()).data();

/** Manda `body` y espera a que la última respuesta cambie y cumpla pred. */
async function sendAndWait(from, body, pred, maxMs = 15_000) {
  const prev = await lastOut(from);
  await postMsg(from, body);
  const end = Date.now() + maxMs;
  let txt = null;
  while (Date.now() < end) {
    txt = await lastOut(from);
    if (txt && txt !== prev && pred(txt)) return txt;
    await sleep(600);
  }
  return txt;
}

/** Saluda 1 vez y reenvía `body` hasta que la respuesta cumpla pred (sortea caché entitlements 30s). */
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

// ---- Ruteo del webhook a perfumeria + bot ON, MOCK + plan starter (IA habilitada) ----
const now = Timestamp.now();
const oldAssets = await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
const oldAssetDocs = oldAssets.docs.map((d) => ({ id: d.id, data: d.data() }));
for (const d of oldAssets.docs) await d.ref.delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ id: PNID, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: 'wa-f3', status: 'active', selected: true, createdAt: now, updatedAt: now });
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: now });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot F3' }, { merge: true });
await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: now },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now },
}, { merge: true });

// ---- Productos del caso real (temporales, se borran al final) ----
const mkProd = (id, name, tags) => ({
  id, tenantId: T, name, description: `${name} — producto de prueba F3`, price: 250000, compareAtPrice: null,
  currency: 'PYG', status: 'ACTIVE', featured: false, categoryId: null, imageUrl: '', aiNotes: '',
  inventory: { trackStock: true, stock: 10, lowStockThreshold: 3, sku: id },
  perfume: { brand: id === ODY_ID ? 'Armaf' : 'Afnan', gender: 'Unisex', styleTags: tags },
  createdAt: now, updatedAt: now,
});
await db.doc(`tenants/${T}/products/${SUP_ID}`).set(mkProd(SUP_ID, 'Perfume Supremacy Not Only Intense', ['frutal', 'intenso']));
await db.doc(`tenants/${T}/products/${ODY_ID}`).set(mkProd(ODY_ID, 'Armaf Odyssey Mega', ['intenso']));

const customers = [];
const fresh = (n) => { const f = `59599300${String(n).padStart(4, '0')}`; customers.push(f); return f; };
const pendingOf = async (from) => (await sessionDoc(from))?.context?.pendingCartConfirmation ?? null;

// === 1-3. BUG REAL: tool=[Odyssey,Supremacy] pero el texto presenta SOLO Supremacy ===
{
  const from = fresh(1);
  // La consulta 'supremacy odyssey' pinnea AMBOS (Odyssey primero por score) — igual que "piña"
  // devolvió [Odyssey, Supremacy] en prod. El texto del fixture solo presenta Supremacy.
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-f3-1', name: 'buscar_productos', input: { consulta: 'supremacy odyssey' } }] },
    { text: `Perfecto, tengo lo que buscás: el **Perfume Supremacy Not Only Intense** (Afnan), frutal con piña, $250.000. ¿Querés que te lo agregue? ${MARK}` },
  ] });
  const txt1 = await probeUntil(from, 'Tienen el Supremacy?', (t) => t.includes(MARK));
  const pending1 = await pendingOf(from);
  const okOferta = !!pending1 && pending1.products.length === 1 && pending1.products[0].id === SUP_ID && pending1.primaryProductId === SUP_ID && pending1.needsDisambiguation === false;
  check('1. IA recomienda Supremacy → la oferta alineada es SOLO Supremacy (aunque la tool devolvió 2, Odyssey primero)',
    !!txt1 && okOferta, `pending=${JSON.stringify(pending1?.products)}`);

  // 9. pendingOrderId stale (orden cancelada/inexistente) presente ANTES de confirmar: no molesta.
  await db.doc(`tenants/${T}/customers/${cid(from)}/sessions/active`).set(
    { context: { pendingOrderId: 'ord_stale_cancelada_f3' } }, { merge: true });

  const txt2 = await sendAndWait(from, 'sí', (t) => t.includes('Agregué'));
  const sess2 = await sessionDoc(from);
  const okAdd = !!txt2 && txt2.includes('Supremacy') && !txt2.includes('Odyssey') &&
    sess2?.cart?.items?.length === 1 && sess2.cart.items[0].productId === SUP_ID;
  check('2. "sí" → agrega SUPREMACY, no Odyssey (el bug real, corregido)', okAdd,
    `cart=${JSON.stringify(sess2?.cart?.items?.map((i) => i.productId))} reply=${JSON.stringify((txt2 ?? '').slice(0, 50))}`);
  check('2b. la oferta se limpia después de agregar', (await pendingOf(from)) === null);

  const txt3 = await sendAndWait(from, 'Quiero pagar', (t) => t.includes('transferir'));
  const sess3 = await sessionDoc(from);
  const orderId = sess3?.context?.pendingOrderId;
  let orderOk = false;
  if (orderId && orderId !== 'ord_stale_cancelada_f3') {
    const o = (await db.doc(`tenants/${T}/orders/${orderId}`).get()).data();
    const ids = (o?.items ?? []).map((i) => i.productId); // items INLINE en el doc de la orden
    orderOk = o?.status === 'PENDING_PAYMENT' && ids.includes(SUP_ID) && !ids.includes(ODY_ID);
  }
  check('3. "Quiero pagar" → preorden NUEVA con Supremacy (la stale no contaminó) + oferta limpia (checkout)',
    !!txt3 && orderOk && (await pendingOf(from)) === null && sess3?.state === 'AWAITING_PAYMENT',
    `orderId=${orderId}`);
  if (orderId && orderId !== 'ord_stale_cancelada_f3') {
    await db.doc(`tenants/${T}/orders/${orderId}`).delete();
  }
}

// === 4-5. Multi-oferta: "si" pide elegir; "el segundo" agrega el 2° PRESENTADO ===
{
  const from = fresh(2);
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-f3-2', name: 'buscar_productos', input: { consulta: 'supremacy odyssey' } }] },
    { text: `Tengo dos opciones:\n1. **Armaf Odyssey Mega** — $250.000\n2. **Perfume Supremacy Not Only Intense** — $250.000\n¿Cuál preferís? ${MARK}` },
  ] });
  // Sin palabras de estilo/precio/catálogo: el turno tiene que DELEGAR a la IA (fixture), no a reglas.
  const txt1 = await probeUntil(from, 'ayudame a elegir un perfume', (t) => t.includes(MARK));
  const pending1 = await pendingOf(from);
  const okMulti = !!pending1 && pending1.needsDisambiguation === true &&
    pending1.products.map((p) => p.id).join(',') === `${ODY_ID},${SUP_ID}`;
  check('4a. IA presenta 2 (Odyssey 1°, Supremacy 2°) → oferta múltiple en el ORDEN DEL TEXTO',
    !!txt1 && okMulti, `pending=${JSON.stringify(pending1?.products)}`);

  const txt2 = await sendAndWait(from, 'si', (t) => t.includes('Cuál querés que agregue'));
  const sess2 = await sessionDoc(from);
  check('4b. "si" con 2 candidatos → NO adivina: pide elegir con lista numerada; carrito intacto',
    !!txt2 && txt2.includes('1. Armaf Odyssey Mega') && txt2.includes('2. Perfume Supremacy Not Only Intense') &&
    (sess2?.cart?.items?.length ?? 0) === 0, JSON.stringify((txt2 ?? '').slice(0, 80)));

  const txt3 = await sendAndWait(from, 'el segundo', (t) => t.includes('Agregué'));
  const sess3 = await sessionDoc(from);
  check('5. "el segundo" → agrega el 2° PRESENTADO (Supremacy) y limpia la oferta',
    !!txt3 && txt3.includes('Supremacy') && sess3?.cart?.items?.[0]?.productId === SUP_ID &&
    (await pendingOf(from)) === null, JSON.stringify((txt3 ?? '').slice(0, 50)));
}

// === 6. Contexto viejo: Odyssey primero en la oferta + "agregame el supremacy" → gana el NOMBRE ===
{
  const from = fresh(3);
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-f3-3', name: 'buscar_productos', input: { consulta: 'supremacy odyssey' } }] },
    { text: `Mirá:\n1. **Armaf Odyssey Mega**\n2. **Perfume Supremacy Not Only Intense**\n¿Cuál te gusta? ${MARK}` },
  ] });
  await probeUntil(from, 'que me recomendas para regalar', (t) => t.includes(MARK));
  const txt = await sendAndWait(from, 'agregame el supremacy', (t) => t.includes('Agregué'));
  const sess = await sessionDoc(from);
  check('6. "agregame el supremacy" con Odyssey 1° en contexto → agrega SUPREMACY (nombre > contexto viejo)',
    !!txt && txt.includes('Supremacy') && sess?.cart?.items?.[0]?.productId === SUP_ID,
    JSON.stringify((txt ?? '').slice(0, 50)));
}

// === 7. Negativa: "no gracias" → no agrega, limpia la oferta ===
{
  const from = fresh(4);
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-f3-4', name: 'buscar_productos', input: { consulta: 'supremacy' } }] },
    { text: `Te recomiendo el **Perfume Supremacy Not Only Intense**, ¿te lo agrego? ${MARK}` },
  ] });
  await probeUntil(from, 'busco un regalo lindo', (t) => t.includes(MARK));
  const txt = await sendAndWait(from, 'no gracias', (t) => t.includes('no lo agrego'));
  const sess = await sessionDoc(from);
  check('7. "no gracias" → NO agrega, limpia la oferta y responde amable',
    !!txt && (sess?.cart?.items?.length ?? 0) === 0 && (await pendingOf(from)) === null,
    JSON.stringify((txt ?? '').slice(0, 60)));
}

// === 8. Oferta VENCIDA + "sí" → repregunta, jamás agrega contexto viejo ===
{
  const from = fresh(5);
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-f3-5', name: 'buscar_productos', input: { consulta: 'supremacy' } }] },
    { text: `El **Perfume Supremacy Not Only Intense** te va a encantar. ¿Te lo agrego? ${MARK}` },
  ] });
  await probeUntil(from, 'busco algo con piña', (t) => t.includes(MARK));
  // Vencer la oferta a mano (simula que pasaron >10 min).
  const sref = db.doc(`tenants/${T}/customers/${cid(from)}/sessions/active`);
  const s = (await sref.get()).data();
  const pc = s?.context?.pendingCartConfirmation;
  await sref.set({ context: { pendingCartConfirmation: { ...pc, expiresAtMs: Date.now() - 1000 } } }, { merge: true });

  const txt = await sendAndWait(from, 'sí', (t) => t.includes('Decime cuál'));
  const sess = await sessionDoc(from);
  check('8. oferta VENCIDA + "sí" → repregunta (no agrega) y limpia el contexto viejo',
    !!txt && (sess?.cart?.items?.length ?? 0) === 0 && (await pendingOf(from)) === null,
    JSON.stringify((txt ?? '').slice(0, 60)));
}

// === 9-10. REVIEW adversarial: "no lo quiero" y nombre inexistente JAMÁS agregan ===
{
  const from = fresh(6);
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-f3-6', name: 'buscar_productos', input: { consulta: 'supremacy' } }] },
    { text: `El **Perfume Supremacy Not Only Intense** es ideal para eso. ¿Te lo agrego? ${MARK}` },
  ] });
  await probeUntil(from, 'busco algo rico para salir', (t) => t.includes(MARK));
  const txt1 = await sendAndWait(from, 'no lo quiero', (t) => t.includes('no lo agrego'));
  const s1 = await sessionDoc(from);
  check('9. REVIEW: "no lo quiero" → NO agrega (quiereAgregar matcheaba "(lo) quiero" adentro) y descarta la oferta',
    !!txt1 && (s1?.cart?.items?.length ?? 0) === 0 && (await pendingOf(from)) === null,
    JSON.stringify((txt1 ?? '').slice(0, 60)));

  // Rearmar la oferta y probar un nombre que NO existe en el catálogo.
  await probeUntil(from, 'busco algo rico para salir', (t) => t.includes(MARK));
  const txt2 = await sendAndWait(from, 'agregame el invictus', (t) => t.includes('Decime cuál'));
  const s2 = await sessionDoc(from);
  check('10. REVIEW: "agregame el invictus" (inexistente) → repregunta, jamás agrega el pendiente en silencio',
    !!txt2 && (s2?.cart?.items?.length ?? 0) === 0,
    JSON.stringify((txt2 ?? '').slice(0, 60)));
}

// ---- Restaurar estado previo de perfumeria (modo convivencia) ----
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
  const msgs = await db.collection(`tenants/${T}/customers/${c}/messages`).get();
  for (const d of msgs.docs) await d.ref.delete();
  await db.doc(`tenants/${T}/customers/${c}/sessions/active`).delete().catch(() => {});
  await db.doc(`tenants/${T}/customers/${c}`).delete();
}

const ok = results.every(Boolean);
console.log(`\nRESULTADO F3 (cart targeting contextual): ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
