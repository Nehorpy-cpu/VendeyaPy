#!/usr/bin/env node
/**
 * verify-wm2-staging-owner.mjs — Smoke LOGUEADO del flujo owner de activación manual de WhatsApp (WM-2)
 * ======================================================================================================
 * Corre en Cloud Shell (Admin SDK / ADC) contra un proyecto REAL (staging). Crea un owner + tenant
 * TEMPORALES, ejecuta el flujo real (owner solicita → pending → admin lista → owner cancela) contra las
 * callables desplegadas, y LIMPIA TODO en un finally (borra solicitud, subcolecciones, tenant y usuario;
 * barre restos wm2-smoke-*). Cubre los checks 5/6/7 del smoke sin tokens reales ni contraseñas.
 *
 * NO usa accessToken real, NO toca Meta real, NO imprime contraseñas ni tokens, NO toca producción.
 * La sesión del owner se obtiene SIN contraseña: Admin SDK firma un custom token → se canjea por idToken
 * (que lleva los custom claims { role, tenantId }) → se invocan las callables como ese owner.
 *
 * USO (Cloud Shell, con ADC del proyecto):
 *   node verify-wm2-staging-owner.mjs --project=vpw-staging
 *     [--api-key=<clave web pública>]      # si no, se autodescubre por la Firebase Management API (ADC)
 *     [--admin-email=<email admin>]        # opcional: chequeo EXTRA de la regla collectionGroup como admin
 *     [--keep]                             # NO limpiar al final (debug); por defecto limpia TODO
 *
 * GUARDAS: exige --project; rechaza proyectos 'prod'; aborta si hay env de EMULADOR seteado (real-only).
 */
import process from 'node:process';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(2); };

const project = String(args.project || process.env.SMOKE_PROJECT || '').trim();
const keep = args.keep === true;
const adminEmail = String(args['admin-email'] || process.env.ADMIN_EMAIL || '').trim();

if (!project) die('Falta --project (ej. --project=vpw-staging). Sin default para no correr contra el proyecto equivocado.');
if (/prod/i.test(project)) die(`El proyecto "${project}" parece PRODUCCIÓN. Este smoke NO opera sobre prod.`);
const emu = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB'].filter((v) => process.env[v]);
if (emu.length) die(`Hay env de EMULADOR seteado (${emu.join(', ')}). Abortando: este smoke opera SOLO contra el proyecto real "${project}".`);

// -------- init Admin SDK (ADC; NUNCA emulador) --------
const { initializeApp, applicationDefault, getApps } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
const { getFirestore, FieldPath, Timestamp } = await import('firebase-admin/firestore');

// serviceAccountId: necesario para firmar custom tokens con ADC (user creds de Cloud Shell) vía IAM
// signBlob. Con un service-account KEY (GOOGLE_APPLICATION_CREDENTIALS) se firma local y esto se ignora.
const saId = String(args['service-account'] || process.env.SERVICE_ACCOUNT || `${project}@appspot.gserviceaccount.com`).trim();
let app;
try { app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId: project, serviceAccountId: saId }); }
catch (e) { die(`No se pudo inicializar el Admin SDK para "${project}" (ADC/service account): ${e?.message || e}`); }
const signHint = (e) => /determine service account|signBlob|iam\.serviceAccounts|iamcredentials|permission|token creator/i.test(String(e?.message || e))
  ? `\n  ↳ Para firmar el custom token con ADC hace falta, una sola vez:\n` +
    `     gcloud services enable iamcredentials.googleapis.com --project ${project}\n` +
    `     gcloud iam service-accounts add-iam-policy-binding ${saId} --project ${project} \\\n` +
    `       --member="user:$(gcloud config get-value account)" --role="roles/iam.serviceAccountTokenCreator"\n` +
    `     (o corré con un service-account KEY: GOOGLE_APPLICATION_CREDENTIALS=<key.json> — firma local, sin IAM).`
  : '';
const auth = getAuth(app);
const db = getFirestore(app);
const BASE = `https://us-central1-${project}.cloudfunctions.net`;

// -------- helpers --------
const results = [];
const check = (n, cond, extra = '') => { results.push(!!cond); console.log(`${cond ? '✅' : '❌'} ${n}${extra ? '  — ' + extra : ''}`); return !!cond; };

async function resolveWebApiKey() {
  const explicit = String(args['api-key'] || process.env.WEB_API_KEY || '').trim();
  if (explicit) return explicit;
  // Autodescubrir la clave web PÚBLICA vía Firebase Management API (ADC). No es secreta.
  const { GoogleAuth } = await import('google-auth-library');
  const gauth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await gauth.getClient();
  const at = (await client.getAccessToken()).token;
  const hdr = { Authorization: `Bearer ${at}` };
  const list = await (await fetch(`https://firebase.googleapis.com/v1beta1/projects/${project}/webApps`, { headers: hdr })).json();
  const app0 = (list.apps || [])[0];
  if (!app0) throw new Error('No hay web apps en el proyecto; pasá --api-key=<clave web>.');
  const cfg = await (await fetch(`https://firebase.googleapis.com/v1beta1/${app0.name}/config`, { headers: hdr })).json();
  if (!cfg.apiKey) throw new Error('No se pudo leer apiKey de la web app; pasá --api-key.');
  return cfg.apiKey;
}

