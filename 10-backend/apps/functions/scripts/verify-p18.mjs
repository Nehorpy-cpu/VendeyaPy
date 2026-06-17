/**
 * verify-p18.mjs — Verificación en vivo de respuestas ganadoras (P18).
 * Siembra 2 chats que cerraron venta con la misma respuesta saliente, mina, y
 * comprueba que queda como "ganadora" con 2 conversiones; + manual + reglas.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = `http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents`;
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
const now = Timestamp.now();

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };

const REPLY = 'Buenísimo! Te reservo el perfume y coordinamos el pago por transferencia 😊';
async function convChat(cid) {
  await db.doc(`tenants/${T}/customers/${cid}`).set({ id: cid, tenantId: T, name: cid, whatsappPhone: '+595', createdAt: now, updatedAt: now });
  await db.doc(`tenants/${T}/orders/${cid}-o`).set({ id: `${cid}-o`, tenantId: T, customerId: cid, status: 'PAID', items: [], totals: { subtotal: 100000, discount: 0, total: 100000, currency: 'PYG' }, createdAt: now, updatedAt: now });
  await db.doc(`tenants/${T}/customers/${cid}/messages/m1`).set({ id: 'm1', tenantId: T, customerId: cid, direction: 'in', author: 'customer', text: 'lo quiero!', createdAt: now });
  await db.doc(`tenants/${T}/customers/${cid}/messages/m2`).set({ id: 'm2', tenantId: T, customerId: cid, direction: 'out', author: 'bot', text: REPLY, createdAt: Timestamp.fromMillis(now.toMillis() + 1000) });
}
await convChat('p18-c1');
await convChat('p18-c2');

// Minar
await fetch(`${BASE}/devGenerateWinningReplies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T }) });

const all = (await db.collection(`tenants/${T}/winningReplies`).get()).docs.map((d) => d.data());
const winner = all.find((r) => r.source === 'auto' && r.text.includes('reservo el perfume'));
check('1. La respuesta de chats convertidos quedó como "ganadora"', !!winner, winner ? `conversiones=${winner.conversions}` : 'no encontrada');
check('2. Cuenta 2 conversiones (apareció en 2 ventas)', winner?.conversions === 2);

// Manual
await db.doc(`tenants/${T}/winningReplies/p18-manual`).set({ id: 'p18-manual', tenantId: T, text: 'Gracias por tu compra 💖', category: 'Cierre', source: 'manual', conversions: 0, status: 'ACTIVE', createdAt: now, updatedAt: now });
check('3. Respuesta manual presente', (await db.doc(`tenants/${T}/winningReplies/p18-manual`).get()).exists);

// Reglas: el vendedor LEE pero NO escribe
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const seller = await signIn('seller@perfumeria.com');
const readStatus = (await fetch(`${FS}/tenants/${T}/winningReplies/p18-manual`, { headers: { Authorization: `Bearer ${seller}` } })).status;
const writeStatus = (await fetch(`${FS}/tenants/${T}/winningReplies/p18-manual?updateMask.fieldPaths=category`, { method: 'PATCH', headers: { Authorization: `Bearer ${seller}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { category: { stringValue: 'hack' } } }) })).status;
check('4. Vendedora SÍ lee las respuestas (200)', readStatus === 200, `HTTP ${readStatus}`);
check('5. Vendedora NO puede editarlas (403)', writeStatus === 403, `HTTP ${writeStatus}`);

// Limpieza
for (const cid of ['p18-c1', 'p18-c2']) {
  for (const m of ['m1', 'm2']) await db.doc(`tenants/${T}/customers/${cid}/messages/${m}`).delete();
  await db.doc(`tenants/${T}/customers/${cid}`).delete();
  await db.doc(`tenants/${T}/orders/${cid}-o`).delete();
}
for (const d of (await db.collection(`tenants/${T}/winningReplies`).get()).docs) if (d.id === 'p18-manual' || d.data().text?.includes('reservo el perfume')) await d.ref.delete();

const ok = results.every((r) => r);
console.log(`\nRESULTADO P18: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
