/**
 * verify-p13.mjs — Verificación en vivo del Centro de Decisiones (P13).
 * Siembra un cliente dormido-comprador y otro con mensajes sin responder, genera
 * las "acciones de hoy" y comprueba: se crean, no reviven al marcarlas, se limpian.
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
const old = Timestamp.fromMillis(Date.now() - 45 * 86_400_000);

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const gen = () => fetch(`${BASE}/devGenerateInsights`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T }) });
const ins = (id) => db.doc(`tenants/${T}/insights/${id}`);

// Sembrar: dormido que ya compró + cliente con mensajes sin responder
await db.doc(`tenants/${T}/customers/p13-dormant`).set({
  id: 'p13-dormant', tenantId: T, name: 'Cliente Dormido', whatsappPhone: '+595', customerType: 'DORMANT',
  stats: { totalOrders: 2, totalSpent: 350000, lastOrderAt: old, firstOrderAt: old },
  conversation: { lastMessageAt: old, lastMessagePreview: '', lastMessageDirection: 'in', state: 'IDLE', humanTakeover: false, unreadForSeller: 0 },
  createdAt: old, updatedAt: old,
});
await db.doc(`tenants/${T}/customers/p13-unread`).set({
  id: 'p13-unread', tenantId: T, name: 'Cliente Esperando', whatsappPhone: '+595', customerType: 'HOT',
  stats: { totalOrders: 0, totalSpent: 0, lastOrderAt: null, firstOrderAt: null },
  conversation: { lastMessageAt: now, lastMessagePreview: 'hola?', lastMessageDirection: 'in', state: 'IDLE', humanTakeover: true, unreadForSeller: 3 },
  createdAt: now, updatedAt: now,
});

// 1. Generar
await gen();
const react = (await ins('react-p13-dormant').get()).data();
const reply = (await ins('reply-p13-unread').get()).data();
check('1. Acción "reactivar dormido" creada (PENDING)', react?.status === 'PENDING' && react?.type === 'CUSTOMER_REACTIVATION', react?.title);
check('2. Acción "responder" creada (PENDING)', reply?.status === 'PENDING' && reply?.type === 'PENDING_REPLY', reply?.title);

// 2. Marcar "Hecho" reactivación → al regenerar NO revive
await ins('react-p13-dormant').update({ status: 'RESOLVED', resolvedAt: now });
await gen();
const react2 = (await ins('react-p13-dormant').get()).data();
check('3. La acción marcada "Hecho" no revive', react2?.status === 'RESOLVED', `status=${react2?.status}`);

// 3. El cliente responde (unread → 0) → la acción "responder" se limpia
await db.doc(`tenants/${T}/customers/p13-unread`).set({ conversation: { unreadForSeller: 0 } }, { merge: true });
await gen();
check('4. La acción que ya no aplica se limpia (borrada)', !(await ins('reply-p13-unread').get()).exists);

// Limpieza
for (const p of ['customers/p13-dormant', 'customers/p13-unread', 'insights/react-p13-dormant', 'insights/reply-p13-unread']) await db.doc(`tenants/${T}/${p}`).delete();

const ok = results.every((r) => r);
console.log(`\nRESULTADO P13: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
