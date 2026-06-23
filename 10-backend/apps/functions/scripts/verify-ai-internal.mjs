/**
 * verify-ai-internal.mjs — Asistente interno de crecimiento (callable askInternalGrowthAssistant · AG-4).
 * Maneja el callable real contra el emulador. NUNCA llama a api.anthropic.com: el cliente de IA es el
 * Fake (lee aiTestFixtures/ai). Cubre la matriz de AG-4:
 *   AUTH (plan-independiente): seller/viewer → 403; admin sin tenantId → 400; mensaje vacío/largo → 400.
 *   PLAN: feature off (free) → error controlado {ok:false,reason:gate}; starter → ok:true (owner/admin).
 *   AISLAMIENTO: owner que pasa tenantId ajeno → opera SU tenant; nunca escribe/lee aiRequests del otro.
 *   ERROR CONTROLADO: Claude falla → {ok:false,reason:error} (no rompe el callable).
 *   AUDITORÍA: aiRequests del contexto internal sin prompt/PII; rules manager+/owner (seller 403).
 *
 * Settle de 31s al final (muta el plan de perfumeria) → suite order-independent. Requiere emulador +
 * seed-users (owner/seller/admin de perfumeria). El viewer se crea efímero.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const auth = getAuth();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';

const T = 'perfumeria';
const OTHER = 'boutique-demo';
const FIX = 'aiTestFixtures/ai';
const MARK = '[internal-ai]';
const FN = 'askInternalGrowthAssistant';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const restGet = async (token, path) => (await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } })).status;
async function callFn(data, idToken) {
  const res = await fetch(`${BASE}/${FN}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}
/** Reintenta el callable hasta que `pred` se cumpla (absorbe el caché de entitlements de 30s). */
async function callUntil(data, token, pred, maxMs = 35_000) {
  const end = Date.now() + maxMs;
  let res;
  while (Date.now() < end) { res = await callFn(data, token); if (pred(res)) return res; await sleep(2000); }
  return res;
}
const setFixture = (d) => db.doc(FIX).set(d);
async function setPlan(planId) {
  await db.doc(`tenants/${T}`).set({ planId, subscription: { status: 'active', currentPeriodStart: Timestamp.now() }, usage: { aiTokensThisMonth: 0, currentPeriodStart: Timestamp.now() } }, { merge: true });
}
const internalReqs = async (tenant) => (await db.collection(`tenants/${tenant}/aiRequests`).where('context', '==', 'internal_growth_assistant').get());

// ---- Snapshot + viewer efímero ----
const before = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const testStart = Timestamp.now();
async function ephemeral(email, role) {
  let u;
  try { u = await auth.getUserByEmail(email); } catch { u = await auth.createUser({ email, password: 'test1234', emailVerified: true }); }
  await auth.setCustomUserClaims(u.uid, { role, tenantId: T });
  return u;
}
const viewer = await ephemeral('viewer-ai@test.com', 'TENANT_VIEWER');
const manager = await ephemeral('manager-ai@test.com', 'TENANT_MANAGER');

const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');
const viewerToken = await signIn('viewer-ai@test.com');
const managerToken = await signIn('manager-ai@test.com');

// === AUTH / VALIDACIÓN (plan-independiente: falla antes del gate) ===
const rSeller = await callFn({ message: 'cómo van mis ventas?' }, seller);
check('1. SELLER → 403 (no puede usar el asistente interno)', rSeller.status === 403, `status=${rSeller.status}`);
const rViewer = await callFn({ message: 'cómo van mis ventas?' }, viewerToken);
check('2. VIEWER → 403', rViewer.status === 403, `status=${rViewer.status}`);
const rManager = await callFn({ message: 'cómo van mis ventas?' }, managerToken);
check('2b. MANAGER → 403 (el asistente interno es solo owner/admin)', rManager.status === 403, `status=${rManager.status}`);
const rAdminNoT = await callFn({ message: 'hola' }, admin);
check('3. PLATFORM_ADMIN sin tenantId → 400 (debe indicar la empresa)', rAdminNoT.status === 400, `status=${rAdminNoT.status}`);
const rEmpty = await callFn({ message: '   ' }, owner);
check('4. mensaje vacío → 400 (validación)', rEmpty.status === 400, `status=${rEmpty.status}`);
const rLong = await callFn({ message: 'x'.repeat(2500) }, owner);
check('5. mensaje muy largo (>2000) → 400 (validación)', rLong.status === 400, `status=${rLong.status}`);

// === FEATURE OFF (free) → error controlado ===
await setFixture({ text: `respuesta IA que no debería verse ${MARK}` });
await setPlan('free');
const rOff = await callUntil({ message: '¿cómo van mis ventas?' }, owner, (r) => r.result?.ok === false && r.result?.reason === 'gate');
check('6. plan free (aiAssistant off) → ok:false, reason gate, mensaje amigable (no rompe)',
  rOff.status === 200 && rOff.result?.ok === false && rOff.result?.reason === 'gate' && typeof rOff.result?.message === 'string' && rOff.result.message.length > 0,
  JSON.stringify(rOff.result));

