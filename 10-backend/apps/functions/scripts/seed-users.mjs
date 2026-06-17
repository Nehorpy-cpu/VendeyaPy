/**
 * seed-users.mjs — Crea usuarios de prueba en el emulador de Auth (P1.2)
 * ======================================================================
 * Crea 3 usuarios con custom claims { tenantId, role } para probar el panel:
 *   superadmin@aiafg.com    → PLATFORM_ADMIN (sin tenant)
 *   owner@perfumeria.com    → TENANT_OWNER (tenantId: perfumeria)
 *   seller@perfumeria.com   → SELLER (tenantId: perfumeria)
 * Contraseña para todos: test1234
 *
 * También crea un doc users/{uid} en Firestore y una 2ª empresa demo para
 * que el selector del Super Admin tenga más de una opción.
 *
 * USO (con emuladores auth+firestore corriendo):
 *   node scripts/seed-users.mjs
 */

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';

initializeApp({ projectId: 'demo-aiafg' });
const auth = getAuth();
const db = getFirestore();

const PASSWORD = 'test1234';
const USERS = [
  { email: 'superadmin@aiafg.com', name: 'Marco (Super Admin)', role: 'PLATFORM_ADMIN', tenantId: null },
  { email: 'owner@perfumeria.com', name: 'Dueña Perfumería', role: 'TENANT_OWNER', tenantId: 'perfumeria' },
  { email: 'seller@perfumeria.com', name: 'Vendedora', role: 'SELLER', tenantId: 'perfumeria' },
];

async function upsertUser(u) {
  let user;
  try {
    user = await auth.getUserByEmail(u.email);
  } catch {
    user = await auth.createUser({ email: u.email, password: PASSWORD, displayName: u.name });
  }
  const claims = { role: u.role };
  if (u.tenantId) claims.tenantId = u.tenantId;
  await auth.setCustomUserClaims(user.uid, claims);
  await db.doc(`users/${user.uid}`).set(
    { id: user.uid, email: u.email, name: u.name, role: u.role, tenantId: u.tenantId, status: 'ACTIVE', updatedAt: Timestamp.now() },
    { merge: true },
  );
  return user.uid;
}

async function main() {
  const now = Timestamp.now();
  // Asegurar empresas (tenants) para el selector del Super Admin
  await db.doc('tenants/perfumeria').set({ name: 'Perfumería AFG', slug: 'perfumeria', status: 'ACTIVE', updatedAt: now }, { merge: true });
  await db.doc('tenants/boutique-demo').set({ name: 'Boutique Demo', slug: 'boutique-demo', status: 'ACTIVE', updatedAt: now }, { merge: true });

  console.log('\n═══════════════════════════════════════════');
  console.log('  SEED DE USUARIOS → emulador de Auth');
  console.log('═══════════════════════════════════════════');
  for (const u of USERS) {
    const uid = await upsertUser(u);
    console.log(`✅ ${u.email}  [${u.role}${u.tenantId ? ' · ' + u.tenantId : ''}]  uid=${uid.slice(0, 8)}…`);
  }
  console.log(`\nContraseña para todos: ${PASSWORD}`);
  console.log('Empresas: perfumeria, boutique-demo');
  console.log('═══════════════════════════════════════════\n');
  process.exit(0);
}

main().catch((e) => { console.error('❌ Error en seed-users:', e); process.exit(1); });
