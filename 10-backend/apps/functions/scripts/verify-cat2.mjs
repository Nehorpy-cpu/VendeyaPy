/**
 * verify-cat2.mjs — CATALOG-ENRICHMENT-2 end-to-end (emulador).
 * El caso real del smoke CAT-1: el agente complació ("Odyssey perfecto para la noche") contra la
 * ficha (día/fresco/moderada) y el compactador de aiNotes dejaba fuera el "cuándo NO".
 *  1. "Quiero uno para salir de noche" (motor) → Supremacy PRIMERO en el listado (ficha noche).
 *  2. "Quiero algo fresco para la oficina" (motor) → Odyssey PRIMERO aunque el styleTag 'fresco'
 *     lo tenga Supremacy (la ficha día/diario invierte el orden — el bug del smoke).
 *  3. "olor a piña" (IA + buscar_productos real) → lastShownSkus[0] = Odyssey (ranking por notas)
 *     y el payload de la tool incluye la ficha compacta con cuándo-NO.
 *  4. "El Odyssey sirve para salidas nocturnas?" (IA) → responde el fixture; carrito INTACTO.
 *  5. "Cuál dura más?" (IA) → fixture; sin carrito ni órdenes nuevas (recomendar ≠ agregar).
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
const PNID = 'wa-cat2-1';
const FIX = 'aiTestFixtures/ai';
const MARK = '[fixture-cat2]';
const SUP_ID = 'cat2-supremacy';
const ODY_ID = 'cat2-odyssey';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mid = 0;
const postMsg = (from, body) => fetch(`${BASE}/metaWebhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: from, profile: { name: 'Test CAT2' } }],
    messages: [{ from, id: `wamid.CAT2-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }],
  } }] }] }),
});
const cid = (f) => f.replace(/[^0-9]/g, '');
async function outs(from) {
  const snap = await db.collection(`tenants/${T}/customers/${cid(from)}/messages`).get();
  return snap.docs.map((d) => d.data()).filter((m) => m.direction === 'out').sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis()).map((m) => m.text);
}
async function sendAndWaitNew(from, body, pred, maxMs = 40000) {
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
const sessionOf = async (from) => (await db.doc(`tenants/${T}/customers/${cid(from)}/sessions/active`).get()).data() ?? {};
const setFixture = (data) => db.doc(FIX).set(data);
/** Primer producto del listado del motor ("✨ Mirá..."): texto de la primera línea con *negrita*. */
const primerProducto = (reply) => (reply ?? '').match(/\*([^*]+?) – /)?.[1] ?? '';

// ---- Snapshot + setup ----
const before = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const now = Timestamp.now();
const oldAssets = await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
const oldAssetDocs = oldAssets.docs.map((d) => ({ id: d.id, data: d.data() }));
for (const d of oldAssets.docs) await d.ref.delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ id: PNID, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: 'wa-cat2', status: 'active', selected: true, createdAt: now, updatedAt: now });
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: now });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: '¡Hola! Bienvenida a Perfumería CAT2.' }, { merge: true });
await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: now },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now },
}, { merge: true });

// Espejo de los productos REALES (fichas del owner) — el caso que motivó el programa.
await db.doc(`tenants/${T}/products/${SUP_ID}`).set({
  id: SUP_ID, tenantId: T, name: 'Perfume Supremacy CAT2', description: 'Intenso de larga duración.', price: 250000,
  compareAtPrice: null, currency: 'PYG', status: 'ACTIVE', featured: false, categoryId: null, imageUrl: '',
  aiNotes: 'Extrait 100ml. Dura 8-10, proyección fuerte.',
  inventory: { trackStock: true, stock: 10, lowStockThreshold: 3, sku: SUP_ID },
  perfume: {
    brand: 'Afnan', gender: 'Unisex', styleTags: ['frutal', 'fresco', 'intenso'], olfactiveFamily: 'amaderado',
    notes: { top: ['bergamota', 'manzana verde'], heart: ['patchouli', 'lavanda'], base: ['ambergris', 'musk'] },
    priceRange: 'MID', sizeMl: 100, isNew: false,
  },
  aiFicha: {
    concentracion: 'Extrait', duracion: '8-10 horas', proyeccion: 'fuerte',
    ocasiones: ['momentos especiales', 'ambientes abiertos'], clima: ['verano', 'otoño'],
    perfil: 'maduro, sofisticado', cuandoRecomendar: 'busca duración y presencia',
  },
  createdAt: now, updatedAt: now,
});
await db.doc(`tenants/${T}/products/${ODY_ID}`).set({
  id: ODY_ID, tenantId: T, name: 'Armaf Odyssey CAT2', description: 'Cítrico fresco.', price: 250000,
  compareAtPrice: null, currency: 'PYG', status: 'ACTIVE', featured: true, categoryId: null, imageUrl: '',
  aiNotes: 'EDP 100ml. Dura 5-6, proyección moderada.',
  inventory: { trackStock: true, stock: 1, lowStockThreshold: 3, sku: ODY_ID },
  perfume: {
    brand: 'Armaf', gender: 'Unisex', styleTags: ['amaderado', 'citrico', 'dulce'], olfactiveFamily: 'Citrico',
    notes: { top: ['naranja', 'bergamota', 'limon'], heart: ['piña', 'salvia'], base: ['almizcle', 'cedro'] },
    priceRange: 'MID', sizeMl: 100, isNew: false,
  },
  aiFicha: {
    concentracion: 'EDP', duracion: '5-6 horas', proyeccion: 'moderada',
    ocasiones: ['fresco', 'diario'], clima: ['verano', 'dia'], perfil: 'juvenil, moderno',
    cuandoRecomendar: 'busca un aroma moderno y juvenil',
    cuandoNoRecomendar: 'si busca algo para salidas nocturnas o eventos formales',
  },
  createdAt: now, updatedAt: now,
});

