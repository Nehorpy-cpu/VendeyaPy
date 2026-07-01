/**
 * verify-wm2-manual.mjs — WM-2: onboarding manual de WhatsApp (solicitud del owner + panel admin).
 * ================================================================================================
 * Cubre: el owner solicita activación; seller/manager/viewer NO pueden; 1 pending por tenant (duplicado
 * falla); el admin lista (collectionGroup) y PROCESA cargando la conexión (WM-1) con requestId → la
 * solicitud queda 'completed'; el owner ve el estado; ESCRITURA directa del cliente BLOQUEADA por rules;
 * lectura cross-tenant bloqueada; channelConfigUpdate→live funciona si la conexión es resoluble; cancelar.
 *
 * Requiere: build de functions (lib/) + emuladores Firestore/Functions/Auth con el MISMO
 * TENANT_SECRETS_ENCRYPTION_KEY del .env del emulador. Usuario seedeado: superadmin@aiafg.com (test1234).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const auth = getAuth();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTHURL = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTHURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, idToken) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}
// Cliente REST del emulador Firestore (con Bearer idToken → aplica reglas, a diferencia del Admin SDK).
async function clientRead(path, idToken) {
  return (await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${idToken}` } })).status;
}
async function clientCreate(collPath, docId, fields, idToken) {
  const res = await fetch(`${FS}/${collPath}?documentId=${docId}`, {
    method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return res.status;
}
const ephemeralUids = [];
async function mkUser(email, role, tenantId) {
  let u;
  try { u = await auth.getUserByEmail(email); } catch { u = await auth.createUser({ email, password: 'test1234' }); }
  await auth.setCustomUserClaims(u.uid, { role, tenantId });
  ephemeralUids.push(u.uid);
  return signIn(email);
}

const A = 'wm2-a';
const B = 'wm2-b';
const PNID = '109876543210987';
const WABA = '100000000000001';
const TOKEN = 'EAAG-wm2-test-token';
const limits = { maxProducts: 100, maxOrdersPerMonth: 999, maxWhatsappMessagesPerMonth: 999, maxDeliveryPersons: 9, maxUsers: 9, maxWhatsappNumbers: 2, maxAdSyncsPerMonth: 9, maxAiTokensPerMonth: 9999 };
const seedTenant = (t) => db.doc(`tenants/${t}`).set({ id: t, name: t, status: 'ACTIVE', planId: 'wm2-plan', limits, subscription: { paymentProvider: 'manual_whatsapp', status: 'active', planId: 'wm2-plan' }, createdAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });

// Fixture de Graph: token válido + scopes + phone presente → verify deja 'active'.
await db.doc('metaTestFixtures/graph').set({ isValid: true, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], phoneNumbers: [{ id: PNID, displayPhoneNumber: '+595 99 123 4567', verifiedName: 'WM2', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED' }] });
await seedTenant(A);
await seedTenant(B);

const admin = await signIn('superadmin@aiafg.com'); // PLATFORM_ADMIN
const ownerA = await mkUser('wm2-owner-a@aiafg.test', 'TENANT_OWNER', A);
const sellerA = await mkUser('wm2-seller-a@aiafg.test', 'SELLER', A);
const managerA = await mkUser('wm2-mgr-a@aiafg.test', 'TENANT_MANAGER', A);
const viewerA = await mkUser('wm2-viewer-a@aiafg.test', 'TENANT_VIEWER', A);
const ownerB = await mkUser('wm2-owner-b@aiafg.test', 'TENANT_OWNER', B);

// 1) seller/manager/viewer NO pueden solicitar → 403 (permission-denied). No crean nada.
const rs = await callFn('requestWhatsappActivation', {}, sellerA);
const rm = await callFn('requestWhatsappActivation', {}, managerA);
const rv = await callFn('requestWhatsappActivation', {}, viewerA);
check('WM2.1 seller/manager/viewer NO pueden solicitar → 403', rs.status === 403 && rm.status === 403 && rv.status === 403, `s=${rs.status} m=${rm.status} v=${rv.status}`);

// 2) owner solicita → 200 + doc pending en SU tenant (ignora cualquier tenantId externo).
const req = await callFn('requestWhatsappActivation', { tenantId: B, note: 'quiero activar WhatsApp', contactPhone: '+595 99 111 222' }, ownerA);
const rid = req.result?.requestId;
const reqDoc = rid ? (await db.doc(`tenants/${A}/whatsappActivationRequests/${rid}`).get()).data() : null;
const notInB = rid ? !(await db.doc(`tenants/${B}/whatsappActivationRequests/${rid}`).get()).exists : false;
check('WM2.2 owner solicita → 200, pending en su tenant (A), ignora tenantId externo (B)',
  req.status === 200 && reqDoc?.status === 'pending' && reqDoc?.requestedByRole === 'TENANT_OWNER' && notInB,
  `status=${req.status} docStatus=${reqDoc?.status} notInB=${notInB}`);

// 3) La solicitud NUNCA guarda token/datos sensibles.
check('WM2.3 la solicitud no contiene token ni datos sensibles',
  reqDoc != null && !JSON.stringify(reqDoc).match(/token|secret|accessToken/i),
  `keys=${reqDoc ? Object.keys(reqDoc).join(',') : '—'}`);

// 4) Duplicado: owner vuelve a solicitar con una pending → 400 (failed-precondition).
const dup = await callFn('requestWhatsappActivation', {}, ownerA);
check('WM2.4 segunda solicitud con una pending → 400 (1 pending por tenant)', dup.status === 400, `status=${dup.status}`);

// 5) Admin lista pendientes (collectionGroup, como el panel) → encuentra la de A.
const listed = (await db.collectionGroup('whatsappActivationRequests').where('status', '==', 'pending').get()).docs.map((d) => d.data());
check('WM2.5 admin lista pendientes (collectionGroup) → incluye la solicitud de A',
  listed.some((r) => r.id === rid && r.tenantId === A), `pendientes=${listed.length}`);

// 6) Admin PROCESA: carga la conexión (WM-1) con requestId → 200 active + solicitud 'completed'.
const proc = await callFn('adminSetManualWhatsappConnection', { tenantId: A, requestId: rid, wabaId: WABA, phoneNumberId: PNID, displayPhoneNumber: '+595 99 123 4567', businessName: 'WM2', accessToken: TOKEN }, admin);
const reqAfter = rid ? (await db.doc(`tenants/${A}/whatsappActivationRequests/${rid}`).get()).data() : null;
const conn = (await db.doc(`tenants/${A}/metaConnections/main`).get()).data();
check('WM2.6 admin procesa → conexión active + solicitud completed (connectionStatus/phoneNumberId, sin token)',
  proc.status === 200 && proc.result?.status === 'active' && conn?.status === 'active' &&
  reqAfter?.status === 'completed' && reqAfter?.connectionStatus === 'active' && reqAfter?.phoneNumberId === PNID &&
  reqAfter?.reviewedByUid && !JSON.stringify(reqAfter).match(/EAAG/),
  `proc=${proc.status} reqStatus=${reqAfter?.status} connStatus=${reqAfter?.connectionStatus}`);

// 7) Estado visible para el owner: lee su solicitud por rules (owner de su tenant) → 200.
const ownerReadOwn = await clientRead(`tenants/${A}/whatsappActivationRequests/${rid}`, ownerA);
check('WM2.7 owner ve el estado de SU solicitud (rules read owner) → 200', ownerReadOwn === 200, `status=${ownerReadOwn}`);

// 8) Escritura directa del cliente BLOQUEADA por rules (write:false) → 403.
const directWrite = await clientCreate(`tenants/${A}/whatsappActivationRequests`, 'hack-1', { status: { stringValue: 'completed' } }, ownerA);
check('WM2.8 escritura directa del cliente a whatsappActivationRequests → 403 (rules write:false)', directWrite === 403, `status=${directWrite}`);

// 9) Lectura cross-tenant BLOQUEADA: owner de B intenta leer la solicitud de A → 403.
const crossRead = await clientRead(`tenants/${A}/whatsappActivationRequests/${rid}`, ownerB);
check('WM2.9 owner de B NO puede leer la solicitud de A (rules) → 403', crossRead === 403, `status=${crossRead}`);

// 10) Conexión resoluble: channelConfigUpdate → live pasa (creds del tenant resolubles).
const live = await callFn('channelConfigUpdate', { tenantId: A, data: { whatsappSendMode: 'live' } }, admin);
check('WM2.10 channelConfigUpdate → live OK (conexión resoluble tras carga manual)', live.status === 200, `status=${live.status} err=${live.error?.message ?? ''}`);

// 11) Cancelar: ownerB solicita y cancela la SUYA → 200 cancelled; owner de A no puede cancelar la de B.
const reqB = await callFn('requestWhatsappActivation', {}, ownerB);
const ridB = reqB.result?.requestId;
const crossCancel = await callFn('cancelWhatsappActivationRequest', { tenantId: B, requestId: ridB }, ownerA); // ownerA scoped a A → 404
const cancel = await callFn('cancelWhatsappActivationRequest', { requestId: ridB }, ownerB);
const reqBAfter = ridB ? (await db.doc(`tenants/${B}/whatsappActivationRequests/${ridB}`).get()).data() : null;
check('WM2.11 owner cancela su pending → 200 cancelled; cross-tenant cancel bloqueado (404)',
  cancel.status === 200 && reqBAfter?.status === 'cancelled' && crossCancel.status === 404,
  `cancel=${cancel.status} after=${reqBAfter?.status} cross=${crossCancel.status}`);

// --- Limpieza ---
for (const t of [A, B]) {
  for (const sub of ['whatsappActivationRequests', 'metaAssets', 'metaConnections', 'config', 'auditLogs']) {
    for (const d of (await db.collection(`tenants/${t}/${sub}`).get()).docs) await d.ref.delete().catch(() => {});
  }
  await db.doc(`tenants/${t}`).delete().catch(() => {});
}
for (const d of (await db.collection('metaExternalIndex').where('tenantId', 'in', [A, B]).get()).docs) await d.ref.delete().catch(() => {});
await db.doc(`secrets/meta-token-${A}`).delete().catch(() => {});
await db.doc('metaTestFixtures/graph').delete().catch(() => {});
for (const uid of ephemeralUids) await auth.deleteUser(uid).catch(() => {});

const allOk = results.every((x) => x);
console.log(`\nRESULTADO WM-2 (onboarding manual WhatsApp): ${allOk ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(allOk ? 0 : 1);
