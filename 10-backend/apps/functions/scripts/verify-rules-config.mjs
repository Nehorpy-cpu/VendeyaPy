/**
 * verify-rules-config.mjs — Cierre de rules de config sensible (Hardening F5C, G-1).
 * Verifica que el wildcard match /config/{doc} quedó con write:false: las escrituras directas desde
 * cliente están bloqueadas (agent/checkout/channels y cualquier doc), los callables siguen
 * funcionando (Admin SDK) y las lecturas por rol no cambian. authz de los callables de config es
 * OWNER/ADMIN (resolveOwnerAdminAuth): manager/viewer/seller → 403 (más estricto que growth).
 * Crea usuarios efímeros manager/viewer (claims) y los borra al final.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const auth = getAuth();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTHURL = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTHURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, idToken) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}
const restGet = (path, token) => fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
const restPatch = (path, fields, token) => fetch(`${FS}/${path}?${Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join('&')}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ fields }) }).then((r) => r.status);

// Usuario efímero con claims {role, tenantId} (no hay seed de manager/viewer). Devuelve idToken fresco.
const ephemeralUids = [];
async function mkUser(email, role) {
  let u;
  try { u = await auth.getUserByEmail(email); } catch { u = await auth.createUser({ email, password: 'test1234' }); }
  await auth.setCustomUserClaims(u.uid, { role, tenantId: T });
  ephemeralUids.push(u.uid);
  return signIn(email); // idToken fresco con los claims recién seteados
}

const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');
const boutiqueOwner = await signIn('owner@boutique.com');
const manager = await mkUser('rules-manager@perfumeria.com', 'TENANT_MANAGER');
const viewer = await mkUser('rules-viewer@perfumeria.com', 'TENANT_VIEWER');

// ===== Cierre G-1 — config/{doc} =====

// 1. agentConfigUpdate owner (callable, Admin SDK) sigue escribiendo config/agent.
const ag = await callFn('agentConfigUpdate', { tenantId: T, data: { agentName: 'Rules Cfg' } }, owner);
check('G1.1 agentConfigUpdate owner → ok (config/agent escrito vía callable)', ag.status === 200 && (await db.doc(`tenants/${T}/config/agent`).get()).data()?.agentName === 'Rules Cfg', `status=${ag.status}`);

// 2. checkoutConfigUpdate owner (callable) sigue escribiendo config/checkout.
const co = await callFn('checkoutConfigUpdate', { tenantId: T, data: { bankAccounts: [{ bank: 'Itaú', accountNumber: '1', holder: 'M', document: '1' }], sellers: [] } }, owner);
check('G1.2 checkoutConfigUpdate owner → ok (config/checkout vía callable)', co.status === 200 && (await db.doc(`tenants/${T}/config/checkout`).get()).data()?.bankAccounts?.length === 1, `status=${co.status}`);

// 3. channelConfigUpdate owner (mock) sigue escribiendo config/channels.
const ch = await callFn('channelConfigUpdate', { tenantId: T, data: { whatsappSendMode: 'mock' } }, owner);
check('G1.3 channelConfigUpdate owner (mock) → ok (config/channels vía callable)', ch.status === 200 && ch.result?.whatsappSendMode === 'mock', `status=${ch.status}`);

// 4. write directo del owner a config/agent → 403 (write cerrado).
const wAgent = await restPatch(`tenants/${T}/config/agent`, { agentName: { stringValue: 'Hack' } }, owner);
check('G1.4 write directo owner a config/agent → 403', wAgent === 403, `status=${wAgent}`);

// 5. write directo del owner a config/checkout → 403.
const wCheckout = await restPatch(`tenants/${T}/config/checkout`, { foo: { stringValue: 'x' } }, owner);
check('G1.5 write directo owner a config/checkout → 403', wCheckout === 403, `status=${wCheckout}`);

// 6. write directo del owner a config/channels → 403.
const wChannels = await restPatch(`tenants/${T}/config/channels`, { whatsappSendMode: { stringValue: 'live' } }, owner);
check('G1.6 write directo owner a config/channels → 403', wChannels === 403, `status=${wChannels}`);

// 7. write directo del owner a un config/{otro-doc} arbitrario → 403 (el wildcard cubre todo).
const wWild = await restPatch(`tenants/${T}/config/rules-hack`, { x: { stringValue: '1' } }, owner);
check('G1.7 write directo owner a config/{otro doc} → 403 (wildcard cerrado)', wWild === 403, `status=${wWild}`);

// 8. authz callables config = OWNER/ADMIN: manager/viewer/seller NO pueden (más estricto que growth).
const mgrUp = await callFn('agentConfigUpdate', { tenantId: T, data: { agentName: 'x' } }, manager);
const viwUp = await callFn('agentConfigUpdate', { tenantId: T, data: { agentName: 'x' } }, viewer);
const selUp = await callFn('agentConfigUpdate', { tenantId: T, data: { agentName: 'x' } }, seller);
check('G1.8 manager/viewer/seller NO pueden agentConfigUpdate → 403 (config es owner/admin)', mgrUp.status === 403 && viwUp.status === 403 && selUp.status === 403, `mgr=${mgrUp.status} viw=${viwUp.status} sel=${selUp.status}`);

// 9. lectura sin cambios: owner y viewer (viewer+) leen config/agent → 200; seller (no viewer) → 403.
const rOwner = await restGet(`tenants/${T}/config/agent`, owner);
const rViewer = await restGet(`tenants/${T}/config/agent`, viewer);
const rSeller = await restGet(`tenants/${T}/config/agent`, seller);
check('G1.9 owner/viewer leen config → 200; seller → 403 (read sin cambios)', rOwner === 200 && rViewer === 200 && rSeller === 403, `owner=${rOwner} viewer=${rViewer} seller=${rSeller}`);

// 10. aislamiento de tenant (lectura): owner de boutique NO lee config de perfumeria → 403.
const rCross = await restGet(`tenants/${T}/config/agent`, boutiqueOwner);
check('G1.10 owner de OTRO tenant NO lee config de perfumeria → 403', rCross === 403, `status=${rCross}`);

// 11. aislamiento de tenant (callable): owner de boutique pidiendo tenantId=perfumeria NO afecta a perfumeria
//     (resolveOwnerAdminAuth ignora el tenantId pedido para no-admin y usa el del token → escribe boutique-demo).
const before = (await db.doc(`tenants/${T}/config/agent`).get()).data()?.agentName;
await callFn('agentConfigUpdate', { tenantId: T, data: { agentName: 'HACK-boutique' } }, boutiqueOwner);
const after = (await db.doc(`tenants/${T}/config/agent`).get()).data()?.agentName;
const boutiqueAgent = (await db.doc('tenants/boutique-demo/config/agent').get()).data()?.agentName;
check('G1.11 callable cross-tenant: boutique NO escribe config de perfumeria (escribe el suyo)', after === before && after !== 'HACK-boutique' && boutiqueAgent === 'HACK-boutique', `perfu=${after} boutique=${boutiqueAgent}`);

// 12. PLATFORM_ADMIN mantiene acceso vía callable: admin con tenantId=perfumeria → 200 y escribe.
const adminUp = await callFn('agentConfigUpdate', { tenantId: T, data: { agentName: 'Admin Set' } }, admin);
check('G1.12 PLATFORM_ADMIN agentConfigUpdate (tenantId=perfumeria) → ok', adminUp.status === 200 && (await db.doc(`tenants/${T}/config/agent`).get()).data()?.agentName === 'Admin Set', `status=${adminUp.status}`);

// --- Limpieza ---
await db.doc(`tenants/${T}/config/channels`).delete().catch(() => {});
await db.doc(`tenants/${T}/config/checkout`).delete().catch(() => {});
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true }, { merge: true });
await db.doc('tenants/boutique-demo/config/agent').delete().catch(() => {});
for (const d of (await db.collection(`tenants/${T}/auditLogs`).get()).docs) await d.ref.delete().catch(() => {});
for (const uid of ephemeralUids) await auth.deleteUser(uid).catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO CIERRE RULES CONFIG — G-1 config/{doc} write:false: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
