/**
 * customerSearch — Callable del panel: búsqueda server-side de clientes (ADR-0021 §4)
 * ====================================================================================
 * Para el modal de vínculo conversación↔cliente. Cualquier staff del tenant (staffAuth valida la
 * membresía: el tenantId del navegador JAMÁS se toma sin verificar claims). Prefijo de nombre y
 * —si la query es numérica— de teléfono, con límite clampeado y cursor opaco; softDeleted
 * excluidos. Solo lectura ⇒ sin audit. Núcleo en conversation/linking.ts.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { searchCustomers } from '../../conversation/linking.js';
import { db } from '../../lib/firebase.js';
import { assertStaffAccess } from './staffAuth.js';

interface SearchData {
  tenantId?: string;
  query?: string;
  limit?: number;
  cursor?: string;
}

export const customerSearch = onCall<SearchData>({ region: 'us-central1' }, async (req) => {
  const { tenantId, query, limit, cursor } = req.data ?? {};
  if (!tenantId || typeof query !== 'string') {
    throw new HttpsError('invalid-argument', 'Faltan tenantId o query.');
  }
  assertStaffAccess(req.auth, tenantId);
  return searchCustomers(db(), {
    tenantId,
    query,
    ...(typeof limit === 'number' ? { limit } : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
  });
});
