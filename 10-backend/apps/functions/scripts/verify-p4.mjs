/**
 * verify-p4.mjs — Verificación en vivo de la P4 (config del agente → afecta al bot)
 * Requiere emuladores encendidos (firestore:8080, functions:5001).
 * Prueba:
 *   1) Saludo personalizado en config/agent → el bot lo usa.
 *   2) botEnabled=false → el bot queda en silencio (handledByHuman, reply vacío).
 *   3) Restaura el estado original.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const ref = db.doc('tenants/perfumeria/config/agent');
const API = 'http://127.0.0.1:5001/demo-aiafg/us-central1/devMessage';

const phone = () => '+595' + Math.floor(900000000 + Math.random() * 99999999);
async function send(from, text) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, text, tenantId: 'perfumeria' }),
  });
  return r.json();
}

// Guardar estado original para restaurar al final
const before = (await ref.get()).data() ?? null;

const MARKER = 'PRUEBA-SALUDO-XYZ';

// --- Test 1: saludo personalizado ---
await ref.set({ greetingMessage: `${MARKER} 🌸 Bienvenida a la perfumería`, botEnabled: true }, { merge: true });
const r1 = await send(phone(), 'hola');
const pass1 = String(r1.reply ?? '').includes(MARKER);
console.log('Test 1 — saludo personalizado');
console.log('  reply:', JSON.stringify(r1.reply));
console.log('  =>', pass1 ? 'PASS ✅' : 'FAIL ❌');

// --- Test 2: bot apagado ---
await ref.set({ botEnabled: false }, { merge: true });
const r2 = await send(phone(), 'hola');
const pass2 = !r2.reply && r2.handledByHuman === true;
console.log('Test 2 — botEnabled=false (silencio)');
console.log('  reply:', JSON.stringify(r2.reply), '| handledByHuman:', r2.handledByHuman);
console.log('  =>', pass2 ? 'PASS ✅' : 'FAIL ❌');

// --- Restaurar estado original ---
if (before) {
  await ref.set(before); // sobrescribe con lo que había
} else {
  await ref.set({ botEnabled: true, greetingMessage: '' }, { merge: true });
}
console.log('Estado de config/agent restaurado.');

const ok = pass1 && pass2;
console.log('\nRESULTADO P4:', ok ? 'TODO OK ✅' : 'HAY FALLOS ❌');
process.exit(ok ? 0 : 1);
