/**
 * verify-fase4-whatsapp.mjs — Activación del agente + WhatsApp outbound POR TENANT (Hardening F4A + W-3).
 * Matriz completa de la activación real del bot por empresa. NUNCA llama a Graph: en el emulador el
 * envío es siempre Mock pero INSPECCIONABLE (_debug/lastWhatsappSend), para aseverar resolución de
 * credenciales, gates y aislamiento. Cubre:
 *   1. botEnabled+live+conexión válida → Mock live con phone_number_id + tokenPresent del tenant.
 *   2. live SIN conexión resoluble → channelConfigUpdate('live') falla failed-precondition; no queda live.
 *   3. botEnabled=false + live → el engine no responde; no hay envío.
 *   4. seller NO puede activar live → channelConfigUpdate → 403.
 *   5. cross-tenant: inbound del número de A no dispara el bot de B (índice resuelve por tenant).
 *   6. límite de mensajes: con usage sobre el límite, el inbound se bloquea, sin envío ni incremento.
 *   7. mock → nunca intenta envío real.
 *   8/9. gates de credenciales: conexión no activa / token vencido → Mock con motivo.
 *
 * Requiere el emulador (auth+firestore+functions) con TENANT_SECRETS_ENCRYPTION_KEY igual a la de este
 * script (cifra el token y el emulador lo descifra) y los usuarios sembrados (seed-users).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';
process.env.TENANT_SECRETS_ENCRYPTION_KEY ??= 'test-tenant-encryption-key-000000000000000';

import { randomBytes, createCipheriv, scryptSync } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';

// --- Cifrado idéntico a apps/functions/src/lib/crypto.ts (AES-256-GCM, iv:tag:ct b64) ---
const SALT = Buffer.from('vpw-tenant-secrets-v1');
function encrypt(plaintext) {
  const iv = randomBytes(16);
  const key = scryptSync(process.env.TENANT_SECRETS_ENCRYPTION_KEY, SALT, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, idToken) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}

const A = 'perfumeria';
const B = 'boutique-demo';
const PNID_A = 'wa-perf-1';
const PNID_B = 'wa-bout-1';
const testCustomers = [];

/** Siembra la conexión + asset + índice + token cifrado + sendMode + agent de un tenant. */
async function setupTenant(tenant, pnid, { mode = 'live', status = 'active', tokenExpiresAtMs = Date.now() + 3_600_000, withToken = true, botEnabled = true } = {}) {
  const now = Timestamp.now();
  const secretName = `meta-token-${tenant}`;
  const tokenSecretRef = `secret://firestore/${secretName}`;
  if (withToken) {
    await db.doc(`secrets/${secretName}`).set({ name: secretName, ciphertext: encrypt(`EAAtoken-${tenant}`), updatedAt: now });
  } else {
    await db.doc(`secrets/${secretName}`).delete().catch(() => {});
  }
  await db.doc(`tenants/${tenant}/metaConnections/main`).set({
    id: 'main', tenantId: tenant, metaBusinessId: 'biz', metaBusinessName: tenant, connectedUserId: '',
    tokenSecretRef: withToken ? tokenSecretRef : '', tokenType: 'live', tokenExpiresAt: Timestamp.fromMillis(tokenExpiresAtMs),
    scopes: ['whatsapp_business_messaging'], status, lastVerifiedAt: now, errorMessage: '', createdAt: now, updatedAt: now,
  }, { merge: true });
  const old = await db.collection(`tenants/${tenant}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
  for (const d of old.docs) await d.ref.delete();
  await db.doc(`tenants/${tenant}/metaAssets/${pnid}`).set({ id: pnid, tenantId: tenant, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: pnid, name: 'wa', status: 'active', selected: true, createdAt: now, updatedAt: now });
  await db.doc(`metaExternalIndex/whatsapp_${pnid}`).set({ id: `whatsapp_${pnid}`, tenantId: tenant, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: pnid, status: 'active', updatedAt: now });
  await db.doc(`tenants/${tenant}/config/channels`).set({ whatsappSendMode: mode });
  await db.doc(`tenants/${tenant}/config/agent`).set({ botEnabled, greetingMessage: `Hola (${tenant})` }, { merge: true });
  // Reset de uso mensual: cada check arranca sin gating por límite (el caso 6 lo sube a propósito).
  await db.doc(`tenants/${tenant}`).set({ usage: { messagesThisMonth: 0, currentPeriodStart: now } }, { merge: true });
  await db.doc(`tenants/${tenant}/_debug/lastWhatsappSend`).delete().catch(() => {});
}

const waPayload = (pnid, from, mid) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: pnid },
    contacts: [{ wa_id: from, profile: { name: 'Test F4' } }],
    messages: [{ from, id: mid, timestamp: '1716750000', type: 'text', text: { body: 'hola fase4' } }],
  } }] }],
});

/** Postea un webhook al phone_number_id y devuelve la traza de envío (Mock inspeccionable) o null. */
async function sendAndGetDebug(tenant, pnid, from, { timeoutMs = 18_000 } = {}) {
  testCustomers.push([tenant, from]);
  const mid = `wamid.F4-${tenant}-${from}-${Date.now()}`;
  await fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(waPayload(pnid, from, mid)) });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const dbg = (await db.doc(`tenants/${tenant}/_debug/lastWhatsappSend`).get()).data();
    if (dbg) return dbg;
    await sleep(1000);
  }
  return null;
}

const owner = await signIn('owner@perfumeria.com'); // TENANT_OWNER de A (perfumeria)
const seller = await signIn('seller@perfumeria.com'); // SELLER de A

// 1. botEnabled + live + conexión válida → Mock live con phone_number_id + token del tenant A.
await setupTenant(A, PNID_A, { mode: 'live' });
const dbg1 = await sendAndGetDebug(A, PNID_A, '595900000001');
check('1. botEnabled+live+conexión válida → Mock live, phoneNumberId del tenant, tokenPresent',
  dbg1?.phoneNumberId === PNID_A && dbg1?.tokenPresent === true && dbg1?.mode === 'live' && dbg1?.viaMock === true, JSON.stringify(dbg1));

// 2. live SIN conexión resoluble → channelConfigUpdate('live') falla failed-precondition; no queda live.
await setupTenant(A, PNID_A, { mode: 'mock', status: 'not_connected', withToken: false });
const r2 = await callFn('channelConfigUpdate', { data: { whatsappSendMode: 'live' } }, owner);
const ch2 = (await db.doc(`tenants/${A}/config/channels`).get()).data();
check('2. live sin conexión resoluble → channelConfigUpdate falla (400 failed-precondition) y NO queda live',
  r2.status === 400 && r2.error?.status === 'FAILED_PRECONDITION' && ch2?.whatsappSendMode !== 'live', `status=${r2.status} mode=${ch2?.whatsappSendMode}`);

// 3. botEnabled=false + live → el engine no responde; no hay envío (sin traza).
await setupTenant(A, PNID_A, { mode: 'live', botEnabled: false });
const dbg3 = await sendAndGetDebug(A, PNID_A, '595900000003', { timeoutMs: 8_000 });
check('3. botEnabled=false + live → engine no responde, sin envío', dbg3 === null, JSON.stringify(dbg3));

// 4. seller NO puede activar live → channelConfigUpdate → 403.
const r4 = await callFn('channelConfigUpdate', { data: { whatsappSendMode: 'live' } }, seller);
check('4. seller NO puede activar live → 403', r4.status === 403, `status=${r4.status}`);

// 5. cross-tenant: inbound del número de A dispara SOLO el bot de A; B queda intacto.
await setupTenant(A, PNID_A, { mode: 'live' });
await setupTenant(B, PNID_B, { mode: 'live' });
await db.doc(`tenants/${A}/_debug/lastWhatsappSend`).delete().catch(() => {});
await db.doc(`tenants/${B}/_debug/lastWhatsappSend`).delete().catch(() => {});
const dbg5A = await sendAndGetDebug(A, PNID_A, '595900000005');
const dbg5B = (await db.doc(`tenants/${B}/_debug/lastWhatsappSend`).get()).data() ?? null;
check('5. cross-tenant: inbound de A resuelve a A (su phone_number_id) y NO dispara a B',
  dbg5A?.phoneNumberId === PNID_A && dbg5A.phoneNumberId !== PNID_B && dbg5B === null, `A=${dbg5A?.phoneNumberId} B=${dbg5B ? 'disparó' : 'intacto'}`);

// 6. límite de mensajes: usage al tope (free=500) → inbound bloqueado, sin envío ni incremento.
await setupTenant(A, PNID_A, { mode: 'live' });
await db.doc(`tenants/${A}`).set({ usage: { messagesThisMonth: 500, currentPeriodStart: Timestamp.now() } }, { merge: true });
const dbg6 = await sendAndGetDebug(A, PNID_A, '595900000006', { timeoutMs: 8_000 });
const usage6 = (await db.doc(`tenants/${A}`).get()).data()?.usage?.messagesThisMonth;
check('6. límite de mensajes → inbound bloqueado, sin envío ni incremento (usage queda 500)',
  dbg6 === null && usage6 === 500, `dbg=${dbg6 ? 'envió' : 'no'} usage=${usage6}`);

// 7. mock → nunca intenta envío real (reason mode_mock, sin phone_number_id).
await setupTenant(A, PNID_A, { mode: 'mock' });
const dbg7 = await sendAndGetDebug(A, PNID_A, '595900000007');
check('7. sendMode=mock → no envía real (reason mode_mock)', dbg7?.reason === 'mode_mock' && !dbg7?.phoneNumberId, JSON.stringify(dbg7));

// 8. conexión no activa en live → Mock con reason not_connected.
await setupTenant(B, PNID_B, { mode: 'live', status: 'not_connected' });
const dbg8 = await sendAndGetDebug(B, PNID_B, '595900000008');
check('8. conexión no activa → Mock (reason not_connected)', dbg8?.reason === 'not_connected', JSON.stringify(dbg8));

// 9. token vencido en live → Mock con reason token_expired.
await setupTenant(A, PNID_A, { mode: 'live', tokenExpiresAtMs: Date.now() - 1000 });
const dbg9 = await sendAndGetDebug(A, PNID_A, '595900000009');
check('9. token vencido → Mock (reason token_expired)', dbg9?.reason === 'token_expired', JSON.stringify(dbg9));

// --- Limpieza: deja a perfumeria/boutique sin override (verify-d2 reconecta la demo) ---
for (const [tenant, from] of testCustomers) {
  const cid = from.replace(/[^0-9]/g, '');
  for (const m of (await db.collection(`tenants/${tenant}/customers/${cid}/messages`).get()).docs) await m.ref.delete();
  for (const s of (await db.collection(`tenants/${tenant}/customers/${cid}/sessions`).get()).docs) await s.ref.delete();
  await db.doc(`tenants/${tenant}/customers/${cid}`).delete().catch(() => {});
}
for (const [tenant, pnid] of [[A, PNID_A], [B, PNID_B]]) {
  await db.doc(`tenants/${tenant}/_debug/lastWhatsappSend`).delete().catch(() => {});
  await db.doc(`tenants/${tenant}/config/channels`).delete().catch(() => {});
  await db.doc(`tenants/${tenant}/config/agent`).set({ botEnabled: true }, { merge: true });
  await db.doc(`tenants/${tenant}/metaAssets/${pnid}`).delete().catch(() => {});
  await db.doc(`metaExternalIndex/whatsapp_${pnid}`).delete().catch(() => {});
  await db.doc(`secrets/meta-token-${tenant}`).delete().catch(() => {});
  await db.doc(`tenants/${tenant}/metaConnections/main`).set({ status: 'not_connected', tokenSecretRef: '', updatedAt: Timestamp.now() }, { merge: true });
}
await db.doc(`tenants/${A}`).set({ usage: { messagesThisMonth: 0 } }, { merge: true });

const ok = results.every((x) => x);
console.log(`\nRESULTADO HARDENING F4A + W-3 (activación del agente + WhatsApp por tenant): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
