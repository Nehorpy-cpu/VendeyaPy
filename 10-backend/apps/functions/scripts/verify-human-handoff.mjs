/**
 * verify-human-handoff.mjs — HUMAN-HANDOFF-1 end-to-end (emulador).
 * El hueco que cierra: comprobante → bot en pausa, pero el vendedor no podía responder desde
 * el panel por el MISMO número Cloud API.
 *
 *  1. Cliente compra → comprobante (dev) → handoff activo (orden PENDING_VERIFICATION,
 *     humanTakeover=true, doc en handoffs/).
 *  2. SELLER responde vía conversationSendManualMessage → mensaje author 'seller' con
 *     senderUid/senderName, retenido por modo mock (viaMock) pero PERSISTIDO.
 *  3. Multi-número: el outbound humano sale por el MISMO número receptor (mock inspeccionable).
 *  4. El bot NO responde mientras humanTakeover=true (mensaje humano tampoco lo despierta).
 *  5. Seguridad: cross-tenant → PERMISSION_DENIED · texto vacío → INVALID_ARGUMENT.
 *  6. chatRelease → humanTakeover=false + asignación liberada + audit
 *     conversation.returned_to_bot; el próximo mensaje del cliente lo atiende el bot.
 *  7. Audits con conversation.manual_message_sent; sin leaks del token en mensajes/audits.
 *
 * Requiere: emulador (auth+firestore+functions) + seed-users + load-catalog (tenant perfumeria).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
const PNID_H = '900000000000077';
const TOKEN_FAKE = 'tok-handoff-e2e-NUNCA-persistir';
const CUST = '595993500001';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null, msg: body.error?.message ?? '' };
}

let mid = 0;
const postText = async (from, body) => fetch(`${BASE}/metaWebhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID_H },
    contacts: [{ wa_id: from, profile: { name: 'Cliente HH' } }],
    messages: [{ from, id: `wamid.HH-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }],
  } }] }] }),
});
const msgsOf = async (c) => (await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs
  .map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
const sessionOf = async (c) => (await db.doc(`tenants/${T}/customers/${c}/sessions/active`).get()).data();
const waitFor = async (pred, maxMs = 12000) => { const end = Date.now() + maxMs; while (Date.now() < end) { if (await pred()) return true; await sleep(600); } return false; };

// ---- Snapshot (convivencia) ----
const beforeTenant = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeCheckout = (await db.doc(`tenants/${T}/config/checkout`).get()).data() ?? null;
const oldAssets = (await db.collection(`tenants/${T}/metaAssets`).get()).docs.map((d) => ({ id: d.id, data: d.data() }));
const oldConns = (await db.collection(`tenants/${T}/metaConnections`).get()).docs.map((d) => ({ id: d.id, data: d.data() }));
const oldIdx = (await db.collection('metaExternalIndex').where('tenantId', '==', T).get()).docs.map((d) => ({ id: d.id, data: d.data() }));

await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: Timestamp.now() },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, currentPeriodStart: Timestamp.now() },
}, { merge: true });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot HH' }, { merge: true });
await db.doc(`tenants/${T}/config/checkout`).set({ sellers: [{ name: 'Aaron Test', whatsapp: '595991000000' }] }, { merge: true });

// Conexión manual (creds resolubles → el mock del emulador expone el phoneNumberId usado).
const admin = await signIn('superadmin@aiafg.com');
const rConn = await call('adminSetManualWhatsappConnection', admin, {
  tenantId: T, wabaId: 'WABA-HH-1', phoneNumberId: PNID_H, displayPhoneNumber: '+595 991 000 077',
  businessName: 'HH Test', accessToken: TOKEN_FAKE,
});
if (!rConn.result?.ok) { console.error('setup: no se pudo cargar la conexión', rConn); process.exit(1); }
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'active' }, { merge: true }); // fixture Graph no valida tokens fake

// ===== 1. Cliente compra y manda comprobante → handoff =====
await postText(CUST, 'hola');
await waitFor(async () => (await msgsOf(CUST)).some((m) => m.direction === 'out'));
await postText(CUST, 'agregá la belle');
await waitFor(async () => (await msgsOf(CUST)).some((m) => m.text?.includes('Agregué')));
await postText(CUST, 'quiero pagar');
await waitFor(async () => (await sessionOf(CUST))?.context?.pendingOrderId);
const orderId = (await sessionOf(CUST))?.context?.pendingOrderId;
const rComp = await (await fetch(`${BASE}/devSubmitComprobante`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tenantId: T, from: CUST, comprobanteUrl: 'tenants/perfumeria/comprobantes/hh-test.jpg' }),
})).json();
const ses1 = await sessionOf(CUST);
const cust1 = (await db.doc(`tenants/${T}/customers/${CUST}`).get()).data();
const order1 = orderId ? (await db.doc(`tenants/${T}/orders/${orderId}`).get()).data() : null;
const handoff1 = orderId ? (await db.doc(`tenants/${T}/handoffs/${orderId}`).get()).data() : null;
check('1. comprobante → handoff ACTIVO (orden PENDING_VERIFICATION + humanTakeover en SESIÓN y RESUMEN + cola del vendedor)',
  rComp.ok === true && ses1?.context?.humanTakeover === true &&
  cust1?.conversation?.humanTakeover === true && // el panel gatea el composer con el resumen (review)
  order1?.status === 'PENDING_VERIFICATION' && handoff1?.status === 'PENDING',
  `order=${order1?.status} takeover=${ses1?.context?.humanTakeover} resumen=${cust1?.conversation?.humanTakeover}`);

// ===== 2-3. SELLER responde desde el panel por el MISMO número =====
// El _debug se compara ANTES/DESPUÉS: el bot ya escribió ahí durante la compra (falso positivo si no).
const dbgAntes = (await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).get()).data();
const seller = await signIn('seller@perfumeria.com');
const rSend = await call('conversationSendManualMessage', seller, {
  tenantId: T, customerId: CUST, text: 'Hola! Soy Vendedora 👋 Ya estoy revisando tu comprobante, en un ratito te confirmo.',
});
const msgs2 = await msgsOf(CUST);
const manual = msgs2.filter((m) => m.author === 'seller').pop();
check('2a. mensaje humano enviado: retenido por mock (viaMock) pero PERSISTIDO como author seller',
  rSend.result?.ok === true && rSend.result?.viaMock === true && !!manual && manual.direction === 'out' &&
  !!manual.senderUid && manual.senderName === 'Vendedora' && manual.viaMock === true,
  `err=${rSend.err} viaMock=${rSend.result?.viaMock} sender=${manual?.senderName}`);
check('2b. el mensaje humano NO desactivó el handoff (el vendedor sigue en control)',
  (await sessionOf(CUST))?.context?.humanTakeover === true);

const dbg = (await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).get()).data();
const dbgEsDelManual = dbg?.at?.toMillis?.() !== dbgAntes?.at?.toMillis?.();
check('3. multi-número: el outbound HUMANO salió por el MISMO número receptor (traza nueva del mock)',
  dbgEsDelManual && dbg?.phoneNumberId === PNID_H && dbg?.to === CUST,
  `nuevo=${dbgEsDelManual} sentVia=${dbg?.phoneNumberId} to=${dbg?.to}`);

// ===== 4. El bot sigue mudo con humanTakeover =====
await postText(CUST, 'sigo esperando la confirmación');
await sleep(5000);
const msgs4 = await msgsOf(CUST);
const last4 = msgs4[msgs4.length - 1];
check('4. el bot NO responde en atención humana (el último mensaje es el del cliente)',
  last4?.direction === 'in' && last4?.author === 'customer', `last=${last4?.author}`);

// ===== 5. Seguridad =====
const boutique = await signIn('owner@boutique.com');
const rCross = await call('conversationSendManualMessage', boutique, { tenantId: T, customerId: CUST, text: 'intruso' });
check('5a. cross-tenant → PERMISSION_DENIED (owner de otra empresa no puede escribirle a este cliente)',
  rCross.err === 'PERMISSION_DENIED', `err=${rCross.err}`);
const rEmpty = await call('conversationSendManualMessage', seller, { tenantId: T, customerId: CUST, text: '   ' });
check('5b. texto vacío → INVALID_ARGUMENT', rEmpty.err === 'INVALID_ARGUMENT', `err=${rEmpty.err}`);

// ===== 6. Devolver al bot → el bot retoma =====
const rRel = await call('chatRelease', seller, { tenantId: T, customerId: CUST });
const ses6 = await sessionOf(CUST);
const cust6 = (await db.doc(`tenants/${T}/customers/${CUST}`).get()).data();
check('6a. chatRelease → humanTakeover=false + asignación liberada',
  rRel.result?.ok === true && ses6?.context?.humanTakeover === false && (cust6?.assignedSellerId ?? null) === null,
  `takeover=${ses6?.context?.humanTakeover}`);
await postText(CUST, 'hola');
const botVolvio = await waitFor(async () => {
  const ms = await msgsOf(CUST);
  const last = ms[ms.length - 1];
  return last?.direction === 'out' && last?.author === 'bot';
});
check('6b. tras devolver al bot, el próximo mensaje del cliente lo responde el BOT', botVolvio);

// ===== 7. Audits + sin leaks =====
const audits = (await db.collection(`tenants/${T}/auditLogs`).get()).docs.map((d) => d.data());
const aSend = audits.filter((a) => a.action === 'conversation.manual_message_sent');
const aRet = audits.filter((a) => a.action === 'conversation.returned_to_bot');
check('7a. audits: manual_message_sent y returned_to_bot registrados',
  aSend.length >= 1 && aRet.length >= 1, `send=${aSend.length} ret=${aRet.length}`);
const todoJson = JSON.stringify([msgs2, audits, dbg]);
check('7b. sin leaks: el access token no aparece en mensajes/audits/debug',
  !todoJson.includes(TOKEN_FAKE) && !todoJson.includes('EAA') && !todoJson.includes('Bearer '));

// ---- Cleanup completo (convivencia) ----
if (orderId) {
  await db.doc(`tenants/${T}/orders/${orderId}`).delete();
  await db.doc(`tenants/${T}/handoffs/${orderId}`).delete();
}
for (const d of (await db.collection(`tenants/${T}/customers/${CUST}/messages`).get()).docs) await d.ref.delete();
await db.doc(`tenants/${T}/customers/${CUST}/sessions/active`).delete().catch(() => {});
await db.doc(`tenants/${T}/customers/${CUST}`).delete();
for (const a of aSend.concat(aRet)) { /* audits quedan: son inmutables por diseño */ }
// Conexión/asset/índice/secret del test
const nowAssets = (await db.collection(`tenants/${T}/metaAssets`).get()).docs;
for (const d of nowAssets) await d.ref.delete();
const nowConns = (await db.collection(`tenants/${T}/metaConnections`).get()).docs;
for (const d of nowConns) await d.ref.delete();
const nowIdx = (await db.collection('metaExternalIndex').where('tenantId', '==', T).get()).docs;
for (const d of nowIdx) await d.ref.delete();
await db.doc(`secrets/meta-token-${T}`).delete().catch(() => {});
for (const d of oldAssets) await db.doc(`tenants/${T}/metaAssets/${d.id}`).set(d.data);
for (const d of oldConns) await db.doc(`tenants/${T}/metaConnections/${d.id}`).set(d.data);
for (const d of oldIdx) await db.doc(`metaExternalIndex/${d.id}`).set(d.data);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();
if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent);
if (beforeCheckout) await db.doc(`tenants/${T}/config/checkout`).set(beforeCheckout); else await db.doc(`tenants/${T}/config/checkout`).delete();
await db.doc(`tenants/${T}`).set(beforeTenant);

const ok = results.every(Boolean);
console.log(`\nRESULTADO HUMAN-HANDOFF-1: ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
