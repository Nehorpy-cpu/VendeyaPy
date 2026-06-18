/**
 * verify-fase3-meta.mjs — Verifica el webhook Meta REAL (Hardening F3).
 * Parser real (entry[]/changes[]) → inbox normalizado → trigger procesa; idempotencia
 * por messageId; no-texto ignorado; devSimulateInbound (simplificado) sigue compatible.
 *
 * Requiere el emulador con el código nuevo cargado (rebuild functions + restart).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const T = 'perfumeria';
const PNID = 'wa-595'; // coincide con el índice demo (whatsapp_wa-595 → perfumeria)
const PHONE = '595990000099';
const MID = 'wamid.F3' + Date.now();
const inboxId = `whatsapp_${MID}`.replace(/[^\w.:=+-]/g, '_').slice(0, 256);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const post = (body) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const waPayload = (mid) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '595991234567', phone_number_id: PNID },
    contacts: [{ wa_id: PHONE, profile: { name: 'Test F3' } }],
    messages: [{ from: PHONE, id: mid, timestamp: '1716750000', type: 'text', text: { body: 'hola desde el webhook real' } }],
  } }] }],
});

// Seed EXPLÍCITO del índice (idempotente) → el e2e siempre resuelve la empresa.
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: Timestamp.now() }, { merge: true });
// Limpieza previa
await db.doc(`metaWebhookInbox/${inboxId}`).delete().catch(() => {});
await db.doc(`tenants/${T}/customers/${PHONE}/sessions/active`).delete().catch(() => {});
await db.doc(`tenants/${T}/customers/${PHONE}`).delete().catch(() => {});

// 1. Webhook real → parseado y escrito
const r1 = await post(waPayload(MID));
check('1. Webhook real parseado (written=1, ignored=0)', r1.status === 200 && r1.json?.written === 1 && r1.json?.ignored === 0, JSON.stringify(r1.json));

// 2. Inbox con id determinístico (idempotencia)
check('2. Inbox con id determinístico (platform_messageId)', (await db.doc(`metaWebhookInbox/${inboxId}`).get()).exists);

// 3. El trigger procesó (cliente + mensaje + inbox processed)
await sleep(3000);
const msgs = await db.collection(`tenants/${T}/customers/${PHONE}/messages`).get();
const inboxAfter = (await db.doc(`metaWebhookInbox/${inboxId}`).get()).data();
check('3. El motor procesó (cliente + inbox processed)', msgs.size >= 1 && inboxAfter?.processingStatus === 'processed', `msgs=${msgs.size} status=${inboxAfter?.processingStatus}`);

// 4. Idempotencia: reenvío del mismo messageId
const r2 = await post(waPayload(MID));
check('4. Reenvío mismo messageId → duplicate (no duplica)', r2.json?.duplicates === 1 && r2.json?.written === 0, JSON.stringify(r2.json));

// 5. No-texto (imagen) → ignored
const r3 = await post({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, messages: [{ from: PHONE, id: 'wamid.IMGF3', timestamp: '1', type: 'image', image: { id: 'X' } }] } }] }] });
check('5. Mensaje no-texto → ignored (written=0)', r3.json?.ignored === 1 && r3.json?.written === 0, JSON.stringify(r3.json));

// 6. devSimulateInbound (simplificado) sigue compatible
const r4 = await fetch(`${BASE}/devSimulateInbound`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T, from: '+595990000098', text: 'compat', externalId: PNID }) }).then((r) => r.status);
check('6. devSimulateInbound sigue funcionando (compat)', r4 === 200, `HTTP ${r4}`);

// Limpieza
await db.doc(`metaWebhookInbox/${inboxId}`).delete().catch(() => {});
for (const p of [PHONE, '595990000098']) {
  await db.doc(`tenants/${T}/customers/${p}/sessions/active`).delete().catch(() => {});
  await db.doc(`tenants/${T}/customers/${p}`).delete().catch(() => {});
}

const ok = results.every((x) => x);
console.log(`\nRESULTADO HARDENING F3 (webhook Meta real): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
