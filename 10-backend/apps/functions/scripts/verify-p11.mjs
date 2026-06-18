/**
 * verify-p11.mjs — Verificación en vivo del tracking propio (P11).
 * El bot capta un código del mensaje y atribuye al cliente; first-touch (no pisa una
 * atribución previa); rollup de ventas por código; reglas (vendedor lee, no edita).
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
const post = (p, b = {}) => fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T, ...b }) }).then((r) => r.json());
const attrOf = async (cid) => (await db.doc(`tenants/${T}/customers/${cid}`).get()).data()?.attribution;

// Código de prueba
await db.doc(`tenants/${T}/trackingSources/p11-code`).set({ id: 'p11-code', tenantId: T, name: 'Prueba', code: 'TEST50', type: 'coupon', active: true, createdAt: now, updatedAt: now });

// 1. El bot capta el código del mensaje
const phone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
const cid = phone.replace(/[^0-9]/g, '');
await post('devMessage', { from: phone, text: 'hola, quiero usar el cupón TEST50' });
const a1 = await attrOf(cid);
check('1. El bot atribuyó el cliente al código', a1?.campaignId === 'p11-code' && a1?.type === 'coupon_match', `attr=${a1?.campaignId}`);

// 2. First-touch: no pisa una atribución previa (ej: vino de Meta)
const phone2 = '+595' + Math.floor(900000000 + Math.random() * 99999999);
const cid2 = phone2.replace(/[^0-9]/g, '');
await db.doc(`tenants/${T}/customers/${cid2}`).set({ id: cid2, tenantId: T, whatsappPhone: phone2, attribution: { campaignId: 'camp-1', adId: 'ad-1', type: 'direct_meta', confidence: 1, platform: 'whatsapp' }, createdAt: now, updatedAt: now });
await post('devMessage', { from: phone2, text: 'uso TEST50' });
check('2. First-touch: no pisa la atribución previa (Meta)', (await attrOf(cid2))?.campaignId === 'camp-1');

// 3. Rollup: pedido atribuido al código → ventas/ingresos/ganancia
await db.doc(`tenants/${T}/orders/p11-order`).set({ id: 'p11-order', tenantId: T, customerId: 'p11oc', status: 'PAID', items: [], channel: 'WHATSAPP', totals: { subtotal: 250000, discount: 0, total: 250000, currency: 'PYG' }, attribution: { campaignId: 'p11-code', adId: null, type: 'coupon_match', confidence: 0.9, platform: null }, createdAt: now, updatedAt: now });
await db.doc(`tenants/${T}/orderFinancials/p11-order`).set({ orderId: 'p11-order', tenantId: T, subtotal: 250000, totalCost: 130000, grossProfit: 120000, grossMarginPercentage: 48, items: [], createdAt: now, updatedAt: now });
await post('devComputeTracking');
const src = (await db.doc(`tenants/${T}/trackingSources/p11-code`).get()).data();
check('3. Rollup del código: ventas + ingresos + ganancia', src?.attribution?.orders >= 1 && src.attribution.revenue >= 250000 && src.attribution.grossProfit >= 120000, `ventas=${src?.attribution?.orders} ganancia=${src?.attribution?.grossProfit}`);

// 4. Reglas: el vendedor LEE los códigos pero NO los edita
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const seller = await signIn('seller@perfumeria.com');
const rd = (await fetch(`${FS}/tenants/${T}/trackingSources/p11-code`, { headers: { Authorization: `Bearer ${seller}` } })).status;
const wr = (await fetch(`${FS}/tenants/${T}/trackingSources/p11-code?updateMask.fieldPaths=name`, { method: 'PATCH', headers: { Authorization: `Bearer ${seller}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { name: { stringValue: 'hack' } } }) })).status;
check('4. Vendedora SÍ lee los códigos (200)', rd === 200, `HTTP ${rd}`);
check('5. Vendedora NO edita los códigos (403)', wr === 403, `HTTP ${wr}`);

// Limpieza
for (const p of [`customers/${cid}`, `customers/${cid2}`, 'orders/p11-order', 'orderFinancials/p11-order', 'trackingSources/p11-code']) await db.doc(`tenants/${T}/${p}`).delete();

const ok = results.every((x) => x);
console.log(`\nRESULTADO P11: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
