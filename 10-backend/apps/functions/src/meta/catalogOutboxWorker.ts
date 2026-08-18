/**
 * meta/catalogOutboxWorker.ts — Estado durable del outbox de catálogo (META-CATALOG-OUTBOX-1)
 * ============================================================================================
 * `catalogSyncApply` ya no escribe en Meta: encola. Este módulo tiene las cuatro operaciones
 * con estado, todas idempotentes y reejecutables:
 *
 *   enqueueCatalogPlan  — convierte el plan confirmado en jobs persistidos (uno por producto).
 *   drainCatalogOutbox  — reclama jobs con lease, revalida los gates y envía UN lote a Meta.
 *   reconcileCatalogOutbox — confirma (o no) contra el catálogo real lo que Meta aceptó.
 *   sweepCatalogOutbox  — red de seguridad: normaliza leases vencidos y ambigüedades viejas.
 *
 * Patrón heredado de la saga de cotización (SHIPPING-CHAT-3C/HARDEN-4), que ya está en
 * producción: claim transaccional → lease → generación inmutable (`attempts`) → settlement con
 * ownership (`settleIfOwner`) → resolución explícita de lo ambiguo. Las decisiones puras viven
 * en `catalogOutbox.ts`; acá está exclusivamente lo que toca Firestore, Meta y el reloj.
 *
 * INVARIANTES:
 *  - Un job NUNCA se envía sin revalidar config + producto DENTRO de la transacción del claim.
 *  - Un worker que perdió el claim no escribe NADA (ni estado ni Meta).
 *  - Aceptación de Meta ≠ éxito: `submitted` guarda el handle y ahí termina el envío.
 *  - Un resultado ambiguo JAMÁS se reintenta a ciegas: primero se mira el catálogo real.
 *  - Todo lo que se escribe sale del `intendedPatch` congelado: nunca se re-serializa el
 *    producto en vuelo (si cambió, el job queda `stale` y exige una confirmación nueva).
 */

import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import type { MetaCatalogSyncLog, Product } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../audit/audit.js';
import { isFeatureEnabled } from '../entitlements/decide.js';
import { resolveEntitlements } from '../entitlements/entitlements.js';
import { settleIfOwner } from '../lib/outboxFencing.js';
import { normalizeCatalogSyncConfig, type MetaCatalogSyncConfig } from './catalogSyncConfig.js';
import {
  assertBatchRequestShape,
  getMetaCatalogClientForTenant,
  type MetaCatalogClient,
  type MetaRemoteCatalogItem,
} from './catalogClient.js';
import type { CatalogBatchRequest } from './catalogOutbound.js';
import { deriveCatalogAuthority } from './catalogAuthority.js';
import { effectiveMode, type EffectiveOwnership } from './catalogOwnership.js';
import { assertPatchOwned, ownershipFingerprint } from './catalogOwnershipGates.js';
import { alertarFuenteDelCatalogo, checkCatalogSources } from './catalogSourceGate.js';
import { catalogHold } from './catalogTestHooks.js';
import {
  attentionRequiredFor,
  chunkJobsForBatch,
  classifySubmitError,
  isTerminalOutboxStatus,
  methodForAction,
  outboxGate,
  outboxIntentKey,
  outboxJobId,
  productStatusForJob,
  stableHash,
  verifyJobOutcome,
  type CatalogOutboxAction,
  type MetaCatalogOutboxIntent,
  type MetaCatalogOutboxJob,
  type MetaCatalogOutboxStatus,
  type OutboxReason,
} from './catalogOutbox.js';

/**
 * Duración del lease. Muy por encima de lo que tarda un lote (submit + status + relectura) y
 * MUY por debajo del umbral de atasco del sweep: un candidato del sweep tiene siempre el lease
 * vencido, así que los `processing` vivos no re-matchean su query en cada corrida.
 */
const LEASE_MS = 120_000;
/** Un job en vuelo más de esto es señal de que su worker murió. */
const ATASCADO_MS = 60 * 60 * 1000;
/**
 * Ventana de gracia antes de intentar confirmar un envío. `items_batch` es asíncrono: Meta
 * acepta el lote y lo procesa después. Sin esta espera, la relectura leería el estado viejo y
 * lo llamaría "divergencia confirmada".
 */
const GRACIA_CONFIRMACION_MS = 60_000;
/** Reintentos automáticos antes de pedir una decisión humana. */
const MAX_ATTEMPTS = 5;
/** Topes del lote: cantidad (alineada al plan) y bytes serializados. */
const MAX_JOBS_PER_BATCH = 100;
const MAX_BATCH_BYTES = 900_000;
/** Tope de jobs por corrida del drenaje y del sweep (costo acotado por tenant). */
const LOTE = 50;
/**
 * Consultas de estado de lote por corrida. Es un contador PROPIO, no un resto del presupuesto
 * general: derivarlo de las llamadas ya hechas significaba que un catálogo grande —cuyo
 * `listItems` paginado consume el presupuesto entero— dejaba a los envíos sin confirmar NUNCA.
 */
const MAX_BATCH_STATUS_PER_RUN = 10;
/**
 * El consumo de una corrida de confirmación queda acotado por dos cosas: la relectura del
 * catálogo (una vez, con sus páginas — es la evidencia, sin ella no se confirma nada) y el tope
 * de consultas de estado de arriba. `client.callsMade` reporta el total real.
 *
 * NO se apoya en ningún límite publicado por Meta: los límites de rate de la Graph API cambian
 * con el tiempo y con el tipo de asset, así que el sistema se acota solo en vez de asumir un
 * número que mañana podría ser falso.
 */
const jobRef = (tenantId: string, jobId: string) => db().doc(paths.metaCatalogOutboxJob(tenantId, jobId));
const jobsCol = (tenantId: string) => db().collection(paths.metaCatalogOutboxJobs(tenantId));

// ---------------------------------------------------------------------------
// Utilidades comunes
// ---------------------------------------------------------------------------

/** Config normalizada del tenant (fail-closed: sin doc ⇒ apagada). */
async function readConfig(tenantId: string): Promise<MetaCatalogSyncConfig> {
  const snap = await db().doc(`tenants/${tenantId}/config/meta`).get();
  return normalizeCatalogSyncConfig((snap.data() as { catalogSync?: unknown } | undefined)?.catalogSync);
}

/** Vista pública del producto tal como la calcula el planificador (fuente única del snapshot). */
type PublicViewFn = (p: Product) => Record<string, unknown>;

/**
 * Contexto del gate leído desde Firestore. `localPublicView` se inyecta para no crear un ciclo
 * de imports con `catalog.ts` (que es quien planifica y quien encola).
 */
function gateContextOf(tenantId: string, cfg: MetaCatalogSyncConfig, product: Product | null, publicView: PublicViewFn) {
  return {
    tenantId,
    config: { enabled: cfg.enabled, mode: cfg.mode, catalogId: cfg.catalogId },
    // La propiedad viaja SIEMPRE con la config (ya normalizada, nunca null): el gate la
    // necesita para el modo efectivo, la huella del snapshot y los campos del patch.
    ownership: cfg.ownership,
    product: product
      ? {
          exists: true,
          syncToMeta: product.syncToMeta,
          stockPendingReview: (product as Product & { stockPendingReview?: boolean }).stockPendingReview,
          snapshotHash: stableHash(publicView(product)),
        }
      : null,
  };
}

/**
 * Proyecta al producto el estado que ve el vendedor, **con fencing**: solo escribe si este job
 * sigue siendo el vigente (`metaSyncCurrentJobId`).
 *
 * POR QUÉ: los jobs terminan en cualquier orden. Un job viejo que se reconcilia tarde —porque
 * su ambigüedad recién se resolvió— reemplazaba el estado, el error, el `metaProductItemId` y
 * el `metaLastSyncAt` de un ciclo POSTERIOR ya confirmado. El job viejo conserva su derecho a
 * cerrar su propia historia (su documento y su log); lo que no puede es hablar por el presente.
 *
 * Devuelve `true` si escribió. Un producto sin `metaSyncCurrentJobId` (encolado por una versión
 * anterior, o tocado por otro camino) se considera SIN vigencia declarada y se deja intacto.
 */
async function proyectarEstado(
  tenantId: string,
  job: MetaCatalogOutboxJob,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const ref = db().doc(paths.product(tenantId, job.productId));
  try {
    return await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const vigente = (snap.data() as { metaSyncCurrentJobId?: string }).metaSyncCurrentJobId;
      if (vigente !== job.id) return false;
      // Un CIERRE TERMINAL libera la vigencia: el ciclo terminó y ya no gobierna el futuro
      // del producto. Sin esto, la convergencia del planificador (que corrige el estado
      // visible sin encolar trabajo) quedaba muerta para siempre en todo producto que alguna
      // vez tuvo un job — un descarte con el cambio ya aplicado en Meta dejaba el badge
      // clavado en "No sincronizado" sin ninguna salida.
      const liberarVigencia = isTerminalOutboxStatus(job.status) ? { metaSyncCurrentJobId: null } : {};
      // `metaCatalogId` NO se reescribe acá: lo fija el encolado. Reponerlo desde el job
      // revertiría el catálogo vigente del producto si la empresa cambió de catálogo.
      tx.set(
        ref,
        {
          metaSyncStatus: productStatusForJob(job),
          metaSyncError: job.error.slice(0, 500),
          updatedAt: Timestamp.now(),
          ...liberarVigencia,
          ...extra,
        },
        { merge: true },
      );
      return true;
    });
  } catch (e) {
    logger.error('Outbox de catálogo: no se pudo proyectar el estado del producto', e, { tenantId, productId: job.productId, jobId: job.id });
    return false;
  }
}

