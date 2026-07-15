/**
 * lib/notifications.ts — Adapter de notificaciones internas del panel (TRIAL-NOTIFICATIONS-2, frontend).
 * Lee las notificaciones del tenant ACTIVO (`tenants/{t}/notifications`) y permite marcarlas leídas. El
 * frontend NUNCA crea ni borra notificaciones (las crea el backend, TN-1). `markNotificationRead` solo manda
 * `{ read, readAt }` — lo único que permiten las rules (`update: hasOnly(['read','readAt'])`).
 */
import { collection, doc, getDocs, updateDoc, serverTimestamp } from 'firebase/firestore';
import type { Notification } from '@vpw/shared';
import { firebaseDb } from './firebase';

const notificationsCol = (tenantId: string) => collection(firebaseDb(), 'tenants', tenantId, 'notifications');

/**
 * Notificaciones del tenant. Solo OWNER/admin pueden leerlas (rules); para seller/manager/viewer
 * `getDocs` devuelve permission-denied → se maneja en SILENCIO (sin notificaciones, sin romper la UI).
 */
export async function listNotifications(tenantId: string): Promise<Notification[]> {
  try {
    const snap = await getDocs(notificationsCol(tenantId));
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
  handoff_ai_unavailable: 5, // el bot no pudo atender: lo más urgente de la campana
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
