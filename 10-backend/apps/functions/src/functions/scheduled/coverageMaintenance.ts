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
import type { CoverageOutboxMessage, CoverageRequest, CoverageResumeJob, Session } from '@vpw/shared';
import { coverageActivationOf } from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { coverageSettings, purgeAtFrom } from '../../conversation/coverage.js';
import { coverageHold } from '../../conversation/coverageTestHooks.js';
import { enviarPorOutbox, processCoverageResumeJob, MENSAJE_COBERTURA_VENCIDA } from '../../conversation/coverageResume.js';
import { outboxIdDeQuote } from '../coverage/coverageCallables.js';
import { getCheckoutConfig } from '../../orders/checkoutConfig.js';

const MAX_ATTEMPTS = 5;
const LOTE = 50; // tope por corrida y por tenant: costo acotado; lo que quede sale mañana
/**
 * SHIPPING-CHAT-3C-HARDEN-1: umbral de "intento de cotización abandonado". 1 h — un intento
 * interactivo se completa en minutos; pasada la hora es señal humana (diseño 3A: prepared/sent
 * atascados y unknown sin reconciliar requieren a una persona; JAMÁS re-drive automático).
 */
const QUOTE_ATASCADO_MS = 60 * 60 * 1000;

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
          // HARDEN-1 (review): el flag/activación se re-leen EN ESTA transacción — el snapshot
          // del inicio del loop puede tener minutos y un kill-switch a mitad de corrida debe
          // respetarse (mismo estándar que las callables y el claim del consumidor).
          const cfgTxSnap = await tx.get(db().doc(`tenants/${tenantId}/config/checkout`));
          const actTx = coverageActivationOf((cfgTxSnap.data() as { coverage?: unknown } | undefined)?.coverage);
          const fresh = (await tx.get(d.ref)).data() as CoverageRequest | undefined;
          if (!fresh || (fresh.status !== 'awaiting_location' && fresh.status !== 'pending_coverage_review')) return false;
          if (fresh.expiresAt.toMillis() > now.toMillis()) return false;
          const sesRef = db().doc(paths.session(tenantId, fresh.customerId));
          const ses = (await tx.get(sesRef)).data() as Session | undefined;
          const ctx = ses?.context;
          // HARDEN-2 (review): un intento de cotización PREPARED (jamás salió) se cierra terminal
          // en la MISMA tx del expire — sin esto quedaba pointer zombi + campana obsoleta del
          // sweep. sent/sending/unknown conservan el pointer (la recuperación/reconciliación de
          // la saga es la salida — jamás un expire ciego sobre algo que PUDO llegar al cliente).
          const pendingExp = fresh.shippingQuotePending ?? null;
          const obExpRef = pendingExp ? db().doc(`tenants/${tenantId}/coverageMessageOutbox/${outboxIdDeQuote(fresh.id, pendingExp.quoteAttemptId)}`) : null;
          const obExp = obExpRef ? ((await tx.get(obExpRef)).data() as CoverageOutboxMessage | undefined) : undefined;
          // HARDEN-1: la expiración es higiene/privacidad y corre SIEMPRE; pero liberar el
          // takeover (y el mensaje de después) exige flag ON y la MISMA activación — con flag
          // off/stale el chat humano no se toca (lo libera una persona desde el panel).
          const vigente = actTx.enabled && (fresh.activationId ?? null) === actTx.activationId;
          const cerrarPrepared = !!pendingExp && (!obExp || obExp.status === 'prepared');
          tx.update(d.ref, {
            status: 'coverage_expired',
            coordinatesPurgeAt: purgeAtFrom(now, fresh),
            ...(cerrarPrepared ? { shippingQuotePending: null } : {}),
            updatedAt: now,
          });
          if (obExpRef && obExp?.status === 'prepared') tx.update(obExpRef, { status: 'failed', leaseUntil: null, updatedAt: now });
          if (vigente && ctx?.humanTakeover === true && ctx.handoffReason === 'coverage_review' && ctx.handoffSourceId === fresh.id) {
            tx.update(sesRef, {
              'context.humanTakeover': false,
              'context.handoffReason': null,
              'context.handoffSellerName': null,
              'context.handoffAt': null,
              'context.handoffSourceId': null,
              'context.coverage': null,
              updatedAt: now,
            });
            return 'liberado_vigente';
          }
          if (ctx?.humanTakeover === true) {
            // Takeover AJENO (vendedor/comprobante) o flujo off/stale con chat tomado: el request
            // expira pero el bot NO interrumpe el chat humano ni libera nada (review).
            if (ctx?.coverage?.requestId === fresh.id) tx.update(sesRef, { 'context.coverage': null, updatedAt: now });
            return 'ajeno';
          }
          if (ctx?.coverage?.requestId === fresh.id) {
            tx.update(sesRef, { 'context.coverage': null, updatedAt: now });
          }
          // El veredicto de MENSAJE sale de esta misma transacción (flag leído acá, no del
          // snapshot del loop): 'liberado_vigente' es el único caso que avisa al cliente.
          return vigente ? 'liberado_vigente' : 'liberado';
        });
        if (expirado === 'liberado_vigente') {
          await enviarPorOutbox({
            tenantId,
            coverageRequestId: req.id,
            action: 'expired',
            checkoutAttemptId: null,
            customerId: req.customerId,
            channel: req.channel,
            receivedVia: req.receivedVia ?? null,
            activationId: req.activationId ?? null,
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
      //    declina y re-encolar sería un loop estéril). Al re-encender con una activación NUEVA,
      //    3c/3d re-drivean también los jobs de la activación anterior: el claim del consumidor
      //    los deja `cancelled` (terminal, sin efectos) — convergencia garantizada.
      if (!cfg.enabled) continue;
      await coverageHold(tenantId, 'mant_pre_reencolar'); // solo-emulador: test del kill-switch
      // KILL-SWITCH-1: cada transacción de re-encolado RE-LEE la config (el snapshot del inicio
      // del loop puede tener minutos): un apagado a mitad de corrida frena los re-drives.
      const cfgRef = db().doc(`tenants/${tenantId}/config/checkout`);
      const held = await db().collection(`tenants/${tenantId}/coverageResumeJobs`).where('status', '==', 'held_by_seller').limit(LOTE).get();
      for (const d of held.docs) {
        const job = d.data() as CoverageResumeJob;
        if ((job.activationId ?? null) !== cfg.activationId) continue; // HARDEN-1: activación anterior → inerte, no se re-encola
        const ses = (await db().doc(paths.session(tenantId, job.customerId)).get()).data() as Session | undefined;
        if (ses?.context?.humanTakeover === true) continue; // el humano sigue: no tocar
        await db().runTransaction(async (tx) => {
          const act = coverageActivationOf(((await tx.get(cfgRef)).data() as { coverage?: unknown } | undefined)?.coverage);
          const fresh = (await tx.get(d.ref)).data() as CoverageResumeJob | undefined;
          if (!act.enabled || (fresh?.activationId ?? null) !== act.activationId) return; // kill-switch en la tx
          if (fresh?.status !== 'held_by_seller') return;
          tx.update(d.ref, { status: 'pending', leaseUntil: null, updatedAt: now });
        });
      }
      const fallidos = await db().collection(`tenants/${tenantId}/coverageResumeJobs`).where('status', '==', 'send_failed').limit(LOTE).get();
      for (const d of fallidos.docs) {
        const job = d.data() as CoverageResumeJob;
        if ((job.activationId ?? null) !== cfg.activationId) continue; // HARDEN-1: activación anterior → inerte
        if ((job.attempts ?? 0) >= MAX_ATTEMPTS) continue; // tope duro: intervención manual
        await db().runTransaction(async (tx) => {
          const act = coverageActivationOf(((await tx.get(cfgRef)).data() as { coverage?: unknown } | undefined)?.coverage);
          const fresh = (await tx.get(d.ref)).data() as CoverageResumeJob | undefined;
          if (!act.enabled || (fresh?.activationId ?? null) !== act.activationId) return; // kill-switch en la tx
          if (fresh?.status !== 'send_failed' || (fresh.attempts ?? 0) >= MAX_ATTEMPTS) return;
          tx.update(d.ref, { status: 'pending', leaseUntil: null, updatedAt: now });
        });
      }
      // 3c) `processing` HUÉRFANO (crash duro post-claim, lease vencido) → re-encolar: el write
      //     a pending dispara el trigger (review: sin esto quedaba muerto para siempre).
      //     HARDEN-1 (review): los de una activación ANTERIOR también se re-encolan A PROPÓSITO —
      //     el claim del consumidor los detecta stale y los deja `cancelled` limpiando la marca
      //     anti-doble-checkout en la misma transacción; saltearlos acá los dejaba huérfanos para
      //     siempre con el checkout del cliente congelado en "estamos preparando tu pedido".
      const colgados = await db().collection(`tenants/${tenantId}/coverageResumeJobs`).where('status', '==', 'processing').limit(LOTE).get();
      for (const d of colgados.docs) {
        const job = d.data() as CoverageResumeJob;
        if ((job.leaseUntil?.toMillis?.() ?? 0) > now.toMillis()) continue; // worker vivo
        await db().runTransaction(async (tx) => {
          // Kill-switch en la tx: apagado ⇒ no re-encolar (los stale SÍ se re-encolan con el
          // flag activo — el claim los cancela con limpieza; ver comentario de 3c).
          const act = coverageActivationOf(((await tx.get(cfgRef)).data() as { coverage?: unknown } | undefined)?.coverage);
          if (!act.enabled) return;
          const fresh = (await tx.get(d.ref)).data() as CoverageResumeJob | undefined;
          if (fresh?.status !== 'processing' || (fresh.leaseUntil?.toMillis?.() ?? 0) > now.toMillis()) return;
          tx.update(d.ref, { status: 'pending', leaseUntil: null, updatedAt: now });
        });
      }
      // 3d) `pending` ESTANCADO (>10 min sin procesar — p. ej. decidido con el flag apagado):
      //     el trigger no re-dispara sin transición, así que se procesa DIRECTO acá. Un pending
      //     de una activación ANTERIOR también pasa por acá A PROPÓSITO: el claim del consumidor
      //     lo detecta stale y lo deja `cancelled` (terminal, sin efectos) — convergencia sin ruido.
      const estancados = await db().collection(`tenants/${tenantId}/coverageResumeJobs`).where('status', '==', 'pending').limit(LOTE).get();
      for (const d of estancados.docs) {
        const job = d.data() as CoverageResumeJob;
        if (now.toMillis() - (job.updatedAt?.toMillis?.() ?? 0) < 10 * 60 * 1000) continue;
        await processCoverageResumeJob(tenantId, d.id);
      }

      // 4) SHIPPING-CHAT-3C-HARDEN-1/2: intentos de COTIZACIÓN abandonados. Un outbox quote que
      //    sigue `prepared` (nunca salió), `sent` (salió y nadie aplicó la aprobación) o
      //    `unknown` (sin reconciliar) más allá del umbral ⇒ SOLO una campana idempotente al
      //    equipo. CERO re-drive automático, CERO Meta, CERO aprobación/orden/PAID: un humano
      //    decide desde el panel (completar, recotizar o resolver el unknown).
      //    HARDEN-2 (B): la query indexada SOLO elige candidatos — cada campana se decide en una
      //    TRANSACCIÓN con lecturas frescas (config, outbox, request, notificación; todas antes
      //    de la única escritura): si la saga completó/reemplazó el intento en la carrera, CERO
      //    campana obsoleta. La señal aplica únicamente al intento VIGENTE de la activación vigente.
      const atascados = await db()
        .collection(`tenants/${tenantId}/coverageMessageOutbox`)
        .where('action', '==', 'quote')
        .where('status', 'in', ['prepared', 'sent', 'unknown'])
        .where('updatedAt', '<=', Timestamp.fromMillis(now.toMillis() - QUOTE_ATASCADO_MS))
        .limit(LOTE)
        .get();
      await coverageHold(tenantId, 'sweep_pre_tx'); // solo-emulador: carrera query→tx determinística
      for (const d of atascados.docs) {
        const candidato = d.data() as CoverageOutboxMessage;
        if (candidato.action !== 'quote') continue; // narrow de la unión (la query ya filtra)
        const qatCandidato = candidato.quote?.quoteAttemptId;
        if (!qatCandidato) continue; // corrupción parcial: sin nonce no hay id determinístico (fail-closed)
        const notifId = `covstuck-${candidato.coverageRequestId}-${qatCandidato}`;
        const notifRef = db().doc(`${paths.notifications(tenantId)}/${notifId}`);
        try {
          await db().runTransaction(async (tx) => {
            // TODAS las lecturas frescas EN la transacción, antes de la única escritura.
            const actTx = coverageActivationOf(((await tx.get(cfgRef)).data() as { coverage?: unknown } | undefined)?.coverage);
            const ob = (await tx.get(d.ref)).data() as CoverageOutboxMessage | undefined;
            const req = (await tx.get(db().doc(`tenants/${tenantId}/coverageRequests/${candidato.coverageRequestId}`))).data() as CoverageRequest | undefined;
            const notifSnap = await tx.get(notifRef);
            if (!actTx.enabled || !actTx.activationId) return; // kill-switch ganó en la carrera
            if (!ob || ob.action !== 'quote') return;
            if ((ob.activationId ?? null) !== actTx.activationId) return; // activación anterior: inerte
            if (ob.status !== 'prepared' && ob.status !== 'sent' && ob.status !== 'unknown') return; // la saga lo terminó
            if ((ob.updatedAt?.toMillis?.() ?? 0) > now.toMillis() - QUOTE_ATASCADO_MS) return; // ya no supera el umbral
            if (!req || req.shippingQuotePending?.quoteAttemptId !== ob.quote?.quoteAttemptId) return; // reemplazado/cerrado
            // HARDEN-2 (review): un PREPARED sobre un request ya decidido/vencido no tiene nada
            // "completable" — la campana sería obsoleta y engañosa (el retry de la saga lo cierra
            // terminal). Un SENT/UNKNOWN sí alerta SIEMPRE: el cliente pudo recibir un costo y la
            // señal humana es obligatoria aunque el request haya muerto.
            if (ob.status === 'prepared' && req.status !== 'pending_coverage_review') return;
            if (notifSnap.exists) return; // ya avisado
            tx.create(notifRef, {
              id: notifId,
              tenantId,
              category: 'handoff',
              type: 'handoff_coverage_stale',
              title: '📦 Una cotización de envío quedó a medio camino',
              body: `Un intento de cotización del cliente …${ob.customerId.slice(-4)} lleva demasiado tiempo sin completarse. Revisalo desde Conversaciones: puede requerir completar el envío, recotizar o resolver un envío sin confirmar.`,
              dedupeKey: notifId,
              customerId: ob.customerId,
              ...(req.sellerUid ? { targetUid: req.sellerUid } : {}),
              read: false,
              readAt: null,
              createdAt: Timestamp.now(),
            });
          });
        } catch (e) {
          logger.warn('Cobertura: no se pudo evaluar/avisar el intento de cotización atascado', { tenantId, requestId: candidato.coverageRequestId, error: e instanceof Error ? e.message : String(e) });
        }
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
