/**
 * verify-billing-manual.mjs — Billing manual por WhatsApp.
 *   MB-1: guarda de precedencia de applySubscriptionUpdate (import directo de la función compilada).
 *   MB-2: callables requestManualPlanActivation / manualBillingActivate / manualBillingCancelRequest
 *         (vía protocolo callable HTTP, con usuarios reales/efímeros).
 * Requiere build de functions (lib/ + registro de las nuevas funciones en el emulador) + emuladores
 * Firestore/Functions/Auth corriendo.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { applySubscriptionUpdate } from '../lib/billing/applySubscription.js';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const auth = getAuth();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTHURL = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTHURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, idToken) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}
const ephemeralUids = [];
async function mkUser(email, role, tenantId) {
  let u;
  try { u = await auth.getUserByEmail(email); } catch { u = await auth.createUser({ email, password: 'test1234' }); }
  await auth.setCustomUserClaims(u.uid, { role, tenantId });
  ephemeralUids.push(u.uid);
  return signIn(email);
}

// Planes de prueba con limits conocidos (getPlan lee plans/{id}).
const PLAN = (id, tier, maxProducts) => ({ id, tier, name: id, description: '', priceUsdPerMonth: 30, isActive: true, limits: { maxProducts, maxOrdersPerMonth: 999, maxWhatsappMessagesPerMonth: 999, maxDeliveryPersons: 9, maxUsers: 9, maxWhatsappNumbers: 2, maxAdSyncsPerMonth: 9, maxAiTokensPerMonth: 9999 }, features: { bancard: false, stripe: false, localWallets: false, electronicInvoicing: false, marketingAutomation: false, multiChannel: false, prioritySupport: false, aiAssistant: false } });
await db.doc('plans/mb-pro').set(PLAN('mb-pro', 'PRO', 5000));
await db.doc('plans/mb-lite').set(PLAN('mb-lite', 'STARTER', 100));

// ======================= MB-1 — guarda de precedencia (import directo) =======================
const G = 'mb-guard-test';
const getG = async () => (await db.doc(`tenants/${G}`).get()).data();
const upd = (provider, planId, status = 'active') => ({ tenantId: null, provider, status, planId, currentPeriodEndMs: null, externalCustomerId: null, externalSubscriptionId: null, externalPlanRef: null, providerMetadata: {}, pastDueSinceMs: null });
const setSub = (t, paymentProvider, planId, status = 'active') => db.doc(`tenants/${t}`).set({ subscription: { paymentProvider, status, planId }, planId }, { merge: true });

await db.doc(`tenants/${G}`).set({ id: G, name: G, status: 'ACTIVE', createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const r1 = await applySubscriptionUpdate(G, upd('paypal', 'mb-pro'));
const t1 = await getG();
check('MB1.1 update normal (paypal) → applied; planId/limits/subscription escritos', r1?.applied === true && !r1?.skipped && t1?.planId === 'mb-pro' && t1?.limits?.maxProducts === 5000 && t1?.subscription?.paymentProvider === 'paypal' && t1?.subscription?.status === 'active', `applied=${r1?.applied} plan=${t1?.planId} max=${t1?.limits?.maxProducts}`);

await setSub(G, 'manual_whatsapp', 'mb-pro');
const r2 = await applySubscriptionUpdate(G, upd('paypal', 'mb-lite', 'canceled'));
const t2 = await getG();
check('MB1.2 webhook PayPal sin override sobre manual_whatsapp → OMITIDO (nada cambia)', r2?.applied === false && r2?.skipped === 'manual_override' && t2?.subscription?.paymentProvider === 'manual_whatsapp' && t2?.planId === 'mb-pro' && t2?.subscription?.status === 'active', `applied=${r2?.applied} skipped=${r2?.skipped}`);

const r3 = await applySubscriptionUpdate(G, upd('stripe', 'mb-lite'));
check('MB1.3 update Stripe sin override sobre manual_whatsapp → OMITIDO', r3?.applied === false && r3?.skipped === 'manual_override' && (await getG())?.subscription?.paymentProvider === 'manual_whatsapp', `applied=${r3?.applied}`);

const r4 = await applySubscriptionUpdate(G, upd('manual_whatsapp', 'mb-lite'), { allowOverrideManual: true });
const t4 = await getG();
check('MB1.4 admin override sobre manual_whatsapp (cambia plan) → applied', r4?.applied === true && t4?.planId === 'mb-lite' && t4?.limits?.maxProducts === 100, `applied=${r4?.applied} plan=${t4?.planId}`);

await setSub(G, 'paypal', 'mb-pro');
const r5 = await applySubscriptionUpdate(G, upd('manual_whatsapp', 'mb-pro'), { allowOverrideManual: true });
const t5 = await getG();
check('MB1.5 admin override pisa PayPal → applied + providerMetadata.previousProvider=paypal', r5?.applied === true && t5?.subscription?.paymentProvider === 'manual_whatsapp' && t5?.subscription?.providerMetadata?.previousProvider === 'paypal', `prev=${t5?.subscription?.providerMetadata?.previousProvider}`);

await setSub(G, 'stripe', 'mb-pro');
const r6 = await applySubscriptionUpdate(G, upd('stripe', 'mb-lite', 'past_due'));
const t6 = await getG();
check('MB1.6 update Stripe normal (tenant no-manual) → applied (no rompe webhooks)', r6?.applied === true && t6?.subscription?.status === 'past_due' && t6?.planId === 'mb-lite', `applied=${r6?.applied}`);
await db.doc(`tenants/${G}`).delete().catch(() => {});

// ======================= MB-2 — callables (HTTP) =======================
const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');
const manager = await mkUser('mb-mgr@perfumeria.com', 'TENANT_MANAGER', 'perfumeria');
const viewer = await mkUser('mb-viewer@perfumeria.com', 'TENANT_VIEWER', 'perfumeria');
const T = 'perfumeria';
const CB = 'mb-cb';
const reqsT = () => db.collection(`tenants/${T}/manualActivationRequests`);
const reqsCB = () => db.collection(`tenants/${CB}/manualActivationRequests`);
// Estado limpio.
for (const d of (await reqsT().get()).docs) await d.ref.delete();
await db.doc(`tenants/${CB}`).set({ id: CB, name: 'MB Cobranza', status: 'ACTIVE', createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
for (const d of (await reqsCB().get()).docs) await d.ref.delete();

// 1. owner solicita → pending + whatsappText (con el requestId).
const reqRes = await callFn('requestManualPlanActivation', { planId: 'mb-pro', method: 'transferencia' }, owner);
const reqId = reqRes.result?.requestId;
const reqDoc = reqId ? (await db.doc(`tenants/${T}/manualActivationRequests/${reqId}`).get()).data() : null;
check('MB2.1 owner solicita → request pending + whatsappText correcto', reqRes.status === 200 && reqDoc?.status === 'pending' && reqDoc?.planId === 'mb-pro' && typeof reqRes.result?.whatsappText === 'string' && reqRes.result.whatsappText.includes(reqId), `status=${reqRes.status} st=${reqDoc?.status}`);

// 2. seller/manager/viewer NO solicitan → 403.
const sReq = await callFn('requestManualPlanActivation', { planId: 'mb-pro', method: 'transferencia' }, seller);
const mReq = await callFn('requestManualPlanActivation', { planId: 'mb-pro', method: 'transferencia' }, manager);
const vReq = await callFn('requestManualPlanActivation', { planId: 'mb-pro', method: 'transferencia' }, viewer);
check('MB2.2 seller/manager/viewer NO solicitan → 403', sReq.status === 403 && mReq.status === 403 && vReq.status === 403, `s=${sReq.status} m=${mReq.status} v=${vReq.status}`);

// 3. validaciones: ya hay pending → 400; free → 400; method inválido → 400.
const dup = await callFn('requestManualPlanActivation', { planId: 'mb-pro', method: 'transferencia' }, owner);
const freeReq = await callFn('requestManualPlanActivation', { planId: 'free', method: 'transferencia' }, owner);
const badMethod = await callFn('requestManualPlanActivation', { planId: 'mb-lite', method: 'efectivo' }, owner);
check('MB2.3 ya hay pending → 400; planId free → 400; method inválido → 400', dup.status === 400 && freeReq.status === 400 && badMethod.status === 400, `dup=${dup.status} free=${freeReq.status} method=${badMethod.status}`);

// 4. owner NO puede activar → 403 (check literal admin).
const ownerAct = await callFn('manualBillingActivate', { tenantId: T, requestId: reqId }, owner);
check('MB2.4 owner NO puede manualBillingActivate → 403', ownerAct.status === 403, `status=${ownerAct.status}`);

// 5. cross-tenant: owner pidiendo para CB cae en SU tenant (no crea nada en CB; falla por 1-pending).
const ownerCross = await callFn('requestManualPlanActivation', { tenantId: CB, planId: 'mb-lite', method: 'giro' }, owner);
const cbPendingAfterOwner = (await reqsCB().where('status', '==', 'pending').get()).size;
check('MB2.5 cross-tenant: owner no crea solicitud en otro tenant (queda en el suyo)', cbPendingAfterOwner === 0 && ownerCross.status === 400, `cbPending=${cbPendingAfterOwner} status=${ownerCross.status}`);

// 6. admin crea solicitud para CB y la activa por requestId → manual_whatsapp active + planId/limits + approved.
const cbReqRes = await callFn('requestManualPlanActivation', { tenantId: CB, planId: 'mb-pro', method: 'deposito' }, admin);
const cbReqId = cbReqRes.result?.requestId;
const act = await callFn('manualBillingActivate', { tenantId: CB, requestId: cbReqId, paymentReference: 'TRX-123' }, admin);
const cbT = (await db.doc(`tenants/${CB}`).get()).data();
const cbReqDoc = (await db.doc(`tenants/${CB}/manualActivationRequests/${cbReqId}`).get()).data();
check('MB2.6 admin activa por requestId → manual_whatsapp active + planId/limits + request approved', act.status === 200 && cbT?.subscription?.paymentProvider === 'manual_whatsapp' && cbT?.subscription?.status === 'active' && cbT?.planId === 'mb-pro' && cbT?.limits?.maxProducts === 5000 && cbReqDoc?.status === 'approved' && cbReqDoc?.paymentReference === 'TRX-123' && !!cbReqDoc?.reviewedByUid, `status=${act.status} prov=${cbT?.subscription?.paymentProvider} max=${cbT?.limits?.maxProducts} req=${cbReqDoc?.status}`);

// 7. entitlements reflejan el plan (planId/limits cacheados = fuente de resolveEntitlements).
check('MB2.7 entitlements reflejan el plan (planId=mb-pro, limits.maxProducts=5000)', cbT?.planId === 'mb-pro' && cbT?.limits?.maxProducts === 5000, '');

// 8. idempotencia: re-activar la MISMA request → 400 y nada cambia.
const act2 = await callFn('manualBillingActivate', { tenantId: CB, requestId: cbReqId, paymentReference: 'TRX-OTRA' }, admin);
const cbT2 = (await db.doc(`tenants/${CB}`).get()).data();
check('MB2.8 idempotencia: re-activar misma request → 400 (no re-aplica)', act2.status === 400 && cbT2?.subscription?.paymentProvider === 'manual_whatsapp' && cbT2?.planId === 'mb-pro', `status=${act2.status}`);

// 9. PayPal sin override NO pisa manual_whatsapp (re-afirma la guarda sobre el tenant ya activado).
const r9 = await applySubscriptionUpdate(CB, upd('paypal', 'mb-lite', 'canceled'));
check('MB2.9 PayPal sin override NO pisa manual_whatsapp (guarda)', r9?.applied === false && r9?.skipped === 'manual_override' && (await db.doc(`tenants/${CB}`).get()).data()?.subscription?.paymentProvider === 'manual_whatsapp', `applied=${r9?.applied}`);

// 10. activación por planId DIRECTO (sin requestId).
const actDirect = await callFn('manualBillingActivate', { tenantId: CB, planId: 'mb-lite' }, admin);
const cbT3 = (await db.doc(`tenants/${CB}`).get()).data();
check('MB2.10 admin activa por planId directo → ok (mb-lite, limits 100)', actDirect.status === 200 && cbT3?.planId === 'mb-lite' && cbT3?.limits?.maxProducts === 100, `status=${actDirect.status} max=${cbT3?.limits?.maxProducts}`);

// 11. tenant inexistente → 400 y NO crea doc fantasma.
const ghost = `mb-ghost-${reqId}`;
const actGhost = await callFn('manualBillingActivate', { tenantId: ghost, planId: 'mb-pro' }, admin);
const ghostExists = (await db.doc(`tenants/${ghost}`).get()).exists;
check('MB2.11 tenant inexistente al activar → 400 y NO crea doc fantasma', actGhost.status === 400 && ghostExists === false, `status=${actGhost.status} exists=${ghostExists}`);

// 12. cancelación: owner cancela SU propia pending (perfumeria) → cancelled; no toca subscription.
const cancelOwn = await callFn('manualBillingCancelRequest', { requestId: reqId, reason: 'me equivoque' }, owner);
const reqDocAfter = (await db.doc(`tenants/${T}/manualActivationRequests/${reqId}`).get()).data();
check('MB2.12 owner cancela su propia pending → cancelled', cancelOwn.status === 200 && reqDocAfter?.status === 'cancelled' && reqDocAfter?.cancelReason === 'me equivoque' && !!reqDocAfter?.reviewedByUid, `status=${cancelOwn.status} st=${reqDocAfter?.status} reason=${reqDocAfter?.cancelReason}`);

// 13. cancelación admin de cualquiera → cancelled; el plan vigente NO se toca.
const cbReq2 = await callFn('requestManualPlanActivation', { tenantId: CB, planId: 'mb-pro', method: 'giro' }, admin);
const cbReq2Id = cbReq2.result?.requestId;
const planBefore = (await db.doc(`tenants/${CB}`).get()).data()?.planId;
const cancelAdmin = await callFn('manualBillingCancelRequest', { tenantId: CB, requestId: cbReq2Id, reason: 'no pago' }, admin);
const cbReq2Doc = (await db.doc(`tenants/${CB}/manualActivationRequests/${cbReq2Id}`).get()).data();
const planAfter = (await db.doc(`tenants/${CB}`).get()).data()?.planId;
check('MB2.13 admin cancela cualquiera → cancelled; plan vigente intacto', cancelAdmin.status === 200 && cbReq2Doc?.status === 'cancelled' && planBefore === planAfter && planAfter === 'mb-lite', `status=${cancelAdmin.status} planBefore=${planBefore} planAfter=${planAfter}`);

// 14. cross-tenant: owner no cancela solicitud de otro tenant (su tenant forzado) → 404.
const ownerCancelCross = await callFn('manualBillingCancelRequest', { tenantId: CB, requestId: cbReq2Id }, owner);
check('MB2.14 cross-tenant: owner no cancela solicitud de otro tenant → 404', ownerCancelCross.status === 404, `status=${ownerCancelCross.status}`);

// --- Limpieza ---
for (const d of (await reqsT().get()).docs) await d.ref.delete().catch(() => {});
for (const d of (await db.collection(`tenants/${T}/auditLogs`).get()).docs) await d.ref.delete().catch(() => {});
for (const sub of ['manualActivationRequests', 'auditLogs']) for (const d of (await db.collection(`tenants/${CB}/${sub}`).get()).docs) await d.ref.delete().catch(() => {});
await db.doc(`tenants/${CB}`).delete().catch(() => {});
await db.doc(`tenants/${ghost}`).delete().catch(() => {});
await db.doc('plans/mb-pro').delete().catch(() => {});
await db.doc('plans/mb-lite').delete().catch(() => {});
for (const uid of ephemeralUids) await auth.deleteUser(uid).catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO BILLING MANUAL — MB-1 guarda + MB-2 callables: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
