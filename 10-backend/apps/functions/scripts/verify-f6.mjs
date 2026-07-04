/**
 * verify-f6.mjs — WHATSAPP-AGENT-F6 FIRST-MESSAGE-INTENT end-to-end (emulador).
 * El caso real del smoke F5: cliente NUEVO escribió "Hola tenes algun perfume llamado Supremacy"
 * y recibió SOLO la bienvenida.
 *  1. Cliente nuevo "Hola" → bienvenida completa (comportamiento intacto).
 *  2. Cliente nuevo "Hola, tenés el Supremacy?" → bienvenida BREVE + respuesta del producto (IA),
 *     con oferta pendiente lista.
 *  3. "sí" → agrega Supremacy (la oferta del primer turno funciona).
 *  4. Segundo "hola" → "¡Hola de nuevo!" corto, NUNCA la bienvenida completa otra vez.
 *  5. Cliente nuevo "Buen día, hacen envíos?" → bienvenida breve + FAQ (IA), sin bienvenida doble.
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
const PNID = 'wa-f6-1';
const FIX = 'aiTestFixtures/ai';
const MARK = '[fixture-f6]';
const GREETING_LINE1 = '¡Hola! 💖 Bienvenida a Perfumería F6.';
const GREETING_FULL = GREETING_LINE1 + '\nSoy Sofía, tu asesora. Contame qué estilo te gusta ✨';
const SUP_ID = 'f6-supremacy';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mid = 0;
const postMsg = (from, body) => fetch(`${BASE}/metaWebhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: from, profile: { name: 'Test F6' } }],
    messages: [{ from, id: `wamid.F6-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }],
  } }] }] }),
});
const cid = (f) => f.replace(/[^0-9]/g, '');
async function outs(from) {
  const snap = await db.collection(`tenants/${T}/customers/${cid(from)}/messages`).get();
  return snap.docs.map((d) => d.data()).filter((m) => m.direction === 'out').sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis()).map((m) => m.text);
}
async function sendAndWaitNew(from, body, pred, maxMs = 30000) {
  const n0 = (await outs(from)).length;
  await postMsg(from, body);
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const o = await outs(from);
    if (o.length > n0 && pred(o[o.length - 1])) return o[o.length - 1];
    await sleep(700);
  }
  const o = await outs(from);
  return o.length > n0 ? o[o.length - 1] : null;
}
const pendingOf = async (from) => (await db.doc(`tenants/${T}/customers/${cid(from)}/sessions/active`).get()).data()?.context?.pendingCartConfirmation ?? null;
const setFixture = (data) => db.doc(FIX).set(data);

// ---- Snapshot + setup ----
const before = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const now = Timestamp.now();
const oldAssets = await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
const oldAssetDocs = oldAssets.docs.map((d) => ({ id: d.id, data: d.data() }));
for (const d of oldAssets.docs) await d.ref.delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ id: PNID, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: 'wa-f6', status: 'active', selected: true, createdAt: now, updatedAt: now });
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: now });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: GREETING_FULL }, { merge: true });
await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: now },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now },
}, { merge: true });
await db.doc(`tenants/${T}/products/${SUP_ID}`).set({
  id: SUP_ID, tenantId: T, name: 'Perfume Supremacy Not Only Intense', description: 'prueba F6', price: 250000,
  compareAtPrice: null, currency: 'PYG', status: 'ACTIVE', featured: false, categoryId: null, imageUrl: '', aiNotes: '',
  inventory: { trackStock: true, stock: 10, lowStockThreshold: 3, sku: SUP_ID },
  perfume: { brand: 'Afnan', gender: 'Unisex', styleTags: ['intenso'] }, createdAt: now, updatedAt: now,
});

const customers = [];
const fresh = (n) => { const f = `59599390${String(n).padStart(4, '0')}`; customers.push(f); return f; };

// ===== 1. Cliente nuevo "Hola" → bienvenida completa =====
{
  const from = fresh(1);
  const t1 = await sendAndWaitNew(from, 'Hola', (t) => t.includes('Bienvenida'));
  check('1. cliente nuevo "Hola" → bienvenida COMPLETA (config del tenant, intacta)',
    !!t1 && t1.includes(GREETING_LINE1) && t1.includes('Soy Sofía'), JSON.stringify((t1 ?? '').slice(0, 60)));
}

// ===== 2-4. BUG REAL: nuevo con "Hola, tenés el Supremacy?" =====
{
  const from = fresh(2);
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-f6-1', name: 'buscar_productos', input: { consulta: 'supremacy' } }] },
    { text: `¡Hola! Sí, tenemos el **Perfume Supremacy Not Only Intense** a ₲ 250.000. ¿Querés que te lo agregue? ${MARK}` },
  ] });
  const t1 = await sendAndWaitNew(from, 'Hola, tenés el Supremacy?', (t) => t.includes(MARK), 40000);
  const p1 = await pendingOf(from);
  check('2. BUG REAL: bienvenida BREVE (línea 1) + respuesta del producto EN EL MISMO turno',
    !!t1 && t1.startsWith(GREETING_LINE1) && t1.includes(MARK) && t1.includes('Supremacy') && !t1.includes('Soy Sofía'),
    JSON.stringify((t1 ?? '').slice(0, 90)));
  // REVIEW: la IA espejó el "Hola" del cliente (el fixture empieza con "¡Hola!") — el sistema
  // se lo quita: un solo saludo en la burbuja.
  check('2b. sin DOBLE saludo (el "¡Hola!" de la IA se elimina; queda solo la bienvenida)',
    !!t1 && !/hola/i.test(t1.slice(GREETING_LINE1.length)), JSON.stringify((t1 ?? '').slice(GREETING_LINE1.length, GREETING_LINE1.length + 40)));
  check('3. la oferta quedó pendiente desde el PRIMER turno', p1?.primaryProductId === SUP_ID, `pending=${p1?.primaryProductId}`);

  const t2 = await sendAndWaitNew(from, 'sí', (t) => t.includes('Agregué'));
  check('4. "sí" agrega Supremacy (el flujo del primer mensaje quedó bien armado)',
    !!t2 && t2.includes('Supremacy'), JSON.stringify((t2 ?? '').slice(0, 50)));

  const t3 = await sendAndWaitNew(from, 'hola', (t) => t.includes('Hola'));
  check('5. segundo "hola" → saludo corto de vuelta, JAMÁS la bienvenida completa otra vez',
    !!t3 && t3.includes('¡Hola de nuevo!') && !t3.includes('Bienvenida a Perfumería F6'), JSON.stringify((t3 ?? '').slice(0, 60)));
}

// ===== 5. Cliente nuevo "Buen día, hacen envíos?" → breve + FAQ =====
{
  const from = fresh(3);
  await setFixture({ text: `¡Sí, hacemos envíos a todo el país! 🚚 ${MARK}` });
  const t1 = await sendAndWaitNew(from, 'Buen día, hacen envíos?', (t) => t.includes(MARK), 40000);
  check('6. "Buen día, hacen envíos?" (nuevo) → bienvenida breve + FAQ, sin bienvenida doble',
    !!t1 && t1.startsWith(GREETING_LINE1) && t1.includes('envíos') && !t1.includes('Soy Sofía'),
    JSON.stringify((t1 ?? '').slice(0, 80)));
}

// ===== 6b. REVIEW: reclamo como PRIMER mensaje → interceptor determinístico, no IA =====
{
  const from = fresh(4);
  await setFixture({ fail: true, failMessage: 'la IA no debe correr en este caso' });
  const t1 = await sendAndWaitNew(from, 'Hola, yo quería el Supremacy', (t) => t.includes('agregue'), 30000);
  const p1 = await pendingOf(from);
  check('7. REVIEW: "Hola, yo quería el Supremacy" (nuevo) → interceptor con bienvenida breve, sin IA',
    !!t1 && t1.startsWith(GREETING_LINE1) && t1.includes('¿Querés que agregue') && p1?.primaryProductId === SUP_ID,
    JSON.stringify((t1 ?? '').slice(0, 90)));
  const t2 = await sendAndWaitNew(from, 'sí', (t) => t.includes('Agregué'));
  check('7b. el "sí" posterior agrega Supremacy', !!t2 && t2.includes('Supremacy'));
}

// ---- Cleanup ----
await db.doc(`tenants/${T}/products/${SUP_ID}`).delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete();
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete();
for (const d of oldAssetDocs) await db.doc(`tenants/${T}/metaAssets/${d.id}`).set(d.data);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();
if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent); else await db.doc(`tenants/${T}/config/agent`).delete();
await db.doc(`tenants/${T}`).set(before);
await db.doc(FIX).delete();
for (const f of customers) {
  const c = cid(f);
  for (const d of (await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs) await d.ref.delete();
  await db.doc(`tenants/${T}/customers/${c}/sessions/active`).delete().catch(() => {});
  await db.doc(`tenants/${T}/customers/${c}`).delete();
}

const ok = results.every(Boolean);
console.log(`\nRESULTADO F6 (primer mensaje con intención): ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
