/**
 * verify-p5.mjs — Verificación en vivo de la P5 (historial + handoff).
 * Requiere emuladores encendidos (firestore:8080, functions:5001).
 *
 * Loop probado, con un cliente nuevo aleatorio:
 *   1) bot saluda  2) bot responde búsqueda  3) historial persistido
 *   4) meta de conversación  5) vendedor toma el chat  6) bot en silencio + "sin leer"
 *   7) vendedor devuelve al bot  8) bot retoma
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const TENANT = 'perfumeria';

const phone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
const cid = phone.replace(/[^0-9]/g, '');

async function post(path, body) {
  const r = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}
const msg = (text) => post('devMessage', { from: phone, text, tenantId: TENANT });
const messagesCount = async () =>
  (await db.collection(`tenants/${TENANT}/customers/${cid}/messages`).get()).size;
const convMeta = async () =>
  (await db.doc(`tenants/${TENANT}/customers/${cid}`).get()).data()?.conversation ?? null;

const results = [];
const check = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
};

// Asegurar bot encendido y saludo por defecto.
await db.doc(`tenants/${TENANT}/config/agent`).set({ botEnabled: true, greetingMessage: '' }, { merge: true });
console.log(`Cliente de prueba: ${phone}\n`);

// 1-2. Conversación normal con el bot
const r1 = await msg('hola');
check('1. Bot saluda al cliente nuevo', !!r1.reply, `"${(r1.reply || '').slice(0, 40)}…"`);
const r2 = await msg('busco un perfume dulce');
check('2. Bot responde a la búsqueda', !!r2.reply);

// 3. Historial persistido
const c3 = await messagesCount();
check('3. Historial guardado (≥4 mensajes in/out)', c3 >= 4, `total=${c3}`);

// 4. Meta de conversación denormalizada
const m4 = await convMeta();
check('4. Meta de conversación creada', !!m4 && m4.lastMessagePreview != null && m4.humanTakeover === false, `state=${m4?.state}`);

// 5. Vendedor toma el chat
const t5 = await post('devTakeoverChat', { from: phone, tenantId: TENANT, by: 'Marco (prueba)' });
const m5 = await convMeta();
check('5. Vendedor toma el chat (humanTakeover=true)', t5.ok && m5?.humanTakeover === true, t5.message || '');
check('5b. Contador "sin leer" reseteado al tomar', (m5?.unreadForSeller ?? 0) === 0);

// 6. Bot en silencio + el mensaje del cliente queda "sin leer"
const r6 = await msg('hola? hay alguien?');
check('6. Bot en silencio durante atención humana', !r6.reply && r6.handledByHuman === true);
const m6 = await convMeta();
check('6b. Mensaje del cliente cuenta como "sin leer"', (m6?.unreadForSeller ?? 0) >= 1, `unread=${m6?.unreadForSeller}`);

// 7. Vendedor devuelve al bot
const t7 = await post('devReleaseChat', { from: phone, tenantId: TENANT });
const m7 = await convMeta();
check('7. Vendedor devuelve al bot (humanTakeover=false)', t7.ok && m7?.humanTakeover === false, t7.message || '');

// 8. El bot retoma
const r8 = await msg('hola de nuevo');
check('8. Bot retoma luego de liberar', !!r8.reply && !r8.handledByHuman);

const okAll = results.every((r) => r);
console.log(`\nRESULTADO P5: ${okAll ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(okAll ? 0 : 1);
