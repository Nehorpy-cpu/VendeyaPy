/**
 * trial/runTrialNotificationsJob.ts — Core REUTILIZABLE del job de notificaciones del trial (TN-3).
 * Lo comparten el callable admin (`generateTrialNotifications`) y la scheduled function diaria
 * (`trialNotificationsDaily`). Recibe la instancia `db` (Firestore) → testeable/importable directo desde el
 * e2e. Idempotente (id determinístico = el tipo, vía `.create()`). NO envía WhatsApp/email/push real: solo
 * escribe la notificación interna + audita. NO pasa por gates de uso (corre aunque el trial esté vencido).
 * Aislamiento por tenant: un doc con datos raros se salta y se cuenta como error, sin tumbar el job entero.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import type { TrialNotificationType } from '@vpw/shared';
import { paths } from '../lib/firebase.js';
import { recordAudit } from '../audit/audit.js';
import { logger } from '../lib/logger.js';
import { computeTrialNotificationState, buildTrialNotificationContent } from './trialNotifications.js';

function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: number | string } | null)?.code;
  return code === 6 || code === 'already-exists' || /already.?exists/i.test(String(e));
}

export interface TrialJobSummary {
  scanned: number;
  created: number;
  skipped: number;
  errors: number;
  byType: Record<TrialNotificationType, number>;
}

export interface TrialJobOptions {
  nowMs?: number;
  /** Si true: NO escribe (solo cuenta lo que se crearía). */
  dryRun?: boolean;
  actorUid?: string | null;
  /** Procesar SOLO este tenant (callable targeteado); si se omite, recorre todos. */
  tenantId?: string;
}

/** Procesa UN tenant: crea la notificación que corresponda (idempotente + auditada), o no hace nada. */
async function processTenant(db: Firestore, tenantId: string, data: unknown, nowMs: number, dryRun: boolean, actorUid: string | null): Promise<{ created: boolean; type?: TrialNotificationType }> {
  const decision = computeTrialNotificationState(data as Parameters<typeof computeTrialNotificationState>[0], nowMs);
  if (!decision) return { created: false };
  const id = decision.type; // determinístico → 1 por (tenant, tipo) por trial
  const ref = db.doc(paths.notification(tenantId, id));
  if (dryRun) {
    const exists = (await ref.get()).exists; // preview exacto: ¿se crearía o ya existe?
    return exists ? { created: false, type: decision.type } : { created: true, type: decision.type };
  }
  const { title, body } = buildTrialNotificationContent(decision);
  try {
    await ref.create({ id, tenantId, category: 'trial', type: decision.type, title, body, dedupeKey: id, read: false, readAt: null, createdAt: Timestamp.now() });
  } catch (e) {
    if (isAlreadyExists(e)) return { created: false, type: decision.type }; // ya existía → idempotente
    throw e;
  }
  await recordAudit({ tenantId, action: 'trial.notification_created', actorUid, targetType: 'notification', targetId: id, summary: `Notificación de trial: ${decision.type}`, metadata: { type: decision.type, daysLeft: decision.daysLeft } });
  return { created: true, type: decision.type };
}

/** Recorre los tenants (o uno) y genera las notificaciones de trial que correspondan. Devuelve el resumen. */
export async function runTrialNotificationsJob(db: Firestore, opts: TrialJobOptions = {}): Promise<TrialJobSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  const dryRun = opts.dryRun === true;
  const actorUid = opts.actorUid ?? null;
  const summary: TrialJobSummary = { scanned: 0, created: 0, skipped: 0, errors: 0, byType: { trial_ending_soon: 0, trial_ending_today: 0, trial_expired: 0 } };

  const docs = opts.tenantId
    ? [await db.doc(paths.tenant(opts.tenantId)).get()].filter((s) => s.exists)
    : (await db.collection(paths.tenants()).get()).docs;

  for (const d of docs) {
    summary.scanned++;
    try {
      const r = await processTenant(db, d.id, d.data(), nowMs, dryRun, actorUid);
      if (r.created && r.type) { summary.created++; summary.byType[r.type] += 1; } else summary.skipped++;
    } catch (e) {
      summary.errors++;
      logger.error('trialNotifications: tenant falló, se salta (el job continúa)', e, { tenantId: d.id });
    }
  }
  return summary;
}