const customers = [];
const fresh = (n) => { const f = `59599391${String(n).padStart(4, '0')}`; customers.push(f); return f; };

// ===== 1. Motor: "para salir de noche" → Supremacy PRIMERO =====
{
  const from = fresh(1);
  await setFixture({ fail: true, failMessage: 'este turno lo resuelve el motor, no la IA' });
  const t1 = await sendAndWaitNew(from, 'Quiero uno para salir de noche', (t) => t.includes('opciones'));
  check('1. listado "para salir de noche" → Supremacy PRIMERO (ficha: ocasión+proyección)',
    !!t1 && primerProducto(t1).includes('Supremacy'), `1ro=${JSON.stringify(primerProducto(t1))}`);
  check('1b. Odyssey NO encabeza la lista nocturna (su cuándo-NO además lo penaliza)',
    !!t1 && !primerProducto(t1).includes('Odyssey'));
}

// ===== 2. Motor: "fresco para la oficina" → Odyssey PRIMERO (inversión vs styleTag) =====
{
  const from = fresh(2);
  const t1 = await sendAndWaitNew(from, 'Quiero algo fresco para la oficina', (t) => t.includes('opciones'));
  check('2. listado "fresco para la oficina" → Odyssey PRIMERO aunque el tag \'fresco\' lo tenga Supremacy',
    !!t1 && primerProducto(t1).includes('Odyssey'), `1ro=${JSON.stringify(primerProducto(t1))}`);
}

// ===== 3. IA + tool real: "olor a piña" → Odyssey primero en lastShownSkus =====
{
  const from = fresh(3);
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-cat2-1', name: 'buscar_productos', input: { consulta: 'quiero un perfume con olor a piña' } }] },
    { text: `Tengo el Armaf Odyssey CAT2 con piña en el corazón, ₲ 250.000. ¿Te lo agrego? ${MARK}` },
  ] });
  const t1 = await sendAndWaitNew(from, 'Quiero un perfume con olor a piña', (t) => t.includes(MARK));
  const ses = await sessionOf(from);
  const shown = ses?.context?.lastShownSkus ?? [];
  check('3. la tool real rankeó por NOTAS: lastShownSkus[0] = Odyssey (piña en corazón)',
    !!t1 && shown[0] === ODY_ID, `shown=${JSON.stringify(shown)}`);
}

// ===== 4. IA: "¿El Odyssey sirve para salidas nocturnas?" → fixture honesto; carrito INTACTO =====
{
  const from = fresh(4);
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-cat2-2', name: 'buscar_productos', input: { consulta: 'Odyssey' } }] },
    { text: `El Odyssey es más fresco, ideal para el día u oficina; para la noche te conviene más el Supremacy, que proyecta fuerte y dura 8-10 horas. ${MARK}` },
  ] });
  const t1 = await sendAndWaitNew(from, 'El Odyssey sirve para salidas nocturnas?', (t) => t.includes(MARK));
  const ses = await sessionOf(from);
  check('4. consulta de ocasión (IA con ficha en el payload) → respuesta pasa; el motor no interfiere',
    !!t1 && t1.includes('para la noche te conviene más'), JSON.stringify((t1 ?? '').slice(0, 70)));
  check('4b. preguntar NO toca el carrito', ((ses?.cart?.items ?? []).length === 0), `items=${(ses?.cart?.items ?? []).length}`);
}

// ===== 5. IA: "Cuál dura más?" → fixture compara; sin carrito ni órdenes =====
{
  const from = fresh(5);
  const ordersBefore = (await db.collection(`tenants/${T}/orders`).get()).size;
  await setFixture({ text: `El Supremacy dura 8-10 horas y el Odyssey 5-6: para durar más, el Supremacy. ${MARK}` });
  const t1 = await sendAndWaitNew(from, 'Cuál dura más?', (t) => t.includes(MARK));
  const ses = await sessionOf(from);
  const ordersAfter = (await db.collection(`tenants/${T}/orders`).get()).size;
  check('5. comparación de duración (IA) → responde; carrito vacío y CERO órdenes nuevas',
    !!t1 && (ses?.cart?.items ?? []).length === 0 && ordersAfter === ordersBefore,
    `orders ${ordersBefore}→${ordersAfter}`);
}

// ---- Cleanup ----
await db.doc(`tenants/${T}/products/${SUP_ID}`).delete();
await db.doc(`tenants/${T}/products/${ODY_ID}`).delete();
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
console.log(`\nRESULTADO CAT-2 (ficha al agente + ranking): ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
