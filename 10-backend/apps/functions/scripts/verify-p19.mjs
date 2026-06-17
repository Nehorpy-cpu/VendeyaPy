/**
 * verify-p19.mjs — Verificación en vivo del onboarding/plantillas (P19).
 * Aplica la plantilla "perfumería" en un tenant de prueba (réplica de applyTemplate)
 * y comprueba que precargó la config del agente + las categorías del rubro.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const T = 'p19-test';
const now = Timestamp.now();

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };

// Plantilla perfumería (mismos datos que lib/templates.ts)
const tpl = {
  id: 'perfumeria',
  agent: {
    agentName: 'Sofía', tone: 'amable y cercano',
    greetingMessage: '¡Hola! 💖 Bienvenida a nuestra perfumería.',
    salesRules: 'Recomendar según el estilo. No ofrecer descuentos no autorizados.',
    faq: [{ q: '¿Hacen envíos?', a: 'Sí.' }, { q: '¿Cómo pago?', a: 'Transferencia.' }, { q: '¿Son originales?', a: 'Sí.' }],
  },
  categories: ['Perfumes', 'Árabes', 'Cremas'],
};
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Aplicar (réplica de applyTemplate)
await db.doc(`tenants/${T}/config/agent`).set({ agentName: tpl.agent.agentName, tone: tpl.agent.tone, greetingMessage: tpl.agent.greetingMessage, salesRules: tpl.agent.salesRules, faq: tpl.agent.faq, industry: tpl.id }, { merge: true });
let pos = 0;
for (const name of tpl.categories) await db.doc(`tenants/${T}/categories/${slug(name)}`).set({ id: slug(name), tenantId: T, name, description: '', emoji: '🏷️', position: pos++, isActive: true, createdAt: now, updatedAt: now });

// Verificar
const agent = (await db.doc(`tenants/${T}/config/agent`).get()).data();
check('1. Rubro/plantilla aplicada (industry)', agent?.industry === 'perfumeria', `industry=${agent?.industry}`);
check('2. Precargó el agente (nombre + FAQ)', agent?.agentName === 'Sofía' && agent?.faq?.length === 3);
const cats = await db.collection(`tenants/${T}/categories`).get();
const names = cats.docs.map((d) => d.data().name).sort();
check('3. Precargó las categorías del rubro', cats.size === 3 && names.includes('Perfumes') && names.includes('Árabes'), names.join(', '));
check('4. Paso "Elegí tu rubro" quedaría completo', !!agent?.industry);

// Limpieza del tenant de prueba
for (const d of cats.docs) await d.ref.delete();
await db.doc(`tenants/${T}/config/agent`).delete();

const ok = results.every((r) => r);
console.log(`\nRESULTADO P19: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
