/**
 * verify-handoff2.mjs — HANDOFF-2 end-to-end (emulador): el CLIENTE pide una persona.
 * El bug de prod que cierra: "quiero hablar con Aaron Sosa nuevamente" → la IA prometía el
 * pase y humanTakeover quedaba en false (el vendedor nunca se enteraba).
 *
 *  1. Pedido por NOMBRE configurado → takeover PERSISTIDO (sesión + resumen) con razón
 *     customer_requested, vendedor asignado y confirmación honesta DESPUÉS de persistir.
 *  2. Notificación al panel: exactamente UNA, con id determinístico (wamid).
 *  3. Webhook con el MISMO wamid repetido → cero confirmaciones/avisos nuevos (dedup).
 *  4. Bot en SILENCIO durante el takeover (y la IA jamás corre: el fixture no aparece).
 *  5. chatRelease → el bot vuelve a responder el próximo mensaje.
 *  6. "quiero hablar NUEVAMENTE con..." → nuevo handoff válido + segunda notificación.
 *  7. Negación ("no necesito hablar con un vendedor") → NO deriva; el bot sigue.
 *  8. Nombre desconocido → honestidad, sin takeover, sin promesa de pase.
 *
 * Requiere: emulador (auth+firestore+functions) + seed-users + load-catalog (tenant perfumeria).
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
const PNID = '900000000000088';
const CUST = '595993600001';
const CUST2 = '595993600002';
const FIX = 'aiTestFixtures/ai';
const AI_MARK = '[fixture-h2]';

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
const postText = async (from, body, wamid) => fetch(`${BASE}/metaWebhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: from, profile: { name: 'Cliente H2' } }],
    messages: [{ from, id: wamid ?? `wamid.H2-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }],
  } }] }] }),
});
const msgsOf = async (c) => (await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs
  .map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
const sessionOf = async (c) => (await db.doc(`tenants/${T}/customers/${c}/sessions/active`).get()).data();
const notifsHandoff = async () => (await db.collection(`tenants/${T}/notifications`).get()).docs
  .map((d) => ({ id: d.id, ...d.data() })).filter((n) => n.category === 'handoff' && [CUST, CUST2].includes(n.customerId));
const waitFor = async (pred, maxMs = 15000) => { const end = Date.now() + maxMs; while (Date.now() < end) { if (await pred()) return true; await sleep(600); } return false; };

// ---- Snapshot (convivencia con otros verifies) ----
const beforeTenant = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeCheckout = (await db.doc(`tenants/${T}/config/checkout`).get()).data() ?? null;

await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: Timestamp.now() },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, currentPeriodStart: Timestamp.now() },
}, { merge: true });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot H2' }, { merge: true });
await db.doc(`tenants/${T}/config/checkout`).set({
  sellers: [{ name: 'Aaron Test', whatsapp: '595991000001', active: true }, { name: 'Marta Demo', whatsapp: '595991000002', active: true }],
}, { merge: true });
await db.doc(FIX).set({ text: `Respuesta IA ${AI_MARK}` }); // si la IA corriera, el marker aparecería

const admin = await signIn('superadmin@aiafg.com');
const rConn = await call('adminSetManualWhatsappConnection', admin, {
  tenantId: T, wabaId: 'WABA-H2-1', phoneNumberId: PNID, displayPhoneNumber: '+595 991 000 088',
  businessName: 'H2 Test', accessToken: 'tok-h2-e2e-NUNCA-persistir',
});
if (!rConn.result?.ok) { console.error('setup: conexión manual falló', rConn); process.exit(1); }
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'active' }, { merge: true });

// ===== 1. Pedido por NOMBRE → takeover persistido + confirmación =====
await postText(CUST, 'hola');
await waitFor(async () => (await msgsOf(CUST)).some((m) => m.direction === 'out'));
const WAMID_PEDIDO = `wamid.H2-PEDIDO-${Date.now()}`;
await postText(CUST, 'Quiero hablar con Aaron Test', WAMID_PEDIDO);
const confirmado = await waitFor(async () => (await msgsOf(CUST)).some((m) => m.text?.includes('Te paso con Aaron Test')));
const ses1 = await sessionOf(CUST);
const cust1 = (await db.doc(`tenants/${T}/customers/${CUST}`).get()).data();
check('1. pedido por nombre → takeover PERSISTIDO con razón customer_requested + vendedor + confirmación',
  confirmado && ses1?.context?.humanTakeover === true &&
  ses1?.context?.handoffReason === 'customer_requested' &&
  ses1?.context?.handoffSellerName === 'Aaron Test' &&
  cust1?.conversation?.humanTakeover === true && cust1?.assignedSellerName === 'Aaron Test',
  `takeover=${ses1?.context?.humanTakeover} reason=${ses1?.context?.handoffReason} asignado=${cust1?.assignedSellerName}`);

// ===== 2. Notificación única con id determinístico =====
const n1 = await notifsHandoff();
check('2. exactamente UNA notificación de handoff, con id determinístico por wamid',
  n1.length === 1 && n1[0].id.includes(CUST) && n1[0].customerId === CUST && !n1[0].body.includes(CUST),
  `count=${n1.length} id=${n1[0]?.id?.slice(0, 40)}`);

// ===== 3. Webhook REPETIDO (mismo wamid) → sin duplicados =====
await postText(CUST, 'Quiero hablar con Aaron Test', WAMID_PEDIDO);
await sleep(2500);
const msgs3 = await msgsOf(CUST);
const confirmaciones = msgs3.filter((m) => m.text?.includes('Te paso con Aaron Test')).length;
const n3 = await notifsHandoff();
check('3. wamid repetido → UNA sola confirmación y UNA sola notificación (dedup)',
  confirmaciones === 1 && n3.length === 1, `confirmaciones=${confirmaciones} notifs=${n3.length}`);

// ===== 4. Bot en silencio durante takeover (y la IA jamás corre) =====
const outsAntes = (await msgsOf(CUST)).filter((m) => m.direction === 'out').length;
await postText(CUST, 'sigo esperando, hay alguien?');
await sleep(3000);
const msgs4 = await msgsOf(CUST);
const outsDespues = msgs4.filter((m) => m.direction === 'out').length;
check('4. bot SILENCIOSO en takeover (inbound persistido, cero outbound nuevos, cero IA)',
  outsDespues === outsAntes && msgs4.some((m) => m.text === 'sigo esperando, hay alguien?') &&
  !msgs4.some((m) => m.text?.includes(AI_MARK)),
  `outs ${outsAntes}→${outsDespues}`);

// ===== 5. chatRelease → el bot vuelve =====
const seller = await signIn('seller@perfumeria.com');
const rRel = await call('chatRelease', seller, { tenantId: T, customerId: CUST });
const ses5 = await sessionOf(CUST);
await postText(CUST, 'hola de nuevo');
const volvio = await waitFor(async () => (await msgsOf(CUST)).some((m) => m.text?.includes('Hola de nuevo') || m.text?.includes('¿Te ayudo')));
check('5. liberación manual → handoffReason limpio y el bot RETOMA el próximo mensaje',
  rRel.result?.ok === true && ses5?.context?.humanTakeover === false && ses5?.context?.handoffReason === null && volvio,
  `release=${rRel.result?.ok} reason=${ses5?.context?.handoffReason}`);

// ===== 6. "NUEVAMENTE" → nuevo handoff válido =====
await postText(CUST, 'Quiero hablar nuevamente con Aaron Test');
const confirmado6 = await waitFor(async () =>
  (await msgsOf(CUST)).filter((m) => m.text?.includes('Te paso con Aaron Test')).length === 2);
const ses6 = await sessionOf(CUST);
const n6 = await notifsHandoff();
check('6. "nuevamente" tras la liberación → NUEVO handoff + SEGUNDA notificación',
  confirmado6 && ses6?.context?.humanTakeover === true && n6.length === 2,
  `takeover=${ses6?.context?.humanTakeover} notifs=${n6.length}`);

// ===== 7. Negación NO deriva (cliente 2, sesión limpia) =====
await postText(CUST2, 'hola');
await waitFor(async () => (await msgsOf(CUST2)).some((m) => m.direction === 'out'));
await postText(CUST2, 'no necesito hablar con un vendedor, quiero ver el catálogo');
const respondioNormal = await waitFor(async () => (await msgsOf(CUST2)).some((m) => m.text?.includes('Mirá, te elegí')));
const ses7 = await sessionOf(CUST2);
check('7. negación → NO deriva: el bot atiende normal y humanTakeover sigue false',
  respondioNormal && ses7?.context?.humanTakeover !== true,
  `takeover=${ses7?.context?.humanTakeover}`);

// ===== 8. Nombre DESCONOCIDO → honestidad sin takeover =====
await postText(CUST2, 'quiero hablar con Zutano Beltran');
const honesto = await waitFor(async () => (await msgsOf(CUST2)).some((m) => m.text?.includes('No tengo a nadie llamado Zutano')));
const ses8 = await sessionOf(CUST2);
const outsCliente2 = (await msgsOf(CUST2)).filter((m) => m.direction === 'out');
check('8. nombre desconocido → respuesta honesta, sin takeover ni promesa de pase',
  honesto && ses8?.context?.humanTakeover !== true &&
  !outsCliente2.some((m) => m.text?.includes('Te paso con')),
  `takeover=${ses8?.context?.humanTakeover}`);

// ---- Restaurar estado (convivencia) ----
await db.doc(FIX).delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete().catch(() => {});
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete().catch(() => {});
await db.doc(`tenants/${T}`).set(beforeTenant);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();
if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent); else await db.doc(`tenants/${T}/config/agent`).delete();
if (beforeCheckout) await db.doc(`tenants/${T}/config/checkout`).set(beforeCheckout); else await db.doc(`tenants/${T}/config/checkout`).delete();
for (const n of await notifsHandoff()) await db.doc(`tenants/${T}/notifications/${n.id}`).delete().catch(() => {});

const ok = results.every(Boolean);
console.log(`\nRESULTADO HANDOFF-2 (pedido de humano): ${ok ? `TODO OK ✅ (${results.length}/${results.length})` : `FALLOS ❌ (${results.filter(Boolean).length}/${results.length})`}`);
process.exit(ok ? 0 : 1);
