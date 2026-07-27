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
import { catalogHold } from './catalogTestHooks.js';
import {
  chunkJobsForBatch,
  classifySubmitError,
  isTerminalOutboxStatus,
  methodForAction,
  outboxGate,
  outboxJobId,
  productStatusForJob,
  stableHash,
  verifyJobOutcome,
  type CatalogOutboxAction,
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
const STATE_COMMIT_CHUNK = 200;

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

/** Escribe el estado que ve el vendedor. Nunca toca `syncToMeta` (es decisión administrativa). */
function productStateOp(tenantId: string, job: MetaCatalogOutboxJob, extra: Record<string, unknown> = {}) {
  return {
    path: paths.product(tenantId, job.productId),
    data: {
      metaSyncStatus: productStatusForJob(job),
      metaCatalogId: job.catalogId,
      metaSyncError: job.error.slice(0, 500),
      updatedAt: Timestamp.now(),
      ...extra,
    },
  };
}

async function commitOps(tenantId: string, ops: Array<{ path: string; data: Record<string, unknown> }>): Promise<boolean> {
  for (let i = 0; i < ops.length; i += STATE_COMMIT_CHUNK) {
    const writer = db().batch();
    for (const op of ops.slice(i, i + STATE_COMMIT_CHUNK)) writer.set(db().doc(op.path), op.data, { merge: true });
    try {
      await writer.commit();
    } catch (e) {
      logger.error('Outbox de catálogo: no se pudo persistir el estado de los productos', e, { tenantId, desde: i });
      return false;
    }
  }
  return true;
}

function syncLogOp(tenantId: string, job: MetaCatalogOutboxJob, status: 'success' | 'failed', itemId: string | null) {
  // Un log por JOB (id determinístico): dos drenajes del mismo job no duplican historial.
  const log: MetaCatalogSyncLog = {
    id: job.id,
    tenantId,
    productId: job.productId,
    metaCatalogId: job.catalogId,
    metaProductItemId: itemId,
    action: job.action,
    status,
    errorMessage: job.error.slice(0, 500),
    createdAt: Timestamp.now(),
  };
  return { path: paths.metaCatalogSyncLog(tenantId, log.id), data: log as unknown as Record<string, unknown> };
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
  /** Confirmaciones repetidas: el job ya existía con el MISMO contenido. */
  deduplicated: number;
  /** Productos cuyo request no cumple el contrato: quedan fuera, sin arrastrar a los demás. */
  blocked: number;
}

/**
 * Crea un job por entrada accionable. La identidad del documento es determinística
 * (`outboxJobId`), así que **dos confirmaciones idénticas producen un solo job**: la segunda
 * choca contra el `create()` y se cuenta como duplicada, SIN tocar el job existente (que puede
 * estar en cualquier estado, incluso terminal).
 *
 * Recibe las entradas CRUDAS del plan: el recorte que persiste el run doc (`slimEntries`) tira
 * `request` y `payload`, y sin ellos no habría ni qué enviar ni contra qué verificar.
 */
export async function enqueueCatalogPlan(
  tenantId: string,
  runId: string,
  entries: readonly EnqueueEntry[],
  cfg: { catalogId: string },
  actor?: { uid?: string | null; role?: string | null },
): Promise<EnqueueResult> {
  const now = Timestamp.now();
  let queued = 0;
  let deduplicated = 0;
  let blocked = 0;
  const productOps: Array<{ path: string; data: Record<string, unknown> }> = [];

  for (const e of entries) {
    // Última barrera de contrato ANTES de persistir: un patch inválido no llega ni al outbox.
    try {
      assertBatchRequestShape(e.request, `producto ${e.productId}`);
    } catch (err) {
      blocked++;
      const detalle = err instanceof Error ? err.message.slice(0, 300) : 'request inválido';
      logger.warn('Outbox de catálogo: producto excluido del encolado por contrato', { tenantId, runId, productId: e.productId });
      productOps.push({
        path: paths.product(tenantId, e.productId),
        data: { metaSyncStatus: 'failed', metaSyncError: detalle, updatedAt: now },
      });
      continue;
    }

    const intendedPatch = e.request.data as Record<string, unknown>;
    const intendedContentHash = stableHash(intendedPatch);
    const id = outboxJobId({ tenantId, catalogId: cfg.catalogId, retailerId: e.sku, action: e.action, intendedContentHash });
    const job: MetaCatalogOutboxJob = {
      id,
      tenantId,
      catalogId: cfg.catalogId,
      productId: e.productId,
      retailerId: e.sku,
      action: e.action,
      intendedPatch,
      intendedContentHash,
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
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      reconciledAt: null,
    };
    // La creación va en transacción para poder distinguir "ya está encolado" de "quedó
    // cerrado y el dueño lo está reintentando", sin carrera entre la lectura y la escritura.
    const r = await db().runTransaction(async (tx) => {
      const ref = jobRef(tenantId, id);
      const previo = (await tx.get(ref)).data() as MetaCatalogOutboxJob | undefined;
      if (!previo) {
        tx.create(ref, job as unknown as Record<string, unknown>);
        return 'nuevo' as const;
      }
      // Ya está en vuelo (o esperando): la confirmación repetida NO genera trabajo nuevo.
      // La deduplicación es sobre trabajo PENDIENTE, jamás sobre historia.
      if (!isTerminalOutboxStatus(previo.status)) return 'duplicado' as const;
      // Terminal (incluido `succeeded`): se REABRE. El plan que originó esta confirmación se
      // calculó contra una relectura FRESCA de Meta, así que que la entrada sea accionable es
      // prueba de que el catálogo remoto HOY no tiene este contenido. Tratar un `succeeded`
      // viejo como "ya está hecho" rompía el ciclo más común del negocio: bajar el precio por
      // promo, subirlo al terminar y volver a bajarlo produce el MISMO patch que la primera
      // vez, y la segunda promo no llegaba nunca a Meta —con el panel informando "ya estaba
      // encolado"—. Lo mismo con agotar stock, reponer y volver a agotar.
      tx.set(ref, { ...job, createdAt: previo.createdAt } as unknown as Record<string, unknown>);
      return 'reabierto' as const;
    }).catch((err) => {
      logger.error('Outbox de catálogo: no se pudo encolar un producto', err, { tenantId, runId, productId: e.productId });
      return 'error' as const;
    });

    if (r === 'duplicado') {
      deduplicated++;
    } else if (r === 'error') {
      // Un fallo de infraestructura NO es una deduplicación: contarlo como tal habría
      // reportado "ya estaba encolado" para trabajo que no existe en ninguna parte.
      blocked++;
      productOps.push({
        path: paths.product(tenantId, e.productId),
        data: { metaSyncStatus: 'failed', metaSyncError: 'no se pudo encolar el cambio', updatedAt: now },
      });
    } else {
      queued++;
      productOps.push({
        path: paths.product(tenantId, e.productId),
        data: { metaSyncStatus: 'queued', metaCatalogId: cfg.catalogId, metaSyncError: '', updatedAt: now },
      });
    }
  }

  await commitOps(tenantId, productOps);
  return { queued, deduplicated, blocked };
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
): Promise<ClaimOutcome | { rechazado: MetaCatalogOutboxStatus | 'ocupado' | 'inexistente' | 'no_encolado' }> {
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
      tx.update(snap.ref, { status: 'needs_reconciliation', reason: 'submit_ambiguous', leaseUntil: null, leaseOwner: null, updatedAt: now });
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
      tx.update(snap.ref, { status: gate.status, reason: gate.reason, leaseUntil: null, leaseOwner: null, updatedAt: now });
      return { rechazado: gate.status };
    }

    // `attempts` es la GENERACIÓN inmutable de este claim: todo settlement posterior la exige.
    const gen = (job.attempts ?? 0) + 1;
    if (gen > MAX_ATTEMPTS) {
      tx.update(snap.ref, { status: 'needs_action', reason: 'submit_ambiguous', leaseUntil: null, leaseOwner: null, updatedAt: now });
      return { rechazado: 'needs_action' as const };
    }
    tx.update(snap.ref, {
      status: 'processing',
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
  /** Motivo por el que no se envió nada (si aplica). */
  skipped?: OutboxReason | 'nothing_queued' | 'client_unavailable';
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
  if (cfg0.mode !== 'live') return { ...vacio, skipped: 'mode_not_live' };

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
  for (const d of candidatos.docs) {
    const r = await claimJob(tenantId, d.id, owner, publicView);
    if ('job' in r) reclamados.push(r);
    else rechazados.push(d.id);
  }
  // Sin esto, un producto cuyo job quedó `cancelled`/`stale`/`held` en el claim seguía
  // mostrándose "En cola" para siempre: el estado visible nunca se enteraba.
  if (rechazados.length) await refreshProductStates(tenantId, rechazados);
  if (!reclamados.length) return { ...vacio, skipped: 'nothing_queued' };

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
      attempts: Math.max(0, r.gen - 1),
      leaseUntil: null,
      leaseOwner: null,
    });

  let released = 0;
  for (const r of reclamados) {
    if (enLote.has(r.job.id)) continue;
    await liberar(r);
    released++;
  }

  let client: MetaCatalogClient;
  try {
    client = await (opts.clientFactory ?? getMetaCatalogClientForTenant)(tenantId);
  } catch (e) {
    for (const r of reclamados.filter((x) => enLote.has(x.job.id))) await liberar(r);
    logger.warn('Outbox de catálogo: sin cliente de Meta; los jobs vuelven a la cola', { tenantId, error: e instanceof Error ? e.message : 'desconocido' });
    return { ...vacio, released: reclamados.length, skipped: 'client_unavailable' };
  }

  await catalogHold(tenantId, 'outbox_pre_submit');

  // KILL-SWITCH INMEDIATO PRE-META: la config se re-lee justo antes del POST. Entre el claim
  // y este punto alguien pudo apagar la sync o cambiar el catálogo, y el claim ya no vale.
  const cfgPre = await readConfig(tenantId);
  if (!cfgPre.enabled || cfgPre.mode !== 'live' || cfgPre.catalogId !== cfg0.catalogId) {
    for (const r of reclamados.filter((x) => enLote.has(x.job.id))) await liberar(r);
    logger.info('Outbox de catálogo: la configuración cambió antes del envío; nada salió', { tenantId });
    return { ...vacio, released: reclamados.length, skipped: !cfgPre.enabled ? 'config_disabled' : 'mode_not_live' };
  }

  // RE-CHEQUEO DE OWNERSHIP inmediato pre-Meta: si este worker perdió el claim (el sweep
  // normalizó su lease vencido, o una persona reconcilió), NO se envía NADA.
  const vigentes: ClaimOutcome[] = [];
  for (const r of reclamados) {
    if (!enLote.has(r.job.id)) continue;
    const fresco = (await jobRef(tenantId, r.job.id).get()).data() as MetaCatalogOutboxJob | undefined;
    if (fresco?.status === 'processing' && (fresco.attempts ?? 0) === r.gen) vigentes.push(r);
  }
  if (!vigentes.length) return { ...vacio, released, skipped: 'nothing_queued' };

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
    for (const r of vigentes) {
      if (clase === 'confirmed_not_applied') {
        // Meta rechazó la llamada: NADA se escribió. Es un fallo determinístico del contrato.
        await settleIfOwner(jobRef(tenantId, r.job.id), r.gen, 'processing', { status: 'failed', reason: 'contract_violation', error: detalle, leaseUntil: null, leaseOwner: null });
      } else if (clase === 'rate_limited') {
        // Tampoco se escribió, pero conviene esperar: vuelve a la cola sin consumir intentos.
        await settleIfOwner(jobRef(tenantId, r.job.id), r.gen, 'processing', { status: 'queued', reason: 'rate_limited', error: detalle, attempts: Math.max(0, r.gen - 1), leaseUntil: null, leaseOwner: null });
      } else {
        // AMBIGUO: el POST pudo haberse aplicado. Jamás se reintenta a ciegas — lo resuelve
        // la reconciliación mirando el catálogo real.
        await settleIfOwner(jobRef(tenantId, r.job.id), r.gen, 'processing', { status: 'needs_reconciliation', reason: 'submit_ambiguous', error: detalle, leaseUntil: null, leaseOwner: null });
      }
    }
    const failed = clase === 'confirmed_not_applied' ? vigentes.length : 0;
    await refreshProductStates(tenantId, vigentes.map((r) => r.job.id));
    return { claimed: reclamados.length, submitted: 0, released, failed, handles: [], skipped: clase === 'rate_limited' ? 'rate_limited' : undefined };
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
  return { claimed: reclamados.length, submitted, released, failed: 0, handles };
}

