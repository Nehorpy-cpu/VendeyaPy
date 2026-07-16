/**
 * COVERAGE-1D — Mantenimiento diario de cobertura (03:30 America/Asuncion).
 * ==========================================================================
 * Cron elegido: DIARIO — las ventanas del flujo son de horas/días (expiración default 24 h,
 * purga de coordenadas a 30 días) y los caminos interactivos ya expiran LAZY al tocarse; este
 * job es la red de seguridad + higiene, con costo mínimo (pocas queries por tenant, catálogo de
 * tenants chico). 03:30 evita solaparse con los schedulers existentes (04:00 y 09:00).
 *
 *  1. Requests activos VENCIDOS → coverage_expired (transaccional) + liberación GUARDADA (solo
 *     coverage_review del mismo request) + mensaje honesto (sin banco/orden) + coordinatesPurgeAt.
 *  2. Terminales con coordinatesPurgeAt vencido → se eliminan lat/lng y el nombre del lugar;
 *     queda la dirección textual, decisión, actor, estado y fingerprint (evidencia intacta).
 *  3. Jobs `held_by_seller` con la sesión ya liberada → re-encolados (recuperación segura).
 *     Jobs `send_failed` con intentos disponibles → retry controlado (tope duro, sin loops).
 * Reejecutable e idempotente: cada paso re-verifica estado dentro de su transacción.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { Timestamp } from 'firebase-admin/firestore';
import type { CoverageRequest, CoverageResumeJob, Session } from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { coverageSettings, purgeAtFrom } from '../../conversation/coverage.js';
import { enviarPorOutbox, processCoverageResumeJob, MENSAJE_COBERTURA_VENCIDA } from '../../conversation/coverageResume.js';
import { getCheckoutConfig } from '../../orders/checkoutConfig.js';

const MAX_ATTEMPTS = 5;
const LOTE = 50; // tope por corrida y por tenant: costo acotado; lo que quede sale mañana

export async function runCoverageMaintenance(): Promise<void> {
  const now = Timestamp.now();
  const tenants = await db().collection('tenants').select().get();
  for (const t of tenants.docs) {
    const tenantId = t.id;
    try {
      const cfg = coverageSettings(await getCheckoutConfig(tenantId));

      // 1) Expirar requests activos vencidos (aunque el flag esté off: higiene de datos;
      //    el MENSAJE solo sale con el flag activo).
      const vencidos = await db()
        .collection(`tenants/${tenantId}/coverageRequests`)
        .where('status', 'in', ['awaiting_location', 'pending_coverage_review'])
        .where('expiresAt', '<=', now)
        .limit(LOTE)
        .get();
      for (const d of vencidos.docs) {
        const req = d.data() as CoverageRequest;
        const expirado = await db().runTransaction(async (tx) => {
          // Admin SDK: TODAS las lecturas antes de cualquier escritura (review: el orden inverso
          // lanza "reads before writes" y abortaba la expiración entera).
          const fresh = (await tx.get(d.ref)).data() as CoverageRequest | undefined;
          if (!fresh || (fresh.status !== 'awaiting_location' && fresh.status !== 'pending_coverage_review')) return false;
          if (fresh.expiresAt.toMillis() > now.toMillis()) return false;
          const sesRef = db().doc(paths.session(tenantId, fresh.customerId));
          const ses = (await tx.get(sesRef)).data() as Session | undefined;
          const ctx = ses?.context;
          tx.update(d.ref, { status: 'coverage_expired', coordinatesPurgeAt: purgeAtFrom(now, fresh), updatedAt: now });
          if (ctx?.humanTakeover === true && ctx.handoffReason === 'coverage_review' && ctx.handoffSourceId === fresh.id) {
            tx.update(sesRef, {
              'context.humanTakeover': false,
              'context.handoffReason': null,
              'context.handoffSellerName': null,
              'context.handoffAt': null,
              'context.handoffSourceId': null,
              'context.coverage': null,
              updatedAt: now,
            });
            return 'liberado';
          }
          if (ctx?.humanTakeover === true) {
            // Takeover AJENO (vendedor/comprobante): el request expira pero el bot NO interrumpe
            // el chat humano con un mensaje a las 03:30 (review) — el humano ya está atendiendo.
            if (ctx?.coverage?.requestId === fresh.id) tx.update(sesRef, { 'context.coverage': null, updatedAt: now });
            return 'ajeno';
          }
          if (ctx?.coverage?.requestId === fresh.id) {
            tx.update(sesRef, { 'context.coverage': null, updatedAt: now });
          }
          return 'liberado';
        });
        if (expirado === 'liberado' && cfg.enabled) {
          await enviarPorOutbox({
            tenantId,
            coverageRequestId: req.id,
            action: 'expired',
            checkoutAttemptId: null,
            customerId: req.customerId,
            channel: req.channel,
            receivedVia: req.receivedVia ?? null,
            text: MENSAJE_COBERTURA_VENCIDA,
          });
        }
      }

      // 2) Purga de coordenadas exactas (privacidad, 30 días post-terminal).
      const purgables = await db()
        .collection(`tenants/${tenantId}/coverageRequests`)
        .where('coordinatesPurgeAt', '<=', now)
        .limit(LOTE)
        .get();
      for (const d of purgables.docs) {
        await db().runTransaction(async (tx) => {
          const fresh = (await tx.get(d.ref)).data() as CoverageRequest | undefined;
          if (!fresh?.coordinatesPurgeAt || fresh.coordinatesPurgeAt.toMillis() > now.toMillis()) return;
          tx.update(d.ref, {
            'location.coordinates': null,
            'location.name': null,
            coordinatesPurgeAt: null,
            updatedAt: now,
          });
        });
      }

      // 3) Recuperación de jobs — SOLO con el feature activo (con el flag off el consumidor
      //    declina y re-encolar sería un loop estéril; al re-encender, el paso 3d los re-drivea).
      if (!cfg.enabled) continue;
      const held = await db().collection(`tenants/${tenantId}/coverageResumeJobs`).where('status', '==', 'held_by_seller').limit(LOTE).get();
      for (const d of held.docs) {
        const job = d.data() as CoverageResumeJob;
        const ses = (await db().doc(paths.session(tenantId, job.customerId)).get()).data() as Session | undefined;
        if (ses?.context?.humanTakeover === true) continue; // el humano sigue: no tocar
        await db().runTransaction(async (tx) => {
          const fresh = (await tx.get(d.ref)).data() as CoverageResumeJob | undefined;
          if (fresh?.status !== 'held_by_seller') return;
          tx.update(d.ref, { status: 'pending', leaseUntil: null, updatedAt: now });
        });
      }
      const fallidos = await db().collection(`tenants/${tenantId}/coverageResumeJobs`).where('status', '==', 'send_failed').limit(LOTE).get();
      for (const d of fallidos.docs) {
        const job = d.data() as CoverageResumeJob;
        if ((job.attempts ?? 0) >= MAX_ATTEMPTS) continue; // tope duro: intervención manual
        await db().runTransaction(async (tx) => {
          const fresh = (await tx.get(d.ref)).data() as CoverageResumeJob | undefined;
          if (fresh?.status !== 'send_failed' || (fresh.attempts ?? 0) >= MAX_ATTEMPTS) return;
          tx.update(d.ref, { status: 'pending', leaseUntil: null, updatedAt: now });
        });
      }
      // 3c) `processing` HUÉRFANO (crash duro post-claim, lease vencido) → re-encolar: el write
      //     a pending dispara el trigger (review: sin esto quedaba muerto para siempre).
      const colgados = await db().collection(`tenants/${tenantId}/coverageResumeJobs`).where('status', '==', 'processing').limit(LOTE).get();
      for (const d of colgados.docs) {
        const job = d.data() as CoverageResumeJob;
        if ((job.leaseUntil?.toMillis?.() ?? 0) > now.toMillis()) continue; // worker vivo
        await db().runTransaction(async (tx) => {
          const fresh = (await tx.get(d.ref)).data() as CoverageResumeJob | undefined;
          if (fresh?.status !== 'processing' || (fresh.leaseUntil?.toMillis?.() ?? 0) > now.toMillis()) return;
          tx.update(d.ref, { status: 'pending', leaseUntil: null, updatedAt: now });
        });
      }
      // 3d) `pending` ESTANCADO (>10 min sin procesar — p. ej. decidido con el flag apagado):
      //     el trigger no re-dispara sin transición, así que se procesa DIRECTO acá.
      const estancados = await db().collection(`tenants/${tenantId}/coverageResumeJobs`).where('status', '==', 'pending').limit(LOTE).get();
      for (const d of estancados.docs) {
        const job = d.data() as CoverageResumeJob;
        if (now.toMillis() - (job.updatedAt?.toMillis?.() ?? 0) < 10 * 60 * 1000) continue;
        await processCoverageResumeJob(tenantId, d.id);
      }
    } catch (e) {
      logger.error('Cobertura: mantenimiento falló para un tenant', e, { tenantId });
    }
  }
}

export const coverageMaintenanceDaily = onSchedule(
  { schedule: '30 3 * * *', timeZone: 'America/Asuncion', region: 'us-central1' },
  async () => {
    await runCoverageMaintenance();
  },
);
