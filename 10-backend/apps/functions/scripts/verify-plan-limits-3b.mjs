/**
 * verify-plan-limits-3b.mjs — Gate de feature `multiChannel` (PLAN-LIMITS-3B).
 * El procesamiento de canales NO-WhatsApp (Instagram/Messenger) requiere la feature `multiChannel`
 * del plan efectivo o un featureOverride del tenant. WhatsApp NUNCA se gatea. El gate vive en
 * meta/process.ts (NO-lanzante → marca el evento 'ignored', no 'failed'). perfumeria habilita la
 * feature por featureOverride per-tenant (queda en false en todos los PLANES). Settle del caché de
 * entitlements (30s) en cada flip del override. NO usa Anthropic/Graph real (devSimulateInbound).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const T = 'perfumeria';
const OTHER = 'boutique-demo';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b = {}) => fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
async function inboxResult(id, ms = 18000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const d = (await db.doc(`metaWebhookInbox/${id}`).get()).data();
    if (d && d.processingStatus !== 'received' && d.processingStatus !== 'processing') return { status: d.processingStatus, err: d.errorMessage ?? '' };
    await sleep(1000);
  }
  return { status: 'timeout', err: '' };
}
const lastChannel = async (t, cid) => (await db.collection(`tenants/${t}/customers/${cid}/messages`).orderBy('createdAt', 'asc').limit(1).get()).docs[0]?.data()?.channel;
const msgCount = async (t, cid) => (await db.collection(`tenants/${t}/customers/${cid}/messages`).get()).size;
const cidOf = (phone) => phone.replace(/[^0-9]/g, '');
const setOverride = (on) => db.doc(`tenants/${T}`).set({ featureOverrides: on ? { multiChannel: true } : FieldValue.delete() }, { merge: true });
const MC_REASON = 'canal no incluido en el plan (multiChannel)';
const usedCids = [];
const sim = async (platform, externalId, body, tenant = T) => {
  const phone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
  const cid = cidOf(phone);
  usedCids.push({ tenant, cid });
  const r = await post('devSimulateInbound', { platform, externalId, from: phone, text: body });
  const res = await inboxResult(r.eventId);
  return { eventId: r.eventId, cid, ...res };
};
const eventIds = [];

// ---- Setup: conectar perfumeria (índices wa-595/ig-200/fb-300) + índice IG de boutique + reset usage ----
await post('devMetaConnect', { tenantId: T, byUid: 'uid-3b' });
const now = Timestamp.now();
await db.doc('metaExternalIndex/instagram_ig-boutique').set({ id: 'instagram_ig-boutique', tenantId: OTHER, connectionId: 'main', assetType: 'instagram_account', platform: 'instagram', externalId: 'ig-boutique', status: 'active', updatedAt: now });
// messagesThisMonth=0 en ambos → el gate de empresa (cuota) no interfiere; el único bloqueo será el de multiChannel.
await db.doc(`tenants/${T}`).set({ usage: { messagesThisMonth: 0, currentPeriodStart: now } }, { merge: true });
await db.doc(`tenants/${OTHER}`).set({ usage: { messagesThisMonth: 0, currentPeriodStart: now } }, { merge: true });

// ============================ FASE OFF (multiChannel deshabilitado) ============================
await setOverride(false);
console.log('→ settle del caché de entitlements (multiChannel OFF, 31s)…');
await sleep(31_000);

const ig1 = await sim('instagram', 'ig-200', 'hola por IG');
eventIds.push(ig1.eventId);
check('1. IG sin multiChannel → NO se procesa (ignored) por el gate de feature', ig1.status === 'ignored' && ig1.err === MC_REASON, `status=${ig1.status} err="${ig1.err}"`);
check('1b. el mensaje NO se entregó al motor (no se guardó)', (await msgCount(T, ig1.cid)) === 0, `msgs=${await msgCount(T, ig1.cid)}`);

const ms1 = await sim('messenger', 'fb-300', 'hola por Messenger');
eventIds.push(ms1.eventId);
check('2. Messenger sin multiChannel → ignored por el gate', ms1.status === 'ignored' && ms1.err === MC_REASON, `status=${ms1.status} err="${ms1.err}"`);

const wa1 = await sim('whatsapp', 'wa-595', 'hola por WhatsApp');
eventIds.push(wa1.eventId);
check('3. WhatsApp SIEMPRE se procesa (nunca gateado, ningún plan se rompe)', wa1.status === 'processed', `status=${wa1.status}`);
check('3b. el mensaje de WhatsApp se guardó con canal whatsapp', (await lastChannel(T, wa1.cid)) === 'whatsapp');

// ============================ FASE ON (multiChannel habilitado por override) ============================
await setOverride(true);
console.log('→ settle del caché de entitlements (multiChannel ON, 31s)…');
await sleep(31_000);

const ig2 = await sim('instagram', 'ig-200', 'hola otra vez por IG');
eventIds.push(ig2.eventId);
check('4. IG con multiChannel (featureOverride) → se procesa', ig2.status === 'processed', `status=${ig2.status} err="${ig2.err}"`);
check('4b. el mensaje de IG se guardó con canal instagram', (await lastChannel(T, ig2.cid)) === 'instagram');

// ============================ CROSS-TENANT ============================
// perfumeria sigue con el override ON; boutique NO lo tiene → su IG debe seguir bloqueado.
const xig = await sim('instagram', 'ig-boutique', 'hola boutique IG', OTHER);
eventIds.push(xig.eventId);
check('5. cross-tenant: el override de perfumeria NO habilita multiChannel en boutique → ignored', xig.status === 'ignored' && xig.err === MC_REASON, `status=${xig.status} err="${xig.err}"`);

// ---- Limpieza + restaurar (sin override) + settle ----
await setOverride(false);
for (const { tenant, cid } of usedCids) {
  for (const m of (await db.collection(`tenants/${tenant}/customers/${cid}/messages`).get()).docs) await m.ref.delete();
  for (const s of (await db.collection(`tenants/${tenant}/customers/${cid}/sessions`).get()).docs) await s.ref.delete();
  await db.doc(`tenants/${tenant}/customers/${cid}`).delete().catch(() => {});
}
for (const id of eventIds) await db.doc(`metaWebhookInbox/${id}`).delete().catch(() => {});
await db.doc('metaExternalIndex/instagram_ig-boutique').delete().catch(() => {});
await sleep(31_000); // settle: no contaminar las regresiones siguientes con multiChannel cacheado

const ok = results.every((x) => x);
console.log(`\nRESULTADO PLAN-LIMITS-3B (gate de feature multiChannel): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
