/**
 * verify-d4.mjs — Catálogo → Meta: contrato VIGENTE del endpoint dev + reglas de los logs.
 *
 * HISTORIA: este script probaba la sync DEMO de D4, que marcaba todos los productos activos
 * como `synced` e inventaba un log por producto. Esa sync dejó de existir en META-CATALOG-LIVE-1
 * (`1d2bad5`, desplegado): `devSyncCatalogToMeta` hoy corre un DRY-RUN de la sync real, que es
 * fail-closed —sin configuración de catálogo no hace absolutamente nada— y que JAMÁS escribe en
 * Meta ni marca productos por su cuenta. El script quedó afirmando un comportamiento que el
 * sistema ya no tiene y fallaba 1/5 desde entonces.
 *
 * Se actualizó al contrato vigente en vez de borrarlo: sigue siendo un gate útil (cubre el
 * fail-closed del endpoint dev y las reglas de lectura de `metaCatalogSyncLogs`, que ningún
 * otro script verifica). Lo que ya no existe no se prueba.
 *
 * El ciclo completo del outbox (encolado, envío, confirmación, recuperación) se verifica en
 * `verify-meta-catalog.mjs`.
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
const CATALOG_ID = 'CAT-D4-1';
const FIXTURE = 'metaTestFixtures/catalog';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sync = () => fetch(`${BASE}/devSyncCatalogToMeta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T }) }).then((r) => r.json());
const writesSnap = () => db.collection(`${FIXTURE}/writes`).get();
const wipe = async (col) => { const s = await db.collection(col).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); };

// ── 1. SIN configuración de catálogo: el endpoint no hace nada (fail-closed) ──
await db.doc(`tenants/${T}/config/meta`).delete().catch(() => {});
await wipe(`${FIXTURE}/writes`);
{
  const r = await sync();
  check('1. sin configuración de catálogo, la sync queda deshabilitada', r?.ok === true && r?.runs?.[T]?.status === 'disabled', `status=${r?.runs?.[T]?.status}`);
  check('2. y no escribió nada en Meta', (await writesSnap()).empty);
}

// ── 2. CON configuración: dry-run que planifica y sigue sin escribir ──
await db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo D4' }, items: [] });
await db.doc(`tenants/${T}/config/meta`).set(
  { catalogSync: { enabled: true, mode: 'dry_run', catalogId: CATALOG_ID, sourceOfTruth: 'vendeyapy' } },
  { merge: true },
);
{
  const r = await sync();
  const run = r?.runs?.[T];
  check('3. con configuración, el endpoint dev corre un DRY-RUN (nunca aplica)', run?.status === 'planned' && run?.requestedMode === 'dry_run', `status=${run?.status} mode=${run?.requestedMode}`);
  check('4. el dry-run no escribe en Meta', (await writesSnap()).empty);
  const runDoc = (await db.doc(`tenants/${T}/metaCatalogSyncRuns/${run?.runId}`).get()).data();
  check('5. deja el run auditable con su plan', !!runDoc && runDoc.status === 'planned' && !!runDoc.summary, `run=${run?.runId}`);
}

// ── 3. Reglas: el vendedor NO lee los logs de sync; la dueña sí ──
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
// Un log cualquiera (lo escribe el Admin SDK; acá solo se verifica quién puede LEERLO).
await db.doc(`tenants/${T}/metaCatalogSyncLogs/d4-rules-probe`).set({
  id: 'd4-rules-probe', tenantId: T, productId: 'p-probe', metaCatalogId: CATALOG_ID,
  metaProductItemId: null, action: 'update', status: 'success', errorMessage: '', createdAt: new Date(),
});
const statusAs = async (tok) => (await fetch(`${FS}/tenants/${T}/metaCatalogSyncLogs/d4-rules-probe`, { headers: { Authorization: `Bearer ${tok}` } })).status;
check('6. Vendedora NO lee los logs de Meta (403)', (await statusAs(await signIn('seller@perfumeria.com'))) === 403);
check('7. Dueña SÍ lee los logs de Meta (200)', (await statusAs(await signIn('owner@perfumeria.com'))) === 200);

await db.doc(`tenants/${T}/metaCatalogSyncLogs/d4-rules-probe`).delete().catch(() => {});
await db.doc(`tenants/${T}/config/meta`).delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO D4 (endpoint dev + reglas de logs): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
