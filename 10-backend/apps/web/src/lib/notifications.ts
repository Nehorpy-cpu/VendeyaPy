/**
 * lib/notifications.ts — Adapter de notificaciones internas del panel (TRIAL-NOTIFICATIONS-2, frontend).
 * Lee las notificaciones del tenant ACTIVO (`tenants/{t}/notifications`) y permite marcarlas leídas. El
 * frontend NUNCA crea ni borra notificaciones (las crea el backend, TN-1). `markNotificationRead` solo manda
 * `{ read, readAt }` — lo único que permiten las rules (`update: hasOnly(['read','readAt'])`).
 */
import { collection, doc, getDocs, query, updateDoc, serverTimestamp, where } from 'firebase/firestore';
import type { Notification } from '@vpw/shared';
import { firebaseDb } from './firebase';

const notificationsCol = (tenantId: string) => collection(firebaseDb(), 'tenants', tenantId, 'notifications');

export interface NotificationsViewer {
  role: string | null;
  uid: string | null;
}

/**
 * Alcance de lectura por rol (COVERAGE-1C). Las rules exigen que la QUERY ya venga acotada:
 * owner/admin → todo; MANAGER → solo categoría handoff; SELLER → solo handoff dirigidos a su
 * uid (targetUid, server-controlled). Cualquier otro rol no lee nada. PURA → testeable.
 */
export function notificationsScopeFor(viewer?: NotificationsViewer):
  | { kind: 'all' }
  | { kind: 'handoff' }
  | { kind: 'handoff-target'; uid: string }
  | { kind: 'none' } {
  const role = viewer?.role ?? null;
  if (role === 'TENANT_OWNER' || role === 'PLATFORM_ADMIN' || role === null) return { kind: 'all' };
  if (role === 'TENANT_MANAGER') return { kind: 'handoff' };
  if (role === 'SELLER') return viewer?.uid ? { kind: 'handoff-target', uid: viewer.uid } : { kind: 'none' };
  return { kind: 'none' };
}

/**
 * Notificaciones visibles para el usuario según su rol. Un rol sin acceso (o cualquier error de
 * lectura) devuelve [] en SILENCIO — la campana simplemente no aparece.
 */
export async function listNotifications(tenantId: string, viewer?: NotificationsViewer): Promise<Notification[]> {
  try {
    const scope = notificationsScopeFor(viewer);
    if (scope.kind === 'none') return [];
    const col = notificationsCol(tenantId);
    const q =
      scope.kind === 'handoff' ? query(col, where('category', '==', 'handoff'))
      : scope.kind === 'handoff-target' ? query(col, where('category', '==', 'handoff'), where('targetUid', '==', scope.uid))
      : col;
    const snap = await getDocs(q);
    // `id` = id del doc (fuente de verdad para markNotificationRead), no se asume que venga en el body.
    return snap.docs.map((d) => ({ ...(d.data() as Notification), id: d.id }));
  } catch {
    return []; // permission-denied (rol sin acceso) u otro error de lectura → silencioso
  }
}

/** Marca una notificación como leída. Solo `{ read, readAt }` (lo permitido por rules). No crea ni borra. */
export async function markNotificationRead(tenantId: string, notificationId: string): Promise<void> {
  await updateDoc(doc(notificationsCol(tenantId), notificationId), { read: true, readAt: serverTimestamp() });
}

// Severidad para ordenar (más urgente primero). PURA → testeable.
// HANDOFF-2: un cliente esperando a una persona es lo más urgente de la campana.
const SEVERITY: Record<Notification['type'], number> = {
  handoff_coverage_stale: 7, // HARDEN-1: aprobación sin reanudar y chat posiblemente mudo — atender YA
  handoff_coverage_review: 6, // cliente queriendo PAGAR a la espera de cobertura: lo más urgente
  handoff_ai_unavailable: 5, // el bot no pudo atender
  handoff_customer_requested: 4,
  trial_expired: 3,
  trial_ending_today: 2,
  trial_ending_soon: 1,
};

/** No leídas, más urgentes primero (vencido > hoy > por vencer). PURA. */
export function selectUnreadSorted(list: Notification[]): Notification[] {
  return list
    .filter((n) => !n.read)
    .sort((a, b) => (SEVERITY[b.type] ?? 0) - (SEVERITY[a.type] ?? 0));
}