/**
 * Escribe `metaSyncStatus:'failed'` en un producto SOLO si no hay un ciclo vigente que gobierne
 * su estado. Es el fencing de los errores de VALIDACIÓN: un intento que ni siquiera llegó a
 * encolarse no puede pisar visualmente lo que el ciclo anterior (activo o ya confirmado) dice.
 * El error igual queda reportado en el run (`blockedCount` + entries del plan).
 */
async function proyectarErrorSinCicloVigente(tenantId: string, productId: string, detalle: string): Promise<void> {
  const ref = db().doc(paths.product(tenantId, productId));
  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const vigente = (snap.data() as { metaSyncCurrentJobId?: string | null }).metaSyncCurrentJobId;
      if (vigente) return; // el estado visible lo gobierna ese ciclo, no este error
      tx.set(ref, { metaSyncStatus: 'failed', metaSyncError: detalle.slice(0, 500), updatedAt: Timestamp.now() }, { merge: true });
    });
  } catch (e) {
    logger.warn('Outbox de catálogo: no se pudo proyectar el error de validación', { tenantId, productId, error: e instanceof Error ? e.message : 'desconocido' });
  }
}

/**
 * Cierra un job en un estado TERMINAL y crea su sync log EN LA MISMA transacción. La
 * precondición se re-evalúa adentro con el documento fresco: si el job cambió (una persona lo
 * descartó, otro worker lo cerró), NO se escribe nada — ni transición, ni log — y el llamador
 * no debe contar ni proyectar. El log usa el id del ciclo y JAMÁS se sobrescribe: si ya existe
 * (un replay), se conserva el original.
 *
 * Devuelve el job actualizado si la transición se aplicó, o null si perdió la carrera.
 */
export async function cerrarTerminalConLog(
  tenantId: string,
  job: MetaCatalogOutboxJob,
  opts: {
    precondicion: (fresco: MetaCatalogOutboxJob) => boolean;
    status: Extract<MetaCatalogOutboxStatus, 'succeeded' | 'failed'>;
    reason: OutboxReason | null;
    error: string;
    logStatus: 'success' | 'failed';
    itemId: string | null;
    extraPatch?: Record<string, unknown>;
  },
): Promise<MetaCatalogOutboxJob | null> {
  const ref = jobRef(tenantId, job.id);
  const logRef = db().doc(paths.metaCatalogSyncLog(tenantId, job.id));
  try {
    return await db().runTransaction(async (tx) => {
      const fresco = (await tx.get(ref)).data() as MetaCatalogOutboxJob | undefined;
      const logExistente = await tx.get(logRef);
      if (!fresco || !opts.precondicion(fresco)) return null;
      const now = Timestamp.now();
      tx.update(ref, {
        status: opts.status,
        reason: opts.reason,
        error: opts.error,
        attentionRequired: attentionRequiredFor(opts.status),
        reconciledAt: now,
        updatedAt: now,
        ...(opts.extraPatch ?? {}),
      });
      if (!logExistente.exists) {
        const log: MetaCatalogSyncLog = {
          id: job.id,
          tenantId,
          productId: job.productId,
          metaCatalogId: job.catalogId,
          metaProductItemId: opts.itemId,
          action: job.action,
          status: opts.logStatus,
          errorMessage: opts.error.slice(0, 500),
          createdAt: now,
        };
        tx.create(logRef, log as unknown as Record<string, unknown>);
      }
      return { ...job, status: opts.status, reason: opts.reason, error: opts.error };
    });
  } catch (e) {
    logger.warn('Outbox de catálogo: no se pudo cerrar un job con su log', { tenantId, jobId: job.id, error: e instanceof Error ? e.message : 'desconocido' });
    return null;
  }
}


// ---------------------------------------------------------------------------
// 1) Encolado
// ---------------------------------------------------------------------------

export interface EnqueueEntry {
  productId: string;
  /** Identidad remota EFECTIVA (`metaRetailerId` confirmado o SKU). */
  sku: string;
  action: CatalogOutboxAction;
  request: CatalogBatchRequest;
  /** Vista pública LOCAL del producto (snapshot del preview). */
  payload: Record<string, unknown>;
  remoteItemId?: string | null;
}

export interface EnqueueResult {
  queued: number;
  /** Confirmaciones repetidas: ya hay trabajo PENDIENTE para ese mismo cambio. */
  deduplicated: number;
  /** De los duplicados, los que están trabados esperando una revisión humana. */
  awaitingReview: number;
  /** Productos cuyo request no cumple el contrato: quedan fuera, sin arrastrar a los demás. */
  blocked: number;
  /**
   * (ADR-0022 §4, review A2) Entradas descartadas porque la RELACIÓN dejó de ser `managed`
   * entre el gate del apply y el encolado (transición de autoridad en el medio): cero jobs.
   */
  relationshipBlocked: number;
  /** false si el estado visible de algún producto no se pudo persistir (los jobs SÍ existen). */
  statePersisted: boolean;
}

/**
 * Crea un job por entrada accionable. La identidad del documento es determinística
 * La identidad tiene DOS niveles: la `intentKey` determinística identifica "este cambio
 * exacto" y se deduplica SOLO contra el trabajo activo (vía el puntero transaccional en
 * `metaCatalogOutboxIntents`); cada ejecución es un CICLO con `jobId` propio e inmutable una
 * vez terminal. Dos confirmaciones del mismo trabajo pendiente ⇒ un solo job; si el ciclo
 * anterior ya terminó, la confirmación nueva crea un job nuevo sin tocar el anterior.
 *
 * Recibe las entradas CRUDAS del plan: el recorte que persiste el run doc (`slimEntries`) tira
 * `request` y `payload`, y sin ellos no habría ni qué enviar ni contra qué verificar.
 */
