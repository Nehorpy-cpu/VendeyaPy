#!/usr/bin/env node
/**
 * bootstrap-platform-admin.mjs — Provisiona/verifica un PLATFORM_ADMIN REAL en un proyecto Firebase.
 * =====================================================================================================
 * Setea EXACTAMENTE el custom claim { role: 'PLATFORM_ADMIN' } (SIN tenantId) sobre un usuario de Auth.
 * Es la vía de bootstrap del primer admin (el callable setUserRole exige un admin previo → huevo/gallina).
 *
 * NO usa seed-users, NO crea tenants, NO toca Firestore/billing/rules/functions/hosting, NO guarda ni
 * imprime contraseñas ni secretos. Opera SOLO contra el proyecto real indicado (NUNCA el emulador).
 *
 * USO:
 *   node apps/functions/scripts/bootstrap-platform-admin.mjs --project=vpw-staging --email=<email>
 *     --create        crea el usuario si no existe (sin contraseña; el admin la setea por "restablecer
 *                     contraseña"). Sin este flag, si el usuario no existe, se DETIENE y pide crearlo en Console.
 *     --verify-only   solo lee y verifica claims; no escribe nada.
 *     --allow-prod    confirma INTENCIONALMENTE un proyecto de producción (nombre con 'prod'); sin esto
 *                     el script rechaza prod para evitar accidentes.
 *
 * CREDENCIALES (Admin SDK): ADC o service account vía GOOGLE_APPLICATION_CREDENTIALS apuntando al JSON
 *   del proyecto (Firebase Console → Project settings → Service accounts → Generate new private key).
 *   El script nunca imprime ni persiste esa credencial.
 *
 * GUARDAS DE SEGURIDAD:
 *   - Exige --project explícito (sin default → no se corre contra el proyecto equivocado por accidente).
 *   - RECHAZA cualquier proyecto que parezca producción (nombre con 'prod') salvo --allow-prod explícito.
 *   - RECHAZA correr si hay env de EMULADOR seteado (FIRESTORE/AUTH_EMULATOR_HOST…): este script es
 *     REAL-only; para el emulador usá seed-users.mjs. Así es imposible tocar el emulador por accidente
 *     cuando se pide un proyecto real, y viceversa (no arranca sin credenciales reales).
 */
import process from 'node:process';

// -------- args --------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const project = String(args.project || process.env.ADMIN_BOOTSTRAP_PROJECT || '').trim();
const email = String(args.email || process.env.ADMIN_EMAIL || '').trim();
const doCreate = args.create === true;
const verifyOnly = args['verify-only'] === true;

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// -------- validación de args + guardas --------
if (!project) die('Falta --project (ej. --project=vpw-staging). Sin default a propósito, para no correr contra el proyecto equivocado.');
// PROD bloqueado por defecto (evita accidentes). Para un bootstrap INTENCIONAL de prod, pasá --allow-prod.
if (/prod/i.test(project) && args['allow-prod'] !== true) {
  die(`El proyecto "${project}" parece PRODUCCIÓN. Pasá --allow-prod para confirmar intencionalmente el bootstrap del admin de prod.`);
}
if (!email) die('Falta --email (o ADMIN_EMAIL).');
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die(`Email inválido: "${email}".`);

// GUARDA emulador: un proyecto REAL nunca debe correr con env de emulador seteado.
const emuVars = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']
  .filter((v) => process.env[v]);
if (emuVars.length) {
  die(`Hay variables de EMULADOR seteadas (${emuVars.join(', ')}). Abortando: este script opera SOLO contra el proyecto real "${project}". Para el emulador usá seed-users.mjs.`);
}

// -------- init Admin SDK (ADC / service account; NUNCA emulador) --------
const { initializeApp, applicationDefault, getApps } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');

let app;
try {
  app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId: project });
} catch (e) {
  die(credHint(e));
}
const auth = getAuth(app);

function credHint(e) {
  return `No se pudo inicializar el Admin SDK para "${project}": ${e?.message || e}\n` +
    `  → Proveé credenciales del Admin SDK del proyecto:\n` +
    `     GOOGLE_APPLICATION_CREDENTIALS=<ruta al service-account.json de ${project}>\n` +
    `     (Firebase Console → Project settings → Service accounts → Generate new private key).`;
}
const isCredError = (e) =>
  /credential|could not load the default|GOOGLE_APPLICATION_CREDENTIALS|unauthenticated|permission_denied|invalid_grant|failed to determine project/i
    .test(String(e?.message || e));

async function main() {
  console.log(`→ Proyecto: ${project}  |  email: ${email}  |  modo: ${verifyOnly ? 'verify-only' : doCreate ? 'set+create' : 'set'}`);

  // -------- buscar usuario --------
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch (e) {
    if (isCredError(e)) die(credHint(e));
    if (e.code === 'auth/user-not-found') {
      if (verifyOnly) die(`El usuario ${email} no existe en ${project} (verify-only, no se crea).`);
      if (!doCreate) {
        die(
          `El usuario ${email} NO existe en ${project}.\n` +
          `  → Opción A: crealo en Firebase Console (Authentication → Users → Add user) con su contraseña, y reintentá.\n` +
          `  → Opción B: reintentá con --create (lo crea SIN contraseña, emailVerified=true; el admin la setea por "restablecer contraseña"). No se imprime ninguna contraseña.`,
        );
      }
      user = await auth.createUser({ email, emailVerified: true, disabled: false });
      console.log(`+ usuario creado (uid=${user.uid}). Sin contraseña: enviá "restablecer contraseña" desde la app/Console para que el admin la defina.`);
    } else {
      die(`Error buscando el usuario: ${e.message}`);
    }
  }

  // -------- setear claims EXACTOS (idempotente) --------
  const current = user.customClaims || {};
  if (!verifyOnly) {
    const alreadyOk = current.role === 'PLATFORM_ADMIN' && current.tenantId === undefined;
    if (alreadyOk) {
      console.log('= claims ya correctos (role=PLATFORM_ADMIN, sin tenantId) — no se reescribe.');
    } else {
      // EXACTO: solo role. Nada de tenantId (un admin de plataforma no pertenece a una empresa).
      await auth.setCustomUserClaims(user.uid, { role: 'PLATFORM_ADMIN' });
      console.log('+ claims seteados: { role: "PLATFORM_ADMIN" }');
    }
  }

  // -------- verificar (re-leer del server) --------
  const fresh = await auth.getUser(user.uid);
  const claims = fresh.customClaims || {};
  const hasTenant = Object.prototype.hasOwnProperty.call(claims, 'tenantId');
  const ok = claims.role === 'PLATFORM_ADMIN' && !hasTenant && fresh.disabled === false;
  console.log('\n--- verificación ---');
  console.log(`  project   : ${project}`);
  console.log(`  email     : ${fresh.email}`);
  console.log(`  uid       : ${fresh.uid}`);
  console.log(`  claims    : ${JSON.stringify(claims)}`);
  console.log(`  tenantId  : ${hasTenant ? claims.tenantId + '  ✗ (no debería existir)' : '(ausente ✓)'}`);
  console.log(`  disabled  : ${fresh.disabled}`);
  console.log(ok ? '\n✅ PLATFORM_ADMIN OK' : '\n✗ verificación FALLÓ');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => die(isCredError(e) ? credHint(e) : (e?.message || String(e))));
