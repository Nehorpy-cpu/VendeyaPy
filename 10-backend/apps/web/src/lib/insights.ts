/**
 * Capa de acceso a insights = "acciones de hoy" del Centro de Decisiones (P13).
 * Solo lectura + cambiar status (hecho/descartar). Generar = job dev (en prod, programado).
 */

import { collection, doc, getDocs, updateDoc, query, where, serverTimestamp } from 'firebase/firestore';
import type { Insight, InsightStatus } from '@vpw/shared';
import { firebaseDb } from './firebase';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:5001/demo-aiafg/us-central1';
const insightsCol = (t: string) => collection(firebaseDb(), 'tenants', t, 'insights');

/** Todos los insights PENDIENTES (cualquier tipo). */
export async function listPendingInsights(tenantId: string): Promise<Insight[]> {
  const snap = await getDocs(query(insightsCol(tenantId), where('status', '==', 'PENDING')));
  return snap.docs.map((d) => d.data() as Insight);
}

export async function setInsightStatus(tenantId: string, id: string, status: InsightStatus): Promise<void> {
  await updateDoc(doc(insightsCol(tenantId), id), {
    status,
    resolvedAt: status === 'PENDING' ? null : serverTimestamp(),
  });
}

/** Dispara el recálculo de acciones (dev/job). */
export async function generateInsights(tenantId: string): Promise<void> {
  await fetch(`${API}/devGenerateInsights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId }),
  });
}
