/**
 * verify-d4.mjs — Verificación en vivo de Catálogo → Meta (D4).
 * Sincroniza el catálogo y comprueba: productos activos marcados "synced" con su
 * metaProductItemId + logs por producto, idempotencia, y reglas (vendedor no lee logs).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = `http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents`;
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sync = () => fetch(`${BASE}/devSyncCatalogToMeta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T }) }).then((r) => r.json());

// 1. Sincronizar
const r = await sync();
const active = (await db.collection(`tenants/${T}/products`).where('status', '==', 'ACTIVE').get()).docs.map((d) => d.data());
const allSynced = active.length > 0 && active.every((p) => p.metaSyncStatus === 'synced' && p.metaProductItemId);
check('1. Productos activos marcados "synced" con item de Meta', allSynced, `activos=${active.length}`);
const logs = await db.collection(`tenants/${T}/metaCatalogSyncLogs`).get();
check('2. Un log de sincronización por producto', logs.size === active.length && logs.docs.every((d) => d.data().status === 'success'), `logs=${logs.size}`);

// 2. Idempotente
await sync();
const logs2 = await db.collection(`tenants/${T}/metaCatalogSyncLogs`).get();
check('3. Re-sincronizar no duplica logs', logs2.size === active.length);

// 3. Reglas: el vendedor NO lee los logs de sync; la dueña sí
const someProductId = active[0]?.id;
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const statusAs = async (tok) => (await fetch(`${FS}/tenants/${T}/metaCatalogSyncLogs/log-${someProductId}`, { headers: { Authorization: `Bearer ${tok}` } })).status;
check('4. Vendedora NO lee los logs de Meta (403)', (await statusAs(await signIn('seller@perfumeria.com'))) === 403);
check('5. Dueña SÍ lee los logs de Meta (200)', (await statusAs(await signIn('owner@perfumeria.com'))) === 200);

const ok = results.every((x) => x);
console.log(`\nRESULTADO D4: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
