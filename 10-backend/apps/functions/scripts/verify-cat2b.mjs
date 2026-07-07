/**
 * verify-cat2b.mjs — CAT-2B pregunta producto+ocasión end-to-end (emulador).
 * Reproduce la conversación REAL de prod que motivó el programa:
 *  1. "Hola quiero el perfume Odyssey Mega" (IA presenta el Odyssey; oferta pendiente = Odyssey).
 *  2. "Ese sirve para usarlo de noche?" → interceptor determinístico (SIN IA): honesto, sugiere
 *     Supremacy como alternativa, CERO listado genérico.
 *  3. "sí" → agrega la ALTERNATIVA ofrecida (Supremacy), no el Odyssey.
 *  4. "El Odyssey Mega sirve para salir de noche?" (nombrado, cliente nuevo) → mismo honesto.
 *  5. "El Supremacy sirve para salir de noche?" → "¡Sí!" + oferta del Supremacy.
 *  6. "Necesito algo para salidas nocturnas" (IA + tool real) → lastShownSkus[0] = Supremacy.
 *  7. "Quiero algo fresco para oficina" (motor) → Odyssey PRIMERO (regresión CAT-2).
 *
 * Requiere: emulador (auth+firestore+functions+storage) + seed-users + load-catalog.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const T = 'perfumeria';
const PNID = 'wa-cat2b-1';
const FIX = 'aiTestFixtures/ai';
const MARK = '[fixture-cat2b]';
const SUP_ID = 'cat2b-supremacy';
const ODY_ID = 'cat2b-odyssey';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mid = 0;
const postMsg = (from, body) => fetch(`${BASE}/metaWebhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: from, profile: { name: 'Test CAT2B' } }],
    messages: [{ from, id: `wamid.CAT2B-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }],
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
const primerProducto = (reply) => (reply ?? '').match(/\*([^*]+?) – /)?.[1] ?? '';

// ---- Snapshot + setup (idéntico a verify-cat2, ids propios) ----
const before = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const now = Timestamp.now();
const oldAssets = await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
const oldAssetDocs = oldAssets.docs.map((d) => ({ id: d.id, data: d.data() }));
for (const d of oldAssets.docs) await d.ref.delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ id: PNID, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: 'wa-cat2b', status: 'active', selected: true, createdAt: now, updatedAt: now });
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: now });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: '¡Hola! Bienvenida a Perfumería CAT2B.' }, { merge: true });
await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: now },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now },
}, { merge: true });

// Espejo de los productos REALES con las fichas de prod (incl. cuándo-NO nocturno del Odyssey).
await db.doc(`tenants/${T}/products/${SUP_ID}`).set({
  id: SUP_ID, tenantId: T, name: 'Perfume Supremacy CAT2B', description: 'Intenso de larga duración.', price: 250000,
  compareAtPrice: null, currency: 'PYG', status: 'ACTIVE', featured: false, categoryId: null, imageUrl: '',
  aiNotes: 'Extrait 100ml. Dura 8-10, proyección fuerte.',
  inventory: { trackStock: true, stock: 10, lowStockThreshold: 3, sku: SUP_ID },
  perfume: {
    brand: 'Afnan', gender: 'Unisex', styleTags: ['frutal', 'fresco', 'intenso'], olfactiveFamily: 'amaderado',
    notes: { top: ['bergamota', 'manzana verde'], heart: ['patchouli'], base: ['ambergris', 'musk'] },
    priceRange: 'MID', sizeMl: 100, isNew: false,
  },
  aiFicha: {
    concentracion: 'Extrait', duracion: '8-10 horas', proyeccion: 'fuerte',
    ocasiones: ['momentos especiales', 'ambientes abiertos'], clima: ['verano', 'otoño'],
    perfil: 'maduro, sofisticado', cuandoRecomendar: 'busca duración y presencia',
    cuandoNoRecomendar: 'cuando quiere algo suave',
  },
  createdAt: now, updatedAt: now,
});
await db.doc(`tenants/${T}/products/${ODY_ID}`).set({
  id: ODY_ID, tenantId: T, name: 'Armaf Odyssey CAT2B', description: 'Cítrico fresco.', price: 250000,
  compareAtPrice: null, currency: 'PYG', status: 'ACTIVE', featured: true, categoryId: null, imageUrl: '',
  aiNotes: 'EDP 100ml. Dura 5-6, proyección moderada.',
  inventory: { trackStock: true, stock: 3, lowStockThreshold: 3, sku: ODY_ID },
  perfume: {
    brand: 'Armaf', gender: 'Unisex', styleTags: ['amaderado', 'citrico', 'dulce'], olfactiveFamily: 'Citrico',
    notes: { top: ['naranja', 'bergamota', 'limon'], heart: ['piña', 'salvia'], base: ['almizcle', 'cedro'] },
    priceRange: 'MID', sizeMl: 100, isNew: false,
  },
  aiFicha: {
    concentracion: 'EDP', duracion: '5-6 horas', proyeccion: 'moderada',
    ocasiones: ['fresco', 'diario'], clima: ['verano', 'dia'], perfil: 'juvenil, moderno',
    cuandoRecomendar: 'busca un aroma moderno y juvenil',
    cuandoNoRecomendar: 'Si busca algo para salidas nocturnas, eventos formales o una fragancia intensa de alta proyección.',
  },
  createdAt: now, updatedAt: now,
});

const customers = [];
const fresh = (n) => { const f = `59599392${String(n).padStart(4, '0')}`; customers.push(f); return f; };

// ===== 1-3. LA CONVERSACIÓN REAL DE PROD =====
{
  const from = fresh(1);
  // Turno 1: la IA presenta el Odyssey (como pasó en prod a las 16:57).
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-cat2b-1', name: 'buscar_productos', input: { consulta: 'odyssey mega' } }] },
    { text: `Encontré el **Armaf Odyssey CAT2B** — EDP 100ml, fresco y cítrico, ideal para el día a día. ₲ 250.000. ¿Te lo agrego? ${MARK}` },
  ] });
  const t1 = await sendAndWaitNew(from, 'Hola quiero el perfume Odyssey Mega', (x) => x.includes(MARK));
  const s1 = await sessionOf(from);
  check('1. turno 1 (IA): presenta el Odyssey y deja la oferta pendiente',
    !!t1 && s1?.context?.pendingCartConfirmation?.primaryProductId === ODY_ID,
    `pending=${s1?.context?.pendingCartConfirmation?.primaryProductId}`);

  // Turno 2 (EL BUG): pregunta anafórica de ocasión → interceptor, SIN IA, SIN listado.
  await setFixture({ fail: true, failMessage: 'la IA no debe correr: responde el interceptor' });
  const t2 = await sendAndWaitNew(from, 'Ese sirve para usarlo de noche?', (x) => x.includes('Supremacy') || x.includes('opciones'));
  check('2. turno 2: respuesta HONESTA desde el motor (no complace, sugiere Supremacy)',
    !!t2 && t2.includes('no es mi primera recomendación') && t2.includes('Supremacy CAT2B'),
    JSON.stringify((t2 ?? '').slice(0, 110)));
  check('2b. CERO listado genérico ("te elegí estas opciones")', !!t2 && !t2.includes('te elegí estas opciones'));
  const s2 = await sessionOf(from);
  check('2c. la oferta pendiente pasó a la ALTERNATIVA (Supremacy)',
    s2?.context?.pendingCartConfirmation?.primaryProductId === SUP_ID,
    `pending=${s2?.context?.pendingCartConfirmation?.primaryProductId}`);
  check('2d. preguntar no tocó el carrito', ((s2?.cart?.items ?? []).length === 0));

  // Turno 3: "sí" agrega la alternativa ofrecida (Supremacy), no el Odyssey.
  const t3 = await sendAndWaitNew(from, 'sí', (x) => x.includes('Agregué'));
  const s3 = await sessionOf(from);
  const items = s3?.cart?.items ?? [];
  check('3. "sí" agrega la alternativa CORRECTA (Supremacy)',
    !!t3 && t3.includes('Supremacy CAT2B') && items.length === 1 && items[0]?.productId === SUP_ID,
    `items=${JSON.stringify(items.map((i) => i.productId))}`);
}

// ===== 4. Nombrado, cliente nuevo =====
{
  const from = fresh(2);
  await setFixture({ fail: true, failMessage: 'sin IA: interceptor' });
  const t1 = await sendAndWaitNew(from, 'El Odyssey CAT2B sirve para salir de noche?', (x) => x.includes('Supremacy') || x.includes('opciones'));
  check('4. nombrado + nuevo: honesto + alternativa (bienvenida breve delante, sin listado)',
    !!t1 && t1.includes('no es mi primera recomendación') && t1.includes('Supremacy CAT2B') && !t1.includes('te elegí estas opciones'),
    JSON.stringify((t1 ?? '').slice(0, 110)));
}

// ===== 5. El que SÍ sirve =====
{
  const from = fresh(3);
  await setFixture({ fail: true, failMessage: 'sin IA: interceptor' });
  const t1 = await sendAndWaitNew(from, 'El Supremacy CAT2B sirve para salir de noche?', (x) => x.includes('Sí'));
  const s1 = await sessionOf(from);
  check('5. "¿Supremacy para la noche?" → "¡Sí!" con motivo de ficha + oferta del consultado',
    !!t1 && t1.includes('¡Sí!') && t1.includes('busca duración y presencia') &&
    s1?.context?.pendingCartConfirmation?.primaryProductId === SUP_ID,
    JSON.stringify((t1 ?? '').slice(0, 100)));
}

// ===== 6. "salidas nocturnas" (IA + tool real): ranking Supremacy primero =====
{
  const from = fresh(4);
  await setFixture({ responses: [
    { toolUses: [{ id: 'tu-cat2b-2', name: 'buscar_productos', input: { consulta: 'algo para salidas nocturnas' } }] },
    { text: `Para salidas nocturnas te recomiendo el Perfume Supremacy CAT2B, proyecta fuerte y dura 8-10 horas. ${MARK}` },
  ] });
  const t1 = await sendAndWaitNew(from, 'Necesito algo para salidas nocturnas', (x) => x.includes(MARK));
  const s1 = await sessionOf(from);
  const shown = s1?.context?.lastShownSkus ?? [];
  check('6. tool real con "salidas nocturnas" → Supremacy PRIMERO en lastShownSkus',
    !!t1 && shown[0] === SUP_ID, `shown=${JSON.stringify(shown)}`);
}

// ===== 7. Regresión CAT-2: oficina → Odyssey primero (listado del motor) =====
{
  const from = fresh(5);
  await setFixture({ fail: true, failMessage: 'motor determinístico' });
  const t1 = await sendAndWaitNew(from, 'Quiero algo fresco para oficina', (x) => x.includes('opciones'));
  check('7. "fresco para oficina" → listado con Odyssey PRIMERO (CAT-2 intacto)',
    !!t1 && primerProducto(t1).includes('Odyssey'), `1ro=${JSON.stringify(primerProducto(t1))}`);
}

// Órdenes: el programa completo no creó ninguna.
{
  const orders = await db.collection(`tenants/${T}/orders`).get();
  const nuestras = orders.docs.filter((d) => customers.some((f) => (d.data().customerId ?? '') === cid(f)));
  check('8. CERO órdenes creadas durante el E2E', nuestras.length === 0, `orders=${nuestras.length}`);
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
console.log(`\nRESULTADO CAT-2B (pregunta producto+ocasión): ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
