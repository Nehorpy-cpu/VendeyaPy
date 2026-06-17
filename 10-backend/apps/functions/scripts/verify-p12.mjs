/**
 * verify-p12.mjs — Verificación en vivo del score/segmentación de clientes (P12).
 * Siembra clientes con perfiles distintos, recalcula y comprueba el tipo asignado.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const T = 'perfumeria';
const DAY = 86_400_000;
const nowMs = Date.now();
const ago = (days) => Timestamp.fromMillis(nowMs - days * DAY);

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };

// id, días desde última interacción, [montos de pedidos PAID], tipo esperado
const CASES = [
  ['p12-hot', 1, [], 'HOT'],
  ['p12-new', 15, [], 'NEW'],
  ['p12-buyer', 1, [200000], 'BUYER'],
  ['p12-recurring', 1, [200000, 150000], 'RECURRING'],
  ['p12-premium', 1, [1200000], 'PREMIUM'],
  ['p12-dormant', 45, [], 'DORMANT'],
  ['p12-lost', 200, [], 'LOST'],
];

const created = [];
for (const [id, days, montos] of CASES) {
  await db.doc(`tenants/${T}/customers/${id}`).set({
    id, tenantId: T, name: id, whatsappPhone: '+595', tags: [], notes: '',
    conversation: { lastMessageAt: ago(days), lastMessagePreview: '', lastMessageDirection: 'in', state: 'IDLE', humanTakeover: false, unreadForSeller: 0 },
    createdAt: ago(days), updatedAt: ago(days),
  });
  created.push(`tenants/${T}/customers/${id}`);
  montos.forEach((total, i) => {
    const oid = `${id}-o${i}`;
    db.doc(`tenants/${T}/orders/${oid}`).set({
      id: oid, tenantId: T, customerId: id, status: 'PAID', items: [],
      totals: { subtotal: total, discount: 0, total, currency: 'PYG' }, createdAt: ago(days), updatedAt: ago(days),
    });
    created.push(`tenants/${T}/orders/${oid}`);
  });
}
// esperar a que se escriban los pedidos (set sin await en el forEach)
await new Promise((r) => setTimeout(r, 800));

await fetch(`${BASE}/devRecomputeScores`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T }) });

for (const [id, , , esperado] of CASES) {
  const c = (await db.doc(`tenants/${T}/customers/${id}`).get()).data();
  check(`${id} → ${esperado}`, c?.customerType === esperado, `tipo=${c?.customerType} score=${c?.customerScore}`);
}

for (const path of created) await db.doc(path).delete();

const ok = results.every((r) => r);
console.log(`\nRESULTADO P12: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