// === HABILITADO (starter) ===
await setPlan('starter');
await setFixture({ text: `Tus ventas crecieron 12% este mes 📈 ${MARK}` });
const rOwner = await callUntil({ message: '¿cómo van mis ventas?' }, owner, (r) => r.status === 200 && r.result?.ok === true);
check('7. OWNER consulta su tenant (starter) → ok:true con respuesta del modelo (fake)',
  rOwner.status === 200 && rOwner.result?.ok === true && typeof rOwner.result?.reply === 'string' && rOwner.result.reply.includes(MARK),
  JSON.stringify(rOwner.result));

// === AISLAMIENTO: owner que pasa tenantId ajeno → opera SU tenant; no toca al otro ===
const otherBefore = (await internalReqs(OTHER)).size;
const rCross = await callFn({ message: '¿cómo van mis ventas?', tenantId: OTHER }, owner);
const otherAfter = (await internalReqs(OTHER)).size;
check('8. OWNER pasa tenantId ajeno → se ignora (opera su tenant); NO genera aiRequests del otro tenant',
  rCross.status === 200 && rCross.result?.ok === true && otherAfter === otherBefore,
  `ok=${rCross.result?.ok} otherReqs ${otherBefore}→${otherAfter}`);

// === PLATFORM_ADMIN consulta un tenant específico ===
const rAdmin = await callFn({ message: '¿cómo van las ventas?', tenantId: T }, admin);
check('9. PLATFORM_ADMIN + tenantId=perfumeria → ok:true', rAdmin.status === 200 && rAdmin.result?.ok === true, JSON.stringify(rAdmin.result));

// === Tool round-trip: el modelo pide resumen_ventas → backend lo ejecuta READ-ONLY y tenant-scoped ===
await setFixture({ responses: [
  { toolUses: [{ id: 'tu', name: 'resumen_ventas', input: { tenantId: OTHER } }] }, // el tenantId del input se ignora
  { text: `Resumen de tu negocio ✨ ${MARK}` },
] });
const otherBeforeTool = (await internalReqs(OTHER)).size;
const rTool = await callUntil({ message: 'dame un resumen de mis ventas' }, owner, (r) => r.status === 200 && r.result?.ok === true && r.result?.reply?.includes(MARK));
const toolDocs = (await internalReqs(T)).docs.map((d) => d.data()).filter((d) => Array.isArray(d.toolNames) && d.toolNames.includes('resumen_ventas'));
const otherAfterTool = (await internalReqs(OTHER)).size;
check('9b. tool round-trip: el modelo ejecuta resumen_ventas (read-only, tenant-scoped); el otro tenant intacto',
  rTool.result?.ok === true && toolDocs.length > 0 && otherAfterTool === otherBeforeTool,
  `toolDocs=${toolDocs.length} otherReqs ${otherBeforeTool}→${otherAfterTool}`);

// === ERROR CONTROLADO: Claude falla ===
await setFixture({ fail: true, failMessage: 'fixture: fallo simulado' });
const rFail = await callUntil({ message: '¿cómo van mis ventas?' }, owner, (r) => r.result?.ok === false && r.result?.reason === 'error');
check('10. Claude falla → ok:false reason error (controlado, no rompe el callable)',
  rFail.status === 200 && rFail.result?.ok === false && rFail.result?.reason === 'error' && typeof rFail.result?.message === 'string',
  JSON.stringify(rFail.result));

// === AUDITORÍA: aiRequests internal sin prompt/PII; rules ===
const myReqs = (await internalReqs(T)).docs.map((d) => ({ id: d.id, ...d.data() }));
const okDoc = myReqs.find((d) => d.status === 'ok');
const keys = okDoc ? Object.keys(okDoc) : [];
const SENSITIVE = ['prompt', 'prompts', 'messages', 'message', 'system', 'content', 'payload', 'text', 'body', 'pii'];
const noPromptKeys = !keys.some((k) => SENSITIVE.includes(k.toLowerCase()));
const noLeak = okDoc ? !JSON.stringify(okDoc).includes('cómo van mis ventas') && !JSON.stringify(okDoc).includes(MARK) : false;
check('11. aiRequests (contexto internal) → metadatos sin prompt ni PII',
  !!okDoc && okDoc.context === 'internal_growth_assistant' && okDoc.model === 'claude-haiku-4-5-20251001' && noPromptKeys && noLeak,
  `keys=${keys.join(',')}`);

const anyId = okDoc?.id ?? myReqs[0]?.id;
check('12. rules: SELLER NO lee aiRequests (403); OWNER sí (200)',
  anyId ? (await restGet(seller, `tenants/${T}/aiRequests/${anyId}`)) === 403 && (await restGet(owner, `tenants/${T}/aiRequests/${anyId}`)) === 200 : false);

// ---- Limpieza: borrar aiRequests del test, viewer efímero y restaurar perfumeria + settle ----
for (const d of (await db.collection(`tenants/${T}/aiRequests`).where('createdAt', '>=', testStart).get()).docs) await d.ref.delete().catch(() => {});
await db.doc(FIX).delete().catch(() => {});
await auth.deleteUser(viewer.uid).catch(() => {});
await auth.deleteUser(manager.uid).catch(() => {});
await db.doc(`tenants/${T}`).set({
  planId: before.planId ?? 'free',
  subscription: before.subscription ?? FieldValue.delete(),
  usage: before.usage ?? FieldValue.delete(),
}, { merge: true });
// Settle del caché de entitlements (30s) → no contamina las regresiones siguientes.
await sleep(31_000);

const ok = results.every((x) => x);
console.log(`\nRESULTADO AG-4 (asistente interno de crecimiento · callable): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