async function signInWithCustomToken(customToken, apiKey) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!j.idToken) throw new Error('signInWithCustomToken falló (¿claims/identity platform?).');
  return j.idToken;
}
function decodeClaims(idToken) {
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
  return { role: payload.role, tenantId: payload.tenantId };
}
async function callAs(fn, data, idToken) {
  const r = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data }) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, result: j.result, error: j.error };
}

// -------- IDs temporales (script node normal → Date.now() OK) --------
const ts = Date.now();
const TENANT = `wm2-smoke-${ts}`;
const OWNER_EMAIL = `wm2-smoke-owner-${ts}@example.test`;
const created = { tenant: false, ownerUid: null, requestId: null };

console.log(`→ Proyecto: ${project}  |  tenant temporal: ${TENANT}  |  owner temporal: ${OWNER_EMAIL}\n`);

try {
  const apiKey = await resolveWebApiKey();

  // 5) doc tenant mínimo (requestWhatsappActivation exige que la empresa exista).
  await db.doc(`tenants/${TENANT}`).set({ id: TENANT, name: `WM2 Smoke ${ts}`, status: 'ACTIVE', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), _smoke: true }, { merge: true });
  created.tenant = true;
  check('setup: tenant temporal creado', (await db.doc(`tenants/${TENANT}`).get()).exists);

  // owner temporal SIN contraseña + claims EXACTOS { role:'TENANT_OWNER', tenantId:TENANT }.
  const owner = await auth.createUser({ email: OWNER_EMAIL, emailVerified: true, disabled: false });
  created.ownerUid = owner.uid;
  await auth.setCustomUserClaims(owner.uid, { role: 'TENANT_OWNER', tenantId: TENANT });
  check('setup: owner temporal creado + claims { TENANT_OWNER, tenantId } seteados', true, `uid=${owner.uid}`);

  // sesión del owner SIN password (custom token → idToken con claims).
  const ownerIdToken = await signInWithCustomToken(await auth.createCustomToken(owner.uid), apiKey);
  const oc = decodeClaims(ownerIdToken);
  check('setup: idToken del owner lleva claims correctos', oc.role === 'TENANT_OWNER' && oc.tenantId === TENANT, `role=${oc.role} tenantId=${oc.tenantId}`);

  // === CHECK 5: owner llama requestWhatsappActivation → 200 ===
  const req = await callAs('requestWhatsappActivation', { note: 'smoke WM-2 (temporal)', contactPhone: '+595 99 000 000' }, ownerIdToken);
  created.requestId = req.result?.requestId ?? null;
  check('CHECK 5: owner solicita activación → 200 + requestId', req.status === 200 && !!created.requestId && req.result?.status === 'pending', `status=${req.status} id=${created.requestId}`);

  // === CHECK 6/8: existe solicitud pending y NO tiene token/secret ===
  let reqDoc = null;
  if (created.requestId) reqDoc = (await db.doc(`tenants/${TENANT}/whatsappActivationRequests/${created.requestId}`).get()).data();
  const noToken = reqDoc != null && !/token|secret|accessToken/i.test(JSON.stringify(reqDoc));
  check('CHECK 6/8: solicitud PENDING en Firestore y SIN token/secret', reqDoc?.status === 'pending' && noToken, reqDoc ? `keys=${Object.keys(reqDoc).join(',')}` : 'sin doc');

  // === CHECK 7/9: el admin puede listarla vía collectionGroup (query igual al panel admin) ===
  let listedViaAdminSdk = false;
  try {
    const snap = await db.collectionGroup('whatsappActivationRequests').where('status', '==', 'pending').orderBy('requestedAt', 'desc').limit(50).get();
    listedViaAdminSdk = snap.docs.some((d) => d.id === created.requestId && d.get('tenantId') === TENANT);
  } catch (e) {
    console.log(`   (collectionGroup Admin SDK falló: ${String(e?.message || e).slice(0, 120)} — ¿índice construyéndose?)`);
  }
  check('CHECK 7: solicitud listable por collectionGroup (query del panel admin)', listedViaAdminSdk);

  // Extra opcional: valida la REGLA con una sesión admin real (no bypassa rules).
  if (adminEmail) {
    try {
      const adminU = await auth.getUserByEmail(adminEmail);
      const adminTok = await signInWithCustomToken(await auth.createCustomToken(adminU.uid), apiKey);
      const q = {
        structuredQuery: {
          from: [{ collectionId: 'whatsappActivationRequests', allDescendants: true }],
          where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'pending' } } },
          orderBy: [{ field: { fieldPath: 'requestedAt' }, direction: 'DESCENDING' }],
          limit: 50,
        },
      };
      const rr = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:runQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` }, body: JSON.stringify(q),
      });
      const rows = await rr.json();
      const found = Array.isArray(rows) && rows.some((x) => x.document?.name?.endsWith(`/whatsappActivationRequests/${created.requestId}`));
      check('CHECK 9 (extra): el ADMIN la lee vía collectionGroup con su sesión (regla isPlatformAdmin)', rr.status === 200 && found, `http=${rr.status}`);
    } catch (e) {
      console.log(`   (chequeo admin-session omitido: ${String(e?.message || e).slice(0, 120)})`);
    }
  }

  // === Paso 10: el owner CANCELA su solicitud (path real) → estado limpiable ===
  if (created.requestId) {
    const cancel = await callAs('cancelWhatsappActivationRequest', { requestId: created.requestId }, ownerIdToken);
    const after = (await db.doc(`tenants/${TENANT}/whatsappActivationRequests/${created.requestId}`).get()).data();
    check('paso 10: owner cancela su solicitud → 200 cancelled', cancel.status === 200 && after?.status === 'cancelled', `status=${cancel.status} doc=${after?.status}`);
  }
} catch (e) {
  console.error(`\n✗ Error en el smoke: ${e?.message || e}${signHint(e)}`);
  results.push(false);
} finally {
  // ============ LIMPIEZA TOTAL (siempre) ============
  if (keep) {
    console.log(`\n⚠ --keep: NO se limpió. Quedó tenant ${TENANT} + user ${created.ownerUid ?? '?'} (borralos a mano).`);
  } else {
    console.log('\n--- limpieza ---');
    // 1) tenant + TODAS sus subcolecciones (whatsappActivationRequests, auditLogs, etc.)
    try { await db.recursiveDelete(db.doc(`tenants/${TENANT}`)); console.log(`  ✓ borrado tenant + subcolecciones: ${TENANT}`); }
    catch (e) { console.log(`  ✗ no se pudo borrar tenant ${TENANT}: ${e?.message || e}`); }
    // 2) usuario owner temporal
    if (created.ownerUid) {
      try { await auth.deleteUser(created.ownerUid); console.log(`  ✓ borrado usuario owner: ${OWNER_EMAIL}`); }
      catch (e) { console.log(`  ✗ no se pudo borrar usuario ${OWNER_EMAIL}: ${e?.message || e}`); }
    }
    // 3) barrido defensivo de restos wm2-smoke-* (tenants + usuarios) de corridas previas/fallidas
    try {
      const leftovers = await db.collection('tenants')
        .where(FieldPath.documentId(), '>=', 'wm2-smoke-')
        .where(FieldPath.documentId(), '<', 'wm2-smoke-').get();
      for (const d of leftovers.docs) { await db.recursiveDelete(d.ref); console.log(`  ✓ barrido tenant residual: ${d.id}`); }
    } catch (e) { console.log(`  (barrido tenants: ${String(e?.message || e).slice(0, 100)})`); }
    try {
      const list = await auth.listUsers(1000);
      for (const u of list.users) {
        if (u.email && u.email.startsWith('wm2-smoke-owner-')) { await auth.deleteUser(u.uid); console.log(`  ✓ barrido usuario residual: ${u.email}`); }
      }
    } catch (e) { console.log(`  (barrido usuarios: ${String(e?.message || e).slice(0, 100)})`); }
    // 4) confirmar que no queda nada
    const gone = !(await db.doc(`tenants/${TENANT}`).get()).exists;
    let userGone = true;
    try { if (created.ownerUid) { await auth.getUser(created.ownerUid); userGone = false; } } catch { userGone = true; }
    check('limpieza: no queda tenant ni usuario temporal (wm2-smoke-*)', gone && userGone, `tenantGone=${gone} userGone=${userGone}`);
  }
}

// -------- reporte --------
const ok = results.length > 0 && results.every(Boolean);
console.log(`\n=== RESUMEN ===`);
console.log(`  creado (temporal): tenant=${TENANT} · owner=${OWNER_EMAIL} · requestId=${created.requestId ?? '(ninguno)'}`);
console.log(`  limpieza: ${keep ? 'OMITIDA (--keep)' : 'ejecutada'}`);
console.log(`\nRESULTADO WM-2 owner smoke (${project}): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
console.log('Revisá logs aparte: firebase functions:log --project ' + project + '  (sin crashes / sin tokens / sin datos sensibles)');
process.exit(ok ? 0 : 1);
