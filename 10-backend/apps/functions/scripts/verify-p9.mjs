/**
 * verify-p9.mjs — Prueba de ACEPTACIÓN (blindaje multiempresa + roles).
 * Requiere emuladores + seed-users (incluye owner@boutique.com).
 * Verifica con logins reales:
 *   - Aislamiento: una empresa NO lee datos de otra; el Super Admin sí.
 *   - Roles: el vendedor no lee finanzas/insights/stats privado/config; sí lo operativo.
 *   - Sin sesión: todo denegado.
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
const now = Timestamp.now();

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const st = async (tok, path) => (await fetch(`${FS}/${path}`, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {})).status;

// --- Asegurar agregados + sembrar docs de prueba (ids fijos) ---
await fetch(`${BASE}/devRecomputeStats`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
const P = 'tenants/perfumeria';
const B = 'tenants/boutique-demo';
const seeded = [
  [`${P}/products/p9-prod`, { id: 'p9-prod', tenantId: 'perfumeria', name: 'P9', price: 1000, status: 'ACTIVE', inventory: { stock: 1 }, createdAt: now, updatedAt: now }],
  [`${P}/productFinancials/p9-prod`, { productId: 'p9-prod', tenantId: 'perfumeria', costPrice: 500, updatedAt: now }],
  [`${P}/orderFinancials/p9-ofin`, { orderId: 'p9-ofin', tenantId: 'perfumeria', subtotal: 1000, totalCost: 500, grossProfit: 500, grossMarginPercentage: 50, items: [], createdAt: now, updatedAt: now }],
  [`${P}/orders/p9-order`, { id: 'p9-order', tenantId: 'perfumeria', customerId: 'x', status: 'PENDING_PAYMENT', items: [], totals: { subtotal: 1000, discount: 0, total: 1000, currency: 'PYG' }, createdAt: now, updatedAt: now }],
  [`${P}/customers/p9cust`, { id: 'p9cust', tenantId: 'perfumeria', whatsappPhone: '+595', name: 'P9', createdAt: now, updatedAt: now }],
  [`${P}/promotions/p9-promo`, { id: 'p9-promo', tenantId: 'perfumeria', name: 'P9', type: 'PERCENTAGE', discountValue: 5, status: 'DRAFT', productIds: [], categoryIds: [], createdAt: now, updatedAt: now }],
  [`${P}/insights/p9-insight`, { id: 'p9-insight', tenantId: 'perfumeria', type: 'PROMO_SUGGESTION', title: 'P9', status: 'PENDING', createdAt: now, resolvedAt: null }],
  [`${P}/statsDaily/p9daily`, { date: 'p9daily', tenantId: 'perfumeria', orders: 1, revenue: 1000, createdAt: now, updatedAt: now }],
  [`${B}/products/b-prod`, { id: 'b-prod', tenantId: 'boutique-demo', name: 'B', price: 1, status: 'ACTIVE', inventory: { stock: 1 }, createdAt: now, updatedAt: now }],
];
for (const [path, data] of seeded) await db.doc(path).set(data);

const su = await signIn('superadmin@aiafg.com');
const pOwner = await signIn('owner@perfumeria.com');
const pSeller = await signIn('seller@perfumeria.com');
const bOwner = await signIn('owner@boutique.com');

console.log('\n— Aislamiento entre empresas —');
check('Dueña perfumería NO lee producto de boutique (403)', (await st(pOwner, `${B}/products/b-prod`)) === 403);
check('Dueño boutique NO lee producto de perfumería (403)', (await st(bOwner, `${P}/products/p9-prod`)) === 403);
check('Super Admin SÍ lee perfumería (200)', (await st(su, `${P}/products/p9-prod`)) === 200);
check('Super Admin SÍ lee boutique (200)', (await st(su, `${B}/products/b-prod`)) === 200);
check('Super Admin SÍ lee platformStats (200)', (await st(su, 'platformStats/current')) === 200);
check('Dueña perfumería NO lee platformStats (403)', (await st(pOwner, 'platformStats/current')) === 403);

console.log('\n— Límites del rol Vendedor (perfumería) —');
check('Vendedora SÍ lee productos (200)', (await st(pSeller, `${P}/products/p9-prod`)) === 200);
check('Vendedora SÍ lee clientes (200)', (await st(pSeller, `${P}/customers/p9cust`)) === 200);
check('Vendedora SÍ lee pedidos (200)', (await st(pSeller, `${P}/orders/p9-order`)) === 200);
check('Vendedora SÍ lee promociones (200)', (await st(pSeller, `${P}/promotions/p9-promo`)) === 200);
check('Vendedora SÍ lee stats/public (200)', (await st(pSeller, `${P}/stats/public`)) === 200);
check('Vendedora NO lee productFinancials (403)', (await st(pSeller, `${P}/productFinancials/p9-prod`)) === 403);
check('Vendedora NO lee orderFinancials (403)', (await st(pSeller, `${P}/orderFinancials/p9-ofin`)) === 403);
check('Vendedora NO lee stats/private (403)', (await st(pSeller, `${P}/stats/private`)) === 403);
check('Vendedora NO lee statsDaily (403)', (await st(pSeller, `${P}/statsDaily/p9daily`)) === 403);
check('Vendedora NO lee insights (403)', (await st(pSeller, `${P}/insights/p9-insight`)) === 403);
check('Vendedora NO lee config (bancos) (403)', (await st(pSeller, `${P}/config/agent`)) === 403);

console.log('\n— La Dueña SÍ ve lo privado —');
check('Dueña SÍ lee productFinancials (200)', (await st(pOwner, `${P}/productFinancials/p9-prod`)) === 200);
check('Dueña SÍ lee stats/private (200)', (await st(pOwner, `${P}/stats/private`)) === 200);
check('Dueña SÍ lee insights (200)', (await st(pOwner, `${P}/insights/p9-insight`)) === 200);
check('Dueña SÍ lee config (200)', (await st(pOwner, `${P}/config/agent`)) === 200);

console.log('\n— Sin sesión —');
check('Sin login NO lee nada (>=400)', (await st(null, `${P}/products/p9-prod`)) >= 400);

console.log('\n— Asignación de vendedor (P9.1) —');
const aphone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
const acid = aphone.replace(/[^0-9]/g, '');
const dev = (p, b) => fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
await dev('devMessage', { from: aphone, text: 'hola', tenantId: 'perfumeria' });
await dev('devTakeoverChat', { from: aphone, tenantId: 'perfumeria', by: 'Vendedora', sellerUid: 'uid-test-123' });
const acust = (await db.doc(`tenants/perfumeria/customers/${acid}`).get()).data();
check('Al tomar el chat, queda asignado al vendedor', acust?.assignedSellerId === 'uid-test-123', `assigned=${acust?.assignedSellerId}`);

// Limpieza
await db.doc(`tenants/perfumeria/customers/${acid}`).delete();
for (const [path] of seeded) await db.doc(path).delete();

const ok = results.every((r) => r);
console.log(`\nRESULTADO P9 (aceptación): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
