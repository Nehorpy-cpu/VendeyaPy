/**
 * verify-billing-manual.mjs — Billing manual por WhatsApp, MB-1: guarda de precedencia de
 * applySubscriptionUpdate. Importa la función COMPILADA (lib/) y la prueba contra el emulador:
 *   - update normal (no manual) aplica y deja planId/limits/subscription coherentes;
 *   - un update EXTERNO (PayPal/Stripe/sync) NO pisa una suscripción 'manual_whatsapp' (sin override);
 *   - el flujo admin (allowOverrideManual:true) SÍ pisa y registra previousProvider;
 *   - un update externo normal sobre un tenant NO-manual sigue aplicando (no rompe Stripe/PayPal).
 * Requiere build de functions (lib/) y el emulador Firestore corriendo.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { applySubscriptionUpdate } from '../lib/billing/applySubscription.js';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const T = 'mb-guard-test';
const get = async () => (await db.doc(`tenants/${T}`).get()).data();

// Planes de prueba con limits conocidos (getPlan lee plans/{id}).
const PLAN = (id, tier, maxProducts) => ({ id, tier, name: id, description: '', priceUsdPerMonth: 0, isActive: true, limits: { maxProducts, maxOrdersPerMonth: 999, maxWhatsappMessagesPerMonth: 999, maxDeliveryPersons: 9, maxUsers: 9, maxWhatsappNumbers: 2, maxAdSyncsPerMonth: 9, maxAiTokensPerMonth: 9999 }, features: { bancard: false, stripe: false, localWallets: false, electronicInvoicing: false, marketingAutomation: false, multiChannel: false, prioritySupport: false, aiAssistant: false } });
await db.doc('plans/mb-pro').set(PLAN('mb-pro', 'PRO', 5000));
await db.doc('plans/mb-lite').set(PLAN('mb-lite', 'STARTER', 100));

const upd = (provider, planId, status = 'active') => ({ tenantId: null, provider, status, planId, currentPeriodEndMs: null, externalCustomerId: null, externalSubscriptionId: null, externalPlanRef: null, providerMetadata: {}, pastDueSinceMs: null });
const setSub = (paymentProvider, planId, status = 'active') => db.doc(`tenants/${T}`).set({ subscription: { paymentProvider, status, planId }, planId }, { merge: true });

// 1. tenant nuevo + update normal (paypal) → aplica; planId/limits/subscription coherentes.
await db.doc(`tenants/${T}`).set({ id: T, name: T, status: 'ACTIVE', createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const r1 = await applySubscriptionUpdate(T, upd('paypal', 'mb-pro'));
const t1 = await get();
check('MB1.1 update normal (paypal) → applied; planId/limits/subscription escritos', r1?.applied === true && !r1?.skipped && t1?.planId === 'mb-pro' && t1?.limits?.maxProducts === 5000 && t1?.subscription?.paymentProvider === 'paypal' && t1?.subscription?.status === 'active', `applied=${r1?.applied} plan=${t1?.planId} max=${t1?.limits?.maxProducts}`);

// 2. tenant ahora manual_whatsapp; update externo PayPal SIN override → OMITIDO, nada cambia.
await setSub('manual_whatsapp', 'mb-pro');
const r2 = await applySubscriptionUpdate(T, upd('paypal', 'mb-lite', 'canceled'));
const t2 = await get();
check('MB1.2 webhook PayPal sin override sobre manual_whatsapp → OMITIDO (nada cambia)', r2?.applied === false && r2?.skipped === 'manual_override' && t2?.subscription?.paymentProvider === 'manual_whatsapp' && t2?.planId === 'mb-pro' && t2?.subscription?.status === 'active', `applied=${r2?.applied} skipped=${r2?.skipped} prov=${t2?.subscription?.paymentProvider} plan=${t2?.planId}`);

// 3. Stripe sync SIN override sobre manual_whatsapp → también OMITIDO.
const r3 = await applySubscriptionUpdate(T, upd('stripe', 'mb-lite'));
check('MB1.3 update Stripe sin override sobre manual_whatsapp → OMITIDO', r3?.applied === false && r3?.skipped === 'manual_override' && (await get())?.subscription?.paymentProvider === 'manual_whatsapp', `applied=${r3?.applied} skipped=${r3?.skipped}`);

// 4. flujo admin manual (allowOverrideManual:true) cambia el plan manual → APLICA.
const r4 = await applySubscriptionUpdate(T, upd('manual_whatsapp', 'mb-lite'), { allowOverrideManual: true });
const t4 = await get();
check('MB1.4 admin override sobre manual_whatsapp (cambia plan) → applied', r4?.applied === true && t4?.planId === 'mb-lite' && t4?.limits?.maxProducts === 100 && t4?.subscription?.paymentProvider === 'manual_whatsapp', `applied=${r4?.applied} plan=${t4?.planId} max=${t4?.limits?.maxProducts}`);

// 5. admin override pisando un proveedor EXTERNO (paypal) → aplica + registra previousProvider.
await setSub('paypal', 'mb-pro');
const r5 = await applySubscriptionUpdate(T, upd('manual_whatsapp', 'mb-pro'), { allowOverrideManual: true });
const t5 = await get();
check('MB1.5 admin override pisa PayPal → applied + providerMetadata.previousProvider=paypal', r5?.applied === true && t5?.subscription?.paymentProvider === 'manual_whatsapp' && t5?.subscription?.providerMetadata?.previousProvider === 'paypal', `applied=${r5?.applied} prev=${t5?.subscription?.providerMetadata?.previousProvider}`);

// 6. update externo normal sobre un tenant NO-manual → sigue aplicando (no rompe Stripe/PayPal).
await setSub('stripe', 'mb-pro');
const r6 = await applySubscriptionUpdate(T, upd('stripe', 'mb-lite', 'past_due'));
const t6 = await get();
check('MB1.6 update Stripe normal (tenant no-manual) → applied (no rompe webhooks)', r6?.applied === true && t6?.subscription?.status === 'past_due' && t6?.planId === 'mb-lite', `applied=${r6?.applied} status=${t6?.subscription?.status}`);

// --- Limpieza ---
await db.doc(`tenants/${T}`).delete().catch(() => {});
await db.doc('plans/mb-pro').delete().catch(() => {});
await db.doc('plans/mb-lite').delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO BILLING MANUAL — MB-1 guarda de precedencia applySubscriptionUpdate: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
