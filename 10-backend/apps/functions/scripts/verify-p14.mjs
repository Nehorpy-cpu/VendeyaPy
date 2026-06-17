/**
 * verify-p14.mjs — Verificación en vivo de follow-ups inteligentes (P14).
 * Siembra escenarios, genera tareas y comprueba: se crean con mensaje sugerido,
 * no reviven al marcarlas, se limpian al dejar de aplicar, y el vendedor las lee.
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
const d40 = Timestamp.fromMillis(Date.now() - 40 * 86_400_000);

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const gen = () => fetch(`${BASE}/devGenerateFollowups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T }) });
const task = (id) => db.doc(`tenants/${T}/followUpTasks/${id}`);

// Sembrar escenarios
await db.doc(`tenants/${T}/customers/p14-hot`).set({ id: 'p14-hot', tenantId: T, name: 'Caliente', whatsappPhone: '+595', customerType: 'HOT', stats: { totalOrders: 0, totalSpent: 0, lastOrderAt: null, firstOrderAt: null }, createdAt: now, updatedAt: now });
await db.doc(`tenants/${T}/customers/p14-repurchase`).set({ id: 'p14-repurchase', tenantId: T, name: 'Recompra', whatsappPhone: '+595', customerType: 'BUYER', stats: { totalOrders: 1, totalSpent: 200000, lastOrderAt: d40, firstOrderAt: d40 }, createdAt: d40, updatedAt: d40 });
await db.doc(`tenants/${T}/customers/p14-pay`).set({ id: 'p14-pay', tenantId: T, name: 'Paga', whatsappPhone: '+595', createdAt: now, updatedAt: now });
await db.doc(`tenants/${T}/orders/p14-order-pay`).set({ id: 'p14-order-pay', tenantId: T, customerId: 'p14-pay', status: 'PENDING_PAYMENT', items: [], totals: { subtotal: 100000, discount: 0, total: 100000, currency: 'PYG' }, createdAt: now, updatedAt: now });

// 1. Generar
await gen();
const pay = (await task('fu-pay-p14-order-pay').get()).data();
const engage = (await task('fu-engage-p14-hot').get()).data();
const repurchase = (await task('fu-repurchase-p14-repurchase').get()).data();
check('1. Tarea "seguí el pago" creada + mensaje sugerido', pay?.status === 'PENDING' && !!pay?.suggestedMessage, pay?.title);
check('2. Tarea "escribile (preguntó y no compró)" creada', engage?.status === 'PENDING' && engage?.type === 'ENGAGE', engage?.title);
check('3. Tarea "recompra" creada', repurchase?.status === 'PENDING' && repurchase?.type === 'REPURCHASE', repurchase?.title);

// 2. Marcar "Hecho" el pago → al regenerar NO revive
await task('fu-pay-p14-order-pay').update({ status: 'COMPLETED', completedAt: now });
await gen();
check('4. La tarea marcada "Hecho" no revive', (await task('fu-pay-p14-order-pay').get()).data()?.status === 'COMPLETED');

// 3. El cliente caliente compra (deja de ser HOT) → la tarea "escribile" se limpia
await db.doc(`tenants/${T}/customers/p14-hot`).set({ customerType: 'BUYER' }, { merge: true });
await gen();
check('5. La tarea que ya no aplica se limpia (borrada)', !(await task('fu-engage-p14-hot').get()).exists);

// 4. Reglas: el vendedor SÍ lee las tareas
const sellerTok = (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'seller@perfumeria.com', password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const sStatus = (await fetch(`${FS}/tenants/${T}/followUpTasks/fu-repurchase-p14-repurchase`, { headers: { Authorization: `Bearer ${sellerTok}` } })).status;
check('6. La vendedora SÍ lee sus tareas (200)', sStatus === 200, `HTTP ${sStatus}`);

// Limpieza
for (const p of ['customers/p14-hot', 'customers/p14-repurchase', 'customers/p14-pay', 'orders/p14-order-pay', 'followUpTasks/fu-pay-p14-order-pay', 'followUpTasks/fu-engage-p14-hot', 'followUpTasks/fu-repurchase-p14-repurchase']) await db.doc(`tenants/${T}/${p}`).delete();

const ok = results.every((r) => r);
console.log(`\nRESULTADO P14: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
