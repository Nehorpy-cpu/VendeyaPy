/**
 * verify-d2.mjs — Verificación en vivo de webhooks + omnicanal (D2).
 * Reconecta Meta (puebla el índice), prueba el handshake del webhook, y simula
 * mensajes entrantes de Instagram y WhatsApp: el trigger los procesa, resuelve la
 * empresa por el índice y los entrega al motor con su canal.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = `http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents`;
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b = {}) => fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
async function waitInbox(id, ms = 18000) { const end = Date.now() + ms; while (Date.now() < end) { const s = (await db.doc(`metaWebhookInbox/${id}`).get()).data()?.processingStatus; if (s && s !== 'received' && s !== 'processing') return s; await sleep(1200); } return 'timeout'; }
const lastMsgChannel = async (cid) => { const ms = await db.collection(`tenants/${T}/customers/${cid}/messages`).orderBy('createdAt', 'asc').limit(1).get(); return ms.docs[0]?.data()?.channel; };

// PLAN-LIMITS-3B: el procesamiento de canales NO-WhatsApp (Instagram/Messenger) ahora requiere la
// feature `multiChannel`. perfumeria (demo omnicanal) la habilita por featureOverride per-tenant
// (multiChannel queda en false en todos los PLANES porque el outbound IG aún no existe). Settle 31s
// para que el caché de entitlements (30s) refleje el override antes de procesar el inbound IG.
await db.doc(`tenants/${T}`).set({ featureOverrides: { multiChannel: true } }, { merge: true });
await sleep(31_000);

// 0. Reconectar (puebla metaExternalIndex con el código D2)
await post('devMetaConnect', { tenantId: T, byUid: 'uid-owner' });
const idx = await db.doc('metaExternalIndex/whatsapp_wa-595').get();
check('0. Índice externo poblado (whatsapp_wa-595 → empresa)', idx.data()?.tenantId === T);

// 1. Handshake del webhook (GET verify)
const okVerify = await fetch(`${BASE}/metaWebhook?hub.mode=subscribe&hub.verify_token=aiafg-verify-demo&hub.challenge=12345`);
const okBody = await okVerify.text();
check('1. Webhook responde el handshake con token correcto', okVerify.status === 200 && okBody === '12345');
const badVerify = await fetch(`${BASE}/metaWebhook?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=12345`);
check('2. Webhook rechaza token incorrecto (403)', badVerify.status === 403);

// 2. Entrante de Instagram → trigger procesa → mensaje con canal instagram
const igPhone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
const igCid = igPhone.replace(/[^0-9]/g, '');
const r1 = await post('devSimulateInbound', { platform: 'instagram', externalId: 'ig-200', from: igPhone, text: 'hola, vi su Instagram' });
const s1 = await waitInbox(r1.eventId);
check('3. Webhook de Instagram procesado', s1 === 'processed', `status=${s1}`);
check('4. El mensaje se guardó con canal instagram', (await lastMsgChannel(igCid)) === 'instagram');

// 3. Entrante de WhatsApp → canal whatsapp
const waPhone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
const waCid = waPhone.replace(/[^0-9]/g, '');
const r2 = await post('devSimulateInbound', { platform: 'whatsapp', externalId: 'wa-595', from: waPhone, text: 'hola por whatsapp' });
const s2 = await waitInbox(r2.eventId);
check('5. Webhook de WhatsApp procesado', s2 === 'processed', `status=${s2}`);
check('6. El mensaje se guardó con canal whatsapp', (await lastMsgChannel(waCid)) === 'whatsapp');

// 4. Reglas: la bandeja de webhooks es solo del Super Admin
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const statusAs = async (tok) => (await fetch(`${FS}/metaWebhookInbox/${r1.eventId}`, { headers: { Authorization: `Bearer ${tok}` } })).status;
check('7. Dueña NO lee la bandeja de webhooks (403)', (await statusAs(await signIn('owner@perfumeria.com'))) === 403);
check('8. Super Admin SÍ lee la bandeja (200)', (await statusAs(await signIn('superadmin@aiafg.com'))) === 200);

// Limpieza
for (const cid of [igCid, waCid]) {
  for (const m of (await db.collection(`tenants/${T}/customers/${cid}/messages`).get()).docs) await m.ref.delete();
  for (const s of (await db.collection(`tenants/${T}/customers/${cid}/sessions`).get()).docs) await s.ref.delete();
  await db.doc(`tenants/${T}/customers/${cid}`).delete();
}
for (const id of [r1.eventId, r2.eventId]) await db.doc(`metaWebhookInbox/${id}`).delete();
await db.doc(`tenants/${T}`).set({ featureOverrides: FieldValue.delete() }, { merge: true }); // restaura: sin override

const ok = results.every((r) => r);
console.log(`\nRESULTADO D2: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
