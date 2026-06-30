/**
 * verify-wm1-manual.mjs — WM-1: alta MANUAL de WhatsApp por PLATFORM_ADMIN.
 * Cubre: auth (solo admin), tenant inexistente, validación, escritura del modelo (conexión/asset/índice),
 * token NO legible (cifrado en secrets/), conexión RESOLUBLE (channelConfigUpdate → live), colisión de
 * phone_number_id entre tenants, y limpieza con metaDisconnect.
 *
 * Requiere: build de functions (lib/) + emuladores Firestore/Functions/Auth corriendo, con el MISMO
 * TENANT_SECRETS_ENCRYPTION_KEY en el .env del emulador (para cifrar/descifrar el token). Usuarios
 * seedeados: superadmin@aiafg.com / owner@perfumeria.com / seller@perfumeria.com (password test1234).
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

const A = 'wm1-a';
const B = 'wm1-b';
const PNID = '109876543210987';
const WABA = '100000000000001';
const TOKEN = 'EAAG-wm1-test-token';
const limits = { maxProducts: 100, maxOrdersPerMonth: 999, maxWhatsappMessagesPerMonth: 999, maxDeliveryPersons: 9, maxUsers: 9, maxWhatsappNumbers: 2, maxAdSyncsPerMonth: 9, maxAiTokensPerMonth: 9999 };
const seedTenant = (t) => db.doc(`tenants/${t}`).set({ id: t, name: t, status: 'ACTIVE', planId: 'wm1-plan', limits, subscription: { paymentProvider: 'manual_whatsapp', status: 'active', planId: 'wm1-plan' }, createdAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });

// Fixture de Graph: token válido + scopes requeridos + el phone presente → verify deja 'active'.
await db.doc('metaTestFixtures/graph').set({ isValid: true, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], phoneNumbers: [{ id: PNID, displayPhoneNumber: '+595 99 123 4567', verifiedName: 'WM1', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED' }] });
await seedTenant(A);
await seedTenant(B);

const admin = await signIn('superadmin@aiafg.com');
const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const manager = await mkUser('wm1-mgr@perfumeria.com', 'TENANT_MANAGER', 'perfumeria');
const baseInput = { wabaId: WABA, phoneNumberId: PNID, displayPhoneNumber: '+595 99 123 4567', businessName: 'WM1', accessToken: TOKEN };

// 1) Solo PLATFORM_ADMIN: owner/seller/manager → 403.
const o = await callFn('adminSetManualWhatsappConnection', { tenantId: A, ...baseInput }, owner);
const s = await callFn('adminSetManualWhatsappConnection', { tenantId: A, ...baseInput }, seller);
const m = await callFn('adminSetManualWhatsappConnection', { tenantId: A, ...baseInput }, manager);
check('WM1.1 owner/seller/manager NO pueden → 403', o.status === 403 && s.status === 403 && m.status === 403, `o=${o.status} s=${s.status} m=${m.status}`);

// 2) Tenant inexistente → failed-precondition (400) y no crea doc.
const ghost = `wm1-ghost`;
const g = await callFn('adminSetManualWhatsappConnection', { tenantId: ghost, ...baseInput }, admin);
check('WM1.2 tenant inexistente → 400 y no crea conexión', g.status === 400 && !(await db.doc(`tenants/${ghost}/metaConnections/main`).get()).exists, `status=${g.status}`);

// 3) Validación: phoneNumberId con '+' (no es el id de Meta) → 400.
const bad = await callFn('adminSetManualWhatsappConnection', { tenantId: A, ...baseInput, phoneNumberId: '+595991234567' }, admin);
check('WM1.3 phoneNumberId no numérico → 400', bad.status === 400, `status=${bad.status}`);

// 4) Admin carga válido → 200 + status active (fixture válido).
const ok = await callFn('adminSetManualWhatsappConnection', { tenantId: A, ...baseInput }, admin);
const conn = (await db.doc(`tenants/${A}/metaConnections/main`).get()).data();
check('WM1.4 admin carga → 200, status active, source manual_admin', ok.status === 200 && ok.result?.status === 'active' && conn?.status === 'active' && conn?.source === 'manual_admin', `status=${ok.status} connStatus=${conn?.status} source=${conn?.source}`);

// 5) Token NO en docs legibles: la conexión solo tiene tokenSecretRef (ref), el secreto está cifrado.
const secName = `meta-token-${A}`;
const secret = (await db.doc(`secrets/${secName}`).get()).data();
const connStr = JSON.stringify(conn ?? {});
check('WM1.5 token NO legible: conexión solo tokenSecretRef; secrets/ cifrado (sin el token en claro)',
  typeof conn?.tokenSecretRef === 'string' && conn.tokenSecretRef.startsWith('secret://') && !connStr.includes(TOKEN) && !!secret?.ciphertext && !String(secret.ciphertext).includes(TOKEN),
  `ref=${conn?.tokenSecretRef?.slice(0, 20)}…`);

// 6) Asset whatsapp_phone_number selected + índice global con el tenant.
const asset = (await db.doc(`tenants/${A}/metaAssets/${PNID}`).get()).data();
const idx = (await db.doc(`metaExternalIndex/whatsapp_${PNID}`).get()).data();
check('WM1.6 asset selected (externalId=pnid) + metaExternalIndex/whatsapp_{pnid} → tenant A',
  asset?.assetType === 'whatsapp_phone_number' && asset?.externalId === PNID && asset?.selected === true && idx?.tenantId === A,
  `assetSel=${asset?.selected} idxTenant=${idx?.tenantId}`);

// 7) RESOLUBLE: channelConfigUpdate a 'live' pasa (internamente resuelve creds del tenant).
const live = await callFn('channelConfigUpdate', { tenantId: A, data: { whatsappSendMode: 'live' } }, admin);
check('WM1.7 conexión resoluble: channelConfigUpdate → live OK', live.status === 200, `status=${live.status} err=${live.error?.message ?? ''}`);

// 8) Colisión: cargar el MISMO pnid para otro tenant (B) → 400 y el índice sigue en A.
const collide = await callFn('adminSetManualWhatsappConnection', { tenantId: B, ...baseInput }, admin);
const idxAfter = (await db.doc(`metaExternalIndex/whatsapp_${PNID}`).get()).data();
check('WM1.8 colisión de phone_number_id entre tenants → 400; índice intacto en A',
  collide.status === 400 && /failed-precondition|asignado/i.test(collide.error?.message ?? '') && idxAfter?.tenantId === A,
  `status=${collide.status} idxTenant=${idxAfter?.tenantId}`);

// 9) metaDisconnect limpia la conexión manual (conexión not_connected + assets/índice/secreto borrados).
const disc = await callFn('metaDisconnect', { tenantId: A }, admin);
const connD = (await db.doc(`tenants/${A}/metaConnections/main`).get()).data();
const assetsLeft = (await db.collection(`tenants/${A}/metaAssets`).get()).size;
const idxLeft = (await db.collection('metaExternalIndex').where('tenantId', '==', A).get()).size;
const secLeft = (await db.doc(`secrets/${secName}`).get()).exists;
check('WM1.9 metaDisconnect limpia la conexión manual (not_connected + assets/índice/secreto borrados)',
  disc.status === 200 && connD?.status === 'not_connected' && assetsLeft === 0 && idxLeft === 0 && secLeft === false,
  `discStatus=${connD?.status} assets=${assetsLeft} idx=${idxLeft} secret=${secLeft}`);

// --- Limpieza ---
for (const t of [A, B]) {
  for (const sub of ['metaAssets', 'metaConnections', 'config', 'auditLogs']) for (const d of (await db.collection(`tenants/${t}/${sub}`).get()).docs) await d.ref.delete().catch(() => {});
  await db.doc(`tenants/${t}`).delete().catch(() => {});
}
for (const d of (await db.collection('metaExternalIndex').where('tenantId', 'in', [A, B]).get()).docs) await d.ref.delete().catch(() => {});
await db.doc(`secrets/${secName}`).delete().catch(() => {});
await db.doc('metaTestFixtures/graph').delete().catch(() => {});
for (const uid of ephemeralUids) await auth.deleteUser(uid).catch(() => {});

const allOk = results.every((x) => x);
console.log(`\nRESULTADO WM-1 (alta manual WhatsApp): ${allOk ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(allOk ? 0 : 1);
