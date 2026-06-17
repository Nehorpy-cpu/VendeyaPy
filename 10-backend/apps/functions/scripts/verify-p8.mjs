/**
 * verify-p8.mjs — Verificación en vivo de la P8 (promociones + sugerencias por reglas).
 * Requiere emuladores. Siembra un producto que dispara las reglas y comprueba:
 * sugerencias generadas, idempotencia (no revive descartadas), limpieza (borra las
 * que dejan de aplicar), y reglas (vendedor no lee insights; sí lee promotions).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const TENANT = 'perfumeria';
const FS = `http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents`;
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const post = (p, b) => fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

const PID = 'test-promo-perfume';
const insight = (id) => db.doc(`tenants/${TENANT}/insights/${id}`);
const estrella = `promo-estrella-${PID}`;
const parado = `promo-parado-${PID}`;

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const now = Timestamp.now();

// Sembrar producto que dispara AMBAS reglas: margen 60% + stock 20 + no destacado + sin ventas.
async function seedProduct(stock) {
  await db.doc(`tenants/${TENANT}/products/${PID}`).set({
    id: PID, tenantId: TENANT, name: 'Test Promo Perfume', description: '', price: 100000,
    compareAtPrice: null, aiNotes: '', currency: 'PYG', categoryId: 'perfumes', images: [], emoji: '🧪',
    inventory: { trackStock: true, stock, lowStockThreshold: 3, sku: PID }, status: 'ACTIVE', featured: false,
    position: 999, externalIds: { facebook: null, instagram: null, tiktok: null }, perfume: null,
    createdAt: now, updatedAt: now,
  });
  await db.doc(`tenants/${TENANT}/productFinancials/${PID}`).set({ productId: PID, tenantId: TENANT, costPrice: 40000, updatedAt: now });
}

await seedProduct(20);

// 1. Generar sugerencias
await post('devGenerateSuggestions', { tenantId: TENANT });
const e1 = (await insight(estrella).get()).data();
const p1 = (await insight(parado).get()).data();
check('1. Sugerencia "estrella oculta" creada (PENDING)', e1?.status === 'PENDING', e1?.title);
check('2. Sugerencia "stock parado" creada (PENDING)', p1?.status === 'PENDING', p1?.title);

// 2. Descartar la "estrella" y regenerar → NO debe revivir
await insight(estrella).update({ status: 'DISMISSED', resolvedAt: now });
await post('devGenerateSuggestions', { tenantId: TENANT });
const e2 = (await insight(estrella).get()).data();
check('3. La descartada NO revive al regenerar', e2?.status === 'DISMISSED', `status=${e2?.status}`);

// 3. Bajar stock a 2 → "stock parado" deja de aplicar → debe limpiarse (borrarse)
await seedProduct(2);
await post('devGenerateSuggestions', { tenantId: TENANT });
const p3 = await insight(parado).get();
check('4. La sugerencia que ya no aplica se limpia (borrada)', !p3.exists);

// 4. Reglas con auth: insights solo manager+; promotions las ve el vendedor
await db.doc(`tenants/${TENANT}/promotions/test-promo`).set({
  id: 'test-promo', tenantId: TENANT, name: 'Promo prueba', description: '', type: 'PERCENTAGE',
  discountValue: 10, objective: '', productIds: [PID], categoryIds: [], startDate: null, endDate: null,
  status: 'DRAFT', createdAt: now, updatedAt: now,
});
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const statusAs = async (tok, path) => (await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${tok}` } })).status;
const seller = await signIn('seller@perfumeria.com');
const owner = await signIn('owner@perfumeria.com');
check('5. Vendedora NO lee insights (403)', (await statusAs(seller, `tenants/${TENANT}/insights/${estrella}`)) === 403);
check('6. Dueña SÍ lee insights (200)', (await statusAs(owner, `tenants/${TENANT}/insights/${estrella}`)) === 200);
check('7. Vendedora SÍ lee promotions (200)', (await statusAs(seller, `tenants/${TENANT}/promotions/test-promo`)) === 200);

// Limpieza del producto/insights de prueba
await seedProduct(20); // dejar algo coherente no hace falta; borramos todo
for (const ref of [db.doc(`tenants/${TENANT}/products/${PID}`), db.doc(`tenants/${TENANT}/productFinancials/${PID}`), insight(estrella), insight(parado), db.doc(`tenants/${TENANT}/promotions/test-promo`)]) {
  await ref.delete();
}

const ok = results.every((r) => r);
console.log(`\nRESULTADO P8: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
