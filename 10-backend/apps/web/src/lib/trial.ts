/**
 * lib/trial.ts — Estado PURO del free trial (TRIAL-ENFORCEMENT-1B, frontend).
 * Deriva por fecha si el tenant está en prueba gratis y cuántos días le quedan, espejo de la lógica de
 * backend (`resolveEntitlements.trialExpired`). Sin dependencias de Firebase → unit-testeable. No expone
 * detalles técnicos (trialExpired/quota/failed-precondition); las páginas usan `formatTrialStatus`.
 */

const DAY_MS = 86_400_000;

/** Fuente mínima para derivar el trial (subset de ResolvedEntitlements; sin acoplar a Firebase). */
export interface TrialSource {
  planId: string;
  isDemo?: boolean;
  /** trial.endsAt en cualquier forma: Firestore Timestamp ({toMillis}/{seconds}), Date, number(ms) o ISO string. */
  trialEndsAt?: unknown;
}

export interface TrialState {
  /** El tenant es una prueba gratis con metadata de trial (free + no demo + `trialEndsAt` presente). */
  isTrial: boolean;
  /** La prueba venció (isTrial && endsAt < now). */
  expired: boolean;
  /** Días restantes (ceil), 0 si vencida. Solo válido si isTrial. */
  daysLeft: number;
  endsAt: Date | null;
}

/** Normaliza un valor de fecha a epoch ms. Soporta Firestore Timestamp, Date, number(ms) e ISO string. */
export function toMillis(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof Date) { const t = v.getTime(); return Number.isNaN(t) ? null : t; }
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  if (typeof v === 'object') {
    const o = v as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof o.toMillis === 'function') { try { return o.toMillis(); } catch { return null; } }
    const secs = o.seconds ?? o._seconds;
    if (typeof secs === 'number' && Number.isFinite(secs)) return secs * 1000;
  }
  return null;
}

const NO_TRIAL: TrialState = { isTrial: false, expired: false, daysLeft: 0, endsAt: null };

/**
 * Estado del trial. Solo es trial si el plan es `free`, no es demo y hay `trialEndsAt`. Tenants pagos,
 * demo, o legacy sin metadata → `isTrial:false` (no banner, no bloqueo desde el frontend).
 */
export function getTrialState(src: TrialSource | null | undefined, nowMs: number = Date.now()): TrialState {
  if (!src || src.planId !== 'free' || src.isDemo) return NO_TRIAL;
  const endsMs = toMillis(src.trialEndsAt);
  if (endsMs == null) return NO_TRIAL; // legacy sin trial
  const expired = endsMs <= nowMs;
  const daysLeft = expired ? 0 : Math.ceil((endsMs - nowMs) / DAY_MS);
  return { isTrial: true, expired, daysLeft, endsAt: new Date(endsMs) };
}

export const isTrialExpired = (src: TrialSource | null | undefined, nowMs?: number): boolean => getTrialState(src, nowMs).expired;
export const trialDaysLeft = (src: TrialSource | null | undefined, nowMs?: number): number => getTrialState(src, nowMs).daysLeft;

/** Texto para el owner (no alarmista, sin tecnicismos). Devuelve null si no es trial. */
export function formatTrialStatus(src: TrialSource | null | undefined, nowMs?: number): string | null {
  const s = getTrialState(src, nowMs);
  if (!s.isTrial) return null;
  if (s.expired) return 'Tu prueba gratis terminó. Activá un plan para seguir usando la plataforma.';
  if (s.daysLeft <= 1) return 'Tu prueba gratis termina hoy.';
  return `Tu prueba gratis termina en ${s.daysLeft} días.`;
}
