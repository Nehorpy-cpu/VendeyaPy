/**
 * Capa de acceso a la biblioteca de respuestas ganadoras (panel · P18).
 *
 * LECTURAS directas (las reglas permiten leer al staff). ESCRITURAS por callables (Fase 5C):
 *   - winningReplyUpsert (alta/edición MANUAL; el backend rechaza editar las "auto" minadas)
 *   - winningReplyDelete (SOFT: status='ARCHIVED') — el panel lo muestra como "Archivar"
 * NO hay hard-delete público (las "auto" las mina/purga un job con Admin SDK).
 */

import { collection, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { WinningReply } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';

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

type ReplyUpsertResp = { ok: boolean; id: string; created: boolean };

/**
 * Alta/edición de reply MANUAL vía callable `winningReplyUpsert`. El backend fuerza source='manual',
 * conversions=0, status='ACTIVE' en create y RECHAZA editar replies source='auto'. NO escribe directo.
 */
export async function upsertReply(tenantId: string, input: ReplyInput): Promise<string> {
  const data = { text: input.text, category: input.category || 'General' };
  const call = httpsCallable<{ tenantId: string; id?: string; data: unknown }, ReplyUpsertResp>(
    firebaseFunctions(),
    'winningReplyUpsert',
  );
  const res = await call({ tenantId, id: input.id, data });
  return res.data.id;
}

/**
 * "Archivar" vía callable `winningReplyDelete`. Es SOFT (status='ARCHIVED'); la lista oculta las
 * archivadas. NO hay hard-delete público. NO escribe directo a Firestore.
 */
export async function archiveReply(tenantId: string, id: string): Promise<void> {
  const call = httpsCallable<{ tenantId: string; id: string }, { ok: boolean }>(firebaseFunctions(), 'winningReplyDelete');
  await call({ tenantId, id });
}

export async function generateReplies(tenantId: string): Promise<void> {
  await fetch(`${API}/devGenerateWinningReplies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId }),
  });
}
