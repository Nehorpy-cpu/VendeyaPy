/**
 * verify-coverage-state.mjs — COVERAGE-1B end-to-end (emulador limpio).
 * Máquina de cobertura ANTES del pago: flag OFF ⇒ checkout intacto; flag ON ⇒ "pagar" pide
 * ubicación (nativa o dirección escrita) SIN crear orden ni mostrar banco, y la ubicación
 * registrada deriva a revisión humana (handoff coverage_review + campana), con la ubicación
 * exacta SOLO en coverageRequests (jamás en historial/IA/notificaciones).
 *
 * Requiere: emulador (auth+functions+firestore) + seed-users + load-catalog (tenant perfumeria).
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
const PNID = '900000000000102';
const FIX = 'aiTestFixtures/ai';
const AI_MARK = '[fixture-cov]';
const LAT = -25.28646;
const LNG = -57.64701;

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null };
}
let mid = 0;
const wa = (from, messages) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
  contacts: [{ wa_id: from, profile: { name: 'Cliente COV' } }], messages,
} }] }] });
const postText = (from, body, wamid) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(wa(from, [{ from, id: wamid ?? `wamid.COV-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }])) });
const postLocation = (from, loc, wamid) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(wa(from, [{ from, id: wamid ?? `wamid.COVLOC-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'location', location: loc }])) });

const msgsOf = async (c) => (await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs
  .map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
const lastOut = async (c) => { const o = (await msgsOf(c)).filter((m) => m.direction === 'out'); return o.length ? o[o.length - 1].text : null; };
const outsCount = async (c) => (await msgsOf(c)).filter((m) => m.direction === 'out').length;
const sessionOf = async (c) => (await db.doc(`tenants/${T}/customers/${c}/sessions/active`).get()).data();
const requestsOf = async (c) => (await db.collection(`tenants/${T}/coverageRequests`).where('customerId', '==', c).get()).docs.map((d) => d.data());
const ordersOf = async (c) => (await db.collection(`tenants/${T}/orders`).where('customerId', '==', c).get()).size;
const notifsCov = async (c) => (await db.collection(`tenants/${T}/notifications`).get()).docs
  .map((d) => ({ id: d.id, ...d.data() })).filter((n) => n.type === 'handoff_coverage_review' && n.customerId === c);
const aiCount = async () => (await db.collection(`tenants/${T}/aiRequests`).get()).size;
const waitFor = async (pred, maxMs = 15000) => { const end = Date.now() + maxMs; while (Date.now() < end) { if (await pred()) return true; await sleep(600); } return false; };
// Devuelve la respuesta NUEVA del turno, o null si el bot no respondió (review: sin falsos verdes
// con el lastOut viejo cuando expira el timeout).
const sendAndWait = async (from, text, maxMs = 15000) => { const antes = await outsCount(from); await postText(from, text); const ok = await waitFor(async () => (await outsCount(from)) > antes, maxMs); return ok ? lastOut(from) : null; };
const armarCarrito = async (from) => {
  await postText(from, 'hola');
  await waitFor(async () => (await outsCount(from)) > 0);
  const r = await sendAndWait(from, 'agregá la belle');
  if (!(r ?? '').includes('Agregué')) { console.error(`setup carrito falló para …${from.slice(-4)}: ${JSON.stringify((r ?? '').slice(0, 60))}`); }
};
const setCoverage = (coverage) => db.doc(`tenants/${T}/config/checkout`).set({
  sellers: [{ name: 'Vendedor COV', whatsapp: '595991000012', active: true }],
  bankAccounts: [{ bank: 'Banco COV', accountNumber: '000-1', holder: 'Titular COV', document: '1111' }],
  ...(coverage !== undefined ? { coverage } : {}),
});

// ---- Snapshot + setup ----
const beforeTenant = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeCheckout = (await db.doc(`tenants/${T}/config/checkout`).get()).data() ?? null;
const now0 = Timestamp.now();
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot COV' }, { merge: true });
await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: now0 },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now0 },
}, { merge: true });
await db.doc(FIX).set({ text: `Respuesta IA ${AI_MARK}` }); // si la IA corriera en cobertura, aparecería

// Conexión manual con credenciales (para que el mock resuelva el phone_number_id → check del
// envío por el MISMO número). Mismo patrón que verify-ai-fallback/coverage-guard.
const admin = await signIn('superadmin@aiafg.com');
const rConn = await call('adminSetManualWhatsappConnection', admin, {
  tenantId: T, wabaId: 'WABA-COV', phoneNumberId: PNID, displayPhoneNumber: '+595 991 000 102',
  businessName: 'COV Test', accessToken: 'tok-cov-NUNCA-persistir',
});
if (!rConn.result?.ok) { console.error('setup: conexión manual falló', rConn); process.exit(1); }
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'active' }, { merge: true });
const ai0 = await aiCount();

const CUST = (n) => `59599400${String(n).padStart(4, '0')}`;

// ===== 1. FLAG OFF: checkout intacto (orden + banco) y cero coverageRequests =====
await setCoverage(undefined);
const A = CUST(1);
await armarCarrito(A);
const rA = await sendAndWait(A, 'quiero pagar');
check('1. flag OFF → "pagar" crea orden y muestra banco (checkout intacto), cero requests',
  (rA ?? '').includes('transferir') && (await ordersOf(A)) === 1 && (await requestsOf(A)).length === 0,
  `orders=${await ordersOf(A)} reqs=${(await requestsOf(A)).length}`);

// ===== 2. FLAG OFF: ubicación entrante → respuesta honesta, sin request, sin coords =====
const A2 = CUST(2);
await postText(A2, 'hola');
await waitFor(async () => (await outsCount(A2)) > 0);
await postLocation(A2, { latitude: LAT, longitude: LNG });
await waitFor(async () => (await outsCount(A2)) > 1);
const rA2 = await lastOut(A2);
const msgsA2 = await msgsOf(A2);
check('2. flag OFF → ubicación: respuesta honesta, sin request, placeholder sin coordenadas',
  (rA2 ?? '').includes('no puedo procesarla') && (await requestsOf(A2)).length === 0 &&
  msgsA2.some((m) => m.text === '📍 Ubicación recibida') && !msgsA2.some((m) => /25\.28|57\.64/.test(m.text ?? '')),
  JSON.stringify((rA2 ?? '').slice(0, 50)));

// ===== FLAG ON de acá en adelante =====
await setCoverage({ enabled: true, expiryHours: 24 });

// ===== 3. "pagar" → awaiting_location SIN orden ni banco; botón nativo por el MISMO número =====
const B = CUST(3);
await armarCarrito(B);
const rB = await sendAndWait(B, 'quiero pagar');
const reqsB = await requestsOf(B);
const sesB = await sessionOf(B);
// La traza del mock se escribe cuando process.ts ENVÍA (después del out del historial): esperarla.
await waitFor(async () => ((await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).get()).data() ?? {}).kind === 'location_request', 8000);
const trace = (await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).get()).data() ?? {};
check('3. flag ON → "pagar" pide ubicación: cero órdenes/banco, request awaiting + puntero en sesión',
  (rB ?? '').includes('ciudad') && !(rB ?? '').includes('transferir') && (await ordersOf(B)) === 0 &&
  reqsB.length === 1 && reqsB[0].status === 'awaiting_location' && reqsB[0].location === null &&
  sesB?.context?.coverage?.requestId === reqsB[0].id,
  `reqs=${reqsB.length} status=${reqsB[0]?.status} orders=${await ordersOf(B)}`);
check('4. la solicitud intentó el botón NATIVO por el mismo número (mock trace location_request)',
  trace.kind === 'location_request' && trace.phoneNumberId === PNID && trace.to === B,
  `kind=${trace.kind} pnid=${trace.phoneNumberId}`);

// ===== 5. Dos "pagar" CONCURRENTES → un solo request =====
const C = CUST(4);
await armarCarrito(C);
await Promise.all([
  postText(C, 'quiero pagar', `wamid.COVC-1-${Date.now()}`),
  postText(C, 'quiero pagar', `wamid.COVC-2-${Date.now()}`),
]);
await sleep(4000);
const reqsC = await requestsOf(C);
check('5. dos "pagar" concurrentes → UN solo request (transacción sobre la sesión)',
  reqsC.length === 1 && (await ordersOf(C)) === 0, `reqs=${reqsC.length}`);

// ===== 6. Ubicación nativa válida → pending review + handoff coverage_review =====
const WAMID_LOC = `wamid.COVLOC-B-${Date.now()}`;
await postLocation(B, { latitude: LAT, longitude: LNG, name: 'Mi casa', address: 'Av. Privada 111' }, WAMID_LOC);
const derivoB = await waitFor(async () => ((await lastOut(B)) ?? '').includes('Recibí tu ubicación'));
const reqB2 = (await requestsOf(B))[0];
const sesB2 = await sessionOf(B);
check('6. ubicación nativa → request pending_coverage_review con coords + fingerprint geo',
  derivoB && reqB2.status === 'pending_coverage_review' && reqB2.location?.coordinates?.lat === LAT &&
  reqB2.location?.source === 'whatsapp_location' && String(reqB2.locationFingerprint).startsWith('geo:') &&
  reqB2.sourceMessageId === WAMID_LOC,
  `status=${reqB2?.status} fp=${reqB2?.locationFingerprint}`);
check('7. handoff coverage_review con sourceId = requestId (no el wamid)',
  sesB2?.context?.humanTakeover === true && sesB2?.context?.handoffReason === 'coverage_review' &&
  sesB2?.context?.handoffSourceId === reqB2.id,
  `reason=${sesB2?.context?.handoffReason} sourceId=${String(sesB2?.context?.handoffSourceId).slice(0, 18)}`);
const notifsB = await notifsCov(B);
check('8. notificación handoff_coverage_review deduplicada POR WAMID',
  notifsB.length === 1 && notifsB[0].id.includes(WAMID_LOC.slice(-20)),
  `notifs=${notifsB.length}`);

// ===== 9. Wamid repetido → cero efectos duplicados =====
const outsB = await outsCount(B);
await postLocation(B, { latitude: LAT, longitude: LNG }, WAMID_LOC);
await sleep(2500);
check('9. mismo wamid repetido → sin mensajes ni notificaciones nuevas',
  (await outsCount(B)) === outsB && (await notifsCov(B)).length === 1);

// ===== 9b. El inbox ANULÓ payload.location al procesar (privacidad) =====
const inboxId = ('whatsapp_' + WAMID_LOC).replace(new RegExp('[^A-Za-z0-9_.:=+-]', 'g'), '_').slice(0, 256);
const inboxDoc = (await db.doc(`metaWebhookInbox/${inboxId}`).get()).data() ?? {};
check('9b. el inbox anuló payload.location al terminar (la ubicación exacta no queda retenida)',
  inboxDoc.processingStatus === 'processed' && (inboxDoc.payload?.location ?? null) === null,
  `status=${inboxDoc.processingStatus} loc=${JSON.stringify(inboxDoc.payload?.location ?? null)}`);

// ===== 9c. Liberado el chat, "pagar" con revisión pendiente NO re-crea ni muestra banco =====
const ownerX = await signIn('owner@perfumeria.com');
await call('chatRelease', ownerX, { tenantId: T, customerId: B });
const rBpend = await sendAndWait(B, 'quiero pagar');
check('9c. "pagar" con revisión pendiente → "en revisión", sin request nuevo ni banco',
  (rBpend ?? '').includes('revisión') && (await requestsOf(B)).length === 1 && (await ordersOf(B)) === 0,
  JSON.stringify((rBpend ?? '').slice(0, 50)));

// ===== 10. La ubicación exacta JAMÁS sale del coverageRequest =====
const msgsB = await msgsOf(B);
const notifTexts = JSON.stringify(await notifsCov(B));
check('10. historial solo placeholder; ni mensajes ni notificaciones contienen coordenadas/dirección',
  msgsB.some((m) => m.text === '📍 Ubicación recibida') &&
  !msgsB.some((m) => /25\.28|57\.64|Privada 111/.test(m.text ?? '')) &&
  !/25\.28|57\.64|Privada 111/.test(notifTexts));
check('11. cero llamadas de IA en todo el flujo de cobertura', (await aiCount()) === ai0, `ai=${(await aiCount()) - ai0}`);

// ===== 12. Ubicación SIN request activo (flag ON) =====
const D = CUST(5);
await postText(D, 'hola');
await waitFor(async () => (await outsCount(D)) > 0);
await postLocation(D, { latitude: LAT, longitude: LNG });
await waitFor(async () => (await outsCount(D)) > 1);
check('12. ubicación sin checkout iniciado → honesto ("primero armá tu pedido"), sin request ni coords',
  ((await lastOut(D)) ?? '').includes('pagar') && (await requestsOf(D)).length === 0 &&
  !(await msgsOf(D)).some((m) => /25\.28|57\.64/.test(m.text ?? '')));

// ===== 13. Dirección ESCRITA =====
const E = CUST(6);
await armarCarrito(E);
await sendAndWait(E, 'quiero pagar');
const DIR = 'Av. España 1234 casi San Martín, Luque, portón negro';
const rE = await sendAndWait(E, DIR);
const reqE = (await requestsOf(E))[0];
const msgsE = await msgsOf(E);
check('13. dirección escrita → pending review (source text) + placeholder (jamás la dirección en el historial)',
  (rE ?? '').includes('Recibí tu ubicación') && reqE?.status === 'pending_coverage_review' &&
  reqE?.location?.source === 'text' && reqE?.location?.addressText === DIR &&
  String(reqE?.locationFingerprint).startsWith('txt:') &&
  msgsE.some((m) => m.text === '📍 Dirección recibida') && !msgsE.some((m) => (m.text ?? '').includes('España 1234')),
  `status=${reqE?.status} src=${reqE?.location?.source}`);

// ===== 14. Texto ambiguo → re-pedir; 15. cancelación → terminal + bot normal =====
const F = CUST(7);
await armarCarrito(F);
await sendAndWait(F, 'quiero pagar');
const rFcomo = await sendAndWait(F, '¿cómo comparto la ubicación?');
check('13b. "¿cómo comparto?" → re-instrucciones (con alternativa textual), sigue awaiting',
  (rFcomo ?? '').includes('ciudad') && (await requestsOf(F))[0]?.status === 'awaiting_location');
const rF1 = await sendAndWait(F, 'asdf');
const reqF1 = (await requestsOf(F))[0];
check('14. texto ambiguo → re-pedir formato (sin IA, sin orden, sin handoff); request sigue awaiting',
  (rF1 ?? '').includes('ciudad') && reqF1?.status === 'awaiting_location' && (await ordersOf(F)) === 0 &&
  (await sessionOf(F))?.context?.humanTakeover !== true);
const rF2 = await sendAndWait(F, 'mejor no, dejalo');
const reqF2 = (await requestsOf(F))[0];
const rF3 = await sendAndWait(F, 'hola');
check('15. cancelación → coverage_cancelled + el bot sigue normal',
  (rF2 ?? '').includes('pausa') && reqF2?.status === 'coverage_cancelled' && /hola/i.test(rF3 ?? ''),
  `status=${reqF2?.status}`);

// ===== 16. Pedido de VENDEDOR durante la espera → HANDOFF-2 intacto =====
const G = CUST(8);
await armarCarrito(G);
await sendAndWait(G, 'quiero pagar');
const rG = await sendAndWait(G, 'Quiero hablar con un vendedor');
const sesG = await sessionOf(G);
check('16. "quiero un vendedor" en la espera → HANDOFF-2 (customer_requested); el request queda awaiting',
  (rG ?? '').includes('Te paso con') && sesG?.context?.handoffReason === 'customer_requested' &&
  (await requestsOf(G))[0]?.status === 'awaiting_location',
  `reason=${sesG?.context?.handoffReason}`);

// ===== 17. Catálogo durante la espera → flujo normal (no se toma como dirección) =====
const H = CUST(9);
await armarCarrito(H);
await sendAndWait(H, 'quiero pagar');
const rH = await sendAndWait(H, 'catálogo');
const reqH = (await requestsOf(H))[0];
check('17. "catálogo" en la espera → responde el catálogo; el request sigue awaiting y el puntero sobrevive',
  !!rH && !rH.includes('ciudad, barrio') && reqH?.status === 'awaiting_location' && reqH?.location === null &&
  !(await msgsOf(H)).some((m) => m.text === '📍 Dirección recibida') &&
  (await sessionOf(H))?.context?.coverage?.requestId === reqH?.id);

// ===== 18. Falla del interactivo → UN solo fallback textual =====
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).set({ failLocationRequest: true });
const I = CUST(10);
await armarCarrito(I);
const atAntesI = (((await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).get()).data() ?? {}).at?.toMillis?.()) ?? 0;
const rI = await sendAndWait(I, 'quiero pagar');
await waitFor(async () => { const d = (await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).get()).data() ?? {}; return d.to === I && ((d.at?.toMillis?.() ?? 0) > atAntesI); }, 8000);
const traceI = (await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).get()).data() ?? {};
check('18. interactivo falla → fallback TEXTUAL NUEVO con el mismo texto; request creado igual',
  (rI ?? '').includes('ciudad') && traceI.kind !== 'location_request' && traceI.to === I &&
  ((traceI.at?.toMillis?.() ?? 0) > atAntesI) && (await requestsOf(I))[0]?.status === 'awaiting_location',
  `traceKind=${traceI.kind ?? '(text)'}`);
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).delete();

// ===== 19. Takeover MANUAL vigente → la ubicación no lo pisa (bot silencioso) =====
const J = CUST(11);
await armarCarrito(J);
await sendAndWait(J, 'quiero pagar');
const owner = await signIn('owner@perfumeria.com');
const rTake = await call('chatTakeover', owner, { tenantId: T, customerId: J });
const outsJ = await outsCount(J);
await postLocation(J, { latitude: LAT, longitude: LNG });
await sleep(3000);
const sesJ = await sessionOf(J);
const reqJ = (await requestsOf(J))[0];
check('19. takeover manual vigente → ubicación registrada SIN pisar el takeover y SIN respuesta del bot',
  rTake.result?.ok === true && sesJ?.context?.handoffReason === 'seller_manual' &&
  reqJ?.status === 'pending_coverage_review' && (await outsCount(J)) === outsJ,
  `reason=${sesJ?.context?.handoffReason} status=${reqJ?.status} outs ${outsJ}→${await outsCount(J)}`);
await call('chatRelease', owner, { tenantId: T, customerId: J });

// ===== 20. Request EXPIRADO → no acepta ubicación =====
const K = CUST(12);
await armarCarrito(K);
await sendAndWait(K, 'quiero pagar');
const reqK = (await requestsOf(K))[0];
await db.doc(`tenants/${T}/coverageRequests/${reqK.id}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
await postLocation(K, { latitude: LAT, longitude: LNG });
await waitFor(async () => ((await lastOut(K)) ?? '').includes('venció'));
const reqK2 = (await requestsOf(K))[0];
check('20. request expirado → ubicación rechazada con honestidad y estado coverage_expired',
  ((await lastOut(K)) ?? '').includes('venció') && reqK2?.status === 'coverage_expired' && reqK2?.location === null,
  `status=${reqK2?.status}`);

// ===== 21. COVERAGE-GUARD sigue activo con el flag ON =====
const L = CUST(13);
await postText(L, 'hola');
await waitFor(async () => (await outsCount(L)) > 0);
const rL = await sendAndWait(L, '¿Hacen envíos al interior del país?');
check('21. COVERAGE-GUARD activo: consulta de envíos → respuesta segura (sin IA)',
  (rL ?? '').includes('deben ser confirmados por el equipo') && !(rL ?? '').includes(AI_MARK));

// ===== 22. Aislamiento por tenant: todos los requests viven bajo tenants/perfumeria =====
const todosReqs = (await db.collection(`tenants/${T}/coverageRequests`).get()).docs.map((d) => d.data());
check('22. aislamiento: todos los requests llevan el tenantId correcto y viven bajo su tenant',
  todosReqs.length >= 6 && todosReqs.every((r) => r.tenantId === T), `reqs=${todosReqs.length}`);

// ---- Cleanup (convivencia con otros verifies) ----
for (const c of [CUST(6), CUST(8)]) await call('chatRelease', ownerX, { tenantId: T, customerId: c }).catch(() => {});
await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).delete().catch(() => {});
await db.doc(FIX).delete().catch(() => {});
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete().catch(() => {});
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete().catch(() => {});
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).delete().catch(() => {});
await db.doc(`tenants/${T}`).set(beforeTenant);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();
if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent); else await db.doc(`tenants/${T}/config/agent`).delete();
if (beforeCheckout) await db.doc(`tenants/${T}/config/checkout`).set(beforeCheckout); else await db.doc(`tenants/${T}/config/checkout`).delete();
{
  const notifs = await db.collection(`tenants/${T}/notifications`).get();
  for (const d of notifs.docs) { if ((d.data().category ?? '') === 'handoff' && String(d.data().customerId ?? '').startsWith('59599400')) await d.ref.delete().catch(() => {}); }
}

const ok = results.every(Boolean);
console.log(`\nRESULTADO COVERAGE-1B (máquina de cobertura, flag off/on): ${ok ? `TODO OK ✅ (${results.length}/${results.length})` : `FALLOS ❌ (${results.filter(Boolean).length}/${results.length})`}`);
process.exit(ok ? 0 : 1);
