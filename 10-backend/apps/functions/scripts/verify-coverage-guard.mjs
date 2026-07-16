/**
 * verify-coverage-guard.mjs — COVERAGE-GUARD-1 end-to-end (emulador).
 * Consultas de cobertura/costo/plazo de envío → respuesta SEGURA determinística, sin IA, sin
 * handoff automático y sin tocar nada comercial. Si el cliente luego pide una persona, HANDOFF-2
 * hace el pase real. Con la IA DISPONIBLE (fixture activo): el guard gana antes de delegar.
 *
 *  1. saludo → bienvenida normal.
 *  2. "¿Hacen envíos al interior del país?" → respuesta segura, CERO IA, CERO handoff/notifs.
 *  3. "¿Llegan a Encarnación?" → misma respuesta segura; contador de IA sigue igual.
 *  4. consulta NO logística ("cuando llega mi pedido?") → SÍ va a la IA (el guard no sobre-bloquea).
 *  5. "Quiero hablar con un vendedor" → HANDOFF-2 real (takeover + notificación).
 *  6. mensaje durante takeover → silencio.
 *  7. chatRelease → el bot retoma.
 *  8. cero mutaciones comerciales (sin órdenes, carrito vacío).
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
const PNID = '900000000000101';
const CUST = '595993950001';
const FIX = 'aiTestFixtures/ai';
const AI_MARK = '[fixture-cg]';
const SAFE_MARK = 'deben ser confirmados por el equipo';

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
    contacts: [{ wa_id: from, profile: { name: 'Cliente CG' } }],
    messages: [{ from, id: wamid ?? `wamid.CG-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }],
  } }] }] }),
});
const msgsOf = async (c) => (await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs
  .map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
const lastOut = async (c) => { const outs = (await msgsOf(c)).filter((m) => m.direction === 'out'); return outs.length ? outs[outs.length - 1].text : null; };
const sessionOf = async (c) => (await db.doc(`tenants/${T}/customers/${c}/sessions/active`).get()).data();
const notifsHandoff = async () => (await db.collection(`tenants/${T}/notifications`).get()).docs
  .map((d) => ({ id: d.id, ...d.data() })).filter((n) => n.category === 'handoff' && n.customerId === CUST);
const aiCount = async () => (await db.collection(`tenants/${T}/aiRequests`).get()).size;
const waitFor = async (pred, maxMs = 15000) => { const end = Date.now() + maxMs; while (Date.now() < end) { if (await pred()) return true; await sleep(600); } return false; };

// ---- Snapshot + setup: IA DISPONIBLE (el guard debe ganar ANTES de la IA) ----
const beforeTenant = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeCheckout = (await db.doc(`tenants/${T}/config/checkout`).get()).data() ?? null;

await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: Timestamp.now() },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, currentPeriodStart: Timestamp.now() }, // cuota DISPONIBLE
}, { merge: true });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({
  botEnabled: true,
  greetingMessage: 'Hola, soy el bot CG',
  // FAQ genérica de envíos (la del hallazgo real): el guard debe ganar aunque exista.
  faq: [{ q: '¿Hacen envíos?', a: 'Sí, coordinamos el envío al confirmar el pedido.' }],
}, { merge: true });
await db.doc(`tenants/${T}/config/checkout`).set({ sellers: [{ name: 'Vendedor CG', whatsapp: '595991000011', active: true }] }, { merge: true });
await db.doc(FIX).set({ text: `Respuesta IA ${AI_MARK}` }); // si la IA corriera, aparecería el marker

const admin = await signIn('superadmin@aiafg.com');
const rConn = await call('adminSetManualWhatsappConnection', admin, {
  tenantId: T, wabaId: 'WABA-CG', phoneNumberId: PNID, displayPhoneNumber: '+595 991 000 101',
  businessName: 'CG Test', accessToken: 'tok-cg-NUNCA-persistir',
});
if (!rConn.result?.ok) { console.error('setup: conexión manual falló', rConn); process.exit(1); }
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'active' }, { merge: true });

// ===== 1. Saludo normal =====
await postText(CUST, 'hola');
const saludo = await waitFor(async () => (await msgsOf(CUST)).some((m) => m.direction === 'out'));
check('1. saludo → bienvenida normal', saludo);

// ===== 2. Consulta de cobertura → respuesta segura, cero IA, cero handoff =====
const ai0 = await aiCount();
await postText(CUST, '¿Hacen envíos al interior del país?');
const seguro2 = await waitFor(async () => ((await lastOut(CUST)) ?? '').includes(SAFE_MARK));
const r2 = await lastOut(CUST);
const ses2 = await sessionOf(CUST);
check('2. cobertura → respuesta segura determinística, sin afirmar cobertura y SIN IA',
  seguro2 && !r2.includes(AI_MARK) && !/llegamos|s[ií],? hacemos env[ií]os|todo el pa[ií]s/i.test(r2) &&
  (await aiCount()) === ai0 && ses2?.context?.humanTakeover !== true && (await notifsHandoff()).length === 0,
  `ai=${(await aiCount()) - ai0} takeover=${ses2?.context?.humanTakeover ?? false}`);

// ===== 3. Variante con lugar → misma respuesta segura (en un out NUEVO, no el del check 2) =====
const outs3antes = (await msgsOf(CUST)).filter((m) => m.direction === 'out').length;
await postText(CUST, '¿Llegan a Encarnación?');
const respondio3 = await waitFor(async () => (await msgsOf(CUST)).filter((m) => m.direction === 'out').length > outs3antes);
const r3 = await lastOut(CUST);
check('3. "¿Llegan a Encarnación?" → respuesta segura nueva, contador de IA intacto',
  respondio3 && (r3 ?? '').includes(SAFE_MARK) && (await aiCount()) === ai0 && (await notifsHandoff()).length === 0,
  `ai=${(await aiCount()) - ai0}`);

// ===== 4. No logística → NO la intercepta el guard (sin sobre-bloqueo) =====
// "mi pedido" es seguimiento: lo atienden las reglas (carrito/pedido), jamás la respuesta segura.
await postText(CUST, 'cuando llega mi pedido?');
await sleep(2500);
const r4 = await lastOut(CUST);
const noGuard4 = !!r4 && !r4.includes(SAFE_MARK);
// Y una consulta conversacional genérica sigue llegando a la IA (el guard no bloquea de más).
await postText(CUST, 'atienden los domingos?');
const fueAIa = await waitFor(async () => ((await lastOut(CUST)) ?? '').includes(AI_MARK));
check('4. no-logística no se intercepta: "mi pedido" → reglas; consulta genérica → IA',
  noGuard4 && fueAIa, `r4=${JSON.stringify((r4 ?? '').slice(0, 50))}`);

// ===== 5. Pedido de vendedor → HANDOFF-2 real =====
await postText(CUST, 'Quiero hablar con un vendedor');
const pase = await waitFor(async () => ((await lastOut(CUST)) ?? '').includes('Te paso con Vendedor CG'));
const ses5 = await sessionOf(CUST);
check('5. "quiero hablar con un vendedor" → HANDOFF-2 real (takeover + notificación)',
  pase && ses5?.context?.humanTakeover === true && ses5?.context?.handoffReason === 'customer_requested' &&
  (await notifsHandoff()).length === 1,
  `takeover=${ses5?.context?.humanTakeover} notifs=${(await notifsHandoff()).length}`);

// ===== 6. Silencio durante takeover =====
const outsAntes = (await msgsOf(CUST)).filter((m) => m.direction === 'out').length;
await postText(CUST, 'hola sigo aca');
await sleep(2500);
const outsDespues = (await msgsOf(CUST)).filter((m) => m.direction === 'out').length;
check('6. bot silencioso durante takeover', outsDespues === outsAntes, `outs ${outsAntes}→${outsDespues}`);

// ===== 7. Liberación → el bot retoma =====
const owner = await signIn('owner@perfumeria.com');
const rRel = await call('chatRelease', owner, { tenantId: T, customerId: CUST });
await postText(CUST, 'hola');
const volvio = await waitFor(async () => (await msgsOf(CUST)).filter((m) => m.direction === 'out').length > outsDespues);
check('7. chatRelease → el bot retoma', rRel.result?.ok === true && volvio);

// ===== 8. Cero mutaciones comerciales =====
const ords = (await db.collection(`tenants/${T}/orders`).where('customerId', '==', CUST).get()).size;
const ses8 = await sessionOf(CUST);
check('8. cero mutaciones comerciales (sin órdenes, carrito vacío)',
  ords === 0 && ((ses8?.cart?.items ?? []).length === 0), `orders=${ords} cart=${(ses8?.cart?.items ?? []).length}`);

// ---- Restaurar (convivencia con otros verifies): si el doc NO existía, BORRARLO —
// dejar el vendedor de prueba colgado cambia el camino sin-vendedor de verify-ai-gateway.
await db.doc(FIX).delete().catch(() => {});
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete().catch(() => {});
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete().catch(() => {});
await db.doc(`tenants/${T}`).set(beforeTenant);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete().catch(() => {});
if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent); else await db.doc(`tenants/${T}/config/agent`).delete().catch(() => {});
if (beforeCheckout) await db.doc(`tenants/${T}/config/checkout`).set(beforeCheckout); else await db.doc(`tenants/${T}/config/checkout`).delete().catch(() => {});
{
  // limpiar las notificaciones handoff de ESTE cliente para no contaminar otros verifies
  const notifs = await db.collection(`tenants/${T}/notifications`).get();
  for (const d of notifs.docs) { if ((d.data().category ?? '') === 'handoff' && d.data().customerId === CUST) await d.ref.delete().catch(() => {}); }
}

const ok = results.every(Boolean);
console.log(`\nRESULTADO COVERAGE-GUARD (afirmaciones logísticas): ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
