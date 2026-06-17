/**
 * verify-p16.mjs — Verificación en vivo de la auditoría del agente (P16).
 * Siembra: chat con 2 "no entendí", chat con reclamo sin derivar, producto incompleto.
 * Genera la auditoría y comprueba los 3 hallazgos + que no reviven al resolverlos.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const T = 'perfumeria';
const now = Timestamp.now();

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const gen = () => fetch(`${BASE}/devGenerateAudits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T }) });
const audit = (id) => db.doc(`tenants/${T}/agentAudits/${id}`);

const cust = (id, opts = {}) => db.doc(`tenants/${T}/customers/${id}`).set({
  id, tenantId: T, name: id, whatsappPhone: '+595', tags: [], notes: '',
  conversation: { lastMessageAt: now, lastMessagePreview: '', lastMessageDirection: 'in', state: 'IDLE', humanTakeover: opts.human ?? false, unreadForSeller: 0 },
  createdAt: now, updatedAt: now,
});
const msg = (cid, direction, author, text, i) => db.doc(`tenants/${T}/customers/${cid}/messages/m${i}`).set({ id: 'm' + i, tenantId: T, customerId: cid, direction, author, text, createdAt: Timestamp.fromMillis(now.toMillis() + i * 1000) });

// 1) Chat donde el bot no entendió 2 veces (frase del fallback)
await cust('p16-nounderstand');
await msg('p16-nounderstand', 'in', 'customer', 'tienen algo para mi abuela?', 1);
await msg('p16-nounderstand', 'out', 'bot', 'Puedo ayudarte a encontrar tu perfume ideal 🌸. Decime qué estilo buscás.', 2);
await msg('p16-nounderstand', 'in', 'customer', 'algo asi nomas', 3);
await msg('p16-nounderstand', 'out', 'bot', 'Puedo ayudarte a encontrar tu perfume ideal 🌸. Decime qué estilo buscás.', 4);

// 2) Chat con reclamo sin derivar (humanTakeover = false)
await cust('p16-complaint', { human: false });
await msg('p16-complaint', 'in', 'customer', 'esto es una estafa, quiero la devolución de mi plata', 1);

// 3) Producto incompleto (sin notas IA, sin descripción, sin costo)
await db.doc(`tenants/${T}/products/p16-prod`).set({ id: 'p16-prod', tenantId: T, name: 'Sin Datos', description: '', aiNotes: '', price: 100000, status: 'ACTIVE', inventory: { stock: 5 }, createdAt: now, updatedAt: now });

// Generar auditoría
await gen();
check('1. Hallazgo "no entendió" creado', (await audit('audit-nounderstand-p16-nounderstand').get()).data()?.issueType === 'NOT_UNDERSTOOD');
check('2. Hallazgo "reclamo sin derivar" creado', (await audit('audit-complaint-p16-complaint').get()).data()?.issueType === 'POSSIBLE_COMPLAINT_NO_HANDOFF');
check('3. Hallazgo "producto incompleto" creado', (await audit('audit-product-p16-prod').get()).data()?.issueType === 'PRODUCT_INCOMPLETE');

// Resolver uno → no revive
await audit('audit-product-p16-prod').update({ status: 'RESOLVED', resolvedAt: now });
await gen();
check('4. El hallazgo resuelto no revive', (await audit('audit-product-p16-prod').get()).data()?.status === 'RESOLVED');

// Limpieza
for (const cid of ['p16-nounderstand', 'p16-complaint']) {
  const ms = await db.collection(`tenants/${T}/customers/${cid}/messages`).get();
  for (const m of ms.docs) await m.ref.delete();
  await db.doc(`tenants/${T}/customers/${cid}`).delete();
}
for (const p of ['products/p16-prod', 'agentAudits/audit-nounderstand-p16-nounderstand', 'agentAudits/audit-complaint-p16-complaint', 'agentAudits/audit-product-p16-prod']) await db.doc(`tenants/${T}/${p}`).delete();

const ok = results.every((r) => r);
console.log(`\nRESULTADO P16: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
