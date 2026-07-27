/**
 * functions/meta/catalogOutboxCallables.ts — Recuperación HUMANA del outbox de catálogo
 * =====================================================================================
 * (META-CATALOG-OUTBOX-HARDEN-1) El outbox manda a `needs_action` lo que no puede resolver
 * solo: un envío cuya suerte no se pudo determinar, un artículo que Meta dejó distinto, un
 * catálogo que cambió. Sin una salida humana, esos jobs quedaban atrapados — la colección está
 * cerrada al cliente por Rules (y tiene que seguir así: un job es una orden de escritura con su
 * generación de fencing).
 *
 * Tres operaciones, todas para TENANT_OWNER / PLATFORM_ADMIN y aisladas por tenant:
 *
 *   metaCatalogOutboxIncidents  — lista SANEADA de lo que requiere atención.
 *   metaCatalogOutboxReconcile  — MIRA Meta primero y decide con evidencia.
 *   metaCatalogOutboxDiscard    — descarta con motivo auditado.
 *
 * NUNCA se ofrece "reenviar": reenviar a ciegas es exactamente lo que este outbox existe para
 * evitar. La única forma de que algo vuelva a salir es que la evidencia muestre que Meta no lo
 * tiene, y aun así se ejecuta como un CICLO NUEVO (historia intacta).
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { Product } from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../audit/audit.js';
import { assertFeatureEnabled } from '../../entitlements/entitlements.js';
import { resolveOwnerAuth } from '../../panel/auth.js';
import { normalizeCatalogSyncConfig } from '../../meta/catalogSyncConfig.js';
import { getMetaCatalogClientForTenant, MetaCatalogApiError, type MetaRemoteCatalogItem } from '../../meta/catalogClient.js';
import {
  isTerminalOutboxStatus,
  outboxJobId,
  verifyJobOutcome,
  type MetaCatalogOutboxIntent,
  type MetaCatalogOutboxJob,
  type MetaCatalogOutboxStatus,
} from '../../meta/catalogOutbox.js';

const REGION = 'us-central1';
const MAX_INCIDENTS = 100;
/** Igual que la ventana de gracia del mantenimiento: `items_batch` es asíncrono. */
const GRACIA_MS = 60_000;

/** Estados que requieren una decisión humana. El resto lo resuelve el mantenimiento solo. */
const REQUIEREN_ATENCION: MetaCatalogOutboxStatus[] = ['needs_action', 'needs_reconciliation', 'failed', 'stale'];

