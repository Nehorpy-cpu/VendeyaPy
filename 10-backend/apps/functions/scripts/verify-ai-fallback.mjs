/**
 * verify-ai-fallback.mjs — AI-FALLBACK-HONESTO-1 end-to-end (emulador).
 * Con la CUOTA de IA agotada, una consulta que necesitaba IA no cae al fallback genérico:
 * deriva HONESTAMENTE a un vendedor (razón ai_unavailable) con notificación idempotente.
 * Los caminos determinísticos (saludo, catálogo, carrito, checkout) siguen funcionando sin IA.
 *
 *  1. saludo con cuota agotada → reglas normales (sin handoff, sin IA).
 *  2. consulta consultiva → handoff ai_unavailable persistido + vendedor + respuesta honesta
 *     (sin tokens/límites/plan) + notificación tipo handoff_ai_unavailable.
 *  3. mismo wamid repetido → sin duplicados.
 *  4. mensaje durante takeover → silencio, cero IA.
 *  5. chatRelease → el bot retoma.
 *  6. catálogo/carrito/checkout determinísticos intactos con cuota agotada.
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
const PNID = '900000000000099';
const CUST = '595993700001';
const FIX = 'aiTestFixtures/ai';
const AI_MARK = '[fixture-aifb]';

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
    contacts: [{ wa_id: from, profile: { name: 'Cliente AIFB' } }],
    messages: [{ from, id: wamid ?? `wamid.AIFB-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }],
  } }] }] }),
});
const msgsOf = async (c) => (await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs
  .map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
const sessionOf = async (c) => (await db.doc(`tenants/${T}/customers/${c}/sessions/active`).get()).data();
const notifsIa = async () => (await db.collection(`tenants/${T}/notifications`).get()).docs
  .map((d) => ({ id: d.id, ...d.data() })).filter((n) => n.type === 'handoff_ai_unavailable');
const waitFor = async (pred, maxMs = 15000) => { const end = Date.now() + maxMs; while (Date.now() < end) { if (await pred()) return true; await sleep(600); } return false; };

// ---- Snapshot + setup: CUOTA AGOTADA ----
const beforeTenant = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeCheckout = (await db.doc(`tenants/${T}/config/checkout`).get()).data() ?? null;

await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: Timestamp.now() },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 999999999, currentPeriodStart: Timestamp.now() }, // CUOTA AGOTADA
}, { merge: true });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot AIFB' }, { merge: true });
await db.doc(`tenants/${T}/config/checkout`).set({ sellers: [{ name: 'Vendedor E2E', whatsapp: '595991000009', active: true }] }, { merge: true });
await db.doc(FIX).set({ text: `Respuesta IA ${AI_MARK}` }); // si la IA corriera, aparecería el marker

const admin = await signIn('superadmin@aiafg.com');
const rConn = await call('adminSetManualWhatsappConnection', admin, {
  tenantId: T, wabaId: 'WABA-AIFB', phoneNumberId: PNID, displayPhoneNumber: '+595 991 000 099',
  businessName: 'AIFB Test', accessToken: 'tok-aifb-NUNCA-persistir',
});
if (!rConn.result?.ok) { console.error('setup: conexión manual falló', rConn); process.exit(1); }
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'active' }, { merge: true });

// ===== 1. Determinístico con cuota agotada: saludo normal, sin handoff =====
await postText(CUST, 'hola');
const saludo = await waitFor(async () => (await msgsOf(CUST)).some((m) => m.direction === 'out'));
const ses1 = await sessionOf(CUST);
check('1. saludo con cuota agotada → reglas normales, sin handoff ni IA',
  saludo && ses1?.context?.humanTakeover !== true && !(await msgsOf(CUST)).some((m) => m.text?.includes(AI_MARK)));

// ===== 2. Consulta que NECESITABA IA → handoff ai_unavailable =====
const WAMID_Q = `wamid.AIFB-QUOTA-${Date.now()}`;
await postText(CUST, 'hacen envios al interior del pais?', WAMID_Q);
const derivado = await waitFor(async () => (await msgsOf(CUST)).some((m) => m.text?.includes('Te paso con Vendedor E2E')));
const ses2 = await sessionOf(CUST);
const outs2 = (await msgsOf(CUST)).filter((m) => m.direction === 'out');
const honesto = outs2.every((m) => !/token|l[ií]mite|plan\b|anthropic|error/i.test(m.text ?? ''));
const n2 = await notifsIa();
check('2. consulta consultiva → handoff ai_unavailable PERSISTIDO + vendedor + respuesta honesta + aviso',
  derivado && ses2?.context?.humanTakeover === true && ses2?.context?.handoffReason === 'ai_unavailable' &&
  ses2?.context?.handoffSellerName === 'Vendedor E2E' && honesto && n2.length === 1 && n2[0].type === 'handoff_ai_unavailable',
  `reason=${ses2?.context?.handoffReason} notifs=${n2.length}`);

// ===== 3. Mismo wamid repetido → sin duplicados =====
await postText(CUST, 'hacen envios al interior del pais?', WAMID_Q);
await sleep(2500);
const confs = (await msgsOf(CUST)).filter((m) => m.text?.includes('Te paso con Vendedor E2E')).length;
check('3. wamid repetido → UNA confirmación y UNA notificación', confs === 1 && (await notifsIa()).length === 1);

// ===== 4. Silencio durante takeover =====
const outsAntes = (await msgsOf(CUST)).filter((m) => m.direction === 'out').length;
await postText(CUST, 'hola? sigo aca');
await sleep(3000);
const msgs4 = await msgsOf(CUST);
check('4. mensaje durante takeover → persistido, cero bot, cero IA',
  msgs4.filter((m) => m.direction === 'out').length === outsAntes &&
  msgs4.some((m) => m.text === 'hola? sigo aca') && !msgs4.some((m) => m.text?.includes(AI_MARK)));

// ===== 5. Liberación → el bot retoma =====
const seller = await signIn('seller@perfumeria.com');
const rRel = await call('chatRelease', seller, { tenantId: T, customerId: CUST });
await postText(CUST, 'hola de nuevo');
const volvio = await waitFor(async () => (await msgsOf(CUST)).filter((m) => m.direction === 'out').length > outsAntes);
check('5. chatRelease → el bot retoma el próximo mensaje', rRel.result?.ok === true && volvio);

// ===== 6. Caminos determinísticos intactos con cuota agotada =====
await postText(CUST, 'mostrame el catálogo');
const catalogo = await waitFor(async () => (await msgsOf(CUST)).some((m) => m.text?.includes('Mirá, te elegí')));
await postText(CUST, 'agregá la belle');
const agregado = await waitFor(async () => (await msgsOf(CUST)).some((m) => m.text?.includes('Agregué')));
await postText(CUST, 'quiero pagar');
const pagar = await waitFor(async () => (await msgsOf(CUST)).some((m) => m.text?.includes('transferir')));
const ses6 = await sessionOf(CUST);
check('6. catálogo/carrito/checkout determinísticos INTACTOS con cuota agotada (sin handoff espurio)',
  catalogo && agregado && pagar && ses6?.context?.humanTakeover !== true,
  `takeover=${ses6?.context?.humanTakeover}`);

// ===== 7. Acks/cortesía con cuota agotada NO derivan (review) =====
await postText(CUST, 'muchas gracias por todo');
await sleep(3000);
const ses7b = await sessionOf(CUST);
check('7. "muchas gracias por todo" con cuota agotada → NO deriva (sin takeover nuevo)',
  ses7b?.context?.humanTakeover !== true || ses7b?.context?.handoffReason !== 'ai_unavailable' || (await notifsIa()).length === 1);

// ===== 8. Feature OFF (override) → NO deriva: fallback genérico (review) =====
await db.doc(`tenants/${T}`).set({ featureOverrides: { aiAssistant: false }, usage: { aiTokensThisMonth: 0, currentPeriodStart: Timestamp.now() } }, { merge: true });
await sleep(31000); // caché de entitlements (30s)
const CUST3 = '595993700003';
await postText(CUST3, 'hola');
await waitFor(async () => (await msgsOf(CUST3)).some((m) => m.direction === 'out'));
await postText(CUST3, 'hacen envios al interior del pais?');
const generico = await waitFor(async () => (await msgsOf(CUST3)).some((m) => m.text?.includes('Puedo ayudarte a encontrar')));
const ses8b = await sessionOf(CUST3);
check('8. feature_unavailable (override off) → fallback genérico, SIN derivación ni takeover',
  generico && ses8b?.context?.humanTakeover !== true &&
  !(await msgsOf(CUST3)).some((m) => /te paso con/i.test(m.text ?? '')));
await db.doc(`tenants/${T}`).set({ featureOverrides: {}, usage: { aiTokensThisMonth: 999999999, currentPeriodStart: Timestamp.now() } }, { merge: true });
await sleep(31000); // reset del caché para el paso 9

// ===== 9. agentTestCaseRun (simulation:true) → CERO efectos operativos (review) =====
const owner9 = await signIn('owner@perfumeria.com');
const notifsAntes9 = (await notifsIa()).length;
const rUp = await call('agentTestCaseUpsert', owner9, { tenantId: T, data: { name: 'aifb-sim', userMessage: 'hacen envios al interior del pais?' } });
const caseId = rUp.result?.id;
const rRun = caseId ? await call('agentTestCaseRun', owner9, { tenantId: T, id: caseId }) : { result: null };
const notifsDespues9 = (await notifsIa()).length;
check('9. simulador (agentTestCaseRun) con cuota agotada → representa el fallback SIN handoff ni aviso reales',
  !!caseId && rRun.result != null && notifsDespues9 === notifsAntes9,
  `case=${!!caseId} notifs ${notifsAntes9}→${notifsDespues9}`);
if (caseId) await call('agentTestCaseDelete', owner9, { tenantId: T, id: caseId });

// ---- Cleanup ----
await db.doc(FIX).delete().catch(() => {});
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete().catch(() => {});
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete().catch(() => {});
await db.doc(`tenants/${T}`).set(beforeTenant);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();
if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent); else await db.doc(`tenants/${T}/config/agent`).delete();
if (beforeCheckout) await db.doc(`tenants/${T}/config/checkout`).set(beforeCheckout); else await db.doc(`tenants/${T}/config/checkout`).delete();
for (const n of await notifsIa()) await db.doc(`tenants/${T}/notifications/${n.id}`).delete().catch(() => {});

const ok = results.every(Boolean);
console.log(`\nRESULTADO AI-FALLBACK-HONESTO (IA no disponible → humano): ${ok ? `TODO OK ✅ (${results.length}/${results.length})` : `FALLOS ❌ (${results.filter(Boolean).length}/${results.length})`}`);
process.exit(ok ? 0 : 1);
