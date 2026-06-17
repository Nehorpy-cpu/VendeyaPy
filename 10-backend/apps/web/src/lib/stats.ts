/**
 * Lectura de agregados precalculados para el dashboard (P7).
 * La UI lee 1-2 documentos ya listos en vez de recorrer todos los pedidos.
 *   stats/public  → no sensible (lo ve el vendedor)
 *   stats/private → ganancia/margen (solo Owner/Manager; el vendedor recibe 403)
 */

import { doc, getDoc } from 'firebase/firestore';
import type { TenantStatsPublic, TenantStatsPrivate } from '@vpw/shared';
import { firebaseDb } from './firebase';

export async function getStatsPublic(tenantId: string): Promise<TenantStatsPublic | null> {
  const snap = await getDoc(doc(firebaseDb(), 'tenants', tenantId, 'stats', 'public'));
  return snap.exists() ? (snap.data() as TenantStatsPublic) : null;
}

export async function getStatsPrivate(tenantId: string): Promise<TenantStatsPrivate | null> {
  const snap = await getDoc(doc(firebaseDb(), 'tenants', tenantId, 'stats', 'private'));
  return snap.exists() ? (snap.data() as TenantStatsPrivate) : null;
}