/** Refresca el estado visible de los productos de un conjunto de jobs (best-effort). */
async function refreshProductStates(tenantId: string, jobIds: readonly string[]): Promise<void> {
  const ops: Array<{ path: string; data: Record<string, unknown> }> = [];
  for (const id of jobIds) {
    const job = (await jobRef(tenantId, id).get()).data() as MetaCatalogOutboxJob | undefined;
    if (job) ops.push(productStateOp(tenantId, job));
  }
  await commitOps(tenantId, ops);
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

  const pend = await jobsCol(tenantId)
    .where('status', 'in', ['submitted', 'needs_reconciliation'])
    .orderBy(FieldPath.documentId())
    .limit(LOTE)
    .get();
  if (pend.empty) return { ...base, skipped: 'nothing_pending' };

  await catalogHold(tenantId, 'outbox_pre_verify');

  let client: MetaCatalogClient;
  let remotos: MetaRemoteCatalogItem[];
  try {
    client = await (opts.clientFactory ?? getMetaCatalogClientForTenant)(tenantId);
    remotos = await client.listItems(cfg.catalogId);
  } catch (e) {
    // Sin relectura no se confirma NADA: los jobs quedan donde están y se reintenta después.
    logger.warn('Outbox de catálogo: no se pudo releer el catálogo para confirmar', { tenantId, error: e instanceof Error ? e.message : 'desconocido' });
    return { ...base, skipped: 'catalog_unreachable' };
  }
  const porRetailer = new Map(remotos.filter((r) => r.retailerId).map((r) => [r.retailerId, r]));

  // Errores por item que Meta ya haya reportado para los batches involucrados (best-effort).
  // La clave es handle+retailerId, no solo el retailerId: dos lotes distintos pueden incluir
  // el mismo artículo, y atribuirle a un job el error de OTRO batch sería inventar una falla.
  const itemErrors = new Map<string, string>();
  const handles = [...new Set(pend.docs.map((d) => (d.data() as MetaCatalogOutboxJob).batchHandle).filter((h): h is string => !!h))];
  for (const h of handles) {
    try {
      for (const err of (await client.getBatchStatus(cfg.catalogId, h)).errors) {
        if (err.retailerId) itemErrors.set(`${h}|${err.retailerId}`, err.message);
      }
    } catch {
      // Sin estado del batch, la relectura decide igual.
    }
  }

  const out = { ...base };
  const ops: Array<{ path: string; data: Record<string, unknown> }> = [];
  for (const d of pend.docs) {
    const job = d.data() as MetaCatalogOutboxJob;
    if (job.tenantId !== tenantId) continue; // aislamiento: nunca se toca un job ajeno
    // `items_batch` es ASÍNCRONO: Meta acepta el lote y lo procesa después. Verificar a los
    // dos segundos de enviarlo leería el estado VIEJO y lo interpretaría como divergencia
    // confirmada — un envío normal terminaría en "requiere revisión" por impaciencia. Por eso
    // la confirmación es DIFERIDA: recién se mira pasada la ventana de gracia.
    if (job.status === 'submitted' && Timestamp.now().toMillis() - (job.submittedAt?.toMillis?.() ?? 0) < gracia) continue;
    // El catálogo cambió desde que este job salió: lo que estamos leyendo NO es el catálogo al
    // que se envió, así que no puede confirmar ni desmentir nada.
    if (job.catalogId !== cfg.catalogId) {
      await d.ref.update({ status: 'needs_action', reason: 'catalog_mismatch', updatedAt: Timestamp.now() });
      ops.push(productStateOp(tenantId, { ...job, status: 'needs_action', reason: 'catalog_mismatch' }));
      continue;
    }
    out.checked++;
    const remoto = porRetailer.get(job.retailerId) ?? null;
    const itemErr = job.batchHandle ? itemErrors.get(`${job.batchHandle}|${job.retailerId}`) : undefined;
    const verif = verifyJobOutcome(job.intendedPatch, remoto);

    let status: MetaCatalogOutboxStatus;
    let reason: OutboxReason | null = null;
    let error = '';
    if (itemErr) {
      // Meta rechazó ESTE artículo: el resto del lote no se ve afectado.
      status = 'failed';
      reason = 'item_rejected';
      error = itemErr.slice(0, 500);
      out.failed++;
    } else if (verif.outcome === 'confirmed_equal') {
      status = 'succeeded';
      out.succeeded++;
    } else if (verif.outcome === 'confirmed_different') {
      // Un CREATE cuyo artículo YA existe en Meta no se puede repetir: con `allow_upsert:false`
      // Meta lo rechaza por id duplicado y el job quedaría `failed` por un artículo que en
      // realidad se creó bien. La divergencia que quede es materia del próximo preview (un
      // UPDATE), no de reenviar la creación.
      const createYaAplicado = job.action === 'create' && !!remoto;
      if (job.status === 'needs_reconciliation' && (job.attempts ?? 0) < MAX_ATTEMPTS && !createYaAplicado) {
        // Ambigüedad resuelta: Meta NO tiene lo nuestro ⇒ el reintento es seguro.
        status = 'queued';
        reason = 'remote_differs';
        out.requeued++;
      } else {
        // Salió y Meta quedó distinto: alguien más lo editó o Meta aplicó otra cosa.
        status = 'needs_action';
        reason = 'remote_differs';
        out.unresolved++;
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
      out.unresolved++;
    }

    const actualizado: MetaCatalogOutboxJob = { ...job, status, reason, error };
    await d.ref.update({ status, reason, error, reconciledAt: Timestamp.now(), updatedAt: Timestamp.now() });
    ops.push(productStateOp(tenantId, actualizado, { ...(remoto ? { metaProductItemId: remoto.id } : {}), ...(status === 'succeeded' ? { metaLastSyncAt: Timestamp.now() } : {}) }));
    if (status === 'succeeded' || status === 'failed') ops.push(syncLogOp(tenantId, actualizado, status === 'succeeded' ? 'success' : 'failed', remoto?.id ?? null));
  }
  const persistido = await commitOps(tenantId, ops);
  if (!persistido) logger.error('Outbox de catálogo: la confirmación no pudo persistirse en los productos', undefined, { tenantId });

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
    await db().runTransaction(async (tx) => {
      const fresco = (await tx.get(d.ref)).data() as MetaCatalogOutboxJob | undefined;
      if (!fresco || fresco.status !== 'processing') return;
      if ((fresco.leaseUntil?.toMillis?.() ?? 0) > now.toMillis()) return; // lease vigente: intocable
      tx.update(d.ref, { status: 'needs_reconciliation', reason: 'submit_ambiguous', leaseUntil: null, leaseOwner: null, updatedAt: Timestamp.now() });
    }).then(() => { out.normalized++; }).catch((e) => {
      logger.warn('Outbox de catálogo: no se pudo normalizar un job en vuelo', { tenantId, jobId: d.id, error: e instanceof Error ? e.message : 'desconocido' });
    });
  }

  const ambiguos = await jobsCol(tenantId)
    .where('status', '==', 'needs_reconciliation')
    .where('updatedAt', '<=', Timestamp.fromMillis(now.toMillis() - ATASCADO_MS))
    .limit(LOTE)
    .get();
  for (const d of ambiguos.docs) {
    await db().runTransaction(async (tx) => {
      const fresco = (await tx.get(d.ref)).data() as MetaCatalogOutboxJob | undefined;
      if (!fresco || fresco.status !== 'needs_reconciliation') return;
      tx.update(d.ref, { status: 'needs_action', reason: 'verification_unavailable', updatedAt: Timestamp.now() });
    }).then(() => { out.aged++; }).catch(() => {});
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
  opts: { graciaMs?: number } = {},
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
  const sweep = await sweepCatalogOutbox(tenantId);
  const drain = await drainCatalogOutbox(tenantId, publicView);
  const reconcile = await reconcileCatalogOutbox(tenantId, { graciaMs: opts.graciaMs });
  return { tenantId, drain, reconcile, sweep };
}
