/**
 * Capa de acceso a promociones e insights de promoción (panel · P8).
 * Promos: las edita el Owner/Manager. Insights: solo lectura + cambiar status
 * (aceptar/descartar). Las reglas validan permisos del lado servidor.
 */

import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  updateDoc,
  query,
  orderBy,
  where,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import type { Promotion, Insight, PromotionType, PromotionStatus, InsightStatus } from '@vpw/shared';
import { firebaseDb } from './firebase';

const promosCol = (t: string) => collection(firebaseDb(), 'tenants', t, 'promotions');
const insightsCol = (t: string) => collection(firebaseDb(), 'tenants', t, 'insights');

export async function listPromotions(tenantId: string): Promise<Promotion[]> {
  const snap = await getDocs(query(promosCol(tenantId), orderBy('updatedAt', 'desc')));
  return snap.docs.map((d) => d.data() as Promotion);
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

const toTs = (s: string | null) => (s ? Timestamp.fromDate(new Date(`${s}T00:00:00`)) : null);

export async function upsertPromotion(tenantId: string, input: PromotionInput): Promise<string> {
  const id = input.id ?? doc(promosCol(tenantId)).id;
  await setDoc(
    doc(promosCol(tenantId), id),
    {
      id,
      tenantId,
      name: input.name,
      description: input.description,
      type: input.type,
      discountValue: input.discountValue,
      objective: input.objective,
      productIds: input.productIds,
      categoryIds: input.categoryIds,
      startDate: toTs(input.startDate),
      endDate: toTs(input.endDate),
      status: input.status,
      updatedAt: serverTimestamp(),
      ...(input.id ? {} : { createdAt: serverTimestamp() }),
    },
    { merge: true },
  );
  return id;
}

export async function deletePromotion(tenantId: string, id: string): Promise<void> {
  await deleteDoc(doc(promosCol(tenantId), id));
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
