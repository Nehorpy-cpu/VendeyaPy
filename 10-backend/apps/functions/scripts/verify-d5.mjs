/**
 * verify-d5.mjs — Verificación en vivo de la atribución (D5).
 * Atribuye un pedido a una campaña, calcula la atribución y comprueba el rollup
 * (ventas/ingresos/ganancia/ROAS). Verifica también la captura desde el webhook.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b = {}) => fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T, ...b }) }).then((r) => r.json());

// Asegurar conexión + campañas
await post('devMetaConnect');
await post('devSyncMetaAds');

// Sembrar un pedido PAID atribuido a camp-1 + sus finanzas
await db.doc(`tenants/${T}/customers/d5-cust`).set({ id: 'd5-cust', tenantId: T, name: 'D5', whatsappPhone: '+595', createdAt: now, updatedAt: now });
await db.doc(`tenants/${T}/orders/d5-order`).set({ id: 'd5-order', tenantId: T, customerId: 'd5-cust', status: 'PAID', items: [], totals: { subtotal: 500000, discount: 0, total: 500000, currency: 'PYG' }, attribution: { campaignId: 'camp-1', adId: 'ad-1', type: 'direct_meta', confidence: 1, platform: 'whatsapp' }, createdAt: now, updatedAt: now });
await db.doc(`tenants/${T}/orderFinancials/d5-order`).set({ orderId: 'd5-order', tenantId: T, subtotal: 500000, totalCost: 300000, grossProfit: 200000, grossMarginPercentage: 40, items: [], createdAt: now, updatedAt: now });

// Calcular atribución
await post('devComputeAttribution');
const camp = (await db.doc(`tenants/${T}/metaCampaigns/camp-1`).get()).data();
const a = camp?.attribution;
check('1. La campaña recibió la venta atribuida', !!a && a.orders >= 1, `ventas=${a?.orders}`);
check('2. Ingresos atribuidos correctos', !!a && a.revenue >= 500000, `ingresos=${a?.revenue}`);
check('3. Ganancia real atribuida', a?.grossProfit != null && a.grossProfit >= 200000, `ganancia=${a?.grossProfit}`);
check('4. ROAS calculado (ingresos / gasto)', a?.roas != null && a.roas > 0, `roas=${a?.roas}× (gasto=${camp?.latestMetrics?.spend})`);

// Captura de atribución desde el webhook (mensaje que vino de un anuncio)
const phone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
const cid = phone.replace(/[^0-9]/g, '');
const r = await post('devSimulateInbound', { platform: 'instagram', externalId: 'ig-200', from: phone, text: 'vi su anuncio en Instagram', adReferral: { campaignId: 'camp-2', adId: 'ad-2' } });
let cap = null;
for (let i = 0; i < 12; i++) { await sleep(1200); cap = (await db.doc(`tenants/${T}/customers/${cid}`).get()).data()?.attribution; if (cap) break; }
check('5. El webhook capturó de qué campaña vino el cliente', cap?.campaignId === 'camp-2', `attr=${cap?.campaignId}`);

// Limpieza
for (const p of ['orders/d5-order', 'orderFinancials/d5-order', 'customers/d5-cust', `customers/${cid}`]) await db.doc(`tenants/${T}/${p}`).delete();
if (r.eventId) await db.doc(`metaWebhookInbox/${r.eventId}`).delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO D5: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
