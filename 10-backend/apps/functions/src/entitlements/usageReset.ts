/**
 * entitlements/usageReset.ts — Reinicio del uso por período (Fase 5A)
 * ==================================================================
 * Los contadores mensuales (mensajes, pedidos, jobs, adSyncs, tokens IA) se reinician
 * al cambiar de mes calendario (UTC). `shouldResetUsage` es puro; `maybeResetUsage` hace
 * el reinicio en transacción (lazy, idempotente) y lo invoca checkQuota/meterUsage. Un job
 * programado (resetUsageMonthly) lo aplica también de forma proactiva.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { db, paths } from '../lib/firebase.js';

/** Reinicia si `now` cae en un mes calendario (UTC) distinto al del inicio del período. */
export function shouldResetUsage(periodStartMs: number | null | undefined, nowMs: number): boolean {
  if (!periodStartMs) return false; // sin período conocido → no forzar reinicio
  const start = new Date(periodStartMs);
  const now = new Date(nowMs);
  return start.getUTCFullYear() !== now.getUTCFullYear() || start.getUTCMonth() !== now.getUTCMonth();
}

const ZEROED = { messagesThisMonth: 0, ordersThisMonth: 0, jobsThisMonth: 0, adSyncsThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0 };

/** Reinicia el uso del tenant si cambió el período. Devuelve true si reinició. */
export async function maybeResetUsage(tenantId: string): Promise<boolean> {
  const ref = db().doc(paths.tenant(tenantId));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const usage = (snap.data()?.usage ?? {}) as { currentPeriodStart?: Timestamp };
    const startMs = usage.currentPeriodStart ? usage.currentPeriodStart.toMillis() : null;
    if (!shouldResetUsage(startMs, Date.now())) return false;
    const now = Timestamp.now();
    tx.set(ref, { usage: { ...ZEROED, currentPeriodStart: now }, updatedAt: now }, { merge: true });
    return true;
  });
}
