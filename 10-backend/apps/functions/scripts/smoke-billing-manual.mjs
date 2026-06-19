/**
 * smoke-billing-manual.mjs — Smoke guiado del flujo completo de billing manual por WhatsApp EN LOCAL,
 * con los USUARIOS SEED REALES (owner@perfumeria.com / superadmin@aiafg.com) sobre el tenant real
 * perfumeria, ejercitando los MISMOS callables que llama la UI (MB-3) + el wa.me + la query
 * collectionGroup de la bandeja admin. Hace snapshot+restore de perfumeria para no ensuciar la demo.
 * NO es un fix ni cambia código: solo verifica el flujo de punta a punta.
 *
 * ⚠️ SOLO EMULADORES. Apunta a los emuladores locales (Firestore 8080 / Functions 5001 / Auth 9099),
 * proyecto demo-aiafg, password de seed 'test1234'. NO contiene secretos ni números privados reales
 * (el número de soporte es un FIXTURE de prueba). NO correr contra producción: activa y luego RESTAURA
 * la suscripción de un tenant real; contra prod modificaría datos reales.
 * Uso: con emuladores + seed-users corriendo → node apps/functions/scripts/smoke-billing-manual.mjs
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue, FieldPath } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTHURL = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
// FIXTURE de prueba — NO es un número real (en prod el front usa NEXT_PUBLIC_SUPPORT_WHATSAPP).
const SUPPORT = '+595 981 234567';

const results = [];
const step = (n, c, detail = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${detail ? '\n     ' + detail : ''}`); };
const signIn = async (email) => (await (await fetch(AUTHURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, idToken) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}
// Espejo de buildWhatsappUrl del front (normaliza a solo dígitos).
const buildWhatsappUrl = (text) => { const d = SUPPORT.replace(/[^0-9]/g, ''); return d ? `https://wa.me/${d}?text=${encodeURIComponent(text)}` : null; };

const owner = await signIn('owner@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');

// --- Snapshot de perfumeria (para restaurar) + plan objetivo ---
const before = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const currentPlan = before.planId ?? 'free';
const planIds = (await db.collection('plans').get()).docs.map((d) => d.id);
let targetPlan = planIds.find((id) => id !== 'free' && id !== currentPlan);
let seededTemp = false;
if (!targetPlan) {
  targetPlan = 'smoke-plan';
  await db.doc('plans/smoke-plan').set({ id: 'smoke-plan', tier: 'PRO', name: 'Smoke Pro', description: '', priceUsdPerMonth: 50, isActive: true, limits: { maxProducts: 7777, maxOrdersPerMonth: 999, maxWhatsappMessagesPerMonth: 999, maxDeliveryPersons: 9, maxUsers: 9, maxWhatsappNumbers: 2, maxAdSyncsPerMonth: 9, maxAiTokensPerMonth: 9999 }, features: { bancard: false, stripe: false, localWallets: false, electronicInvoicing: false, marketingAutomation: false, multiChannel: false, prioritySupport: false, aiAssistant: false } });
  seededTemp = true;
}
const targetPlanDoc = (await db.doc(`plans/${targetPlan}`).get()).data();
const targetMaxProducts = targetPlanDoc?.limits?.maxProducts;
// Limpiar solicitudes pendientes previas de perfumeria (estado limpio).
for (const d of (await db.collection(`tenants/${T}/manualActivationRequests`).get()).docs) await d.ref.delete();
console.log(`\n▶ Smoke billing manual — tenant=${T}, plan actual=${currentPlan}, plan objetivo=${targetPlan} (maxProducts=${targetMaxProducts})\n`);

// === 4-5. Owner solicita un plan por WhatsApp → se crea la solicitud pending ===
const reqRes = await callFn('requestManualPlanActivation', { planId: targetPlan, method: 'transferencia', note: 'Smoke test' }, owner);
const reqId = reqRes.result?.requestId;
const reqDoc = reqId ? (await db.doc(`tenants/${T}/manualActivationRequests/${reqId}`).get()).data() : null;
step('Paso 4-5: owner solicita → solicitud PENDING creada', reqRes.status === 200 && reqDoc?.status === 'pending' && reqDoc?.planId === targetPlan && reqDoc?.requestedByRole === 'TENANT_OWNER', `requestId=${reqId} status=${reqDoc?.status} method=${reqDoc?.method}`);

// === 6. Se arma el wa.me correctamente ===
const waUrl = buildWhatsappUrl(reqRes.result?.whatsappText ?? '');
const waOk = !!waUrl && waUrl.startsWith('https://wa.me/595981234567?text=') && (reqRes.result?.whatsappText ?? '').includes(reqId);
step('Paso 6: se arma el wa.me (número normalizado a dígitos)', waOk, `${waUrl}`);

// === 12. No se puede duplicar pending (owner re-solicita estando pending) ===
const dup = await callFn('requestManualPlanActivation', { planId: targetPlan, method: 'transferencia' }, owner);
step('Paso 12: no se puede duplicar pending (re-solicitud → 400)', dup.status === 400, `status=${dup.status} ${dup.error?.message ?? ''}`);

// === 13 (backend gate). Owner NO puede activar su propio plan ===
const ownerAct = await callFn('manualBillingActivate', { tenantId: T, requestId: reqId }, owner);
step('Paso 13: owner NO puede activar (manualBillingActivate → 403)', ownerAct.status === 403, `status=${ownerAct.status} (la bandeja admin además NO se renderiza para owner: gate role==='PLATFORM_ADMIN' en page.tsx)`);

// === 8. Admin ve la solicitud en la bandeja (query collectionGroup, igual que AdminActivationQueue) ===
const pending = await db.collectionGroup('manualActivationRequests').where('status', '==', 'pending').orderBy('requestedAt', 'desc').get();
const seen = pending.docs.map((d) => d.data()).find((r) => r.id === reqId && r.tenantId === T);
step('Paso 8: admin ve la solicitud en la bandeja (collectionGroup pending)', !!seen, `pendientes=${pending.size}, perfumeria/${targetPlan} presente=${!!seen}`);

// === 9. Admin aprueba con paymentReference ===
const approve = await callFn('manualBillingActivate', { tenantId: T, requestId: reqId, paymentReference: 'SMOKE-REF-001' }, admin);
const reqAfter = (await db.doc(`tenants/${T}/manualActivationRequests/${reqId}`).get()).data();
step('Paso 9: admin aprueba con paymentReference', approve.status === 200 && reqAfter?.status === 'approved' && reqAfter?.paymentReference === 'SMOKE-REF-001' && !!reqAfter?.reviewedByUid, `status=${approve.status} reqStatus=${reqAfter?.status} ref=${reqAfter?.paymentReference}`);

// === 10. El tenant pasa a manual_whatsapp active ===
const after = (await db.doc(`tenants/${T}`).get()).data();
step('Paso 10: tenant → manual_whatsapp ACTIVE', after?.subscription?.paymentProvider === 'manual_whatsapp' && after?.subscription?.status === 'active', `provider=${after?.subscription?.paymentProvider} status=${after?.subscription?.status}`);

// === 11. plan/limits/entitlements reflejados (la UI lee estos campos del doc) ===
step('Paso 11: plan/limits reflejados (fuente de entitlements en el panel)', after?.planId === targetPlan && after?.limits?.maxProducts === targetMaxProducts, `planId=${after?.planId} limits.maxProducts=${after?.limits?.maxProducts} (esperado ${targetMaxProducts})`);

// --- Restore perfumeria al estado previo (no ensuciar la demo) ---
const restore = { planId: before.planId ?? FieldValue.delete(), limits: before.limits ?? FieldValue.delete(), subscription: before.subscription ?? FieldValue.delete(), updatedAt: Timestamp.now() };
await db.doc(`tenants/${T}`).set(restore, { merge: true });
for (const d of (await db.collection(`tenants/${T}/manualActivationRequests`).get()).docs) await d.ref.delete();
for (const d of (await db.collection(`tenants/${T}/auditLogs`).get()).docs) await d.ref.delete().catch(() => {});
// Borrar clientes sintéticos del simulador no aplica acá (este flujo no corre el bot).
if (seededTemp) await db.doc('plans/smoke-plan').delete().catch(() => {});
const restored = (await db.doc(`tenants/${T}`).get()).data();
console.log(`\n↺ perfumeria restaurada: planId=${restored?.planId} subscription.provider=${restored?.subscription?.paymentProvider ?? '(sin)'}`);

const ok = results.every((x) => x);
console.log(`\nRESULTADO SMOKE BILLING MANUAL (flujo completo en local): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
