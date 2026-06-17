/**
 * catalog/financials.ts — Lectura del costo privado de un producto (P6)
 * ====================================================================
 * El costo vive en tenants/{t}/productFinancials/{id} (privado, ADR-0008).
 * Solo Cloud Functions (Admin SDK) y Owner/Manager lo leen; el vendedor no.
 */

import type { ProductFinancials } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';

/** Costo unitario de un producto (null si no se cargó). */
export async function getProductCost(tenantId: string, productId: string): Promise<number | null> {
  const snap = await db().doc(paths.productFinancial(tenantId, productId)).get();
  return snap.exists ? ((snap.data() as ProductFinancials).costPrice ?? null) : null;
}
