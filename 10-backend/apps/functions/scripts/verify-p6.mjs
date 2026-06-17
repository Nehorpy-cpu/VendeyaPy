/**
 * verify-p6.mjs — Verificación en vivo de la P6 (privacidad financiera).
 * Requiere emuladores + catálogo recargado (load-catalog.mjs con la versión P6).
 *
 * Comprueba que:
 *   - el producto VISIBLE no expone costPrice; productFinancials sí lo tiene.
 *   - al crear un pedido por el bot, la orden VISIBLE no expone costo/ganancia;
 *     orderFinancials sí (con snapshot de costo por ítem).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const TENANT = 'perfumeria';
const phone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
const cid = phone.replace(/[^0-9]/g, '');

const post = (p, b) =>
  fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const msg = (t) => post('devMessage', { from: phone, text: t, tenantId: TENANT });

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };

// --- Productos ---
const prods = await db.collection(`tenants/${TENANT}/products`).get();
const anyCostInProduct = prods.docs.some((d) => 'costPrice' in d.data());
check('1. Ningún producto VISIBLE expone costPrice', prods.size > 0 && !anyCostInProduct, `productos=${prods.size}`);

const fins = await db.collection(`tenants/${TENANT}/productFinancials`).get();
const withCost = fins.docs.filter((d) => d.data().costPrice != null).length;
check('2. productFinancials (privado) tiene el costo', fins.size > 0 && withCost > 0, `con costo=${withCost}/${fins.size}`);

// --- Pedido por el bot ---
await msg('hola');
await msg('busco un perfume');
await msg('quiero el primero');
const pay = await msg('pagar');
check('3. El bot llegó al checkout', pay.state === 'AWAITING_PAYMENT' || !!pay.reply, `state=${pay.state}`);

const orders = await db.collection(`tenants/${TENANT}/orders`).where('customerId', '==', cid).get();
check('4. Se creó la orden', orders.size >= 1, `orders=${orders.size}`);
const order = orders.docs[0]?.data();
const orderId = orders.docs[0]?.id;

const itemHasCost = (order?.items || []).some((it) => 'grossProfit' in it || 'unitCost' in it || 'totalCost' in it);
const totalsHasCost = order ? ('grossProfit' in order.totals || 'totalCost' in order.totals) : true;
check('5. La orden VISIBLE no expone costo/ganancia', !itemHasCost && !totalsHasCost);

const ofin = orderId ? (await db.doc(`tenants/${TENANT}/orderFinancials/${orderId}`).get()).data() : null;
check('6. orderFinancials (privado) con ganancia', !!ofin && ofin.grossProfit != null, `ganancia=${ofin?.grossProfit}`);
check('7. orderFinancials con snapshot de costo por ítem', !!ofin && (ofin.items || []).some((i) => i.unitCostSnapshot != null));

const ok = results.every((r) => r);
console.log(`\nRESULTADO P6: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
