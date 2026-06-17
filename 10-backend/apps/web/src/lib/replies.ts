/**
 * Capa de acceso a la biblioteca de respuestas ganadoras (panel · P18).
 * Staff lee/copia; manager+ cura (crear/editar/archivar). "auto" las mina un job.
 */

import { collection, doc, getDocs, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import type { WinningReply } from '@vpw/shared';
import { firebaseDb } from './firebase';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:5001/demo-aiafg/us-central1';
const repliesCol = (t: string) => collection(firebaseDb(), 'tenants', t, 'winningReplies');

export async function listReplies(tenantId: string): Promise<WinningReply[]> {
  const snap = await getDocs(repliesCol(tenantId));
  return snap.docs
    .map((d) => d.data() as WinningReply)
    .filter((r) => r.status === 'ACTIVE')
    .sort((a, b) => (b.conversions ?? 0) - (a.conversions ?? 0));
}

export interface ReplyInput {
  id?: string;
  text: string;
  category: string;
}

export async function upsertReply(tenantId: string, input: ReplyInput): Promise<string> {
  const id = input.id ?? doc(repliesCol(tenantId)).id;
  await setDoc(
    doc(repliesCol(tenantId), id),
    {
      id,
      tenantId,
      text: input.text,
      category: input.category || 'General',
      updatedAt: serverTimestamp(),
      ...(input.id ? {} : { source: 'manual', conversions: 0, status: 'ACTIVE', createdAt: serverTimestamp() }),
    },
    { merge: true },
  );
  return id;
}

export async function archiveReply(tenantId: string, id: string): Promise<void> {
  await setDoc(doc(repliesCol(tenantId), id), { status: 'ARCHIVED', updatedAt: serverTimestamp() }, { merge: true });
}

export async function deleteReply(tenantId: string, id: string): Promise<void> {
  await deleteDoc(doc(repliesCol(tenantId), id));
}

export async function generateReplies(tenantId: string): Promise<void> {
  await fetch(`${API}/devGenerateWinningReplies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId }),
  });
}
