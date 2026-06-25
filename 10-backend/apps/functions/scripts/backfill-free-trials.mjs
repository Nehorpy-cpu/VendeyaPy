/**
 * backfill-free-trials.mjs — Migración: asigna `trial` a tenants `free` LEGACY (TRIAL-ENFORCEMENT-1C).
 * ============================================================================================
 * 1A/1B solo enforcean/muestran el trial a tenants free que TIENEN `trial`. Los tenants free creados
 * antes de 1A no lo tienen. Este script les asigna `trial.startedAt = asOf` y `endsAt = asOf + trialDays`.
 *
 * SEGURO POR DEFECTO: **dry-run** (no escribe) salvo `--apply`. **Idempotente**: un tenant que ya tiene
 * `trial` se omite (no se re-escribe ni se extiende). NO toca: tenants pagos, con suscripción activa,
 * demo, ya migrados, o suspendidos/borrados.
 *
 * USO (emulador):
 *   node scripts/backfill-free-trials.mjs                 # dry-run de TODOS los tenants
 *   node scripts/backfill-free-trials.mjs --prefix acme-  # dry-run solo de ids que empiezan con "acme-"
 *   node scripts/backfill-free-trials.mjs --apply         # ESCRIBE
 *   node scripts/backfill-free-trials.mjs --apply --as-of 1700000000000   # fecha de inicio fija (ms)
 *
 * PRODUCCIÓN: correr SIEMPRE dry-run primero y guardar el resumen; recién después `--apply`. Los tenants
 * demo deben estar marcados `isDemo:true` (el script los omite); si no, usar `--prefix` para acotar.
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { DEFAULT_PLANS } from '../lib/plans/plans.js';

const DAY_MS = 86_400_000;
const FREE_TRIAL_DAYS = DEFAULT_PLANS.find((p) => p.id === 'free')?.trialDays ?? 7;

/**
 * Recorre `tenants/`, clasifica cada uno y (si `apply`) asigna `trial` a los elegibles.
 * Elegible = plan `free` (o sin plan) + sin `trial` + sin suscripción paga (status 'none'/ausente) +
 * no demo + no suspendido/borrado. Devuelve el resumen de conteos.
 */
export async function backfillFreeTrials(db, { apply = false, prefix = '', asOfMs = Date.now(), trialDays = FREE_TRIAL_DAYS } = {}) {
  const summary = { scanned: 0, eligible: 0, skippedPaid: 0, skippedDemo: 0, skippedAlreadyHasTrial: 0, skippedInactive: 0, updated: 0 };
  const startedAt = Timestamp.fromMillis(asOfMs);
  const endsAt = Timestamp.fromMillis(asOfMs + trialDays * DAY_MS);
  const snap = await db.collection('tenants').get();
  for (const d of snap.docs) {
    if (prefix && !d.id.startsWith(prefix)) continue;
    summary.scanned++;
    const t = d.data();
    // Orden de prioridad de exclusión (mutuamente excluyente):
    if (t.isDemo === true) { summary.skippedDemo++; continue; }
    if (t.trial) { summary.skippedAlreadyHasTrial++; continue; }
    const planFree = (t.planId ?? 'free') === 'free';
    const subStatus = t.subscription?.status ?? 'none';
    if (!planFree || subStatus !== 'none') { summary.skippedPaid++; continue; } // pago o con suscripción
    if (t.status === 'SUSPENDED' || t.status === 'DELETED' || t.deletedAt) { summary.skippedInactive++; continue; }
    summary.eligible++;
    if (apply) {
      await d.ref.set({ trial: { startedAt, endsAt }, updatedAt: Timestamp.now() }, { merge: true });
      summary.updated++;
    }
  }
  return summary;
}

// ----------------------------- CLI (solo cuando se ejecuta directo) -----------------------------
const isMain = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/backfill-free-trials.mjs');
if (isMain) {
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
  process.env.GCLOUD_PROJECT ??= 'demo-aiafg';
  const onEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  const apply = process.argv.includes('--apply');
  const pIdx = process.argv.indexOf('--prefix');
  const prefix = pIdx >= 0 ? (process.argv[pIdx + 1] ?? '') : '';
  const aIdx = process.argv.indexOf('--as-of');
  const asOfRaw = aIdx >= 0 ? Number(process.argv[aIdx + 1]) : Date.now();
  const asOfMs = Number.isFinite(asOfRaw) ? asOfRaw : Date.now();
  if (aIdx >= 0 && !Number.isFinite(asOfRaw)) console.log('  ⚠️ --as-of inválido; usando la fecha actual');
  if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  const db = getFirestore();

  console.log(`backfill-free-trials — modo: ${apply ? 'APPLY (escribe)' : 'DRY-RUN (no escribe)'} · ${onEmulator ? 'EMULADOR' : '⚠️ NO-EMULADOR (¿producción?)'}${prefix ? ` · prefix="${prefix}"` : ''} · trialDays=${FREE_TRIAL_DAYS}`);
  if (!apply) console.log('  (dry-run: usá --apply para escribir; en prod, guardá este resumen antes de aplicar)');
  const summary = await backfillFreeTrials(db, { apply, prefix, asOfMs });
  console.log('RESUMEN:', JSON.stringify(summary, null, 2));
  process.exitCode = 0;
}
