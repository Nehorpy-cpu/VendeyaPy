/**
 * verify-p17.mjs — Verificación en vivo del Simulador del agente (P17).
 * Crea un caso, lo corre contra el bot (hola + userMessage) y guarda la respuesta;
 * comprueba que lastResult quedó con la respuesta real + reglas (vendedor no lee).
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
const T = 'perfumeria';
const now = Timestamp.now();

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };

// Crear caso (como lo haría el panel)
const TC = { id: 'p17-barato', tenantId: T, name: 'Algo barato', scenario: 'Presupuesto bajo', userMessage: 'algo barato que tengas', expectedBehavior: 'Mostrar opciones accesibles.', lastResult: '', lastRunAt: null, status: 'UNTESTED', createdAt: now, updatedAt: now };
await db.doc(`tenants/${T}/agentTestCases/p17-barato`).set(TC);

// Correr (replica runTestCase): hola + userMessage con teléfono de prueba
const phone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
const send = (text) => fetch(`${BASE}/devMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: phone, text, tenantId: T }) }).then((r) => r.json());
await send('hola');
const r = await send(TC.userMessage);
const reply = r.reply || '';
await db.doc(`tenants/${T}/agentTestCases/p17-barato`).set({ lastResult: reply, lastRunAt: now }, { merge: true });

check('1. El bot respondió al correr el caso', !!reply, `"${reply.slice(0, 50)}…"`);
check('2. La respuesta parece una recomendación (catálogo)', /opciones|✨|₲/.test(reply));
const saved = (await db.doc(`tenants/${T}/agentTestCases/p17-barato`).get()).data();
check('3. lastResult quedó guardado en el caso', !!saved?.lastResult && saved.lastResult === reply);

// Reglas: el vendedor NO lee los casos; la dueña SÍ
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const statusAs = async (tok, path) => (await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${tok}` } })).status;
const seller = await signIn('seller@perfumeria.com');
const owner = await signIn('owner@perfumeria.com');
check('4. Vendedora NO lee los casos (403)', (await statusAs(seller, `tenants/${T}/agentTestCases/p17-barato`)) === 403);
check('5. Dueña SÍ lee los casos (200)', (await statusAs(owner, `tenants/${T}/agentTestCases/p17-barato`)) === 200);

await db.doc(`tenants/${T}/agentTestCases/p17-barato`).delete();

const ok = results.every((x) => x);
console.log(`\nRESULTADO P17: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
