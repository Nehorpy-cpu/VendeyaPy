/**
 * Capa de acceso a promociones e insights de promoción (panel · P8).
 *
 * PROMOS: LECTURAS directas (las reglas permiten leer al staff). ESCRITURAS por callables (Fase 5C):
 *   - promotionUpsert (alta/edición; valida whitelist, fechas y status server-side)
 *   - promotionDelete (SOFT: status='FINISHED', conserva historial) — el panel lo muestra como "Finalizar"
 * INSIGHTS (fuera de alcance de 5C-growth): siguen con write directo limitado (status/resolvedAt).
 */

import { collection, doc, getDocs, updateDoc, query, orderBy, where, serverTimestamp } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { Promotion, Insight, PromotionType, PromotionStatus, InsightStatus } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';

const promosCol = (t: string) => collection(firebaseDb(), 'tenants', t, 'promotions');
const insightsCol = (t: string) => collection(firebaseDb(), 'tenants', t, 'insights');

export async function listPromotions(tenantId: string): Promise<Promotion[]> {
  const snap = await getDocs(query(promosCol(tenantId), orderBy('updatedAt', 'desc')));
  // El "borrar" ahora es SOFT (status='FINISHED'); ocultamos finalizadas para que no se vean como activas.
  return snap.docs.map((d) => d.data() as Promotion).filter((p) => p.status !== 'FINISHED');
}

export interface PromotionInput {
  id?: string;
  name: string;
  description: string;
  type: PromotionType;
  discountValue: number;
  objective: string;
  productIds: string[];
  categoryIds: string[];
  startDate: string | null; // yyyy-mm-dd
  endDate: string | null;
  status: PromotionStatus;
}

// yyyy-mm-dd → epoch ms a medianoche LOCAL (mismo instante que guardaba el write directo anterior;
// el callable lo convierte a Timestamp y `tsToDateInput` lo lee de vuelta sin corrimiento de día).
const toMs = (s: string | null) => (s ? new Date(`${s}T00:00:00`).getTime() : null);

type PromotionUpsertResp = { ok: boolean; id: string; created: boolean };

/**
 * Alta/edición de promoción vía callable `promotionUpsert`. El backend valida (whitelist),
 * convierte fechas y setea id/tenantId/createdAt/updatedAt. NO escribe directo a Firestore.
 */
export async function upsertPromotion(tenantId: string, input: PromotionInput): Promise<string> {
  const data = {
    name: input.name,
    description: input.description,
    type: input.type,
    discountValue: input.discountValue,
    objective: input.objective,
    productIds: input.productIds,
    categoryIds: input.categoryIds,
    startDate: toMs(input.startDate),
    endDate: toMs(input.endDate),
    status: input.status,
  };
  const call = httpsCallable<{ tenantId: string; id?: string; data: unknown }, PromotionUpsertResp>(
    firebaseFunctions(),
    'promotionUpsert',
  );
  const res = await call({ tenantId, id: input.id, data });
  return res.data.id;
}

/**
 * "Borrar" vía callable `promotionDelete`. Es SOFT-delete: marca `status='FINISHED'` (conserva
 * historial; no borra el doc). La lista oculta las finalizadas. NO escribe directo a Firestore.
 */
export async function deletePromotion(tenantId: string, id: string): Promise<void> {
  const call = httpsCallable<{ tenantId: string; id: string }, { ok: boolean }>(firebaseFunctions(), 'promotionDelete');
  await call({ tenantId, id });
}

/** Sugerencias de promo PENDIENTES (las descartadas/aceptadas no aparecen). */
export async function listPromoSuggestions(tenantId: string): Promise<Insight[]> {
  const snap = await getDocs(query(insightsCol(tenantId), where('type', '==', 'PROMO_SUGGESTION')));
  return snap.docs.map((d) => d.data() as Insight).filter((i) => i.status === 'PENDING');
}

export async function setInsightStatus(tenantId: string, id: string, status: InsightStatus): Promise<void> {
  await updateDoc(doc(insightsCol(tenantId), id), {
    status,
    resolvedAt: status === 'PENDING' ? null : serverTimestamp(),
  });
}

/** Convierte un Timestamp de Firestore a yyyy-mm-dd para inputs date (o ''). */
export function tsToDateInput(ts: unknown): string {
  try {
    const d = (ts as { toDate?: () => Date } | null)?.toDate?.();
    if (!d) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}
