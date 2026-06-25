/**
 * verify-plan-matrix.mjs — Matriz e2e por plan (PLAN-LIMITS-5).
 * Verifica que límites + features de CADA plan (free/starter/growth/pro/enterprise) coinciden con la
 * matriz comercial y se enforcean en el comportamiento real (callables + webhook contra el emulador).
 * NUNCA llama a Anthropic/Meta real (FakeAiClient por aiTestFixtures + devSimulateInbound).
 *
 * Estrategia anti-flake: un TENANT FRESCO (id único) por escenario → el caché de entitlements (30s,
 * por tenantId) nunca está poblado → resolución fresca sin settle de 31s. Snapshot/cleanup explícito.
 * messageIds de webhook únicos por corrida (devSimulateInbound usa doc-id aleatorio).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { DEFAULT_PLANS, UNLIMITED } from '../lib/plans/plans.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const FIX = 'aiTestFixtures/ai';
const RUN = Date.now();

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, token) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}

const NOW = Timestamp.now();
const ZERO_USAGE = { ordersThisMonth: 0, messagesThisMonth: 0, jobsThisMonth: 0, adSyncsThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: NOW };
const createdTenants = [];
const createdIndex = [];
const createdEvents = [];
async function mkTenant(id, { planId = 'free', usage, featureOverrides } = {}) {
  createdTenants.push(id);
  await db.doc(`tenants/${id}`).set({
    id, name: id, slug: id, status: 'ACTIVE', planId,
    subscription: { status: 'active', currentPeriodStart: NOW },
    usage: { ...ZERO_USAGE, ...(usage ?? {}) },
    ...(featureOverrides ? { featureOverrides } : {}),
    createdAt: NOW, updatedAt: NOW,
  }, { merge: true });
}
const delivery = (tenantId, n, token) => callFn('deliveryPersonUpsert', { tenantId, data: { name: `Repa ${n}`, whatsappPhone: `+59598100${n}` } }, token);

// IG inbound: índice único por tenant + devSimulateInbound + poll del inbox.
async function igProbe(tenantId, token, { botOn = false } = {}) {
  const ext = `ig-${tenantId}`;
  createdIndex.push(`instagram_${ext}`);
  await db.doc(`metaExternalIndex/instagram_${ext}`).set({ id: `instagram_${ext}`, tenantId, connectionId: 'main', assetType: 'instagram_account', platform: 'instagram', externalId: ext, status: 'active', updatedAt: Timestamp.now() });
  if (botOn) {
    await db.doc(`tenants/${tenantId}/config/channels`).set({ whatsappSendMode: 'mock' });
    await db.doc(`tenants/${tenantId}/config/agent`).set({ botEnabled: true }, { merge: true });
  }
  const from = '+595' + (900000000 + (RUN % 99999999));
  const r = await fetch(`${BASE}/devSimulateInbound`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'instagram', externalId: ext, from, text: 'hola IG' }) }).then((x) => x.json());
  createdEvents.push(r.eventId);
  const end = Date.now() + 18000;
  while (Date.now() < end) {
    const d = (await db.doc(`metaWebhookInbox/${r.eventId}`).get()).data();
    if (d && d.processingStatus !== 'received' && d.processingStatus !== 'processing') return { status: d.processingStatus, err: d.errorMessage ?? '' };
    await sleep(1000);
  }
  return { status: 'timeout', err: '' };
}

const admin = await signIn('superadmin@aiafg.com');

// ===== MATRIZ COMERCIAL ESPERADA (fuente: docs/plan-limits.md §5 / plans.ts) =====
const U = UNLIMITED;
const MATRIX = {
  free:       { limits: { maxProducts: 20, maxOrdersPerMonth: 10, maxWhatsappMessagesPerMonth: 50, maxDeliveryPersons: 1, maxUsers: 2, maxWhatsappNumbers: 1, maxAdSyncsPerMonth: 0, maxAiTokensPerMonth: 0 }, aiAssistant: false, marketingAutomation: false, trialDays: 7 },
  starter:    { limits: { maxProducts: 200, maxOrdersPerMonth: 500, maxWhatsappMessagesPerMonth: 5000, maxDeliveryPersons: 10, maxUsers: 5, maxWhatsappNumbers: 1, maxAdSyncsPerMonth: 0, maxAiTokensPerMonth: 50000 }, aiAssistant: true, marketingAutomation: false },
  growth:     { limits: { maxProducts: 1000, maxOrdersPerMonth: 2000, maxWhatsappMessagesPerMonth: 20000, maxDeliveryPersons: 50, maxUsers: 15, maxWhatsappNumbers: 3, maxAdSyncsPerMonth: 30, maxAiTokensPerMonth: 250000 }, aiAssistant: true, marketingAutomation: true },
  pro:        { limits: { maxProducts: 10000, maxOrdersPerMonth: 20000, maxWhatsappMessagesPerMonth: 100000, maxDeliveryPersons: 200, maxUsers: 50, maxWhatsappNumbers: 10, maxAdSyncsPerMonth: 300, maxAiTokensPerMonth: 1000000 }, aiAssistant: true, marketingAutomation: true },
  enterprise: { limits: { maxProducts: U, maxOrdersPerMonth: U, maxWhatsappMessagesPerMonth: U, maxDeliveryPersons: U, maxUsers: U, maxWhatsappNumbers: U, maxAdSyncsPerMonth: U, maxAiTokensPerMonth: U }, aiAssistant: true, marketingAutomation: true },
};
const OFF_FEATURES = ['bancard', 'stripe', 'localWallets', 'electronicInvoicing', 'multiChannel', 'prioritySupport'];
const LIMIT_KEYS = Object.keys(MATRIX.free.limits);

function matchesMatrix(planObj, exp) {
  const limsOk = LIMIT_KEYS.every((k) => planObj.limits?.[k] === exp.limits[k]);
  const featOk = planObj.features?.aiAssistant === exp.aiAssistant && planObj.features?.marketingAutomation === exp.marketingAutomation;
  const offOk = OFF_FEATURES.every((f) => planObj.features?.[f] === false);
  // PLAN-LIMITS-FREE-TRIAL: trialDays=7 solo en free; planes pagos sin trialDays.
  const trialOk = (planObj.trialDays ?? undefined) === (exp.trialDays ?? undefined);
  return { ok: limsOk && featOk && offOk && trialOk, limsOk, featOk, offOk, trialOk };
}

console.log('=== PARTE A — Matriz de datos (spec DEFAULT_PLANS + seed plans/{id}) ===');
for (const planId of Object.keys(MATRIX)) {
  const spec = DEFAULT_PLANS.find((p) => p.id === planId);
  const m = spec ? matchesMatrix(spec, MATRIX[planId]) : { ok: false };
  check(`A. spec '${planId}' (plans.ts) = matriz comercial (8 límites + features + trialDays)`,
    m.ok, m.ok ? '' : `lims=${m.limsOk} feat=${m.featOk} off=${m.offOk} trial=${m.trialOk}`);
}
// Seed real en Firestore (lo que usa resolveEntitlements vía getPlan). Si falta, getPlan cae al spec.
let seedOk = true, seedNote = '';
for (const planId of Object.keys(MATRIX)) {
  const snap = await db.doc(`plans/${planId}`).get();
  if (!snap.exists) { seedNote += `${planId}:no-seed `; continue; }
  const m = matchesMatrix(snap.data(), MATRIX[planId]);
  if (!m.ok) { seedOk = false; seedNote += `${planId}:MISMATCH(lims=${m.limsOk},feat=${m.featOk},off=${m.offOk}) `; }
}
check('A6. plans/{id} seedeados coinciden con la matriz (o ausentes → getPlan usa spec)', seedOk, seedNote || 'todos OK');

console.log('\n=== PARTE B — Features + cuotas por plan (callables reales, tenant fresco) ===');
// aiAssistant: free OFF (gate) vs starter/growth ON. Fixture canned (no red).
await db.doc(FIX).set({ text: `respuesta IA (fake) ${RUN}` });
const tFreeAI = `pm5-ai-free-${RUN}`; await mkTenant(tFreeAI, { planId: 'free' });
const rAIfree = await callFn('askInternalGrowthAssistant', { tenantId: tFreeAI, message: '¿cómo van mis ventas?' }, admin);
check('B1. free → aiAssistant BLOQUEADO (ok:false, reason gate)', rAIfree.status === 200 && rAIfree.result?.ok === false && rAIfree.result?.reason === 'gate', JSON.stringify(rAIfree.result));

const tStAI = `pm5-ai-starter-${RUN}`; await mkTenant(tStAI, { planId: 'starter' });
const rAIst = await callFn('askInternalGrowthAssistant', { tenantId: tStAI, message: '¿cómo van mis ventas?' }, admin);
check('B2. starter (Básico) → aiAssistant PERMITIDO (ok:true con reply fake)', rAIst.status === 200 && rAIst.result?.ok === true && typeof rAIst.result?.reply === 'string', JSON.stringify(rAIst.result?.ok));

const tGrAI = `pm5-ai-growth-${RUN}`; await mkTenant(tGrAI, { planId: 'growth' });
const rAIgr = await callFn('askInternalGrowthAssistant', { tenantId: tGrAI, message: '¿cómo van mis ventas?' }, admin);
check('B3. growth (Pro) → aiAssistant PERMITIDO (ok:true)', rAIgr.status === 200 && rAIgr.result?.ok === true, JSON.stringify(rAIgr.result?.ok));

// maxAiTokensPerMonth: starter con uso = límite (50000) → bloqueado por presupuesto.
const tTok = `pm5-tok-${RUN}`; await mkTenant(tTok, { planId: 'starter', usage: { aiTokensThisMonth: 50000 } });
const rTok = await callFn('askInternalGrowthAssistant', { tenantId: tTok, message: '¿cómo van mis ventas?' }, admin);
check('B4. starter en el tope de tokens IA (maxAiTokensPerMonth=50k) → bloqueado (ok:false)', rTok.status === 200 && rTok.result?.ok === false, JSON.stringify(rTok.result));

// marketingAutomation: free/starter OFF vs growth ON (runTenantJob metaAdsSync gatea la feature).
const tMaFree = `pm5-ma-free-${RUN}`; await mkTenant(tMaFree, { planId: 'free' });
const rMaFree = await callFn('runTenantJob', { tenantId: tMaFree, action: 'metaAdsSync' }, admin);
check('B5. free → marketingAutomation BLOQUEADO (400, "plan no incluye")', rMaFree.status === 400 && /plan no incluye/i.test(rMaFree.error?.message ?? ''), `status=${rMaFree.status}`);

const tMaSt = `pm5-ma-starter-${RUN}`; await mkTenant(tMaSt, { planId: 'starter' });
const rMaSt = await callFn('runTenantJob', { tenantId: tMaSt, action: 'metaAdsSync' }, admin);
check('B6. starter (Básico) → marketingAutomation BLOQUEADO (400)', rMaSt.status === 400 && /plan no incluye/i.test(rMaSt.error?.message ?? ''), `status=${rMaSt.status}`);

const tMaGr = `pm5-ma-growth-${RUN}`; await mkTenant(tMaGr, { planId: 'growth' });
const rMaGr = await callFn('runTenantJob', { tenantId: tMaGr, action: 'metaAdsSync' }, admin);
check('B7. growth (Pro) → marketingAutomation PERMITIDO (no 400-feature)', rMaGr.status === 200 || !/plan no incluye/i.test(rMaGr.error?.message ?? ''), `status=${rMaGr.status} msg=${rMaGr.error?.message ?? ''}`);

// Límite count (maxDeliveryPersons) enforceado DESDE el plan: free trial=1 → 2º bloqueado; enterprise → 3 permitidos.
const tDpFree = `pm5-dp-free-${RUN}`; await mkTenant(tDpFree, { planId: 'free' });
const d1 = await delivery(tDpFree, 1, admin); const d2 = await delivery(tDpFree, 2, admin);
check('B8. free trial maxDeliveryPersons=1 → crea 1 (200), el 2º BLOQUEADO (429)', d1.status === 200 && d2.status === 429, `${d1.status}/${d2.status}`);

const tDpEnt = `pm5-dp-ent-${RUN}`; await mkTenant(tDpEnt, { planId: 'enterprise' });
const e1 = await delivery(tDpEnt, 1, admin); const e2 = await delivery(tDpEnt, 2, admin); const e3 = await delivery(tDpEnt, 3, admin);
check('B9. enterprise (ilimitado) → crea 3 repartidores sin bloqueo (donde free trial bloquea el 2º)', e1.status === 200 && e2.status === 200 && e3.status === 200, `${e1.status}/${e2.status}/${e3.status}`);

console.log('\n=== PARTE C — multiChannel apagado por defecto + featureOverride per-tenant ===');
const tMcPro = `pm5-mc-pro-${RUN}`; await mkTenant(tMcPro, { planId: 'pro' });
const mcPro = await igProbe(tMcPro, admin);
check('C1. pro (plan más alto) → multiChannel OFF: inbound IG ignorado por el gate', mcPro.status === 'ignored' && /multiChannel/i.test(mcPro.err), `status=${mcPro.status} err="${mcPro.err}"`);

const tMcOv = `pm5-mc-ov-${RUN}`; await mkTenant(tMcOv, { planId: 'free', featureOverrides: { multiChannel: true } });
const mcOv = await igProbe(tMcOv, admin, { botOn: true });
check('C2. featureOverride multiChannel=true (en plan free) → inbound IG PROCESADO', mcOv.status === 'processed', `status=${mcOv.status} err="${mcOv.err}"`);

console.log('\n=== PARTE D — Cross-tenant: el override/uso de un tenant no afecta a otro ===');
const tXa = `pm5-x-ov-${RUN}`; await mkTenant(tXa, { planId: 'growth', featureOverrides: { multiChannel: true } });
const tXb = `pm5-x-noov-${RUN}`; await mkTenant(tXb, { planId: 'growth' });
const xa = await igProbe(tXa, admin, { botOn: true });
const xb = await igProbe(tXb, admin);
check('D1. dos tenants en el MISMO plan (growth): el del override procesa IG; el otro NO (ignored)', xa.status === 'processed' && xb.status === 'ignored', `override=${xa.status} sinOverride=${xb.status}`);
// Aislamiento de cuota: B8 (free bloquea 3º repartidor) vs B9 (enterprise permite 3º) ya prueban
// que el límite es por-tenant (cada uno resuelve su propio plan).
check('D2. aislamiento de límites por-tenant (free trial bloquea el 2º repartidor / enterprise permite el 3º)', d2.status === 429 && e3.status === 200, `free2=${d2.status} ent3=${e3.status}`);

console.log('\n=== PARTE E — Consistencia frontend (espejo PLAN_CATALOG vs backend) ===');
const webSrc = await readFile(join(__dirname, '..', '..', 'web', 'src', 'lib', 'entitlements.ts'), 'utf8');
const pricesOk = ['pricePygPerMonth: 0', 'pricePygPerMonth: 150_000', 'pricePygPerMonth: 350_000', 'pricePygPerMonth: 650_000'].every((s) => webSrc.includes(s));
const namesOk = ["name: 'Prueba gratis'", "name: 'Básico'", "name: 'Pro'", "name: 'Max'", "name: 'Enterprise'"].every((s) => webSrc.includes(s));
check('E1. precios PYG + nombres comerciales del espejo coinciden con la matriz', pricesOk && namesOk, `precios=${pricesOk} nombres=${namesOk}`);

const featuresOk = webSrc.includes('features: F({ aiAssistant: true })') && webSrc.includes('features: F({ aiAssistant: true, marketingAutomation: true })');
const noFalsePromise = !OFF_FEATURES.some((f) => webSrc.includes(`${f}: true`));
check('E2. espejo NO vende features apagadas (sin `<off>: true`) + features reales por plan correctas', featuresOk && noFalsePromise, `featuresReales=${featuresOk} sinPromesasFalsas=${noFalsePromise}`);

// ===== Limpieza =====
await db.doc(FIX).delete().catch(() => {});
for (const id of createdTenants) {
  for (const sub of ['deliveryPersons', 'metaAssets', 'auditLogs', 'aiRequests', 'customers', 'config']) {
    for (const d of (await db.collection(`tenants/${id}/${sub}`).get()).docs) await d.ref.delete().catch(() => {});
  }
  await db.doc(`tenants/${id}`).delete().catch(() => {});
}
for (const idx of createdIndex) await db.doc(`metaExternalIndex/${idx}`).delete().catch(() => {});
for (const ev of createdEvents) if (ev) await db.doc(`metaWebhookInbox/${ev}`).delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO PLAN-LIMITS-5 (matriz e2e por plan): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exitCode = ok ? 0 : 1;
