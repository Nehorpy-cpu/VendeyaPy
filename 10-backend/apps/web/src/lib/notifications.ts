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

/** Categorías que las rules le permiten leer al MANAGER (firestore.rules, match /notifications). */
type CategoriaManager = 'handoff' | 'catalog_quality';

export type NotificationsScope =
  | { kind: 'all' }
  | { kind: 'categories'; categories: ReadonlyArray<CategoriaManager> }
  | { kind: 'handoff-target'; uid: string }
  | { kind: 'none' };

/**
 * Alcance de lectura por rol (COVERAGE-1C + QUALITY-1). Las rules exigen que la QUERY ya venga
 * acotada: owner/admin → todo; MANAGER → categorías 'handoff' Y 'catalog_quality' (exactamente
 * las que le permiten las rules — nada más: ni trial/billing ni avisos de otros roles); SELLER →
 * solo handoff dirigidos a su uid (targetUid, server-controlled). Cualquier otro rol no lee nada.
 * PURA → testeable.
 */
export function notificationsScopeFor(viewer?: NotificationsViewer): NotificationsScope {
  const role = viewer?.role ?? null;
  if (role === 'TENANT_OWNER' || role === 'PLATFORM_ADMIN' || role === null) return { kind: 'all' };
  if (role === 'TENANT_MANAGER') return { kind: 'categories', categories: ['handoff', 'catalog_quality'] };
  if (role === 'SELLER') return viewer?.uid ? { kind: 'handoff-target', uid: viewer.uid } : { kind: 'none' };
  return { kind: 'none' };
}

/** Filtros de IGUALDAD de UNA query Firestore (se ejecuta una query por spec). PURO → testeable. */
export interface NotificationQuerySpec {
  filters: ReadonlyArray<readonly ['category' | 'targetUid', string]>;
}

/**
 * Specs de las queries EXACTAS permitidas por las rules para cada alcance. Se emite UNA query de
 * igualdad por categoría (nunca `where in [...]`): con `in`, una sola categoría no permitida por
 * rules rompe TODA la lectura; con queries separadas cada una es provable contra su disyuntiva de
 * la rule y una denegada no silencia a las demás. PURA → testeable.
 */
export function notificationQuerySpecsFor(scope: NotificationsScope): NotificationQuerySpec[] {
  switch (scope.kind) {
    case 'all':
      return [{ filters: [] }];
    case 'categories':
      return scope.categories.map((c) => ({ filters: [['category', c] as const] }));
    case 'handoff-target':
      return [{ filters: [['category', 'handoff'] as const, ['targetUid', scope.uid] as const] }];
    case 'none':
      return [];
  }
}

/**
 * Notificaciones visibles para el usuario según su rol. Un rol sin acceso (o cualquier error de
 * lectura) devuelve [] en SILENCIO — la campana simplemente no aparece. Cada spec corre como
 * query independiente: si una categoría falla (p. ej. rules desactualizadas), las demás siguen.
 */
export async function listNotifications(tenantId: string, viewer?: NotificationsViewer): Promise<Notification[]> {
  try {
    const specs = notificationQuerySpecsFor(notificationsScopeFor(viewer));
    if (specs.length === 0) return [];
    const col = notificationsCol(tenantId);
    const porSpec = await Promise.all(
      specs.map(async (spec) => {
        try {
          const q = spec.filters.length === 0 ? col : query(col, ...spec.filters.map(([campo, valor]) => where(campo, '==', valor)));
          const snap = await getDocs(q);
          // `id` = id del doc (fuente de verdad para markNotificationRead), no se asume que venga en el body.
          return snap.docs.map((d) => ({ ...(d.data() as Notification), id: d.id }));
        } catch {
          return []; // permission-denied de UNA categoría → esa query en silencio, sin tumbar el resto
        }
      }),
    );
    return porSpec.flat();
  } catch {
    return []; // error de configuración/lectura → silencioso
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
  // ADR-0015 §8: el dato público lo gobierna una fuente externa y hoy dice otra cosa — el cliente
  // está esperando un precio/stock que solo una persona puede confirmar (se corrige en el ORIGEN).
  handoff_catalog_drift: 5,
  handoff_customer_requested: 4,
  // ADR-0015 §4: una fuente externa sin reconocer (o que cambió) DETUVO las escrituras hacia
  // Meta. No hay un cliente esperando, pero el catálogo quedó sin poder publicarse: por encima
  // de la calidad (que es trabajo de fondo) y por debajo de cualquier handoff.
  catalog_source_changed: 4,
  // ADR-0015 §6: no se puede verificar el catálogo (gobierno externo declarado y ningún catálogo
  // que leer), así que la venta automática de los productos vinculados queda bloqueada hasta que
  // una persona corrija la config. Mismo escalón que la fuente sin reconocer: el gobierno del
  // catálogo quedó roto y solo un humano lo destraba. Cuando hay un cliente esperando por esto,
  // el aviso que salta es `handoff_catalog_drift`, que ya está más arriba.
  catalog_verification_blocked: 4,
  // Calidad del catálogo (agregada, autocerrable): productos que no pueden venderse/publicarse.
  // Debajo de los handoff (un cliente esperando manda) y a la par del trial vencido.
  catalog_quality_summary: 3,
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