function authorizeOwner(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolveOwnerAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

const actorOf = (req: CallableRequest<unknown>) => ({
  uid: req.auth?.uid ?? null,
  role: (req.auth?.token as { role?: string } | undefined)?.role ?? null,
});

/**
 * Vista SANEADA de un job para el panel. NO viaja el `intendedPatch` completo (es el contenido
 * exacto que se publica y no aporta a la decisión), ni el lease, ni el owner del worker, ni
 * nada que permita reconstruir credenciales. Solo lo necesario para entender y decidir.
 */
function incidentOf(job: MetaCatalogOutboxJob, producto: Product | null) {
  return {
    jobId: job.id,
    productId: job.productId,
    productName: producto?.name ?? '',
    retailerId: job.retailerId,
    action: job.action,
    status: job.status,
    reason: job.reason ?? null,
    cycle: job.cycle ?? 1,
    attempts: job.attempts ?? 0,
    /** Campos que el envío pretendía cambiar (nombres, no valores). */
    fields: Object.keys(job.intendedPatch ?? {}).filter((k) => k !== 'id'),
    error: (job.error ?? '').slice(0, 300),
    submittedAt: job.submittedAt ?? null,
    updatedAt: job.updatedAt ?? null,
  };
}

async function jobDeTenant(tenantId: string, jobId: string): Promise<MetaCatalogOutboxJob> {
  const id = String(jobId ?? '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'Falta el identificador del envío.');
  const snap = await db().doc(paths.metaCatalogOutboxJob(tenantId, id)).get();
  const job = snap.exists ? (snap.data() as MetaCatalogOutboxJob) : null;
  // AISLAMIENTO: la ruta ya es del tenant, pero el campo se verifica igual — un job con
  // `tenantId` ajeno sería una invariante rota y no se toca por las dudas.
  if (!job || job.tenantId !== tenantId) throw new HttpsError('not-found', 'Ese envío no existe en esta empresa.');
  return job;
}

// ---------------------------------------------------------------------------
// 1) Listado de incidencias
// ---------------------------------------------------------------------------

export const metaCatalogOutboxIncidents = onCall<{ tenantId?: string }>(
  { region: REGION },
  async (req) => {
    const tenantId = authorizeOwner(req, req.data?.tenantId);
    const snap = await db()
      .collection(paths.metaCatalogOutboxJobs(tenantId))
      .where('status', 'in', REQUIEREN_ATENCION)
      .limit(MAX_INCIDENTS)
      .get();

    // Lo ya revisado no vuelve a ocupar la lista: si no, los cerrados se acumulan y tapan las
    // incidencias nuevas.
    const jobs = snap.docs
      .map((d) => d.data() as MetaCatalogOutboxJob & { reviewedAt?: unknown })
      .filter((j) => j.tenantId === tenantId && !j.reviewedAt);
    // Truncar en silencio haría que el panel afirmara un número que no es el real.
    const truncated = snap.size >= MAX_INCIDENTS;
    const productos = new Map<string, Product>();
    for (const j of jobs) {
      if (productos.has(j.productId)) continue;
      const p = await db().doc(paths.product(tenantId, j.productId)).get();
      if (p.exists) productos.set(j.productId, { ...(p.data() as Product), id: p.id });
    }
    return {
      ok: true,
      truncated,
      incidents: jobs
        .map((j) => incidentOf(j, productos.get(j.productId) ?? null))
        .sort((a, b) => (b.updatedAt?.toMillis?.() ?? 0) - (a.updatedAt?.toMillis?.() ?? 0)),
    };
  },
);

// ---------------------------------------------------------------------------
// 2) Reconciliar AHORA: se mira Meta y se decide con evidencia
// ---------------------------------------------------------------------------

export const metaCatalogOutboxReconcile = onCall<{ tenantId?: string; jobId?: string }>(
  { region: REGION, timeoutSeconds: 120 },
  async (req) => {
    const tenantId = authorizeOwner(req, req.data?.tenantId);
    const job = await jobDeTenant(tenantId, String(req.data?.jobId ?? ''));
    if (isTerminalOutboxStatus(job.status)) {
      // Un job terminal es EVIDENCIA: no se reabre ni se reescribe. Si hace falta repetir el
      // cambio, el camino es una confirmación nueva desde el catálogo (que crea otro ciclo).
      return { ok: true, outcome: 'nothing_to_do' as const, status: job.status, message: 'Ese envío ya está cerrado. Si el cambio sigue haciendo falta, volvé a confirmarlo desde el catálogo.' };
    }
    // EN VUELO: hay un worker con el claim vivo. Tocarlo desde acá cancelaría su claim y podría
    // producir un SEGUNDO envío del mismo cambio — justo lo que este sistema evita.
    if (job.status === 'processing' && (job.leaseUntil?.toMillis?.() ?? 0) > Date.now()) {
      return { ok: true, outcome: 'nothing_to_do' as const, status: job.status, message: 'Este envío se está procesando ahora mismo. Esperá un momento y volvé a mirar.' };
    }
    // RECIÉN ENVIADO: `items_batch` es asíncrono. Consultar el catálogo a los pocos segundos
    // leería el estado viejo y lo llamaría "evidencia" — la misma trampa que la confirmación
    // automática evita con su ventana de gracia.
    const desdeElEnvio = Date.now() - (job.submittedAt?.toMillis?.() ?? 0);
    if (job.submittedAt && desdeElEnvio < GRACIA_MS) {
      return { ok: true, outcome: 'nothing_to_do' as const, status: job.status, message: 'Este cambio acaba de salir hacia Meta. Esperá un minuto para que Meta lo procese y volvé a revisar.' };
    }

    // Mismo gate que el mantenimiento: esta operación consulta Meta, así que exige el plan que
    // habilita marketing. Sin esto, un tenant degradado seguía gastando llamadas a la API.
    await assertFeatureEnabled(tenantId, 'marketingAutomation', { actorUid: req.auth?.uid ?? null });

    const cfgSnap = await db().doc(`tenants/${tenantId}/config/meta`).get();
    const cfg = normalizeCatalogSyncConfig((cfgSnap.data() as { catalogSync?: unknown } | undefined)?.catalogSync);
    if (!cfg.enabled || !cfg.catalogId) {
      throw new HttpsError('failed-precondition', 'La sincronización de catálogo no está configurada para esta empresa.');
    }
    if (cfg.catalogId !== job.catalogId) {
      throw new HttpsError('failed-precondition', 'El catálogo configurado cambió: no se puede confirmar contra un catálogo distinto del que recibió el envío.');
    }

    // SIEMPRE se mira Meta primero. No existe un camino que reenvíe sin haber leído.
    let remoto: MetaRemoteCatalogItem | null = null;
    try {
      const client = await getMetaCatalogClientForTenant(tenantId);
      const items = await client.listItems(cfg.catalogId);
      remoto = items.find((r) => r.retailerId === job.retailerId) ?? null;
    } catch (e) {
      const detalle = e instanceof MetaCatalogApiError ? e.message : 'no se pudo consultar el catálogo de Meta';
      logger.warn('Outbox de catálogo: la reconciliación manual no pudo leer Meta', { tenantId, jobId: job.id });
      throw new HttpsError('unavailable', `No pudimos consultar el catálogo de Meta. Probá de nuevo en unos minutos. (${detalle.slice(0, 200)})`);
    }

    const verif = verifyJobOutcome(job.intendedPatch, remoto);
    const a = actorOf(req);
    const now = Timestamp.now();
    const ref = db().doc(paths.metaCatalogOutboxJob(tenantId, job.id));

    if (verif.outcome === 'confirmed_equal') {
      // Meta YA tiene lo que este envío pretendía: el trabajo está hecho.
      await ref.update({ status: 'succeeded', reason: null, error: '', reconciledAt: now, updatedAt: now });
      await liberarIntentSiVigente(tenantId, job);
      await proyectarSiVigente(tenantId, job.productId, job.id, {
        metaSyncStatus: job.action === 'disable' ? 'disabled' : 'synced',
        metaSyncError: '',
        ...(remoto ? { metaProductItemId: remoto.id } : {}),
        metaLastSyncAt: now,
        updatedAt: now,
      });
      // La historia por ciclo queda completa: un cierre manual también deja su log.
      await db().doc(paths.metaCatalogSyncLog(tenantId, job.id)).set({
        id: job.id, tenantId, productId: job.productId, metaCatalogId: job.catalogId,
        metaProductItemId: remoto?.id ?? null, action: job.action, status: 'success',
        errorMessage: '', createdAt: now,
      }, { merge: true });
      await recordAudit({
        tenantId, action: 'meta.catalog_sync', actorUid: a.uid, actorRole: a.role,
        targetType: 'metaCatalogOutbox', targetId: job.id,
        summary: 'Revisión manual: Meta confirmó el cambio', metadata: { jobId: job.id, productId: job.productId, outcome: 'confirmed_equal' },
      });
      return { ok: true, outcome: 'confirmed_equal' as const, status: 'succeeded', message: 'Meta ya tiene este cambio: el envío quedó confirmado.' };
    }

    if (verif.outcome === 'confirmed_different') {
      // Un CREATE cuyo artículo YA existe no se puede repetir: con `allow_upsert:false` Meta lo
      // rechaza por id duplicado. La creación se aplicó; lo que difiere es materia de un UPDATE
      // que va a planificar la próxima confirmación desde el catálogo.
      if (job.action === 'create' && remoto) {
        await db().doc(paths.metaCatalogOutboxJob(tenantId, job.id)).update({
          status: 'needs_action', reason: 'remote_differs', reconciledAt: now, updatedAt: now,
        });
        return {
          ok: true,
          outcome: 'confirmed_different' as const,
          status: 'needs_action',
          message: 'El artículo ya existe en Meta pero con otros datos. Revisá el producto y volvé a confirmar los cambios desde el catálogo: repetir esta publicación la rechazaría por duplicada.',
        };
      }
      // Hay evidencia de que Meta NO tiene lo nuestro. Recién acá es seguro volver a intentar,
      // y se hace como un CICLO NUEVO: el job actual queda cerrado con su historia intacta.
      const nuevo = await reencolarCicloNuevo(tenantId, job, a);
      if (!nuevo) {
        return { ok: true, outcome: 'nothing_to_do' as const, status: job.status, message: 'Ya hay otro intento en curso para este mismo cambio: esperá a que termine.' };
      }
      await recordAudit({
        tenantId, action: 'meta.catalog_sync', actorUid: a.uid, actorRole: a.role,
        targetType: 'metaCatalogOutbox', targetId: job.id,
        summary: 'Revisión manual: Meta difiere, se encoló un intento nuevo', metadata: { jobId: job.id, nuevoJobId: nuevo, productId: job.productId, outcome: 'confirmed_different' },
      });
      return { ok: true, outcome: 'confirmed_different' as const, status: 'queued', newJobId: nuevo, message: 'Meta tiene otro valor: encolamos un intento nuevo. El anterior queda registrado.' };
    }

    // Sin evidencia: NO se toca nada. Reenviar acá sería exactamente el reintento a ciegas.
    await recordAudit({
      tenantId, action: 'meta.catalog_sync', actorUid: a.uid, actorRole: a.role,
      targetType: 'metaCatalogOutbox', targetId: job.id,
      summary: 'Revisión manual: Meta no devolvió evidencia', metadata: { jobId: job.id, productId: job.productId, outcome: 'unverifiable' },
    });
    return {
      ok: true,
      outcome: 'unverifiable' as const,
      status: job.status,
      message: 'Meta no devolvió información suficiente sobre este artículo. Queda pendiente de revisión: no reenviamos a ciegas.',
    };
  },
);

// ---------------------------------------------------------------------------
// 3) Descartar con motivo
// ---------------------------------------------------------------------------

export const metaCatalogOutboxDiscard = onCall<{ tenantId?: string; jobId?: string; reason?: string }>(
  { region: REGION },
  async (req) => {
    const tenantId = authorizeOwner(req, req.data?.tenantId);
    const job = await jobDeTenant(tenantId, String(req.data?.jobId ?? ''));
    const motivo = String(req.data?.reason ?? '').trim().slice(0, 300);
    if (!motivo) throw new HttpsError('invalid-argument', 'Escribí por qué se descarta este envío (queda registrado).');
    if (isTerminalOutboxStatus(job.status)) {
      // Un terminal NO se reescribe: solo se marca como REVISADO para que deje de ocupar la
      // lista. El estado, el error y el patch —la evidencia— quedan exactamente como están.
      const now = Timestamp.now();
      await db().doc(paths.metaCatalogOutboxJob(tenantId, job.id)).update({ reviewedAt: now, reviewedReason: motivo, updatedAt: now });
      const a = actorOf(req);
      await recordAudit({
        tenantId, action: 'meta.catalog_sync', actorUid: a.uid, actorRole: a.role,
        targetType: 'metaCatalogOutbox', targetId: job.id,
        summary: 'Envío cerrado marcado como revisado', metadata: { jobId: job.id, productId: job.productId, motivo },
      });
      return { ok: true, status: job.status, message: 'Marcado como revisado. El registro de lo que pasó queda intacto.' };
    }
    // EN VUELO con el claim vivo: descartarlo dejaría al worker escribiendo en Meta contra un
    // job ya "cancelado". Se espera a que termine (o a que el sweep lo normalice).
    if (job.status === 'processing' && (job.leaseUntil?.toMillis?.() ?? 0) > Date.now()) {
      throw new HttpsError('failed-precondition', 'Este envío se está procesando ahora mismo. Esperá un momento antes de descartarlo.');
    }

    const now = Timestamp.now();
    // HONESTIDAD: si el lote YA salió hacia Meta, descartarlo no lo deshace — solo deja de
    // seguirlo. El texto guardado lo dice, para que nadie lea "cancelado" como "no pasó nada".
    const yaSalio = job.status === 'submitted' || !!job.batchHandle;
    const detalle = yaSalio
      ? `descartado por el dueño (el envío YA había salido hacia Meta; esto solo deja de seguirlo): ${motivo}`
      : `descartado por el dueño: ${motivo}`;
    await db().doc(paths.metaCatalogOutboxJob(tenantId, job.id)).update({
      status: 'cancelled', reason: null, error: detalle, updatedAt: now,
    });
    await liberarIntentSiVigente(tenantId, job);
    await proyectarSiVigente(tenantId, job.productId, job.id, { metaSyncStatus: 'not_synced', metaSyncError: '', updatedAt: now });
    const a = actorOf(req);
    await recordAudit({
      tenantId, action: 'meta.catalog_sync', actorUid: a.uid, actorRole: a.role,
      targetType: 'metaCatalogOutbox', targetId: job.id,
      summary: 'Envío de catálogo descartado por el dueño', metadata: { jobId: job.id, productId: job.productId, motivo, yaSalio },
    });
    return {
      ok: true,
      status: 'cancelled' as const,
      message: yaSalio
        ? 'Dejamos de seguir este envío. Ojo: ya había salido hacia Meta, así que el cambio pudo haberse aplicado allá.'
        : 'Envío descartado. Queda registrado con tu motivo.',
    };
  },
);

// ---------------------------------------------------------------------------
// Helpers de estado (mismas invariantes que el worker)
// ---------------------------------------------------------------------------

/** Suelta el puntero de la intención si este job seguía siendo el activo. */
async function liberarIntentSiVigente(tenantId: string, job: MetaCatalogOutboxJob): Promise<void> {
  if (!job.intentKey) return;
  const ref = db().doc(paths.metaCatalogOutboxIntent(tenantId, job.intentKey));
  await db().runTransaction(async (tx) => {
    const intent = (await tx.get(ref)).data() as MetaCatalogOutboxIntent | undefined;
    if (!intent || intent.activeJobId !== job.id) return;
    tx.set(ref, { activeJobId: null, updatedAt: Timestamp.now() }, { merge: true });
  }).catch(() => {});
}

/** Proyecta al producto SOLO si este job sigue siendo el vigente (mismo fencing que el worker). */
async function proyectarSiVigente(tenantId: string, productId: string, jobId: string, data: Record<string, unknown>): Promise<void> {
  const ref = db().doc(paths.product(tenantId, productId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    if ((snap.data() as { metaSyncCurrentJobId?: string }).metaSyncCurrentJobId !== jobId) return;
    tx.set(ref, data, { merge: true });
  }).catch(() => {});
}

/**
 * Cierra el job actual y crea el CICLO SIGUIENTE de la misma intención, con el mismo patch
 * congelado. El job viejo queda intacto como evidencia; el nuevo empieza de cero.
 */
async function reencolarCicloNuevo(
  tenantId: string,
  job: MetaCatalogOutboxJob,
  actor: { uid: string | null; role: string | null },
): Promise<string | null> {
  const now = Timestamp.now();
  const intentRef = db().doc(paths.metaCatalogOutboxIntent(tenantId, job.intentKey));
  const productRef = db().doc(paths.product(tenantId, job.productId));
  return db().runTransaction(async (tx) => {
    // Admin SDK: TODAS las lecturas antes de la primera escritura.
    const intent = (await tx.get(intentRef)).data() as MetaCatalogOutboxIntent | undefined;
    const actual = (await tx.get(db().doc(paths.metaCatalogOutboxJob(tenantId, job.id)))).data() as MetaCatalogOutboxJob | undefined;
    const activo = intent?.activeJobId && intent.activeJobId !== job.id
      ? ((await tx.get(db().doc(paths.metaCatalogOutboxJob(tenantId, intent.activeJobId)))).data() as MetaCatalogOutboxJob | undefined)
      : undefined;
    const productSnap = await tx.get(productRef);

    // Ya hay otro ciclo en curso para la misma intención: no se duplica trabajo. Se devuelve
    // `null` para que el llamador NO diga "encolamos un intento nuevo" cuando no encoló nada.
    if (activo && !isTerminalOutboxStatus(activo.status)) return null;
    // Cambió de estado entre la lectura y la transacción (otro worker, o el mantenimiento).
    if (!actual || actual.status !== job.status) return null;

    const cycle = (intent?.cycle ?? job.cycle ?? 1) + 1;
    const nuevoId = outboxJobId(job.intentKey, cycle);
    const nuevo: MetaCatalogOutboxJob = {
      ...job,
      id: nuevoId,
      cycle,
      status: 'queued',
      attempts: 0,
      leaseOwner: null,
      leaseUntil: null,
      batchHandle: null,
      reason: null,
      error: '',
      requestedByUid: actor.uid,
      requestedByRole: actor.role,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      reconciledAt: null,
    };
    tx.create(db().doc(paths.metaCatalogOutboxJob(tenantId, nuevoId)), nuevo as unknown as Record<string, unknown>);
    // El job anterior se cierra SOLO si no era terminal: un terminal es evidencia y no se
    // reescribe ni siquiera para anotar que fue reemplazado.
    if (!isTerminalOutboxStatus(actual.status)) {
      tx.update(db().doc(paths.metaCatalogOutboxJob(tenantId, job.id)), {
        status: 'cancelled', error: 'reemplazado por un intento nuevo tras la revisión manual', updatedAt: now,
      });
    }
    tx.set(intentRef, { intentKey: job.intentKey, tenantId, activeJobId: nuevoId, cycle, updatedAt: now } satisfies MetaCatalogOutboxIntent);
    // El producto pasa a mostrar el ciclo NUEVO como vigente, pero SOLO si la vigencia era de
    // este mismo job (o de ninguno). Si mientras tanto se encoló otro ciclo —de otra intención,
    // más nuevo—, este reintento no puede robarle la vigencia. `set(merge)` sobre un documento
    // inexistente lo CREARÍA: un producto borrado no se resucita con un estado de sync.
    const vigenteActual = (productSnap.data() as { metaSyncCurrentJobId?: string } | undefined)?.metaSyncCurrentJobId;
    if (productSnap.exists && (!vigenteActual || vigenteActual === job.id)) {
      tx.set(productRef, { metaSyncStatus: 'queued', metaSyncCurrentJobId: nuevoId, metaSyncError: '', updatedAt: now }, { merge: true });
    }
    return nuevoId;
  });
}
