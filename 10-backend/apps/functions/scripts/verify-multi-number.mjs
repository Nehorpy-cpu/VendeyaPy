/**
 * verify-multi-number.mjs — MULTI-NUMBER-1 end-to-end (emulador).
 *   1. Alta del número PRINCIPAL (WM-1, callable) + agregar ADICIONAL dentro del límite.
 *   2. Tercer número sobre el límite del plan → failed-precondition.
 *   3. Inbound por DOS phoneNumberId distintos → mismo tenant, cada conversación conserva
 *      el número receptor (receivedVia en mensajes y en el resumen).
 *   4. La respuesta sale por el MISMO número que recibió (mock inspeccionable del emulador).
 *   5. Desactivar el adicional: índice fuera (deja de rutear), conversaciones INTACTAS.
 *   6. Sin leaks: el access token no aparece en conexiones/assets/audits.
 *
 * Requiere: emulador (auth+firestore+functions) + seed-users.
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
const PNID_A = '900000000000001';
const PNID_B = '900000000000002';
const PNID_C = '900000000000003';
const TOKEN_FAKE = 'tok-multinum-e2e-NUNCA-persistir';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null, msg: body.error?.message ?? '' };
}

// Snapshot para restaurar (convivencia) + plan con límite de 2 números.
const beforeTenant = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const oldAssets = (await db.collection(`tenants/${T}/metaAssets`).get()).docs.map((d) => ({ id: d.id, data: d.data() }));
const oldConns = (await db.collection(`tenants/${T}/metaConnections`).get()).docs.map((d) => ({ id: d.id, data: d.data() }));
const oldIdx = (await db.collection('metaExternalIndex').where('tenantId', '==', T).get()).docs.map((d) => ({ id: d.id, data: d.data() }));
await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: Timestamp.now() },
  limitOverrides: { maxWhatsappNumbers: 2 },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, currentPeriodStart: Timestamp.now() },
}, { merge: true });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot multi' }, { merge: true });

const admin = await signIn('superadmin@aiafg.com');
const baseInput = (pnid, display) => ({
  tenantId: T, wabaId: 'WABA-MULTI-1', phoneNumberId: pnid, displayPhoneNumber: display,
  businessName: 'Multi Test', accessToken: TOKEN_FAKE,
});

// === 1a. Número PRINCIPAL (WM-1 reemplaza limpio) ===
const r1 = await call('adminSetManualWhatsappConnection', admin, baseInput(PNID_A, '+595 991 000 001'));
check('1a. principal cargado (WM-1)', r1.result?.ok === true, `status=${r1.result?.status}`);

// === 1b. Número ADICIONAL dentro del límite (2) ===
const r2 = await call('adminAddWhatsappNumber', admin, baseInput(PNID_B, '+595 991 000 002'));
const assetB = (await db.doc(`tenants/${T}/metaAssets/${PNID_B}`).get()).data();
const idxB = (await db.doc(`metaExternalIndex/whatsapp_${PNID_B}`).get()).data();
const connB = (await db.doc(`tenants/${T}/metaConnections/wa_${PNID_B}`).get()).data();
check('1b. adicional agregado: asset (no default) + índice con connectionId propio + conexión con token cifrado',
  r2.result?.ok === true && assetB?.selected === false && assetB?.status === 'active' &&
  idxB?.tenantId === T && idxB?.connectionId === `wa_${PNID_B}` &&
  !!connB?.tokenSecretRef && !String(connB.tokenSecretRef).includes(TOKEN_FAKE),
  `status=${r2.result?.status} idx=${idxB?.connectionId}`);

// Arreglo de test: el fixture de Graph del emulador no valida tokens fake → las conexiones
// quedan 'error'. Para probar el RUTEO (creds activas por número) las activamos a mano.
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'active' }, { merge: true });
await db.doc(`tenants/${T}/metaConnections/wa_${PNID_B}`).set({ status: 'active' }, { merge: true });

// === 2. Tercer número → límite del plan ===
const r3 = await call('adminAddWhatsappNumber', admin, baseInput(PNID_C, '+595 991 000 003'));
check('2. tercer número sobre el límite → FAILED_PRECONDITION', r3.err === 'FAILED_PRECONDITION', `err=${r3.err} msg=${r3.msg.slice(0, 60)}`);

// === 3-4. Inbound por A y por B → mismo tenant, receptor conservado, respuesta por el mismo número ===
let mid = 0;
const postText = async (from, pnid, body) => fetch(`${BASE}/metaWebhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: pnid },
    contacts: [{ wa_id: from, profile: { name: 'Multi' } }],
    messages: [{ from, id: `wamid.MULTI-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }],
  } }] }] }),
});
const lastMsgs = async (from) => (await db.collection(`tenants/${T}/customers/${from}/messages`).get()).docs
  .map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
const debugSend = async () => (await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).get()).data();

const CUST_A = '595993400001';
const CUST_B = '595993400002';
await postText(CUST_A, PNID_A, 'hola');
await sleep(6000);
const msgsA = await lastMsgs(CUST_A);
const dbgA = await debugSend();
check('3a. inbound por número A → tenant resuelto + receivedVia=A en mensajes (in y out)',
  msgsA.length >= 2 && msgsA[0].receivedVia === PNID_A && msgsA[msgsA.length - 1].receivedVia === PNID_A,
  `msgs=${msgsA.length} via=${msgsA[0]?.receivedVia}`);
check('4a. la respuesta salió por el número A (mock inspeccionable)', dbgA?.phoneNumberId === PNID_A, `sentVia=${dbgA?.phoneNumberId}`);

await postText(CUST_B, PNID_B, 'hola');
await sleep(6000);
const msgsB = await lastMsgs(CUST_B);
const dbgB = await debugSend();
const convB = (await db.doc(`tenants/${T}/customers/${CUST_B}`).get()).data();
check('3b. inbound por número B → mismo tenant + receivedVia=B (mensajes y resumen de conversación)',
  msgsB.length >= 2 && msgsB[0].receivedVia === PNID_B && convB?.conversation?.receivedVia === PNID_B,
  `via=${msgsB[0]?.receivedVia} conv=${convB?.conversation?.receivedVia}`);
check('4b. la respuesta salió por el número B (no por el default)', dbgB?.phoneNumberId === PNID_B, `sentVia=${dbgB?.phoneNumberId}`);

// === 5. Desactivar B: índice fuera, historial intacto, inbound nuevo no rutea ===
const r5 = await call('adminDeactivateWhatsappNumber', admin, { tenantId: T, phoneNumberId: PNID_B });
const idxBGone = !(await db.doc(`metaExternalIndex/whatsapp_${PNID_B}`).get()).exists;
const msgsBAfter = await lastMsgs(CUST_B);
const assetBAfter = (await db.doc(`tenants/${T}/metaAssets/${PNID_B}`).get()).data();
const secretBGone = !(await db.doc(`secrets/meta-token-${T}-${PNID_B}`).get()).exists;
check('5a. desactivar B → índice eliminado + asset inactivo + secreto del token borrado + historial INTACTO',
  r5.result?.ok === true && idxBGone && assetBAfter?.status === 'inactive' && secretBGone && msgsBAfter.length === msgsB.length,
  `idxGone=${idxBGone} msgs=${msgsBAfter.length}/${msgsB.length} secretGone=${secretBGone}`);

await postText(CUST_B, PNID_B, 'sigo acá?');
await sleep(4000);
const events = (await db.collection('metaWebhookInbox').get()).docs.map((d) => d.data())
  .filter((e) => e.externalId === PNID_B).sort((a, b) => a.receivedAt.toMillis() - b.receivedAt.toMillis());
const lastEvB = events[events.length - 1];
check('5b. inbound nuevo al número desactivado → ignored (empresa no resuelta), sin respuesta',
  lastEvB?.processingStatus === 'ignored' && (await lastMsgs(CUST_B)).length === msgsB.length,
  `status=${lastEvB?.processingStatus}`);

// === 6. Sin leaks del access token ===
const dump = JSON.stringify([
  (await db.collection(`tenants/${T}/metaConnections`).get()).docs.map((d) => d.data()),
  (await db.collection(`tenants/${T}/metaAssets`).get()).docs.map((d) => d.data()),
  (await db.collection(`tenants/${T}/auditLogs`).get()).docs.map((d) => d.data()),
]);
check('6. el access token NO aparece en conexiones/assets/audits', !dump.includes(TOKEN_FAKE));

// ---- Restaurar estado previo (convivencia) ----
for (const d of (await db.collection(`tenants/${T}/metaAssets`).get()).docs) await d.ref.delete();
for (const d of (await db.collection(`tenants/${T}/metaConnections`).get()).docs) await d.ref.delete();
for (const d of (await db.collection('metaExternalIndex').where('tenantId', '==', T).get()).docs) await d.ref.delete();
for (const a of oldAssets) await db.doc(`tenants/${T}/metaAssets/${a.id}`).set(a.data);
for (const c of oldConns) await db.doc(`tenants/${T}/metaConnections/${c.id}`).set(c.data);
for (const i of oldIdx) await db.doc(`metaExternalIndex/${i.id}`).set(i.data);
await db.doc(`tenants/${T}`).set(beforeTenant);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();
await db.doc(`secrets/meta-token-${T}`).delete().catch(() => {});
for (const c of [CUST_A, CUST_B]) {
  for (const d of (await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs) await d.ref.delete();
  await db.doc(`tenants/${T}/customers/${c}/sessions/active`).delete().catch(() => {});
  await db.doc(`tenants/${T}/customers/${c}`).delete().catch(() => {});
}
await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).delete().catch(() => {});

const ok = results.every(Boolean);
console.log(`\nRESULTADO MULTI-NUMBER-1: ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
