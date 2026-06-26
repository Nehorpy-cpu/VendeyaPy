/**
 * Capa de acceso a la auditoría del agente (panel · P16).
 * Solo lectura + cambiar status (resolver/descartar). Generar = callable real `runTenantJob`.
 */

import { collection, doc, getDocs, updateDoc, query, where, serverTimestamp } from 'firebase/firestore';
import type { AgentAudit, AuditStatus } from '@vpw/shared';
import { firebaseDb } from './firebase';
import { runTenantJob } from './entitlements';

const auditsCol = (t: string) => collection(firebaseDb(), 'tenants', t, 'agentAudits');

export async function listOpenAudits(tenantId: string): Promise<AgentAudit[]> {
  const snap = await getDocs(query(auditsCol(tenantId), where('status', '==', 'OPEN')));
  return snap.docs.map((d) => d.data() as AgentAudit);
}

export async function setAuditStatus(tenantId: string, id: string, status: AuditStatus): Promise<void> {
  await updateDoc(doc(auditsCol(tenantId), id), {
    status,
    resolvedAt: status === 'OPEN' ? null : serverTimestamp(),
  });
}

/** Revisa la config del agente y genera hallazgos vía el callable real (acción `generateAudits`). */
export async function generateAudits(tenantId: string): Promise<void> {
  await runTenantJob('generateAudits', tenantId);
}
