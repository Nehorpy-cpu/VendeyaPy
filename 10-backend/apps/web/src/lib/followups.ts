/**
 * Capa de acceso a tareas de seguimiento (panel · P14).
 * Solo lectura + cambiar status (hecho/descartar). Generar = callable real `runTenantJob`.
 */

import { collection, doc, getDocs, updateDoc, query, where, serverTimestamp } from 'firebase/firestore';
import type { FollowUpTask, FollowUpStatus } from '@vpw/shared';
import { firebaseDb } from './firebase';
import { runTenantJob } from './entitlements';

const tasksCol = (t: string) => collection(firebaseDb(), 'tenants', t, 'followUpTasks');

/** Tareas pendientes (las hechas/descartadas no aparecen). */
export async function listFollowUpTasks(tenantId: string): Promise<FollowUpTask[]> {
  const snap = await getDocs(query(tasksCol(tenantId), where('status', '==', 'PENDING')));
  return snap.docs.map((d) => d.data() as FollowUpTask);
}

export async function setTaskStatus(tenantId: string, id: string, status: FollowUpStatus): Promise<void> {
  await updateDoc(doc(tasksCol(tenantId), id), {
    status,
    completedAt: status === 'COMPLETED' ? serverTimestamp() : null,
  });
}

/** Genera tareas de seguimiento vía el callable real (acción `generateFollowups`). */
export async function generateFollowups(tenantId: string): Promise<void> {
  await runTenantJob('generateFollowups', tenantId);
}
