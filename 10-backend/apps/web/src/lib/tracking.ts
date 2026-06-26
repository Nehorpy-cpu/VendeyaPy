/**
 * Capa de acceso al tracking propio (panel · P11). Códigos/cupones que, al
 * mencionarlos el cliente, atribuyen la venta a una promo propia (sin Meta).
 *
 * LECTURAS directas (las reglas permiten leer al staff). ESCRITURAS por callables (Fase 5C):
 *   - trackingSourceUpsert (alta/edición; el backend NORMALIZA y valida el `code`)
 *   - trackingSourceDelete (SOFT: active=false, conserva el rollup) — el panel lo muestra como "Desactivar"
 */

import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { TrackingSource, TrackingType } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';
import { runTenantJob } from './entitlements';

const col = (t: string) => collection(firebaseDb(), 'tenants', t, 'trackingSources');

export async function listTrackingSources(tenantId: string): Promise<TrackingSource[]> {
  const snap = await getDocs(query(col(tenantId), orderBy('createdAt', 'desc')));
  // El "borrar" ahora es SOFT (active=false); ocultamos los inactivos para que no se vean como activos.
  return snap.docs.map((d) => d.data() as TrackingSource).filter((s) => s.active !== false);
}

export interface TrackingInput {
  id?: string;
  name: string;
  code: string;
  type: TrackingType;
  active: boolean;
}

type TrackingUpsertResp = { ok: boolean; id: string; created: boolean };

/**
 * Alta/edición vía callable `trackingSourceUpsert`. El backend valida y NORMALIZA el `code`
 * (trim + UPPERCASE + formato ^[A-Z0-9_-]{2,32}$); el frontend ya NO normaliza. NO escribe directo.
 */
export async function upsertTrackingSource(tenantId: string, input: TrackingInput): Promise<string> {
  const data = { name: input.name, code: input.code, type: input.type, active: input.active };
  const call = httpsCallable<{ tenantId: string; id?: string; data: unknown }, TrackingUpsertResp>(
    firebaseFunctions(),
    'trackingSourceUpsert',
  );
  const res = await call({ tenantId, id: input.id, data });
  return res.data.id;
}

/**
 * "Desactivar" vía callable `trackingSourceDelete`. Es SOFT-delete: marca `active=false` (conserva el
 * rollup de atribución; no borra el doc). La lista oculta los inactivos. NO escribe directo a Firestore.
 */
export async function deleteTrackingSource(tenantId: string, id: string): Promise<void> {
  const call = httpsCallable<{ tenantId: string; id: string }, { ok: boolean }>(firebaseFunctions(), 'trackingSourceDelete');
  await call({ tenantId, id });
}

/** Recalcula el rollup de atribución por código vía el callable real (acción `computeTracking`). */
export async function computeTracking(tenantId: string): Promise<void> {
  await runTenantJob('computeTracking', tenantId);
}
