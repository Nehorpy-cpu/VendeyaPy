/**
 * verify-p15.mjs — Verificación en vivo del Modo Ganancia (P15).
 * Catálogo controlado: 2 perfumes "dulce" con igual relevancia pero distinto margen.
 *   profitMode OFF → manda la relevancia (el destacado primero).
 *   profitMode ON  → manda el margen (el más rentable primero).
 *   El costo NUNCA aparece en la respuesta al cliente.
 * Restaurá la demo después con: node scripts/load-catalog.mjs && node scripts/seed-demo.mjs
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
const setProfit = (on) => db.doc(`tenants/${T}/config/agent`).set({ profitMode: on, botEnabled: true, greetingMessage: '' }, { merge: true });
const post = (p, b) => fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const firstShown = async (cid) => (await db.doc(`tenants/${T}/customers/${cid}/sessions/active`).get()).data()?.context?.lastShownSkus?.[0];

function perfume() { return { brand: 'Test', gender: 'Femenino', olfactiveFamily: '', styleTags: ['dulce'], notes: { top: [], heart: [], base: [] }, priceRange: 'MID', sizeMl: null, isNew: false }; }
async function seedProd(id, featured) {
  await db.doc(`tenants/${T}/products/${id}`).set({ id, tenantId: T, name: id, description: '', price: 100000, compareAtPrice: null, aiNotes: '', currency: 'PYG', categoryId: 'perfumes', images: [], emoji: '🧪', inventory: { trackStock: true, stock: 10, lowStockThreshold: 3, sku: id }, status: 'ACTIVE', featured, position: 1, externalIds: { facebook: null, instagram: null, tiktok: null }, perfume: perfume(), createdAt: now, updatedAt: now });
}

// Catálogo controlado: A = destacado, bajo margen (cost 90k). B = no destacado, alto margen (cost 30k).
const prods = await db.collection(`tenants/${T}/products`).get();
for (const d of prods.docs) await d.ref.delete();
await seedProd('p15-a', true);
await seedProd('p15-b', false);
await db.doc(`tenants/${T}/productFinancials/p15-a`).set({ productId: 'p15-a', tenantId: T, costPrice: 90000, priorityScore: 0, updatedAt: now });
await db.doc(`tenants/${T}/productFinancials/p15-b`).set({ productId: 'p15-b', tenantId: T, costPrice: 30000, priorityScore: 0, updatedAt: now });

const ask = async (on) => {
  await setProfit(on);
  const phone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
  await post('devMessage', { from: phone, text: 'hola', tenantId: T });
  const r = await post('devMessage', { from: phone, text: 'busco algo dulce', tenantId: T });
  return { first: await firstShown(phone.replace(/[^0-9]/g, '')), reply: r.reply ?? '' };
};

const off = await ask(false);
check('1. Modo Ganancia OFF → primero el destacado (relevancia)', off.first === 'p15-a', `primero=${off.first}`);
const on = await ask(true);
check('2. Modo Ganancia ON → primero el más rentable (margen)', on.first === 'p15-b', `primero=${on.first}`);
check('3. El costo NUNCA aparece en la respuesta al cliente', !on.reply.includes('30.000') && !on.reply.includes('90.000') && !on.reply.includes('30000') && !on.reply.includes('90000'));

// Limpiar test + dejar profitMode en false
for (const p of ['products/p15-a', 'products/p15-b', 'productFinancials/p15-a', 'productFinancials/p15-b']) await db.doc(`tenants/${T}/${p}`).delete();
await setProfit(false);

const ok = results.every((r) => r);
console.log(`\nRESULTADO P15: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
