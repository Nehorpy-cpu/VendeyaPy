/**
 * seed-demo-chats.mjs — Conversaciones de ejemplo para la demo del panel (P5)
 * ===========================================================================
 * Limpia los clientes existentes y crea 3 conversaciones realistas usando el
 * motor real (devMessage), una de ellas dejada en "atención humana" para ver
 * el badge de vendedor y el contador de "sin leer".
 *
 * USO (emuladores firestore:8080 + functions:5001 encendidos):
 *   node scripts/seed-demo-chats.mjs
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const TENANT = 'perfumeria';

const post = (p, b) =>
  fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const cid = (phone) => phone.replace(/[^0-9]/g, '');

async function chat(phone, texts) {
  for (const t of texts) await post('devMessage', { from: phone, text: t, tenantId: TENANT });
}
const setName = (phone, name) =>
  db.doc(`tenants/${TENANT}/customers/${cid(phone)}`).set({ name }, { merge: true });

async function wipeCustomers() {
  const col = db.collection(`tenants/${TENANT}/customers`);
  const all = await col.get();
  for (const d of all.docs) {
    for (const sub of ['messages', 'sessions']) {
      const s = await d.ref.collection(sub).get();
      for (const m of s.docs) await m.ref.delete();
    }
    await d.ref.delete();
  }
  console.log(`🧹 Clientes anteriores borrados: ${all.size}`);
}

const DEMOS = [
  { phone: '+595981111111', name: 'Carla Giménez', texts: ['hola', 'busco un perfume dulce para mí', 'me gusta el primero'] },
  { phone: '+595982222222', name: 'Rocío Benítez', texts: ['buenas', 'tienen algo floral para regalar?'] },
  { phone: '+595983333333', name: 'Lucía Fernández', texts: ['hola', 'quiero algo intenso para la noche'] },
];

await wipeCustomers();
for (const d of DEMOS) {
  await chat(d.phone, d.texts);
  await setName(d.phone, d.name);
  console.log(`💬 ${d.name} (${d.phone}) — ${d.texts.length} mensajes`);
}

// Dejar a Lucía en atención humana, con un mensaje del cliente sin leer.
await post('devTakeoverChat', { from: '+595983333333', tenantId: TENANT, by: 'Vendedora' });
await post('devMessage', { from: '+595983333333', text: '¿sigue disponible? quiero pagar 🙏', tenantId: TENANT });
console.log('🧑‍💼 Lucía Fernández quedó en atención humana (1 mensaje sin leer).');

console.log('\n✅ Demo lista. Entrá al panel y abrí Clientes / Conversaciones.');
process.exit(0);
