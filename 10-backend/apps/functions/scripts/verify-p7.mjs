/**
 * verify-p7.mjs — Verificación en vivo de la P7 (dashboards con agregados).
 * Requiere emuladores. Comprueba: agregados generados, el TRIGGER recalcula solo
 * al crear/confirmar un pedido, y las reglas separan público (vendedor) de privado.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const PROJECT = 'demo-aiafg';
const TENANT = 'perfumeria';
const FS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';

const post = (p, b) => fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pub = async () => (await db.doc(`tenants/${TENANT}/stats/public`).get()).data();
const priv = async () => (await db.doc(`tenants/${TENANT}/stats/private`).get()).data();

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
async function waitFor(fn, ms = 18000, step = 1500) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }

// 1. Backfill manual (todos los tenants + global)
await post('devRecomputeStats', {});
const p1 = await pub();
const pr1 = await priv();
check('1. stats/public generado', !!p1 && typeof p1.ventas === 'number', `ventas=${p1?.ventas} ingresos=${p1?.ingresos} pend=${p1?.pendingOrders}`);
check('2. stats/private con ganancia/margen', !!pr1 && 'ganancia' in pr1, `ganancia=${pr1?.ganancia}`);
const plat = (await db.doc('platformStats/current').get()).data();
check('4. platformStats (global) generado', !!plat && typeof plat.ventas === 'number', `tenants=${plat?.tenants}`);

// 2. TRIGGER al crear pedido → pendingOrders sube solo
const pendAntes = (await pub())?.pendingOrders ?? 0;
const phone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
const msg = (t) => post('devMessage', { from: phone, text: t, tenantId: TENANT });
await msg('hola'); await msg('busco un perfume'); await msg('quiero el primero'); await msg('pagar');
const subio = await waitFor(async () => ((await pub())?.pendingOrders ?? 0) > pendAntes);
check('5. El TRIGGER recalcula al crear pedido (pendientes ↑)', subio, `antes=${pendAntes} después=${(await pub())?.pendingOrders}`);

// 3. Confirmar pago → venta PAID con ganancia (trigger en update)
const ventasAntes = (await pub())?.ventas ?? 0;
await post('devConfirmPayment', { from: phone, tenantId: TENANT });
const vendio = await waitFor(async () => ((await pub())?.ventas ?? 0) > ventasAntes);
check('6. Al confirmar pago, ventas ↑ (trigger en update)', vendio, `antes=${ventasAntes} después=${(await pub())?.ventas}`);
check('7. La ganancia quedó registrada en stats/private', ((await priv())?.ganancia ?? null) != null, `ganancia=${(await priv())?.ganancia}`);
check('7b. statsDaily con snapshot diario tras la venta', (await db.collection(`tenants/${TENANT}/statsDaily`).get()).size > 0, `días=${(await db.collection(`tenants/${TENANT}/statsDaily`).get()).size}`);

// 4. Reglas con auth (vendedora vs dueña)
const signIn = async (email) => { const r = await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) }); return (await r.json()).idToken; };
const statusAs = async (tok, path) => (await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${tok}` } })).status;
const dailyId = (await db.collection(`tenants/${TENANT}/statsDaily`).limit(1).get()).docs[0]?.id;
const seller = await signIn('seller@perfumeria.com');
const owner = await signIn('owner@perfumeria.com');
check('8. Vendedora SÍ lee stats/public (200)', (await statusAs(seller, `tenants/${TENANT}/stats/public`)) === 200);
check('9. Vendedora NO lee stats/private (403)', (await statusAs(seller, `tenants/${TENANT}/stats/private`)) === 403);
check('10. Vendedora NO lee statsDaily (403)', (await statusAs(seller, `tenants/${TENANT}/statsDaily/${dailyId}`)) === 403);
check('11. Dueña SÍ lee stats/private (200)', (await statusAs(owner, `tenants/${TENANT}/stats/private`)) === 200);

const ok = results.every((r) => r);
console.log(`\nRESULTADO P7: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
