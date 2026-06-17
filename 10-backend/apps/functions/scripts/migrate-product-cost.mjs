/**
 * migrate-product-cost.mjs — Migración P6: saca costPrice de productos viejos
 * ===========================================================================
 * Para productos creados ANTES de la P6 que todavía tienen `costPrice` dentro del
 * documento (legible por el vendedor): mueve el costo a productFinancials/{id} y
 * BORRA el campo costPrice del producto. Idempotente. Ver ADR-0008.
 *
 * USO (emulador):  node scripts/migrate-product-cost.mjs [tenantId]
 * En producción se corre una vez por empresa con credenciales Admin (sin emulador).
 */
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.GCLOUD_PROJECT ??= 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const TENANT = process.argv[2] || 'perfumeria';

const snap = await db.collection(`tenants/${TENANT}/products`).get();
let moved = 0;
for (const d of snap.docs) {
  const data = d.data();
  if (!('costPrice' in data)) continue; // ya migrado
  const costPrice = data.costPrice ?? null;
  await db.doc(`tenants/${TENANT}/productFinancials/${d.id}`).set(
    { productId: d.id, tenantId: TENANT, costPrice, updatedAt: Timestamp.now() },
    { merge: true },
  );
  await d.ref.update({ costPrice: FieldValue.delete() });
  moved++;
  console.log(`  • ${data.name ?? d.id}: costo ${costPrice ?? '—'} → productFinancials`);
}
console.log(`\n✅ Migración tenant "${TENANT}": ${moved} producto(s) migrado(s).`);
process.exit(0);
