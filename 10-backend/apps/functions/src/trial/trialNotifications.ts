/**
 * trial/trialNotifications.ts — Decisión PURA de notificaciones del free trial (TRIAL-NOTIFICATIONS-1).
 * Espeja la lógica de enforcement (`resolveEntitlements.trialExpired`) + excluye suspendidos/borrados y
 * tenants con suscripción (un trial activo tiene `subscription.status:'none'`). Sin E/S → unit-testeable.
 * El creador (escribe el doc + audita) vive en `functions/trial/generateTrialNotifications.ts`.
 */
import type { TrialNotificationType } from '@vpw/shared';

const DAY_MS = 86_400_000;

export interface TrialNotificationDecision {
  type: TrialNotificationType;
  daysLeft: number;
}

/** Subset del Tenant que necesita la decisión (desacopla de Firestore Timestamp). */
export interface TrialNotificationTenant {
  planId?: string;
  isDemo?: boolean;
  status?: string;
  deletedAt?: unknown;
  subscription?: { status?: string } | null;
  trial?: { endsAt?: { toMillis?: () => number } | number | null } | null;
}

function endsAtMs(trial: TrialNotificationTenant['trial']): number | null {
  const e = trial?.endsAt;
  if (e == null) return null;
  if (typeof e === 'number') return Number.isFinite(e) ? e : null;
  if (typeof e === 'object' && typeof e.toMillis === 'function') { try { return e.toMillis(); } catch { return null; } }
  return null;
}

/**
 * Qué notificación de trial corresponde (o `null` = ninguna). PURA. Reglas:
 * - No es trial (pago / demo / suspendido-borrado / con suscripción / `free` sin `trial`) → null.
 * - Vencido (`endsAt <= now`) → `trial_expired`.
 * - Último día (≤1 día restante) → `trial_ending_today`.
 * - 2–3 días restantes → `trial_ending_soon`.
 * - >3 días → null (todavía no).
 */
export function computeTrialNotificationState(tenant: TrialNotificationTenant | null | undefined, nowMs: number): TrialNotificationDecision | null {
  if (!tenant) return null;
  if ((tenant.planId ?? 'free') !== 'free') return null;
  if (tenant.isDemo === true) return null;
  if (tenant.status === 'SUSPENDED' || tenant.status === 'DELETED' || tenant.deletedAt) return null;
  if ((tenant.subscription?.status ?? 'none') !== 'none') return null;
  const endsMs = endsAtMs(tenant.trial);
  if (endsMs == null) return null; // legacy sin trial
  if (endsMs <= nowMs) return { type: 'trial_expired', daysLeft: 0 };
  const daysLeft = Math.ceil((endsMs - nowMs) / DAY_MS);
  if (daysLeft <= 1) return { type: 'trial_ending_today', daysLeft };
  if (daysLeft <= 3) return { type: 'trial_ending_soon', daysLeft };
  return null;
}

/** Contenido INTERNO (owner-facing, sin tecnicismos ni PII; no es un mensaje externo). */
export function buildTrialNotificationContent(d: TrialNotificationDecision): { title: string; body: string } {
  switch (d.type) {
    case 'trial_ending_soon':
      return { title: 'Tu prueba gratis está por terminar', body: `Te quedan ${d.daysLeft} días de prueba. Activá un plan para no perder acceso.` };
    case 'trial_ending_today':
      return { title: 'Tu prueba gratis termina hoy', body: 'Activá un plan para seguir usando la plataforma sin interrupciones.' };
    case 'trial_expired':
      return { title: 'Tu prueba gratis terminó', body: 'Activá un plan para volver a usar la plataforma.' };
  }
}
