/**
 * verify-fase2-hardening.mjs — Verifica la capa de callables del panel (Hardening F2).
 * runTenantJob / simulateAgentMessage con autorización por rol + tenant.
 *
 * Requiere el emulador con el código nuevo cargado (rebuild functions + restart).
 * USO (con permiso para reiniciar el emulador):  node scripts/verify-fase2-hardening.mjs
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email, password = 'test1234') =>
  (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) })).json()).idToken;
const callable = async (name, data, token) => {
  const r = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const denied = (r) => r.status === 403 || r.json?.error?.status === 'PERMISSION_DENIED';

const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');

// 1. Owner corre un job → 200, sobre SU empresa
const r1 = await callable('runTenantJob', { action: 'computeTracking' }, owner);
check('1. Owner corre computeTracking (su empresa)', r1.status === 200 && r1.json?.result?.tenantId === 'perfumeria', JSON.stringify(r1.json?.result ?? r1.json));

// 2. Cross-tenant: owner pide otra empresa → igual corre la suya
const r2 = await callable('runTenantJob', { action: 'computeTracking', tenantId: 'boutique-demo' }, owner);
check('2. Owner NO puede targetear otra empresa (usa la suya)', r2.json?.result?.tenantId === 'perfumeria', `tenantId=${r2.json?.result?.tenantId}`);

// 3. Vendedor denegado
const r3 = await callable('runTenantJob', { action: 'computeTracking' }, seller);
check('3. Vendedor denegado', denied(r3), `HTTP ${r3.status}`);

// 4. Acción inválida → invalid-argument
const r4 = await callable('runTenantJob', { action: 'devSyncMetaAds' }, owner);
check('4. Acción inválida → invalid-argument', r4.status === 400 || r4.json?.error?.status === 'INVALID_ARGUMENT', `HTTP ${r4.status}`);

// 5. Admin SÍ puede targetear otra empresa
const r5 = await callable('runTenantJob', { action: 'computeTracking', tenantId: 'boutique-demo' }, admin);
check('5. Admin targetea boutique-demo', r5.status === 200 && r5.json?.result?.tenantId === 'boutique-demo', `tenantId=${r5.json?.result?.tenantId}`);

// 6. Simulador: owner y el bot responde
const r6 = await callable('simulateAgentMessage', { from: '+595990000001', text: 'hola' }, owner);
check('6. Owner simula y el bot responde', r6.status === 200 && typeof r6.json?.result?.reply === 'string' && r6.json.result.reply.length > 0, `reply.len=${r6.json?.result?.reply?.length}`);

// 7. Simulador: vendedor denegado
const r7 = await callable('simulateAgentMessage', { from: '+595990000002', text: 'hola' }, seller);
check('7. Vendedor no puede simular', denied(r7), `HTTP ${r7.status}`);

// Limpieza (el simulador creó clientes de prueba)
for (const p of ['595990000001', '595990000002']) {
  await db.doc(`tenants/perfumeria/customers/${p}/sessions/active`).delete().catch(() => {});
  await db.doc(`tenants/perfumeria/customers/${p}`).delete().catch(() => {});
}

const ok = results.every((x) => x);
console.log(`\nRESULTADO HARDENING F2 (callables del panel): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
