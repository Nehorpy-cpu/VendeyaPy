/**
 * verify-d3.mjs — Verificación en vivo de Meta Ads (D3, solo lectura).
 * Sincroniza (demo) y comprueba campañas/adsets/ads + snapshots diarios,
 * idempotencia, y reglas (vendedor no lee). Deja los datos para la demo.
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
const sync = () => fetch(`${BASE}/devSyncMetaAds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T }) }).then((r) => r.json());
const count = async (col) => (await db.collection(`tenants/${T}/${col}`).get()).size;

// 1. Sincronizar
await sync();
const campaigns = (await db.collection(`tenants/${T}/metaCampaigns`).get()).docs.map((d) => d.data());
check('1. Campañas sincronizadas con métricas', campaigns.length === 2 && campaigns.every((c) => c.latestMetrics?.spend > 0), `campañas=${campaigns.length}`);
check('2. Adsets y anuncios creados', (await count('metaAdsets')) === 2 && (await count('metaAds')) === 2);
const insights = await count('metaAdInsightsDaily');
check('3. Snapshots diarios (2 ads × 7 días = 14)', insights === 14, `insights=${insights}`);
const oneIns = (await db.collection(`tenants/${T}/metaAdInsightsDaily`).limit(1).get()).docs[0]?.data();
check('4. Cada snapshot trae gasto + impresiones', !!oneIns && oneIns.spend >= 0 && oneIns.impressions >= 0);

// 2. Idempotente: re-sincronizar no duplica
await sync();
check('5. Re-sincronizar no duplica', (await count('metaCampaigns')) === 2 && (await count('metaAdInsightsDaily')) === 14);

// 3. Reglas: el vendedor NO lee los anuncios (gasto sensible); la dueña sí
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const statusAs = async (tok) => (await fetch(`${FS}/tenants/${T}/metaCampaigns/camp-1`, { headers: { Authorization: `Bearer ${tok}` } })).status;
check('6. Vendedora NO lee campañas (403)', (await statusAs(await signIn('seller@perfumeria.com'))) === 403);
check('7. Dueña SÍ lee campañas (200)', (await statusAs(await signIn('owner@perfumeria.com'))) === 200);

const ok = results.every((r) => r);
console.log(`\nRESULTADO D3: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
