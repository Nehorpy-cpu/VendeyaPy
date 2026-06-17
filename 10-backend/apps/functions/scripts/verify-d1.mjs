/**
 * verify-d1.mjs — Verificación en vivo del Centro de Integración Meta (D1).
 * Conecta (demo) y comprueba: conexión + activos, SIN token en claro (solo
 * tokenSecretRef); desconectar limpia; reglas (vendedor no lee). Reconecta al final.
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
const post = (p, b = {}) => fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T, ...b }) }).then((r) => r.json());
const conn = () => db.doc(`tenants/${T}/metaConnections/main`).get().then((s) => s.data());

// 1. Conectar (demo)
await post('devMetaConnect', { byUid: 'uid-owner' });
const c = await conn();
check('1. Conexión creada con estado connected_limited', c?.status === 'connected_limited', `status=${c?.status}`);
check('2. El token NO está en claro (solo tokenSecretRef)', !!c?.tokenSecretRef && !('token' in (c ?? {})) && !('accessToken' in (c ?? {})), `ref=${c?.tokenSecretRef}`);
const assets = await db.collection(`tenants/${T}/metaAssets`).get();
const types = assets.docs.map((d) => d.data().assetType);
check('3. Activos de Meta creados', assets.size >= 6 && types.includes('whatsapp_business_account') && types.includes('ad_account'), `assets=${assets.size}`);

// 2. Desconectar
await post('devMetaDisconnect');
const c2 = await conn();
const assets2 = await db.collection(`tenants/${T}/metaAssets`).get();
check('4. Desconectar limpia (not_connected + sin activos)', c2?.status === 'not_connected' && assets2.size === 0);

// 3. Reglas: vendedor no lee; dueña sí
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const statusAs = async (tok) => (await fetch(`${FS}/tenants/${T}/metaConnections/main`, { headers: { Authorization: `Bearer ${tok}` } })).status;
check('5. Vendedora NO lee la conexión Meta (403)', (await statusAs(await signIn('seller@perfumeria.com'))) === 403);
check('6. Dueña SÍ lee la conexión Meta (200)', (await statusAs(await signIn('owner@perfumeria.com'))) === 200);

// Reconectar para que la demo quede conectada
await post('devMetaConnect', { byUid: 'uid-owner' });

const ok = results.every((r) => r);
console.log(`\nRESULTADO D1: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