export async function enqueueCatalogPlan(
  tenantId: string,
  runId: string,
  entries: readonly EnqueueEntry[],
  cfg: { catalogId: string; ownership: EffectiveOwnership },
  actor?: { uid?: string | null; role?: string | null },
): Promise<EnqueueResult> {
  const now = Timestamp.now();
  let queued = 0;
  let deduplicated = 0;
  let awaitingReview = 0;
  let blocked = 0;
  let relationshipBlocked = 0;

  // ═══ TECHO DE PROPIEDAD (ADR-0015 §7) ═══
  // Sin un solo campo propio no existe patch posible, así que tampoco existe job. Es la
  // barrera que vuelve INALCANZABLE el loop diario: con `external_managed` no hay nada que
  // encolar aunque alguien ponga `mode:'live'` por error, y aunque el plan traiga entradas.
  // No se proyecta error en los productos: no es culpa de ellos, es que el campo no es nuestro.
  const huellaPropiedad = ownershipFingerprint(cfg.ownership);
  if (!cfg.ownership.writable.length) {
    if (entries.length) {
      logger.warn('Outbox de catálogo: la propiedad efectiva no habilita ninguna escritura; nada se encola', {
        tenantId, runId, model: cfg.ownership.model, degraded: cfg.ownership.degraded, descartadas: entries.length,
      });
    }
    return { queued: 0, deduplicated: 0, awaitingReview: 0, blocked: entries.length, relationshipBlocked: 0, statePersisted: true };
  }

  for (const e of entries) {
    // Última barrera de contrato Y de propiedad ANTES de persistir: ni un patch inválido ni un
    // patch con un campo ajeno llegan al outbox. La propiedad se verifica sobre las claves
    // REALES del request, no sobre lo que el planificador creyó que iba a mandar.
    try {
      assertBatchRequestShape(e.request, `producto ${e.productId}`);
      assertPatchOwned(cfg.ownership, e.request.data, `producto ${e.productId}`);
    } catch (err) {
      blocked++;
      const detalle = err instanceof Error ? err.message.slice(0, 300) : 'request inválido';
      logger.warn('Outbox de catálogo: producto excluido del encolado por contrato', { tenantId, runId, productId: e.productId });
      // CON FENCING: este error pertenece a un intento que NI SIQUIERA se encoló. Si el
      // producto tiene un ciclo vigente (en curso o ya confirmado), su estado visible lo
      // gobierna ese ciclo — el error de la validación nueva se reporta en el run
      // (`blockedCount` + entries), no pisando lo que el vendedor ve.
      await proyectarErrorSinCicloVigente(tenantId, e.productId, detalle);
      continue;
    }

    const intendedPatch = e.request.data as Record<string, unknown>;
    const intendedContentHash = stableHash(intendedPatch);
    const intentKey = outboxIntentKey({ tenantId, catalogId: cfg.catalogId, retailerId: e.sku, action: e.action, intendedContentHash });

    /**
     * Una transacción por intención. El PUNTERO (`metaCatalogOutboxIntents/{intentKey}`) es lo
     * único que se reescribe: dice cuál es el job activo y cuántos ciclos hubo. Los JOBS son
     * inmutables — cada ciclo crea un documento nuevo con `tx.create`, así que la evidencia de
     * lo que se envió y de lo que Meta respondió no se pierde jamás.
     *
     * Deduplicar mirando la HISTORIA (como hacía la versión anterior) rompía el ciclo más
     * común del negocio: bajar el precio por promo, subirlo al terminar y volver a bajarlo
     * produce el MISMO contenido, y esa segunda promo no llegaba nunca a Meta. Deduplicar
     * mirando el trabajo ACTIVO resuelve el doble click sin borrar nada.
     */
    const r = await db().runTransaction(async (tx) => {
      // (ADR-0022 §4, review A2) RELACIÓN RE-DERIVADA CON DATOS FRESCOS, DENTRO de la
      // transacción — misma filosofía que la re-validación de propiedad del ADR-0015 §7 que
      // vive más abajo. El gate de `catalogSyncApply` corre al ARRANQUE de un job de hasta
      // 300 s: una transición de autoridad en el medio (managed → mirror/none) dejaría jobs
      // encolados bajo un modo que ya no escribe — exactamente los zombis del hallazgo A1.
      const cfgFresca = (await tx.get(db().doc(`tenants/${tenantId}/config/meta`))).data() as
        | { catalogSync?: unknown }
        | undefined;
      if (deriveCatalogAuthority(cfgFresca?.catalogSync).relationship !== 'managed') {
        return { r: 'relacion' as const, awaitingReview: false };
      }
      const intentRef = db().doc(paths.metaCatalogOutboxIntent(tenantId, intentKey));
      const intent = (await tx.get(intentRef)).data() as MetaCatalogOutboxIntent | undefined;
      const activo = intent?.activeJobId
        ? ((await tx.get(jobRef(tenantId, intent.activeJobId))).data() as MetaCatalogOutboxJob | undefined)
        : undefined;
      const productoExiste = (await tx.get(db().doc(paths.product(tenantId, e.productId)))).exists;
      // Trabajo pendiente para esta MISMA intención: la confirmación repetida no genera nada.
      // Se distingue "ya está en camino" de "está esperando que lo revises": decirle al dueño
      // "ya estaba en cola" cuando en realidad hay algo trabado esperándolo sería mentirle.
      if (activo && !isTerminalOutboxStatus(activo.status)) {
        const enRevision = activo.status === 'needs_action' || activo.status === 'needs_reconciliation';
        return { r: 'duplicado' as const, awaitingReview: enRevision };
      }

      const cycle = (intent?.cycle ?? 0) + 1;
      const id = outboxJobId(intentKey, cycle);
      const job: MetaCatalogOutboxJob = {
        id,
        intentKey,
        cycle,
        tenantId,
        catalogId: cfg.catalogId,
        productId: e.productId,
        retailerId: e.sku,
        action: e.action,
        intendedPatch,
        intendedContentHash,
        // SNAPSHOT DE PROPIEDAD congelado: el permiso con el que se aprobó este envío.
        ownershipFingerprint: huellaPropiedad,
        ownedFields: [...cfg.ownership.writable],
        productSnapshotHash: stableHash(e.payload),
        runId,
        requestedByUid: actor?.uid ?? null,
        requestedByRole: actor?.role ?? null,
        status: 'queued',
        attempts: 0,
        leaseOwner: null,
        leaseUntil: null,
        batchHandle: null,
        reason: null,
        error: '',
        attentionRequired: attentionRequiredFor('queued'),
        reviewedAt: null,
        reviewedReason: null,
        createdAt: now,
        updatedAt: now,
        submittedAt: null,
        reconciledAt: null,
      };
      // `create` (no `set`): si dos transacciones intentaran el mismo ciclo, la segunda falla
      // en vez de sobrescribir un job existente.
      tx.create(jobRef(tenantId, id), job as unknown as Record<string, unknown>);
      tx.set(intentRef, { intentKey, tenantId, activeJobId: id, cycle, updatedAt: now } satisfies MetaCatalogOutboxIntent);
      // El TOKEN DE VIGENCIA se publica en la MISMA transacción que crea el job. Escribirlo
      // después dejaba una ventana en la que el worker ya podía reclamar el job pero el
      // producto todavía no lo reconocía: toda proyección se descartaba por fencing y el
      // producto quedaba mostrando un estado viejo para siempre.
      if (productoExiste) {
        tx.set(db().doc(paths.product(tenantId, e.productId)), {
          metaSyncStatus: 'queued', metaSyncCurrentJobId: id, metaCatalogId: cfg.catalogId, metaSyncError: '', updatedAt: now,
        }, { merge: true });
      }
      return { r: 'nuevo' as const, id, awaitingReview: false };
    }).catch((err) => {
      logger.error('Outbox de catálogo: no se pudo encolar un producto', err, { tenantId, runId, productId: e.productId });
      return { r: 'error' as const, awaitingReview: false };
    });

    if (r.r === 'duplicado') {
      deduplicated++;
      if (r.awaitingReview) awaitingReview++;
    } else if (r.r === 'relacion') {
      // La relación dejó de ser `managed` mientras el apply corría: se descarta SIN proyectar
      // error en el producto (no es culpa suya — el tenant cambió de modo) y se reporta aparte.
      relationshipBlocked++;
    } else if (r.r === 'error') {
      // Un fallo de infraestructura NO es una deduplicación: contarlo como tal habría
      // reportado "ya estaba encolado" para trabajo que no existe en ninguna parte.
      blocked++;
      await proyectarErrorSinCicloVigente(tenantId, e.productId, 'no se pudo encolar el cambio');
    } else {
      // El estado visible del producto ya lo escribió la MISMA transacción que creó el job.
      queued++;
    }
  }

  if (relationshipBlocked) {
    logger.warn('Outbox de catálogo: la relación con Meta dejó de ser managed durante el apply; nada se encoló', {
      tenantId, runId, descartadas: relationshipBlocked,
    });
  }
  // El estado visible de cada producto se escribe DENTRO de la transacción que crea su job:
  // no queda ningún commit diferido que pueda fallar en silencio. Un fallo por producto ya se
  // contó como `blocked` y se reporta en el run.
  return { queued, deduplicated, awaitingReview, blocked, relationshipBlocked, statePersisted: true };
}

// ---------------------------------------------------------------------------
// 2) Drenaje: claim → revalidación → envío → settlement
// ---------------------------------------------------------------------------

interface ClaimOutcome {
  job: MetaCatalogOutboxJob;
  gen: number;
}

/**
 * Claim transaccional de UN job. Todas las lecturas antes de cualquier escritura (Admin SDK).
 * El gate se re-evalúa acá adentro con datos frescos: entre la query y esta transacción alguien
 * pudo apagar la sync, cambiar el catálogo o editar el producto.
 */
async function claimJob(
  tenantId: string,
  jobId: string,
  owner: string,
  publicView: PublicViewFn,
): Promise<ClaimOutcome | { rechazado: MetaCatalogOutboxStatus | 'ocupado' | 'inexistente' | 'no_encolado'; motivo?: OutboxReason | null }> {
  const now = Timestamp.now();
  return db().runTransaction(async (tx) => {
    const cfgSnap = await tx.get(db().doc(`tenants/${tenantId}/config/meta`));
    const snap = await tx.get(jobRef(tenantId, jobId));
    const job = snap.exists ? (snap.data() as MetaCatalogOutboxJob) : null;
    if (!job) return { rechazado: 'inexistente' as const };
    if (job.status === 'processing') {
      const lease = job.leaseUntil?.toMillis?.() ?? 0;
      if (lease > now.toMillis()) return { rechazado: 'ocupado' as const };
      // Lease vencido: el worker anterior murió. Queda AMBIGUO —pudo haber enviado— y lo
      // resuelve la reconciliación mirando el catálogo, jamás un reintento ciego.
      tx.update(snap.ref, { status: 'needs_reconciliation', reason: 'submit_ambiguous', attentionRequired: true, leaseUntil: null, leaseOwner: null, updatedAt: now });
      return { rechazado: 'needs_reconciliation' as const };
    }
    // `held` (config apagada al momento de intentarlo) vuelve a ser candidato: el gate de acá
    // abajo lo re-evalúa con la config fresca. Sin esto, apagar la sync un momento dejaba los
    // jobs retenidos para siempre — nadie los volvía a mirar.
    if (job.status !== 'queued' && job.status !== 'held') return { rechazado: 'no_encolado' as const };

    const productSnap = await tx.get(db().doc(paths.product(tenantId, job.productId)));
    const product = productSnap.exists ? ({ ...(productSnap.data() as Product), id: productSnap.id }) : null;
    const cfg = normalizeCatalogSyncConfig((cfgSnap.data() as { catalogSync?: unknown } | undefined)?.catalogSync);
    const gate = outboxGate(job, gateContextOf(tenantId, cfg, product, publicView));
    if (!gate.go) {
      tx.update(snap.ref, { status: gate.status, reason: gate.reason, attentionRequired: attentionRequiredFor(gate.status), leaseUntil: null, leaseOwner: null, updatedAt: now });
      // El motivo viaja al llamador: si la cola se vació por PROPIEDAD, reportar
      // `nothing_queued` sería mentir — había trabajo y lo frenó un permiso.
      return { rechazado: gate.status, motivo: gate.reason };
    }

    // `attempts` es la GENERACIÓN inmutable de este claim: todo settlement posterior la exige.
    const gen = (job.attempts ?? 0) + 1;
    if (gen > MAX_ATTEMPTS) {
      tx.update(snap.ref, { status: 'needs_action', reason: 'submit_ambiguous', attentionRequired: true, leaseUntil: null, leaseOwner: null, updatedAt: now });
      return { rechazado: 'needs_action' as const };
    }
    tx.update(snap.ref, {
      status: 'processing',
      attentionRequired: false,
      attempts: gen,
      leaseOwner: owner,
      leaseUntil: Timestamp.fromMillis(now.toMillis() + LEASE_MS),
      updatedAt: now,
    });
    return { job: { ...job, status: 'processing', attempts: gen }, gen };
  });
}

