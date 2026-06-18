/**
 * Capa de acceso al tracking propio (panel · P11). Códigos/cupones que, al
 * mencionarlos el cliente, atribuyen la venta a una promo propia (sin Meta).
 */

import { collection, doc, getDocs, setDoc, deleteDoc, query, orderBy, serverTimestamp } from 'firebase/firestore';
import type { TrackingSource, TrackingType } from '@vpw/shared';
import { firebaseDb } from './firebase';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:5001/demo-aiafg/us-central1';
const col = (t: string) => collection(firebaseDb(), 'tenants', t, 'trackingSources');

export async function listTrackingSources(tenantId: string): Promise<TrackingSource[]> {
  const snap = await getDocs(query(col(tenantId), orderBy('createdAt', 'desc')));
  return snap.docs.map((d) => d.data() as TrackingSource);
}

export interface TrackingInput {
  id?: string;
  name: string;
  code: string;
  type: TrackingType;
  active: boolean;
}

export async function upsertTrackingSource(tenantId: string, input: TrackingInput): Promise<string> {
  const id = input.id ?? doc(col(tenantId)).id;
  await setDoc(
    doc(col(tenantId), id),
    { id, tenantId, name: input.name, code: input.code.trim().toUpperCase(), type: input.type, active: input.active, updatedAt: serverTimestamp(), ...(input.id ? {} : { createdAt: serverTimestamp() }) },
    { merge: true },
  );
  return id;
}

export async function deleteTrackingSource(tenantId: string, id: string): Promise<void> {
  await deleteDoc(doc(col(tenantId), id));
}

export async function computeTracking(tenantId: string): Promise<void> {
  await fetch(`${API}/devComputeTracking`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId }) });
}
