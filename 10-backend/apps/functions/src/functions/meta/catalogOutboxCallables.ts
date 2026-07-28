/**
 * functions/meta/catalogOutboxCallables.ts — Recuperación HUMANA del outbox de catálogo
 * =====================================================================================
 * (META-CATALOG-OUTBOX-HARDEN-1/2) El outbox manda a `needs_action` lo que no puede resolver
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
 *
 * TODA escritura de estado es un CAS: se relee el job DENTRO de la transacción y la
 * precondición decide. Perder la carrera devuelve `nothing_to_do` con el estado vigente —
 * nunca se afirma una transición que hizo otro, nunca se resucita un descartado, y un descarte
 * jamás pisa un cierre `succeeded`/`failed` ajeno (se preserva y solo se marca revisado).
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
import { catalogHold } from '../../meta/catalogTestHooks.js';
import { cerrarTerminalConLog } from '../../meta/catalogOutboxWorker.js';
import {
  attentionRequiredFor,
  isTerminalOutboxStatus,
  outboxJobId,
  verifyJobOutcome,
  type MetaCatalogOutboxIntent,
  type MetaCatalogOutboxJob,
} from '../../meta/catalogOutbox.js';

const REGION = 'us-central1';
const MAX_INCIDENTS = 100;
/** Igual que la ventana de gracia del mantenimiento: `items_batch` es asíncrono. */
const GRACIA_MS = 60_000;

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
  // Los ids de job son `mco_<hex>_c<n>`: cualquier otra cosa (por ejemplo un '/') rompería el
  // path del documento con un error interno en vez de un rechazo limpio.
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new HttpsError('invalid-argument', 'El identificador del envío no es válido.');
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
    // La bandeja consulta un campo PERSISTIDO (`attentionRequired`), no un filtro en memoria:
    // filtrar después de un `limit()` dejaba que los registros ya revisados ocuparan el cupo
    // de la consulta y taparan incidencias abiertas. `limit(MAX+1)` permite calcular
    // `truncated` con honestidad: sabemos que hay más, no adivinamos.
    const snap = await db()
      .collection(paths.metaCatalogOutboxJobs(tenantId))
      .where('attentionRequired', '==', true)
      .orderBy('updatedAt', 'desc')
      .limit(MAX_INCIDENTS + 1)
      .get();

    const jobs = snap.docs
      .slice(0, MAX_INCIDENTS)
      .map((d) => d.data() as MetaCatalogOutboxJob)
      .filter((j) => j.tenantId === tenantId);
    const truncated = snap.size > MAX_INCIDENTS;
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

    // Punto de pausa SOLO-EMULADOR: acá es donde una acción concurrente (un descarte, otra
    // reconciliación, el mantenimiento) puede ganar la carrera. Los tests lo explotan.
    await catalogHold(tenantId, 'manual_pre_cas');

    /**
     * Si el CAS pierde —el job cambió entre nuestra lectura y la transacción—, se relee el
     * resultado VIGENTE y se responde `nothing_to_do`: esta llamada NO hizo ninguna
     * transición y no puede afirmar lo contrario. El estado que quedó lo escribió quien ganó.
     */
    const perderCarrera = async () => {
      const vigente = (await db().doc(paths.metaCatalogOutboxJob(tenantId, job.id)).get()).data() as MetaCatalogOutboxJob | undefined;
      return {
        ok: true,
        outcome: 'nothing_to_do' as const,
        status: vigente?.status ?? job.status,
        message: 'Otra acción resolvió este envío mientras lo revisábamos. Mirá su estado actual: esta revisión no cambió nada.',
      };
    };

    if (verif.outcome === 'confirmed_equal') {
      // Meta YA tiene lo que este envío pretendía. El cierre usa EL MISMO contrato que el
      // mantenimiento: transición terminal + sync log en una sola transacción, con la
      // precondición releída adentro. Una reconciliación manual jamás resucita un descartado.
      const cerrado = await cerrarTerminalConLog(tenantId, job, {
        precondicion: (fresco) => fresco.status === job.status && !isTerminalOutboxStatus(fresco.status),
        status: 'succeeded',
        reason: null,
        error: '',
        logStatus: 'success',
        itemId: remoto?.id ?? null,
      });
      if (!cerrado) return perderCarrera();
      await liberarIntentSiVigente(tenantId, job);
      await proyectarSiVigente(tenantId, job.productId, job.id, {
        metaSyncStatus: job.action === 'disable' ? 'disabled' : 'synced',
        // El ciclo terminó: libera la vigencia para que la convergencia futura pueda hablar.
        metaSyncCurrentJobId: null,
        metaSyncError: '',
        ...(remoto ? { metaProductItemId: remoto.id } : {}),
        metaLastSyncAt: now,
        updatedAt: now,
      });
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
        const marcado = await db().runTransaction(async (tx) => {
          const ref = db().doc(paths.metaCatalogOutboxJob(tenantId, job.id));
          const fresco = (await tx.get(ref)).data() as MetaCatalogOutboxJob | undefined;
          // MISMA precondición que todo lo demás: si otra acción lo movió (descarte incluido),
          // esta revisión no escribe nada.
          if (!fresco || fresco.status !== job.status || isTerminalOutboxStatus(fresco.status)) return false;
          tx.update(ref, { status: 'needs_action', reason: 'remote_differs', attentionRequired: true, reconciledAt: now, updatedAt: now });
          return true;
        }).catch(() => false);
        if (!marcado) return perderCarrera();
        return {
          ok: true,
          outcome: 'confirmed_different' as const,
          status: 'needs_action',
          message: 'El artículo ya existe en Meta pero con otros datos. Revisá el producto y volvé a confirmar los cambios desde el catálogo: repetir esta publicación la rechazaría por duplicada.',
        };
      }
      // Hay evidencia de que Meta NO tiene lo nuestro. Recién acá es seguro volver a intentar,
      // y se hace como un CICLO NUEVO: el job actual queda cerrado con su historia intacta.
      // `reencolarCicloNuevo` ya es transaccional y aborta si el job cambió de estado.
      const nuevo = await reencolarCicloNuevo(tenantId, job, a);
      if (!nuevo) return perderCarrera();
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

    await catalogHold(tenantId, 'manual_pre_cas');

    /**
     * TODA la decisión adentro de UNA transacción, con el documento FRESCO. La lectura de
     * afuera solo sirvió para validar el pedido: entre esa lectura y acá el mantenimiento pudo
     * cerrar el job como succeeded/failed, un worker pudo reclamarlo, u otra persona pudo
     * descartarlo. Cada rama se decide con lo que el job ES ahora, no con lo que era:
     *  - terminal ⇒ el resultado se PRESERVA; solo se agrega la metadata de revisión;
     *  - processing con lease vivo ⇒ no se toca (el worker está escribiendo en Meta);
     *  - resto ⇒ cancelled, con la honestidad de `yaSalio` calculada sobre el fresco.
     */
    const now = Timestamp.now();
    const resultado = await db().runTransaction(async (tx) => {
      const ref = db().doc(paths.metaCatalogOutboxJob(tenantId, job.id));
      const fresco = (await tx.get(ref)).data() as MetaCatalogOutboxJob | undefined;
      if (!fresco) return { r: 'desaparecido' as const };
      if (isTerminalOutboxStatus(fresco.status)) {
        // Un descarte JAMÁS convierte en cancelado un job que otro worker ya cerró: el
        // resultado real se preserva y esto solo lo saca de la bandeja.
        tx.update(ref, { reviewedAt: now, reviewedReason: motivo, attentionRequired: false, updatedAt: now });
        return { r: 'revisado' as const, status: fresco.status, gano: fresco.status !== job.status };
      }
      if (fresco.status === 'processing' && (fresco.leaseUntil?.toMillis?.() ?? 0) > now.toMillis()) {
        return { r: 'en_vuelo' as const };
      }
      // Un 'processing' con el lease vencido es genuinamente ambiguo: su worker murió y el
      // POST PUDO haber salido antes del crash. Se trata como 'ya salió' para no afirmar de más.
      const yaSalio = fresco.status === 'submitted' || fresco.status === 'processing' || !!fresco.batchHandle || !!fresco.submittedAt;
      const detalle = yaSalio
        ? `descartado por el dueño (el envío YA había salido hacia Meta; esto solo deja de seguirlo): ${motivo}`
        : `descartado por el dueño: ${motivo}`;
      tx.update(ref, { status: 'cancelled', reason: null, error: detalle, attentionRequired: false, updatedAt: now });
      return { r: 'descartado' as const, yaSalio };
    });

    if (resultado.r === 'desaparecido') throw new HttpsError('not-found', 'Ese envío ya no existe.');
    if (resultado.r === 'en_vuelo') {
      throw new HttpsError('failed-precondition', 'Este envío se está procesando ahora mismo. Esperá un momento antes de descartarlo.');
    }
    const a = actorOf(req);
    if (resultado.r === 'revisado') {
      await recordAudit({
        tenantId, action: 'meta.catalog_sync', actorUid: a.uid, actorRole: a.role,
        targetType: 'metaCatalogOutbox', targetId: job.id,
        summary: 'Envío cerrado marcado como revisado', metadata: { jobId: job.id, productId: job.productId, motivo },
      });
      return {
        ok: true,
        status: resultado.status,
        message: resultado.gano
          ? `Mientras lo revisabas, este envío se resolvió solo (quedó "${resultado.status}"). Lo marcamos como revisado sin tocar ese resultado.`
          : 'Marcado como revisado. El registro de lo que pasó queda intacto.',
      };
    }
    await liberarIntentSiVigente(tenantId, job);
    await proyectarSiVigente(tenantId, job.productId, job.id, { metaSyncStatus: 'not_synced', metaSyncCurrentJobId: null, metaSyncError: '', updatedAt: now });
    await recordAudit({
      tenantId, action: 'meta.catalog_sync', actorUid: a.uid, actorRole: a.role,
      targetType: 'metaCatalogOutbox', targetId: job.id,
      summary: 'Envío de catálogo descartado por el dueño', metadata: { jobId: job.id, productId: job.productId, motivo, yaSalio: resultado.yaSalio },
    });
    return {
      ok: true,
      status: 'cancelled' as const,
      message: resultado.yaSalio
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
  if (!job.intentKey) return null; // job legado sin intención: no hay puntero que gobernar
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
      attentionRequired: attentionRequiredFor('queued'),
      reviewedAt: null,
      reviewedReason: null,
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
        status: 'cancelled', error: 'reemplazado por un intento nuevo tras la revisión manual', attentionRequired: false, updatedAt: now,
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
