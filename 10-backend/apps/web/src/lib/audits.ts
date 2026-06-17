/**
 * Capa de acceso a la auditoría del agente (panel · P16).
 * Solo lectura + cambiar status (resolver/descartar). Generar = job dev.
 */

import { collection, doc, getDocs, updateDoc, query, where, serverTimestamp } from 'firebase/firestore';
import type { AgentAudit, AuditStatus } from '@vpw/shared';
import { firebaseDb } from './firebase';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:5001/demo-aiafg/us-central1';
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

export async function generateAudits(tenantId: string): Promise<void> {
  await fetch(`${API}/devGenerateAudits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId }),
  });
}
