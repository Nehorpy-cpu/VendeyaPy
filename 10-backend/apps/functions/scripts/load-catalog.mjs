/**
 * load-catalog.mjs — Carga el catálogo al emulador de Firestore
 * =============================================================
 * Toma el seed generado por el importador (70-perfumeria/catalogo/seed-productos.json)
 * y lo escribe en el emulador, en tenants/perfumeria/products/{id}.
 *
 * USO (con el emulador de Firestore corriendo):
 *   node scripts/load-catalog.mjs
 *
 * Requiere FIRESTORE_EMULATOR_HOST (por defecto 127.0.0.1:8080).
 * NUNCA escribe en producción: usa el projectId "demo-aiafg" del emulador.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const DIR = dirname(fileURLToPath(import.meta.url));
const TENANT_ID = 'perfumeria';

// Seguridad: solo emulador. Si no está la variable, la seteamos al default local.
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';

const seedPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(DIR, '../../../../70-perfumeria/catalogo/seed-productos.json');

let productos;
try {
  productos = JSON.parse(readFileSync(seedPath, 'utf-8'));
} catch {
  console.error(`❌ No se encontró el seed: ${seedPath}`);
  console.error('   Generalo primero: cd 70-perfumeria/catalogo && node import-catalogo.mjs');
  process.exit(1);
}

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const now = Timestamp.now();

console.log(`\n═══════════════════════════════════════════`);
console.log(`  CARGA DE CATÁLOGO → emulador Firestore`);
console.log(`  Host: ${process.env.FIRESTORE_EMULATOR_HOST}`);
console.log(`═══════════════════════════════════════════`);

// 1. Documento del tenant (mínimo)
await db.doc(`tenants/${TENANT_ID}`).set(
  { name: 'Perfumería AFG', slug: TENANT_ID, status: 'ACTIVE', updatedAt: now },
  { merge: true },
);

// 2. Categoría perfumes
await db.doc(`tenants/${TENANT_ID}/categories/perfumes`).set(
  { id: 'perfumes', tenantId: TENANT_ID, name: 'Perfumes', emoji: '🌸', isActive: true, position: 0, createdAt: now, updatedAt: now },
  { merge: true },
);

// 3. Productos (batch)
const batch = db.batch();
for (const p of productos) {
  const ref = db.doc(`tenants/${TENANT_ID}/products/${p.id}`);
  batch.set(ref, { ...p, createdAt: now, updatedAt: now });
}
await batch.commit();

// 4. Verificar leyendo de vuelta
const snap = await db.collection(`tenants/${TENANT_ID}/products`).get();
console.log(`✅ Productos en la base: ${snap.size}`);
snap.forEach((d) => {
  const p = d.data();
  console.log(`   • ${p.name} (${p.perfume?.brand}) — ₲ ${Number(p.price).toLocaleString('es-PY')} [${p.perfume?.priceRange}]`);
});
console.log(`\n🌐 Vela en la UI: http://127.0.0.1:4000/firestore\n`);
process.exit(0);
