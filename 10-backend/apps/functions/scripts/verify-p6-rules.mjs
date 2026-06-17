/**
 * verify-p6-rules.mjs — Prueba REAL de las reglas P6 (con auth).
 * Inicia sesión como vendedora y como dueña (emulador Auth) e intenta leer las
 * colecciones privadas vía la API REST de Firestore (con reglas activas).
 *   Esperado: vendedora 403 en *Financials, 200 en products; dueña 200 en todo.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const PROJECT = 'demo-aiafg';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const FS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;

async function signIn(email) {
  const r = await fetch(AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }),
  });
  const d = await r.json();
  if (!d.idToken) throw new Error(`signin falló ${email}: ${JSON.stringify(d)}`);
  return d.idToken;
}
async function statusAs(token, path) {
  const r = await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.status;
}

const pid = (await db.collection('tenants/perfumeria/productFinancials').limit(1).get()).docs[0]?.id;
const oid = (await db.collection('tenants/perfumeria/orderFinancials').limit(1).get()).docs[0]?.id;

const seller = await signIn('seller@perfumeria.com');
const owner = await signIn('owner@perfumeria.com');

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };

check('Vendedora NO lee productFinancials (403)', (await statusAs(seller, `tenants/perfumeria/productFinancials/${pid}`)) === 403);
check('Vendedora NO lee orderFinancials (403)', (await statusAs(seller, `tenants/perfumeria/orderFinancials/${oid}`)) === 403);
check('Vendedora SÍ lee products (200)', (await statusAs(seller, `tenants/perfumeria/products/${pid}`)) === 200);
check('Dueña SÍ lee productFinancials (200)', (await statusAs(owner, `tenants/perfumeria/productFinancials/${pid}`)) === 200);
check('Dueña SÍ lee orderFinancials (200)', (await statusAs(owner, `tenants/perfumeria/orderFinancials/${oid}`)) === 200);

const ok = results.every((r) => r);
console.log(`\nRESULTADO REGLAS P6: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
