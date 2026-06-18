/**
 * verify-fase4-whatsapp.mjs — WhatsApp outbound POR TENANT (Hardening F4A).
 * Verifica que getWhatsAppClient resuelve credenciales por tenant (MetaConnection +
 * metaAsset whatsapp_phone_number + token vía SecretStore) y los GATES de envío real
 * (whatsappSendMode='live', estado 'active', token presente/no vencido). NUNCA llama a
 * Graph: en el emulador siempre es Mock, pero INSPECCIONABLE (escribe en _debug solo en
 * emulador) para poder aseverar el aislamiento tenant A / tenant B.
 *
 * Requiere el emulador con el código nuevo + TENANT_SECRETS_ENCRYPTION_KEY igual al de
 * este script (para que el cifrado del token coincida con el descifrado in-emulator).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';
process.env.TENANT_SECRETS_ENCRYPTION_KEY ??= 'test-tenant-encryption-key-000000000000000';

import { randomBytes, createCipheriv, scryptSync } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';

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

const A = 'perfumeria';
const B = 'boutique-demo';
const PNID_A = 'wa-perf-1';
const PNID_B = 'wa-bout-1';
const testCustomers = [];

/** Siembra la conexión + asset + índice + token cifrado + sendMode de un tenant. */
async function setupTenant(tenant, pnid, { mode = 'live', status = 'active', tokenExpiresAtMs = Date.now() + 3_600_000, withToken = true } = {}) {
  const now = Timestamp.now();
  // El name NO puede tener '/' (FirestoreSecretStore lo mapea a secrets/{name}, doc de 2 segmentos).
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
  // Asegura UN solo whatsapp_phone_number seleccionado (determinismo en la resolución).
  const old = await db.collection(`tenants/${tenant}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
  for (const d of old.docs) await d.ref.delete();
  await db.doc(`tenants/${tenant}/metaAssets/${pnid}`).set({ id: pnid, tenantId: tenant, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: pnid, name: 'wa', status: 'active', selected: true, createdAt: now, updatedAt: now });
  await db.doc(`metaExternalIndex/whatsapp_${pnid}`).set({ id: `whatsapp_${pnid}`, tenantId: tenant, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: pnid, status: 'active', updatedAt: now });
  await db.doc(`tenants/${tenant}/config/channels`).set({ whatsappSendMode: mode });
  // Garantiza que el bot responda (así se invoca el envío) y limpia la traza previa.
  await db.doc(`tenants/${tenant}/config/agent`).set({ botEnabled: true, greetingMessage: `Hola (${tenant})` }, { merge: true });
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

/** Postea un webhook al phone_number_id y devuelve la traza de envío (Mock inspeccionable). */
async function sendAndGetDebug(tenant, pnid, from) {
  testCustomers.push([tenant, from]);
  const mid = `wamid.F4-${tenant}-${from}-${Date.now()}`;
  await fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(waPayload(pnid, from, mid)) });
  const end = Date.now() + 18_000;
  while (Date.now() < end) {
    const dbg = (await db.doc(`tenants/${tenant}/_debug/lastWhatsappSend`).get()).data();
    if (dbg) return dbg;
    await sleep(1000);
  }
  return null;
}

// 1. Tenant A en 'live' con conexión activa + asset + token → resuelve SU phone_number_id.
await setupTenant(A, PNID_A, { mode: 'live' });
const dbgA = await sendAndGetDebug(A, PNID_A, '595900000001');
check('1. Tenant A (live) resuelve su phone_number_id y token', dbgA?.phoneNumberId === PNID_A && dbgA?.tokenPresent === true && dbgA?.mode === 'live' && dbgA?.viaMock === true, JSON.stringify(dbgA));

// 2. Tenant B en 'live' → resuelve SU propio phone_number_id (distinto).
await setupTenant(B, PNID_B, { mode: 'live' });
const dbgB = await sendAndGetDebug(B, PNID_B, '595900000002');
check('2. Tenant B (live) resuelve su propio phone_number_id y token', dbgB?.phoneNumberId === PNID_B && dbgB?.tokenPresent === true, JSON.stringify(dbgB));

// 3. AISLAMIENTO: A y B usan credenciales distintas (nunca se cruzan).
check('3. Aislamiento por tenant (A.phoneNumberId !== B.phoneNumberId)', !!dbgA && !!dbgB && dbgA.phoneNumberId !== dbgB.phoneNumberId, `${dbgA?.phoneNumberId} vs ${dbgB?.phoneNumberId}`);

// 4. sendMode='mock' → NO se envía real (reason mode_mock, sin phone_number_id).
await setupTenant(A, PNID_A, { mode: 'mock' });
const dbgMock = await sendAndGetDebug(A, PNID_A, '595900000003');
check('4. sendMode=mock → no envía real (reason mode_mock)', dbgMock?.reason === 'mode_mock' && !dbgMock?.phoneNumberId, JSON.stringify(dbgMock));

// 5. Estado no 'active' (not_connected) en live → Mock con reason not_connected.
await setupTenant(B, PNID_B, { mode: 'live', status: 'not_connected' });
const dbgNoConn = await sendAndGetDebug(B, PNID_B, '595900000004');
check('5. Conexión no activa → Mock (reason not_connected)', dbgNoConn?.reason === 'not_connected', JSON.stringify(dbgNoConn));

// 6. Token vencido en live → Mock con reason token_expired.
await setupTenant(A, PNID_A, { mode: 'live', tokenExpiresAtMs: Date.now() - 1000 });
const dbgExpired = await sendAndGetDebug(A, PNID_A, '595900000005');
check('6. Token vencido → Mock (reason token_expired)', dbgExpired?.reason === 'token_expired', JSON.stringify(dbgExpired));

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
  await db.doc(`tenants/${tenant}/metaAssets/${pnid}`).delete().catch(() => {});
  await db.doc(`metaExternalIndex/whatsapp_${pnid}`).delete().catch(() => {});
  await db.doc(`secrets/meta-token-${tenant}`).delete().catch(() => {});
  await db.doc(`tenants/${tenant}/metaConnections/main`).set({ status: 'not_connected', tokenSecretRef: '', updatedAt: Timestamp.now() }, { merge: true });
}

const ok = results.every((x) => x);
console.log(`\nRESULTADO HARDENING F4A (WhatsApp outbound por tenant): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