export interface DrainResult {
  claimed: number;
  submitted: number;
  released: number;
  failed: number;
  handles: string[];
  /** Jobs excluidos del lote porque la propiedad cambió o dejó de cubrir su patch. */
  ownershipBlocked?: number;
  /** Motivo por el que no se envió nada (si aplica). */
  skipped?: OutboxReason | 'nothing_queued' | 'client_unavailable' | 'relationship_not_managed';
}

/**
 * Drena la cola de UN tenant: reclama hasta un lote de jobs, los envía en UNA llamada a
 * `items_batch` y asienta el resultado por job. No verifica nada: la confirmación es diferida
 * (`reconcileCatalogOutbox`) porque `items_batch` es asíncrono del lado de Meta.
 */
export async function drainCatalogOutbox(
  tenantId: string,
  publicView: PublicViewFn,
  opts: { owner?: string; clientFactory?: (t: string) => Promise<MetaCatalogClient> } = {},
): Promise<DrainResult> {
  const owner = opts.owner ?? `drain_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const vacio: DrainResult = { claimed: 0, submitted: 0, released: 0, failed: 0, handles: [] };

  // Gate barato ANTES de leer la cola: con la config apagada no se toca nada.
  const cfg0 = await readConfig(tenantId);
  if (!cfg0.enabled) return { ...vacio, skipped: 'config_disabled' };
  // MODO EFECTIVO: el techo de la propiedad no lo supera la config. Un tenant gobernado por
  // un feed externo ni siquiera lee la cola — no hay nada que pueda salir.
  if (effectiveMode(cfg0.mode, cfg0.ownership) !== 'live') {
    return { ...vacio, skipped: cfg0.mode === 'live' ? 'ownership_not_writable' : 'mode_not_live' };
  }

  // Orden por `updatedAt` ASC: el más viejo primero. Ordenar por id dejaba a los jobs que
  // vuelven a la cola (rate limit) ocupando siempre los mismos lugares del lote, y los de
  // atrás no salían nunca.
  const candidatos = await jobsCol(tenantId)
    .where('status', 'in', ['queued', 'held'])
    .orderBy('updatedAt', 'asc')
    .limit(LOTE)
    .get();
  if (candidatos.empty) return { ...vacio, skipped: 'nothing_queued' };

  await catalogHold(tenantId, 'outbox_pre_claim');

  const reclamados: ClaimOutcome[] = [];
  /** Jobs que el gate rechazó: su producto también tiene que reflejar el estado nuevo. */
  const rechazados: string[] = [];
  /** Rechazos por PROPIEDAD en el claim: se reportan como tales, no como "no había nada". */
  let bloqueadosEnClaim = 0;
  let motivoClaim: OutboxReason | null = null;
  for (const d of candidatos.docs) {
    const r = await claimJob(tenantId, d.id, owner, publicView);
    if ('job' in r) {
      reclamados.push(r);
      continue;
    }
    rechazados.push(d.id);
    if (r.motivo === 'ownership_changed' || r.motivo === 'ownership_not_writable') {
      bloqueadosEnClaim++;
      motivoClaim = r.motivo;
    }
  }
  // Sin esto, un producto cuyo job quedó `cancelled`/`stale`/`held` en el claim seguía
  // mostrándose "En cola" para siempre: el estado visible nunca se enteraba.
  if (rechazados.length) await refreshProductStates(tenantId, rechazados);
  if (bloqueadosEnClaim) await alertarPropiedadCambiada(tenantId, bloqueadosEnClaim);
  if (!reclamados.length) {
    return { ...vacio, ...(bloqueadosEnClaim ? { ownershipBlocked: bloqueadosEnClaim } : {}), skipped: motivoClaim ?? 'nothing_queued' };
  }

  // El lote respeta cantidad Y bytes. Lo que no entra vuelve a la cola intacto.
  const { chunk } = chunkJobsForBatch(
    reclamados.map((r) => r.job),
    { maxJobs: MAX_JOBS_PER_BATCH, maxBytes: MAX_BATCH_BYTES },
  );
  const enLote = new Set(chunk.map((j) => j.id));
  /**
   * Devolver a la cola SIN haber enviado nada tiene que devolver también el intento. El claim
   * ya subió `attempts` a `gen`; si no se restaura, cinco caídas de token (o cinco lotes
   * sobredimensionados) agotarían el tope y mandarían a revisión humana una cola que jamás
   * llegó a tocar Meta.
   */
  const liberar = (r: ClaimOutcome) =>
    settleIfOwner(jobRef(tenantId, r.job.id), r.gen, 'processing', {
      status: 'queued',
      attentionRequired: false,
      attempts: Math.max(0, r.gen - 1),
      leaseUntil: null,
      leaseOwner: null,
    });

  // Los contadores reflejan settles PROPIOS: un `liberar` que perdió el ownership (el sweep o
  // una persona ya movieron el job) no liberó nada y no puede contarse.
  let released = 0;
  for (const r of reclamados) {
    if (enLote.has(r.job.id)) continue;
    if ((await liberar(r)).propio) released++;
  }

  let client: MetaCatalogClient;
  try {
    client = await (opts.clientFactory ?? getMetaCatalogClientForTenant)(tenantId);
  } catch (e) {
    for (const r of reclamados.filter((x) => enLote.has(x.job.id))) {
      if ((await liberar(r)).propio) released++;
    }
    logger.warn('Outbox de catálogo: sin cliente de Meta; los jobs vuelven a la cola', { tenantId, error: e instanceof Error ? e.message : 'desconocido' });
    return { ...vacio, released, skipped: 'client_unavailable' };
  }

  await catalogHold(tenantId, 'outbox_pre_submit');

  // KILL-SWITCH INMEDIATO PRE-META: la config se re-lee justo antes del POST. Entre el claim
  // y este punto alguien pudo apagar la sync, cambiar el catálogo O CAMBIAR LA PROPIEDAD, y el
  // claim ya no vale. Los jobs vuelven a la cola sin haber tocado Meta: el gate del próximo
  // claim los mandará a revisión con el motivo exacto — nunca salen con permisos viejos.
  const cfgPre = await readConfig(tenantId);
  const propiedadCambio = ownershipFingerprint(cfgPre.ownership) !== ownershipFingerprint(cfg0.ownership);
  if (!cfgPre.enabled || effectiveMode(cfgPre.mode, cfgPre.ownership) !== 'live' || cfgPre.catalogId !== cfg0.catalogId || propiedadCambio) {
    for (const r of reclamados.filter((x) => enLote.has(x.job.id))) {
      if ((await liberar(r)).propio) released++;
    }
    logger.info('Outbox de catálogo: la configuración cambió antes del envío; nada salió', { tenantId, propiedadCambio });
    const motivo: OutboxReason = !cfgPre.enabled
      ? 'config_disabled'
      : propiedadCambio
        ? 'ownership_changed'
        : cfgPre.mode === 'live'
          ? 'ownership_not_writable'
          : 'mode_not_live';
    return { ...vacio, released, skipped: motivo };
  }

  // VERIFICACIÓN DE FUENTES EXTERNAS INMEDIATAMENTE ANTES DEL POST (ADR-0015 §4). Es una
  // lectura (GET) del catálogo: si apareció una fuente que nadie reconoció, o la reconocida
  // cambió de forma, NO se escribe. Los jobs vuelven a la cola intactos (no es culpa suya) y
  // el aviso agregado queda abierto hasta que una persona decida. Jamás se desactiva un feed
  // ni se cambia el modelo de propiedad por nuestra cuenta.
  const fuentes = await verificarFuentesAntesDelPost(tenantId, cfg0.catalogId, cfgPre.ownership, client);
  if (fuentes === 'blocked') {
    for (const r of reclamados.filter((x) => enLote.has(x.job.id))) {
      if ((await liberar(r)).propio) released++;
    }
    return { ...vacio, released, skipped: 'external_source_changed' };
  }

  // REVALIDACIÓN TRANSACCIONAL COMPLETA, JOB POR JOB, INMEDIATAMENTE ANTES DE ARMAR EL LOTE.
  // No alcanza con re-chequear la propiedad del claim: entre el claim y este punto el dueño
  // pudo editar el producto, borrarlo, apagarle el opt-in o dejarle el stock en revisión. Cada
  // job que ya no corresponde se EXCLUYE individualmente y se asienta con su motivo — el resto
  // del lote sale igual.
  const vigentes: ClaimOutcome[] = [];
  const excluidos: string[] = [];
  /** Excluidos por PROPIEDAD: se alertan aparte — no son un error del producto ni de la red. */
  let ownershipBlocked = bloqueadosEnClaim;
  let motivoPropiedad: OutboxReason | null = motivoClaim;
  for (const r of reclamados) {
    if (!enLote.has(r.job.id)) continue;
    const veredicto = await revalidarAntesDelPost(tenantId, r, publicView);
    if (veredicto.ok) {
      vigentes.push(r);
      continue;
    }
    excluidos.push(r.job.id);
    if (veredicto.reason === 'ownership_changed' || veredicto.reason === 'ownership_not_writable') {
      ownershipBlocked++;
      motivoPropiedad = veredicto.reason;
    }
  }
  if (excluidos.length) await refreshProductStates(tenantId, excluidos);
  // Los rechazados EN EL CLAIM ya se alertaron arriba: acá solo los que cayeron en la
  // revalidación previa al POST (avisar dos veces por el mismo lote sería ruido).
  if (ownershipBlocked > bloqueadosEnClaim) await alertarPropiedadCambiada(tenantId, ownershipBlocked - bloqueadosEnClaim);
  // Reportar `nothing_queued` cuando la cola se vació por PROPIEDAD sería mentir: había
  // trabajo, y lo frenó un permiso. El motivo real es lo que después explica la bandeja.
  if (!vigentes.length) return { ...vacio, released, ownershipBlocked, skipped: motivoPropiedad ?? 'nothing_queued' };

  // Se envía el patch CONGELADO en el job, nunca una re-serialización del producto: si el
  // producto cambió, el gate ya lo dejó `stale` y este job no llegó hasta acá.
  const requests: CatalogBatchRequest[] = vigentes.map((r) => ({
    method: methodForAction(r.job.action),
    data: r.job.intendedPatch as { id: string } & Record<string, unknown>,
  }));

  let handles: string[] = [];
  try {
    const res = await client.submitItemsBatch(cfg0.catalogId, requests);
    handles = res.handles ?? [];
  } catch (e) {
    const clase = classifySubmitError(e);
    const detalle = e instanceof Error ? e.message.slice(0, 300) : 'items_batch falló';
    await catalogHold(tenantId, 'outbox_post_submit');
    let failed = 0;
    for (const r of vigentes) {
      if (clase === 'confirmed_not_applied') {
        // Meta rechazó la llamada: NADA se escribió. Es un fallo determinístico del contrato,
        // y como es TERMINAL, la transición y su sync log van en la MISMA transacción: un
        // `failed` sin log sería una historia incompleta. Se cuenta SOLO si el CAS aplicó.
        const cerrado = await cerrarTerminalConLog(tenantId, r.job, {
          precondicion: (fresco) => fresco.status === 'processing' && (fresco.attempts ?? 0) === r.gen,
          status: 'failed',
          reason: 'contract_violation',
          error: detalle,
          logStatus: 'failed',
          itemId: null,
          extraPatch: { leaseUntil: null, leaseOwner: null },
        });
        if (cerrado) failed++;
      } else if (clase === 'rate_limited') {
        // Tampoco se escribió, pero conviene esperar: vuelve a la cola sin consumir intentos.
        await settleIfOwner(jobRef(tenantId, r.job.id), r.gen, 'processing', { status: 'queued', reason: 'rate_limited', error: detalle, attentionRequired: false, attempts: Math.max(0, r.gen - 1), leaseUntil: null, leaseOwner: null });
      } else {
        // AMBIGUO: el POST pudo haberse aplicado. Jamás se reintenta a ciegas — lo resuelve
        // la reconciliación mirando el catálogo real. `submittedAt` se estampa ACÁ: el POST
        // efectivamente salió, y sin el ancla la ventana de gracia no protegía justo al caso
        // que existe para proteger (evaluar contra un catálogo leído antes de que Meta
        // procese el lote).
        await settleIfOwner(jobRef(tenantId, r.job.id), r.gen, 'processing', {
          status: 'needs_reconciliation', reason: 'submit_ambiguous', error: detalle,
          attentionRequired: true, submittedAt: r.job.submittedAt ?? Timestamp.now(), leaseUntil: null, leaseOwner: null,
        });
      }
    }
    await refreshProductStates(tenantId, vigentes.map((r) => r.job.id));
    return { claimed: reclamados.length, submitted: 0, released, failed, handles: [], ownershipBlocked, skipped: clase === 'rate_limited' ? 'rate_limited' : undefined };
  }

  await catalogHold(tenantId, 'outbox_post_submit');

  // ACEPTACIÓN ≠ ÉXITO. El handle se persiste ANTES de cualquier seguimiento: si el proceso
  // muere ahora, la reconciliación sabe qué batch mirar y JAMÁS reenvía.
  const handle = handles[0] ?? null;
  const submittedAt = Timestamp.now();
  let submitted = 0;
  for (const r of vigentes) {
    const s = await settleIfOwner(jobRef(tenantId, r.job.id), r.gen, 'processing', {
      status: 'submitted',
      attentionRequired: false,
      batchHandle: handle,
      submittedAt,
      reason: null,
      error: '',
      leaseUntil: null,
      leaseOwner: null,
    });
    if (s.propio) submitted++;
  }
  await refreshProductStates(tenantId, vigentes.map((r) => r.job.id));

  logger.info('Outbox de catálogo drenado', { tenantId, reclamados: reclamados.length, enviados: submitted, liberados: released });
  return { claimed: reclamados.length, submitted, released, failed: 0, handles, ownershipBlocked };
}

/**
 * Alerta por envíos frenados por la PROPIEDAD (ADR-0015 §7). Los jobs ya quedaron en
 * `needs_action` —bandeja de incidencias, `attentionRequired:true`— y nunca se reintentan
 * solos; esto deja además el rastro auditable de que hubo escrituras detenidas porque los
 * permisos cambiaron. Metadata SANEADA: cantidad y motivo, ningún artículo ni fuente.
 */
async function alertarPropiedadCambiada(tenantId: string, jobs: number): Promise<void> {
  logger.warn('Outbox de catálogo: envíos frenados porque la propiedad de los campos cambió', { tenantId, jobs });
  try {
    await recordAudit({
      tenantId,
      action: 'meta.catalog_sync',
      actorUid: null,
      actorRole: null,
      targetType: 'metaCatalogOutbox',
      targetId: `ownership_${Timestamp.now().toMillis()}`,
      summary: `Envíos frenados: la propiedad de los campos cambió (${jobs} job(s) a revisión)`,
      metadata: { jobs, reason: 'ownership_changed' },
    });
  } catch (e) {
    logger.warn('Outbox de catálogo: no se pudo auditar el bloqueo por propiedad', { tenantId, error: e instanceof Error ? e.message : 'desconocido' });
  }
}

/**
 * Verificación de FUENTES EXTERNAS justo antes del POST (ADR-0015 §4). Devuelve:
 *  - `'ok'`      — las fuentes observadas son las reconocidas (o no hay ninguna y nadie declaró
 *                  una): se puede escribir. Un aviso previo, si existía, se autocierra.
 *  - `'blocked'` — hay una fuente sin reconocer o la reconocida cambió: NO se escribe, y el
 *                  aviso agregado queda abierto (idempotente: el mismo hallazgo no re-alerta).
 *
 * Si la LECTURA falla, se devuelve `'ok'`: este chequeo detecta un cambio de gobierno, no es un
 * kill-switch de disponibilidad. Un parpadeo del Graph no puede frenar una cola que ya pasó
 * todos los gates de propiedad — esos siguen siendo los que deciden qué campo puede salir.
 */
async function verificarFuentesAntesDelPost(
  tenantId: string,
  catalogId: string,
  ownership: EffectiveOwnership,
  client: MetaCatalogClient,
): Promise<'ok' | 'blocked'> {
  try {
    const r = await checkCatalogSources({ tenantId, catalogId, ownership, client });
    await alertarFuenteDelCatalogo(tenantId, r.comparison, r.checkId);
    if (!r.blocksWrites) return 'ok';
    logger.warn('Outbox de catálogo: envío detenido — la fuente que publica el catálogo no es la reconocida', {
      tenantId,
      estado: r.comparison.status,
      // Ids NO secretos del data source. Nunca host, URL, query string ni token.
      fuentes: r.comparison.affectedSourceIds.slice(0, 5),
      listadoIncompleto: r.comparison.incompleteListing,
    });
    return 'blocked';
  } catch (e) {
    logger.warn('Outbox de catálogo: no se pudieron verificar las fuentes externas; se sigue con los gates de propiedad', {
      tenantId,
      error: e instanceof Error ? e.message.slice(0, 200) : 'desconocido',
    });
    return 'ok';
  }
}

/** Veredicto de la revalidación previa al POST. El motivo viaja para poder alertar por él. */
type VeredictoPrevio = { ok: true } | { ok: false; reason: OutboxReason | null };

/**
 * Última revalidación antes de que el job entre al lote. TRANSACCIONAL y COMPLETA: propiedad
 * del claim, estado del job, tenant, catálogo, MODO EFECTIVO, huella de la propiedad, campos
 * del patch, existencia del producto, opt-in, revisión de stock y snapshot público. Lo que ya
 * no corresponde se asienta acá mismo con su motivo.
 *
 * LÍMITE INEVITABLE: entre este commit y el POST externo hay una ventana de milisegundos. Un
 * cambio hecho exactamente ahí puede llegar a Meta igual — es irreducible sin transacciones
 * distribuidas con un sistema ajeno. Todo lo demás está cubierto: lo que se detecte después lo
 * corrige el próximo ciclo, y el job no puede declararse confirmado sin evidencia.
 */
async function revalidarAntesDelPost(
  tenantId: string,
  r: ClaimOutcome,
  publicView: PublicViewFn,
): Promise<VeredictoPrevio> {
  const ref = jobRef(tenantId, r.job.id);
  try {
    return await db().runTransaction(async (tx): Promise<VeredictoPrevio> => {
      const cfgSnap = await tx.get(db().doc(`tenants/${tenantId}/config/meta`));
      const jobSnap = await tx.get(ref);
      const job = jobSnap.exists ? (jobSnap.data() as MetaCatalogOutboxJob) : null;
      // Perdió el claim (el sweep normalizó su lease, o una persona reconcilió): cero escrituras.
      if (!job || job.status !== 'processing' || (job.attempts ?? 0) !== r.gen) return { ok: false, reason: null };

      const productSnap = await tx.get(db().doc(paths.product(tenantId, job.productId)));
      const product = productSnap.exists ? ({ ...(productSnap.data() as Product), id: productSnap.id }) : null;
      const cfg = normalizeCatalogSyncConfig((cfgSnap.data() as { catalogSync?: unknown } | undefined)?.catalogSync);
      const gate = outboxGate(job, gateContextOf(tenantId, cfg, product, publicView));
      if (gate.go) return { ok: true };
      // `held` (config apagada a mitad) NO es culpa del job y NO tocó Meta: se le devuelve el
      // intento. Sin esto, cinco apagones de configuración lo mandaban a revisión humana con
      // un motivo falso de "envío ambiguo".
      const devolverIntento = gate.status === 'held' ? { attempts: Math.max(0, r.gen - 1) } : {};
      tx.update(ref, { status: gate.status, reason: gate.reason, attentionRequired: attentionRequiredFor(gate.status), ...devolverIntento, leaseUntil: null, leaseOwner: null, updatedAt: Timestamp.now() });
      return { ok: false, reason: gate.reason };
    });
  } catch (e) {
    logger.warn('Outbox de catálogo: no se pudo revalidar un job antes del envío; vuelve a la cola', { tenantId, jobId: r.job.id, error: e instanceof Error ? e.message : 'desconocido' });
    // La revalidación falló por infraestructura: el job JAMÁS tocó Meta. Vuelve a la cola con
    // su intento devuelto y sin lease — dejarlo `processing` lo habría dejado varado hasta que
    // el sweep lo declarara ambiguo, que es exactamente lo contrario de lo que pasó.
    await settleIfOwner(ref, r.gen, 'processing', { status: 'queued', attentionRequired: false, attempts: Math.max(0, r.gen - 1), leaseUntil: null, leaseOwner: null }).catch(() => {});
    return { ok: false, reason: null };
  }
}

/**
 * Refresca el estado visible de los productos de un conjunto de jobs (best-effort, con
 * fencing) y libera el puntero de las intenciones que ya terminaron.
 */
async function refreshProductStates(tenantId: string, jobIds: readonly string[]): Promise<void> {
  for (const id of jobIds) {
    const job = (await jobRef(tenantId, id).get()).data() as MetaCatalogOutboxJob | undefined;
    if (!job) continue;
    if (isTerminalOutboxStatus(job.status)) await liberarIntent(tenantId, job);
    await proyectarEstado(tenantId, job);
  }
}

/**
 * Libera el puntero de la intención si este job sigue siendo el activo. Sin esto, un job que
 * terminó dejaría la intención bloqueada y la próxima confirmación del MISMO cambio se
 * deduplicaría contra un ciclo ya cerrado.
 */
async function liberarIntent(tenantId: string, job: Pick<MetaCatalogOutboxJob, 'id' | 'intentKey'>): Promise<void> {
  if (!job.intentKey) return;
  const ref = db().doc(paths.metaCatalogOutboxIntent(tenantId, job.intentKey));
  try {
    await db().runTransaction(async (tx) => {
      const intent = (await tx.get(ref)).data() as MetaCatalogOutboxIntent | undefined;
      if (!intent || intent.activeJobId !== job.id) return;
      tx.set(ref, { activeJobId: null, updatedAt: Timestamp.now() }, { merge: true });
    });
  } catch (e) {
    logger.warn('Outbox de catálogo: no se pudo liberar el puntero de la intención', { tenantId, intentKey: job.intentKey, error: e instanceof Error ? e.message : 'desconocido' });
  }
}

// ---------------------------------------------------------------------------
// 3) Reconciliación: confirmar contra el catálogo real
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  checked: number;
  succeeded: number;
  failed: number;
  requeued: number;
  unresolved: number;
  /**
   * Llamadas HTTP REALES a Meta que costó la confirmación: incluye cada página de `listItems`
   * y cada reintento interno de los GET. El máximo teórico por corrida es
   * `páginas_de_listItems × reintentos + MAX_BATCH_STATUS_PER_RUN × reintentos`.
   */
  metaCalls?: number;
  /** Consultas de estado de lote INTENTADAS (el tope se aplica sobre esto). */
  handlesAttempted?: number;
  /** De las intentadas, las que Meta efectivamente respondió. */
  handlesAnswered?: number;
  /** Lotes sin consultar + jobs fuera de la ventana: todo queda para la próxima corrida. */
  deferredHandles?: number;
  skipped?: 'nothing_pending' | 'catalog_unreachable' | OutboxReason;
}

/**
 * Confirma los jobs que ya salieron (`submitted`) y resuelve los ambiguos
 * (`needs_reconciliation`). Es la única función que puede declarar `succeeded`, y solo con
 * evidencia: TODOS los campos del patch `confirmed_equal` contra una relectura del catálogo.
 *
 * Para los ambiguos hace exactamente lo que pide el contrato: mirar primero. Si el artículo ya
 * coincide, el envío llegó (cerrar `succeeded`). Si difiere de forma confirmada, el reintento
 * es seguro y vuelve a la cola. Si no se puede determinar, queda para revisión humana — jamás
 * un reintento a ciegas (con `allow_upsert:false` un CREATE repetido falla por id duplicado).
 */
export async function reconcileCatalogOutbox(
  tenantId: string,
  opts: { clientFactory?: (t: string) => Promise<MetaCatalogClient>; graciaMs?: number } = {},
): Promise<ReconcileResult> {
  const gracia = opts.graciaMs ?? GRACIA_CONFIRMACION_MS;
  const base: ReconcileResult = { checked: 0, succeeded: 0, failed: 0, requeued: 0, unresolved: 0 };
  const cfg = await readConfig(tenantId);
  if (!cfg.enabled) return { ...base, skipped: 'config_disabled' };

  // Orden por antigüedad, NO por id: el id es un hash y ordenar por él dejaba a los mismos
  // jobs ocupando siempre los primeros lugares del lote — inanición real para los de atrás.
  const pend = await jobsCol(tenantId)
    .where('status', 'in', ['submitted', 'needs_reconciliation'])
    .orderBy('updatedAt', 'asc')
    .limit(LOTE)
    .get();
  if (pend.empty) return { ...base, skipped: 'nothing_pending' };

  // Jobs que esta corrida PUEDE evaluar: los `submitted` dentro de la ventana de gracia no se
  // miran todavía, así que ni ellos ni sus handles deben costar una sola llamada.
  const ahora = Timestamp.now().toMillis();
  // La gracia se mide por `submittedAt`, sin importar el estado: un `needs_reconciliation` que
  // acaba de salir es JUSTO el caso donde el POST puede seguir en vuelo del lado de Meta.
  const evaluables = pend.docs.filter((d) => {
    const j = d.data() as MetaCatalogOutboxJob;
    const salioReciente = !!j.submittedAt && ahora - (j.submittedAt.toMillis?.() ?? 0) < gracia;
    return !salioReciente;
  });
  // Todo dentro de la gracia ⇒ no se paga NI la relectura del catálogo. Pero lo diferido se
  // DECLARA: reportar cero pendientes cuando hay una cola entera esperando sería mentir.
  if (!evaluables.length) return { ...base, skipped: 'nothing_pending', metaCalls: 0, deferredHandles: pend.size };

  await catalogHold(tenantId, 'outbox_pre_verify');

  let client: MetaCatalogClient | undefined;
  let remotos: MetaRemoteCatalogItem[];
  try {
    client = await (opts.clientFactory ?? getMetaCatalogClientForTenant)(tenantId);
    remotos = await client.listItems(cfg.catalogId);
  } catch (e) {
    // Sin relectura no se confirma NADA: los jobs quedan donde están y se reintenta después.
    // Las llamadas que SÍ se hicieron se reportan igual — justo cuando la API falla es cuando
    // más importa saber cuánto se está gastando.
    logger.warn('Outbox de catálogo: no se pudo releer el catálogo para confirmar', { tenantId, error: e instanceof Error ? e.message : 'desconocido' });
    return { ...base, skipped: 'catalog_unreachable', metaCalls: client?.callsMade ?? 0 };
  }
  const cli = client; // asignado: el try de arriba retornó en el catch si falló
  const porRetailer = new Map(remotos.filter((r) => r.retailerId).map((r) => [r.retailerId, r]));

  // Errores por item que Meta ya haya reportado para los batches involucrados (best-effort).
  // TOPE DE CONSULTAS DE ESTADO. Consultar el estado de CADA handle sin límite hacía que el
  // consumo creciera con la cola, sin techo. El tope es un contador propio y ABSOLUTO: los
  // handles se consultan en el orden de la cola (jobs más viejos primero) y los que no entran
  // hoy entran mañana, con sus jobs INTACTOS —sin marca de error ni consumo de intentos—.
  // Nadie se queda esperando para siempre.
  const itemErrors = new Map<string, string>();
  // Solo los handles de los jobs que SÍ se van a evaluar: pagar por el handle de un job que
  // está en su ventana de gracia gastaba presupuesto y tiraba el resultado.
  const handles = [...new Set(evaluables.map((d) => (d.data() as MetaCatalogOutboxJob).batchHandle).filter((h): h is string => !!h))];
  // El tope se aplica a los INTENTOS, no a las respuestas exitosas: si Meta contesta 5xx a
  // todo, contar solo los éxitos habría intentado la cola completa igual — un tope que no
  // topaba nada justo cuando la API está en problemas.
  const handlesIntentados = new Set<string>();
  const handlesConsultados = new Set<string>();
  for (const h of handles) {
    if (handlesIntentados.size >= MAX_BATCH_STATUS_PER_RUN) {
      logger.info('Outbox de catálogo: tope de consultas de estado alcanzado; el resto queda para la próxima corrida', {
        tenantId,
        intentados: handlesIntentados.size,
        pendientes: handles.length - handlesIntentados.size,
      });
      break;
    }
    // El presupuesto se consume ANTES de llamar: una llamada que falla también costó.
    handlesIntentados.add(h);
    try {
      for (const err of (await cli.getBatchStatus(cfg.catalogId, h)).errors) {
        if (err.retailerId) itemErrors.set(`${h}|${err.retailerId}`, err.message);
      }
      // "Consultado" = Meta RESPONDIÓ. Un intento fallido no habilita a evaluar sus jobs:
      // tratar "sin datos" como "sin errores" habría confirmado envíos que Meta rechazó.
      handlesConsultados.add(h);
    } catch {
      logger.warn('Outbox de catálogo: no se pudo consultar el estado de un lote; sus jobs quedan para la próxima corrida', { tenantId });
    }
  }

  const out = { ...base };
  for (const d of evaluables) {
    const job = d.data() as MetaCatalogOutboxJob;
    if (job.tenantId !== tenantId) continue; // aislamiento: nunca se toca un job ajeno
    // El catálogo cambió desde que este job salió: lo que estamos leyendo NO es el catálogo al
    // que se envió, así que no puede confirmar ni desmentir nada.
    if (job.catalogId !== cfg.catalogId) {
      const ok = await db().runTransaction(async (tx) => {
        const fresco = (await tx.get(d.ref)).data() as MetaCatalogOutboxJob | undefined;
        if (!fresco || fresco.status !== job.status) return false;
        tx.update(d.ref, { status: 'needs_action', reason: 'catalog_mismatch', attentionRequired: true, updatedAt: Timestamp.now() });
        return true;
      }).catch(() => false);
      if (ok) {
        // Es una transición REAL a revisión humana: se cuenta como no resuelta igual que las
        // demás — sin esto los `catalog_mismatch` desaparecían de todo contador y auditoría.
        out.unresolved++;
        await proyectarEstado(tenantId, { ...job, status: 'needs_action', reason: 'catalog_mismatch' });
      }
      continue;
    }
    // Su handle no entró en el presupuesto de esta corrida: sin el estado del batch no se
    // puede distinguir "Meta lo rechazó" de "Meta todavía no contestó". Se deja INTACTO.
    if (job.batchHandle && !handlesConsultados.has(job.batchHandle)) continue;
    out.checked++;
    const remoto = porRetailer.get(job.retailerId) ?? null;
    const itemErr = job.batchHandle ? itemErrors.get(`${job.batchHandle}|${job.retailerId}`) : undefined;
    const verif = verifyJobOutcome(job.intendedPatch, remoto);

    // DECISIÓN (todavía sin efectos): qué transición corresponde según la evidencia. Los
    // contadores NO se tocan acá — solo cuentan las transiciones que se APLICARON de verdad.
    let status: MetaCatalogOutboxStatus;
    let reason: OutboxReason | null = null;
    let error = '';
    if (itemErr) {
      // Meta rechazó ESTE artículo: el resto del lote no se ve afectado.
      status = 'failed';
      reason = 'item_rejected';
      error = itemErr.slice(0, 500);
    } else if (verif.outcome === 'confirmed_equal') {
      status = 'succeeded';
    } else if (verif.outcome === 'confirmed_different') {
      // Un CREATE cuyo artículo YA existe en Meta no se puede repetir: con `allow_upsert:false`
      // Meta lo rechaza por id duplicado y el job quedaría `failed` por un artículo que en
      // realidad se creó bien. La divergencia que quede es materia del próximo preview (un
      // UPDATE), no de reenviar la creación.
      const createYaAplicado = job.action === 'create' && !!remoto;
      const viejo = Timestamp.now().toMillis() - (job.updatedAt?.toMillis?.() ?? 0) > ATASCADO_MS;
      if (job.status === 'needs_reconciliation' && (job.attempts ?? 0) < MAX_ATTEMPTS && !createYaAplicado) {
        // Ambigüedad resuelta: Meta NO tiene lo nuestro ⇒ el reintento es seguro.
        status = 'queued';
        reason = 'remote_differs';
      } else if (job.status === 'submitted' && !viejo) {
        // El batch fue ACEPTADO y "distinto" puede significar simplemente "Meta todavía no lo
        // procesó" — `getBatchStatus` no expone el estado de procesamiento, solo errores.
        // Escalarlo ya sería declarar una divergencia sin saber si el lote terminó: queda como
        // pendiente de reconciliación y se re-mira en la próxima corrida. Si envejece sin
        // resolverse, recién ahí pasa a revisión humana.
        status = 'needs_reconciliation';
        reason = 'submit_ambiguous';
      } else {
        // Salió hace rato y Meta quedó distinto: alguien más lo editó o Meta aplicó otra cosa.
        status = 'needs_action';
        reason = 'remote_differs';
      }
    } else {
      // Sin evidencia. `submitted` espera; un ambiguo viejo pasa a decisión humana.
      const viejo = Timestamp.now().toMillis() - (job.updatedAt?.toMillis?.() ?? 0) > ATASCADO_MS;
      // NO se reescribe un job que sigue igual: tocar `updatedAt` en cada pasada haría que un
      // ambiguo sin evidencia rejuveneciera para siempre y jamás escalara a revisión humana.
      if (!viejo) continue;
      status = 'needs_action';
      // Se PRESERVA el motivo original: que la relectura tampoco aclare nada no borra el
      // hecho de que el envío quedó ambiguo — es la información que necesita quien lo revise.
      reason = job.reason ?? 'verification_unavailable';
    }

    // APLICACIÓN. La precondición se re-evalúa DENTRO de la transacción: entre la query y esta
    // escritura una persona pudo descartar el job desde el panel, o el sweep pudo moverlo. Un
    // `update` ciego resucitaba un job cancelado —y en el camino habría reenviado a Meta un
    // cambio que el dueño acababa de descartar. Las transiciones TERMINALES (`succeeded`,
    // `failed`) escriben su sync log EN LA MISMA transacción: nunca un terminal sin historia.
    let asentado: MetaCatalogOutboxJob | null = null;
    if (status === 'succeeded' || status === 'failed') {
      asentado = await cerrarTerminalConLog(tenantId, job, {
        precondicion: (fresco) => fresco.status === job.status,
        status,
        reason,
        error,
        logStatus: status === 'succeeded' ? 'success' : 'failed',
        itemId: remoto?.id ?? null,
      });
    } else {
      asentado = await db().runTransaction(async (tx) => {
        const fresco = (await tx.get(d.ref)).data() as MetaCatalogOutboxJob | undefined;
        if (!fresco || fresco.status !== job.status) return null;
        tx.update(d.ref, { status, reason, error, attentionRequired: attentionRequiredFor(status), reconciledAt: Timestamp.now(), updatedAt: Timestamp.now() });
        return { ...job, status, reason, error };
      }).catch(() => null);
    }
    // Perdió la carrera: NADA se cuenta, nada se proyecta, ningún log. El estado que quedó lo
    // escribió quien ganó, y esta corrida no puede atribuirse su resultado.
    if (!asentado) continue;

    // Los contadores recién ahora: reflejan transiciones REALES, no intenciones.
    if (status === 'succeeded') out.succeeded++;
    else if (status === 'failed') out.failed++;
    else if (status === 'queued') out.requeued++;
    else out.unresolved++;

    // Un job que llegó a un estado terminal suelta el puntero de su intención: recién ahí la
    // MISMA confirmación puede volver a ejecutarse como un ciclo nuevo.
    if (isTerminalOutboxStatus(status)) await liberarIntent(tenantId, job);
    // El estado visible se proyecta CON FENCING: si mientras tanto se encoló un ciclo nuevo,
    // este job cierra su historia (documento + log) pero no habla por el presente.
    await proyectarEstado(tenantId, asentado, {
      ...(remoto ? { metaProductItemId: remoto.id } : {}),
      ...(status === 'succeeded' ? { metaLastSyncAt: Timestamp.now() } : {}),
    });
  }

  if (out.succeeded > 0) {
    await recordAudit({
      tenantId,
      action: 'meta.catalog_sync',
      actorUid: null,
      actorRole: null,
      targetType: 'metaCatalogOutbox',
      targetId: `reconcile_${Timestamp.now().toMillis()}`,
      summary: `Outbox de catálogo confirmado: ${out.succeeded} artículo(s)`,
      metadata: { checked: out.checked, succeeded: out.succeeded, failed: out.failed, requeued: out.requeued, unresolved: out.unresolved },
    });
  }
  // Observabilidad honesta: `metaCalls` cuenta cada request HTTP real (incluye las páginas de
  // `listItems` y los reintentos internos de los GET); intentados ≠ respondidos cuando la API
  // está fallando; y los diferidos incluyen tanto los lotes que no entraron en el tope como
  // los jobs que ni siquiera entraron en la ventana de la query.
  out.metaCalls = cli.callsMade;
  out.handlesAttempted = handlesIntentados.size;
  out.handlesAnswered = handlesConsultados.size;
  out.deferredHandles = handles.length - handlesConsultados.size + Math.max(0, pend.size - evaluables.length);
  return out;
}

// ---------------------------------------------------------------------------
// 4) Sweep: red de seguridad
// ---------------------------------------------------------------------------

export interface SweepResult {
  normalized: number;
  aged: number;
}

/**
 * Normaliza lo que ningún worker vivo va a tocar:
 *  - `processing` con lease vencido ⇒ `needs_reconciliation` (pudo haber enviado).
 *  - `needs_reconciliation` viejo ⇒ `needs_action` (ya no converge solo: lo mira una persona).
 * Reejecutable: cada transición se re-verifica dentro de su propia transacción.
 */
export async function sweepCatalogOutbox(tenantId: string): Promise<SweepResult> {
  const now = Timestamp.now();
  const out: SweepResult = { normalized: 0, aged: 0 };

  const enVuelo = await jobsCol(tenantId).where('status', '==', 'processing').orderBy(FieldPath.documentId()).limit(LOTE).get();
  for (const d of enVuelo.docs) {
    await catalogHold(tenantId, 'outbox_sweep_pre_tx');
    // El contador solo sube si la transacción REALMENTE hizo la transición: contar cada
    // intento reportaba trabajo que no ocurrió (un lease vigente no se toca) y volvía inútil
    // la métrica para diagnosticar.
    await db().runTransaction(async (tx) => {
      const fresco = (await tx.get(d.ref)).data() as MetaCatalogOutboxJob | undefined;
      if (!fresco || fresco.status !== 'processing') return false;
      if ((fresco.leaseUntil?.toMillis?.() ?? 0) > now.toMillis()) return false; // lease vigente: intocable
      tx.update(d.ref, { status: 'needs_reconciliation', reason: 'submit_ambiguous', attentionRequired: true, leaseUntil: null, leaseOwner: null, updatedAt: Timestamp.now() });
      return true;
    }).then((hubo) => { if (hubo) out.normalized++; }).catch((e) => {
      logger.warn('Outbox de catálogo: no se pudo normalizar un job en vuelo', { tenantId, jobId: d.id, error: e instanceof Error ? e.message : 'desconocido' });
    });
  }

  // Los envejecidos incluyen a los `submitted`: si la confirmación no pudo cerrarlos en una
  // hora —porque `listItems` falla en toda corrida, o porque su handle nunca responde y
  // monopoliza el tope de intentos—, escalan a revisión humana IGUAL. El sweep no necesita a
  // Meta para esto, así que una evidencia permanentemente inaccesible ya no puede congelar
  // jobs para siempre ni dejar que diez handles muertos produzcan inanición total.
  const ambiguos = await jobsCol(tenantId)
    .where('status', 'in', ['needs_reconciliation', 'submitted'])
    .where('updatedAt', '<=', Timestamp.fromMillis(now.toMillis() - ATASCADO_MS))
    .limit(LOTE)
    .get();
  for (const d of ambiguos.docs) {
    await db().runTransaction(async (tx) => {
      const fresco = (await tx.get(d.ref)).data() as MetaCatalogOutboxJob | undefined;
      if (!fresco || (fresco.status !== 'needs_reconciliation' && fresco.status !== 'submitted')) return false;
      if ((fresco.updatedAt?.toMillis?.() ?? 0) > now.toMillis() - ATASCADO_MS) return false;
      // Se preserva el motivo original del ambiguo: por qué quedó así es lo que necesita saber
      // quien lo revise, no el hecho genérico de que no se pudo verificar.
      tx.update(d.ref, { status: 'needs_action', reason: fresco.reason ?? 'verification_unavailable', attentionRequired: true, updatedAt: Timestamp.now() });
      return true;
    }).then((hubo) => { if (hubo) out.aged++; }).catch(() => {});
  }

  if (out.normalized || out.aged) logger.info('Outbox de catálogo: sweep', { tenantId, ...out });
  return out;
}

// ---------------------------------------------------------------------------
// Mantenimiento por tenant (lo llama el scheduler y el endpoint dev)
// ---------------------------------------------------------------------------

export interface OutboxMaintenanceResult {
  tenantId: string;
  drain: DrainResult;
  reconcile: ReconcileResult;
  sweep: SweepResult;
}

export async function runCatalogOutboxForTenant(
  tenantId: string,
  publicView: PublicViewFn,
  opts: { graciaMs?: number; skipDrain?: boolean } = {},
): Promise<OutboxMaintenanceResult> {
  const vacio: OutboxMaintenanceResult = {
    tenantId,
    drain: { claimed: 0, submitted: 0, released: 0, failed: 0, handles: [] },
    reconcile: { checked: 0, succeeded: 0, failed: 0, requeued: 0, unresolved: 0 },
    sweep: { normalized: 0, aged: 0 },
  };
  // El drenaje corre FUERA del callable que lo originó: los entitlements se re-verifican acá,
  // si no un tenant degradado seguiría escribiendo en Meta por la cola vieja.
  //
  // Se consulta SIN auditar: `assertFeatureEnabled` deja un registro de bloqueo por cada
  // llamada, y este job corre cada 5 minutos sobre TODOS los tenants — habría llenado de
  // ruido la auditoría de las empresas que ni siquiera usan el catálogo.
  const ent = await resolveEntitlements(tenantId);
  if (!isFeatureEnabled(ent.features, 'marketingAutomation')) {
    return { ...vacio, drain: { ...vacio.drain, skipped: 'config_disabled' } };
  }
  // (ADR-0022 §4, review A1) El gate por RELACIÓN cubre SOLO el drenaje — la única fase que
  // ESCRIBE en Meta. El sweep (normaliza leases vencidos y envejece ambiguos: puro Firestore)
  // y la confirmación (solo LEE el catálogo para cerrar `submitted` con evidencia) corren
  // SIEMPRE: saltearlos dejaba jobs no-terminales ZOMBIS bajo mirror/none que nadie podía
  // mover y que bloqueaban (`outbox_not_terminal`) el REGRESO a managed — un deadlock.
  const sweep = await sweepCatalogOutbox(tenantId);
  const drain = opts.skipDrain
    ? { ...vacio.drain, skipped: 'relationship_not_managed' as const }
    : await drainCatalogOutbox(tenantId, publicView);
  const reconcile = await reconcileCatalogOutbox(tenantId, { graciaMs: opts.graciaMs });
  return { tenantId, drain, reconcile, sweep };
}
