/**
 * functions/meta/catalogAuthorityCallables.ts — Transición de autoridad de catálogo (ADR-0022 §3)
 * ===============================================================================================
 * Dos callables OWNER/PLATFORM_ADMIN con el MISMO contrato de evidencia que el preview→apply de
 * sync (META-CATALOG-PREVIEW-BINDING-1): TTL 10 min, uso único con `consumedAt` transaccional,
 * mismo actor, y precondición FRESCA sobre el doc de config (huella recalculada ⇒
 * `concurrent_change`).
 *
 *   · metaCatalogAuthorityPreview({ tenantId?, target:{authority, relationship} }) — relee
 *     config, conexión, catálogo, propiedad, locks, import state, runs de sync y outbox;
 *     calcula el plan SIN escribir en la config; persiste el run en
 *     `tenants/{t}/metaCatalogAuthorityRuns/{runId}` (Admin-SDK-only) y devuelve
 *     `{resumen, bloqueos[], advertencias[], estadoEsperado, planHash?, expiresAt?}`.
 *     CON BLOQUEOS el preview sigue siendo INFORMATIVO (se responde el detalle completo) pero
 *     NO emite planHash: un apply sobre ese run es imposible por construcción (`not_usable`).
 *   · metaCatalogAuthorityApply({ tenantId?, runId, planHash }) — transaccional: re-valida la
 *     evidencia ADENTRO de la tx, marca el run consumido y escribe con UPDATE MASK estricto
 *     SOLO `catalogSync.relationship` (+ `catalogSync.ownership` si la transición cambia de
 *     modelo, con la propuesta normalizada fijada al run). JAMÁS toca enabled/mode/catalogId/
 *     syncToMeta/productos/mappings/locks/jobs; no borra nada; no crea jobs; no activa live.
 *
 * PRIVACIDAD: ni el run ni las respuestas llevan tokens, URLs firmadas, query strings ni PII —
 * la propuesta de propiedad ya es metadata SANEADA por contrato (ADR-0015 §4).
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { CatalogAuthorityTarget } from '@vpw/shared';
import { CATALOG_AUTHORITIES, CATALOG_RELATIONSHIPS } from '@vpw/shared';
import { resolveOwnerAuth } from '../../panel/auth.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { PREVIEW_TTL_MS } from '../../meta/catalog.js';
import { isTerminalOutboxStatus, type MetaCatalogOutboxStatus } from '../../meta/catalogOutbox.js';
import type { CatalogOwnership } from '../../meta/catalogOwnership.js';
import {
  AUTHORITY_PREVIEW_TTL_MS,
  authorityConfigFingerprint,
  authorityPlanHash,
  deriveCatalogAuthority,
  evaluateAuthorityRunBinding,
  isValidAuthorityTarget,
  planAuthorityTransition,
  type AuthorityApplyBlockReason,
  type AuthorityRunDocData,
  type AuthorityTransitionSignals,
} from '../../meta/catalogAuthority.js';

const REGION = 'us-central1';

/** Formatos estrictos: el runId viaja a una ruta de doc y el hash es hex de stableHash. */
const AUTHORITY_RUN_ID_RE = /^mca_[a-z0-9_]{1,60}$/;
const PLAN_HASH_RE = /^[a-f0-9]{16,128}$/;

/** Tope de lecturas de diagnóstico por preview (conteos honestos, gasto acotado). */
const OUTBOX_SCAN_LIMIT = 200;
const LOCK_SCAN_LIMIT = 500;
const SYNC_RUN_SCAN_LIMIT = 50;

const newRunId = () => `mca_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

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

/** Todos los estados del outbox; los NO terminales bloquean la transición (ADR-0022 §3). */
const OUTBOX_STATUSES: MetaCatalogOutboxStatus[] = [
  'queued', 'processing', 'submitted', 'succeeded', 'failed', 'cancelled', 'held', 'stale', 'needs_action', 'needs_reconciliation',
];
const OUTBOX_NO_TERMINALES = OUTBOX_STATUSES.filter((s) => !isTerminalOutboxStatus(s));

/**
 * Señales que alimentan el plan puro. SOLO lecturas de Firestore del propio tenant — cero
 * llamadas a Meta: el preview no gasta contra Graph.
 */
async function readTransitionSignals(tenantId: string): Promise<AuthorityTransitionSignals> {
  const nowMs = Date.now();

  // Conexión utilizable = token referenciado (mismo criterio que el cliente de catálogo:
  // `resolveMetaCatalogToken` solo exige tokenSecretRef; la desconexión lo vacía).
  const conn = (await db().doc(paths.metaConnection(tenantId, 'main')).get()).data() as
    | { tokenSecretRef?: string }
    | undefined;
  const connectionOk = !!(conn?.tokenSecretRef && String(conn.tokenSecretRef).trim());

  // Outbox NO terminal: cambiar de modo con envíos vivos dejaría jobs zombis con permisos viejos.
  const outboxSnap = await db()
    .collection(paths.metaCatalogOutboxJobs(tenantId))
    .where('status', 'in', OUTBOX_NO_TERMINALES)
    .limit(OUTBOX_SCAN_LIMIT)
    .get();

  // Import paginado con run activo (claim). Un run 'running' con lease vencida TAMBIÉN cuenta:
  // es reanudable, y reanudaría bajo una relación que ya no lo permite.
  const state = (await db().doc(paths.metaCatalogImportState(tenantId)).get()).data() as
    | { activeRunId?: string | null }
    | undefined;
  let importRunInFlight = false;
  if (state?.activeRunId) {
    const run = (await db().doc(paths.metaCatalogImportRun(tenantId, state.activeRunId)).get()).data() as
      | { status?: string }
      | undefined;
    importRunInFlight = run?.status === 'running';
  }

  // Preview de sync vigente (evidencia `mcs_*` viva): un plan aprobado sin consumir dentro del
  // TTL es un apply potencial en vuelo. La query filtra por frescura (campo único, índice
  // automático) y el resto se decide en memoria — a 10 minutos son pocos docs.
  const frescos = await db()
    .collection(paths.metaCatalogSyncRuns(tenantId))
    .where('finishedAt', '>=', Timestamp.fromMillis(nowMs - PREVIEW_TTL_MS))
    .limit(SYNC_RUN_SCAN_LIMIT)
    .get();
  const syncRunInFlight = frescos.docs.some((d) => {
    const r = d.data() as { requestedMode?: string; status?: string; planHash?: string; consumedAt?: unknown };
    return r.requestedMode === 'dry_run' && r.status === 'planned' && !!r.planHash && !r.consumedAt;
  });

  // Locks con invariantes rotas: un lock de otro tenant o dos locks del mismo producto son una
  // ambigüedad de identidad que ninguna transición debe pisar (se resuelve a mano primero).
  const locks = await db().collection(`tenants/${tenantId}/metaRetailerLocks`).limit(LOCK_SCAN_LIMIT).get();
  const porProducto = new Map<string, number>();
  let mappingAmbiguous = false;
  for (const d of locks.docs) {
    const l = d.data() as { tenantId?: string; productId?: string };
    if (l.tenantId && l.tenantId !== tenantId) { mappingAmbiguous = true; break; }
    if (l.productId) {
      const n = (porProducto.get(l.productId) ?? 0) + 1;
      porProducto.set(l.productId, n);
      if (n > 1) { mappingAmbiguous = true; break; }
    }
  }

  return { connectionOk, outboxNotTerminal: outboxSnap.size, importRunInFlight, syncRunInFlight, mappingAmbiguous };
}

/** Señales NULAS para el rechazo inmediato de un objetivo inválido (no se lee nada). */
const SIN_SENALES: AuthorityTransitionSignals = {
  connectionOk: false,
  outboxNotTerminal: 0,
  importRunInFlight: false,
  syncRunInFlight: false,
  mappingAmbiguous: false,
};

function parseTarget(raw: unknown): CatalogAuthorityTarget {
  const t = raw as { authority?: unknown; relationship?: unknown } | undefined;
  const authority = typeof t?.authority === 'string' ? t.authority : '';
  const relationship = typeof t?.relationship === 'string' ? t.relationship : '';
  if (
    !(CATALOG_AUTHORITIES as readonly string[]).includes(authority) ||
    !(CATALOG_RELATIONSHIPS as readonly string[]).includes(relationship)
  ) {
    throw new HttpsError('invalid-argument', 'Indicá target.authority (vendeyapy|meta|external) y target.relationship (none|mirror|managed).');
  }
  return { authority, relationship } as CatalogAuthorityTarget;
}

// ---------------------------------------------------------------------------
// 1) Preview (calcula y persiste el run; CERO escrituras en la config)
// ---------------------------------------------------------------------------

export const metaCatalogAuthorityPreview = onCall<{ tenantId?: string; target?: { authority?: string; relationship?: string } }>(
  { region: REGION, timeoutSeconds: 60 },
  async (req) => {
    const tenantId = authorizeOwner(req, req.data?.tenantId);
    const target = parseTarget(req.data?.target);
    const actor = actorOf(req);
    const startedAt = Timestamp.now();

    // Config CRUDA + huella: la precondición que el apply va a exigir fresca.
    const cfgSnap = await db().doc(`tenants/${tenantId}/config/meta`).get();
    const rawCatalogSync = (cfgSnap.data() as { catalogSync?: unknown } | undefined)?.catalogSync;
    const configFingerprint = authorityConfigFingerprint(rawCatalogSync);

    // Rechazo INMEDIATO de combinaciones fuera de §2: no se leen señales (el plan corta solo).
    const signals = isValidAuthorityTarget(target) ? await readTransitionSignals(tenantId) : SIN_SENALES;
    const plan = planAuthorityTransition({ target, rawCatalogSync, signals });

    const bloqueado = plan.bloqueos.length > 0;
    const planHash = bloqueado
      ? null
      : authorityPlanHash({ tenantId, target, rawCatalogSync, signals, proposal: plan.proposal, modelChange: plan.modelChange });
    const expiresAtMs = bloqueado ? null : startedAt.toMillis() + AUTHORITY_PREVIEW_TTL_MS;

    const runId = newRunId();
    const finishedAt = Timestamp.now();
    // Run persistido (Admin-SDK-only, cerrado por rules como el resto de tenants/*): con
    // bloqueos queda `blocked` y SIN planHash — informativo para el panel, inaplicable después.
    await db().doc(paths.metaCatalogAuthorityRun(tenantId, runId)).create({
      id: runId,
      runId,
      tenantId,
      kind: 'authority',
      status: bloqueado ? 'blocked' : 'planned',
      target,
      current: plan.current,
      estadoEsperado: plan.estadoEsperado,
      bloqueos: plan.bloqueos,
      advertencias: plan.advertencias,
      modelChange: plan.modelChange,
      proposal: plan.proposal,
      planHash,
      configFingerprint,
      actorUid: actor.uid,
      actorRole: actor.role,
      consumedAt: null,
      consumedByUid: null,
      expiresAtMs,
      startedAt,
      finishedAt,
    });

    logger.info('Autoridad de catálogo: preview de transición', {
      tenantId,
      runId,
      target,
      bloqueos: plan.bloqueos.map((b) => b.id),
      modelChange: plan.modelChange,
    });

    return {
      ok: true,
      runId,
      resumen: {
        de: { authority: plan.current.authority, relationship: plan.current.relationship, declared: plan.current.declared },
        a: plan.estadoEsperado
          ? { authority: plan.estadoEsperado.authority, relationship: plan.estadoEsperado.relationship }
          : null,
        cambiaModelo: plan.modelChange,
      },
      bloqueos: plan.bloqueos,
      advertencias: plan.advertencias,
      estadoEsperado: plan.estadoEsperado,
      ...(planHash ? { planHash, expiresAt: expiresAtMs } : {}),
    };
  },
);

// ---------------------------------------------------------------------------
// 2) Apply (transaccional: consumo del run + update mask estricto)
// ---------------------------------------------------------------------------

/** Motivo → mensaje accionable (contrato `failed-precondition`, espejo del binding de sync). */
const APPLY_BLOCK_MESSAGES: Record<
  AuthorityApplyBlockReason | 'concurrent_change' | 'import_run_in_flight' | 'outbox_not_terminal' | 'sync_run_in_flight' | 'connection_missing',
  string
> = {
  preview_required: 'Para cambiar la autoridad primero previsualizá: el cambio va atado a esa previsualización.',
  not_found: 'La previsualización referida no existe para esta empresa. Previsualizá de nuevo.',
  not_usable: 'La previsualización referida no es utilizable (tenía bloqueos o no es de autoridad). Previsualizá de nuevo.',
  mismatch: 'La evidencia no coincide con la previsualización. Previsualizá de nuevo.',
  actor_mismatch: 'El cambio debe hacerlo la misma persona que previsualizó. Previsualizá de nuevo.',
  expired: 'La previsualización venció. Previsualizá de nuevo y confirmá dentro de los 10 minutos.',
  consumed: 'Esa previsualización ya se usó. Previsualizá de nuevo para otro cambio.',
  concurrent_change: 'La configuración del catálogo cambió desde la previsualización. Previsualizá de nuevo.',
  import_run_in_flight: 'Hay una importación de catálogo en curso. Esperá a que termine y previsualizá de nuevo.',
  outbox_not_terminal: 'Hay envíos de catálogo hacia Meta todavía en curso. Esperá a que terminen y previsualizá de nuevo.',
  sync_run_in_flight: 'Hay una previsualización de sincronización vigente sin confirmar. Confirmala o dejala vencer, y previsualizá el cambio de autoridad de nuevo.',
  connection_missing: 'La conexión con Meta ya no está disponible y el destino la exige. Reconectá y previsualizá de nuevo.',
};

class AuthorityApplyError extends Error {
  constructor(readonly reason: AuthorityApplyBlockReason | 'concurrent_change' | 'import_run_in_flight') {
    super(`authority apply: ${reason}`);
  }
}

/** Subset del run doc que el apply necesita (validación + escritura). */
interface AuthorityRunDoc extends AuthorityRunDocData {
  target?: CatalogAuthorityTarget;
  modelChange?: boolean;
  proposal?: CatalogOwnership | null;
  configFingerprint?: string;
  current?: { authority?: string; relationship?: string; declared?: boolean };
  estadoEsperado?: { authority?: string; relationship?: string } | null;
}

export const metaCatalogAuthorityApply = onCall<{ tenantId?: string; runId?: string; planHash?: string }>(
  { region: REGION, timeoutSeconds: 60 },
  async (req) => {
    const tenantId = authorizeOwner(req, req.data?.tenantId);
    const actor = actorOf(req);

    const runId = String(req.data?.runId ?? '').trim();
    const planHash = String(req.data?.planHash ?? '').trim().toLowerCase();
    // Evidencia ausente o malformada = no hay evidencia (mismo contrato que el sync apply).
    if (!AUTHORITY_RUN_ID_RE.test(runId) || !PLAN_HASH_RE.test(planHash)) {
      throw new HttpsError('failed-precondition', APPLY_BLOCK_MESSAGES.preview_required, { reason: 'preview_required' });
    }
    const evidence = { runId, planHash };

    const runRef = db().doc(paths.metaCatalogAuthorityRun(tenantId, runId));
    const cfgRef = db().doc(`tenants/${tenantId}/config/meta`);

    // Fail-fast barato ANTES de la transacción (la tx re-valida TODO igual).
    const preSnap = await runRef.get();
    const preBlock = evaluateAuthorityRunBinding(preSnap.exists ? (preSnap.data() as AuthorityRunDocData) : null, {
      evidence,
      actorUid: actor.uid,
      nowMs: Date.now(),
    });
    if (preBlock) throw new HttpsError('failed-precondition', APPLY_BLOCK_MESSAGES[preBlock], { reason: preBlock });

    // Re-chequeos BARATOS inmediatamente antes de la tx (queries y lecturas que no entran en
    // ella). La ventana residual restante la cierra el ENCOLADO mismo: `enqueueCatalogPlan`
    // re-deriva la relación DENTRO de su transacción (review A2) — un apply de sync que llegue
    // tarde no encola nada bajo un modo que ya no escribe.
    const outboxSnap = await db()
      .collection(paths.metaCatalogOutboxJobs(tenantId))
      .where('status', 'in', OUTBOX_NO_TERMINALES)
      .limit(1)
      .get();
    if (outboxSnap.size > 0) {
      throw new HttpsError('failed-precondition', APPLY_BLOCK_MESSAGES.outbox_not_terminal, { reason: 'outbox_not_terminal' });
    }
    // (review A2) Preview de sync vigente: el MISMO chequeo del preview de autoridad — un
    // dry-run `planned` sin consumir dentro del TTL es un apply de sync potencial en vuelo.
    const frescos = await db()
      .collection(paths.metaCatalogSyncRuns(tenantId))
      .where('finishedAt', '>=', Timestamp.fromMillis(Date.now() - PREVIEW_TTL_MS))
      .limit(SYNC_RUN_SCAN_LIMIT)
      .get();
    const syncVigente = frescos.docs.some((d) => {
      const r = d.data() as { requestedMode?: string; status?: string; planHash?: string; consumedAt?: unknown };
      return r.requestedMode === 'dry_run' && r.status === 'planned' && !!r.planHash && !r.consumedAt;
    });
    if (syncVigente) {
      throw new HttpsError('failed-precondition', APPLY_BLOCK_MESSAGES.sync_run_in_flight, { reason: 'sync_run_in_flight' });
    }
    // (review B4) La conexión también es parte de lo que el preview validó: si el destino la
    // exige (B/C) y desapareció dentro de los 10 minutos, este apply habría pasado con una
    // precondición que el preview habría bloqueado.
    const target = (preSnap.data() as { target?: CatalogAuthorityTarget } | undefined)?.target;
    const exigeConexion =
      (target?.authority === 'vendeyapy' && target?.relationship === 'managed') || target?.authority === 'meta';
    if (exigeConexion) {
      const conn = (await db().doc(paths.metaConnection(tenantId, 'main')).get()).data() as
        | { tokenSecretRef?: string }
        | undefined;
      if (!(conn?.tokenSecretRef && String(conn.tokenSecretRef).trim())) {
        throw new HttpsError('failed-precondition', APPLY_BLOCK_MESSAGES.connection_missing, { reason: 'connection_missing' });
      }
    }

    let antes: { authority: string; relationship: string; declared: boolean } | null = null;
    let despues: { authority: string; relationship: string } | null = null;
    let modelChange = false;
    try {
      await db().runTransaction(async (tx) => {
        // TODAS las lecturas antes de la primera escritura (contrato del Admin SDK).
        const fresh = await tx.get(runRef);
        const cfgSnap = await tx.get(cfgRef);
        const stateSnap = await tx.get(db().doc(paths.metaCatalogImportState(tenantId)));
        const run = fresh.exists ? (fresh.data() as AuthorityRunDoc) : null;

        const bloqueo = evaluateAuthorityRunBinding(run, { evidence, actorUid: actor.uid, nowMs: Date.now() });
        if (bloqueo) throw new AuthorityApplyError(bloqueo);
        const target = run!.target!;

        // PRECONDICIÓN FRESCA: la config no cambió desde el preview (enabled/mode/catalogId/
        // ownership/relationship — cualquier mutación cambia la huella).
        const rawNow = (cfgSnap.data() as { catalogSync?: unknown } | undefined)?.catalogSync;
        if (authorityConfigFingerprint(rawNow) !== run!.configFingerprint) {
          throw new AuthorityApplyError('concurrent_change');
        }

        // Re-chequeo del import DENTRO de la tx (lectura simple, sin agregados).
        const state = stateSnap.data() as { activeRunId?: string | null } | undefined;
        if (state?.activeRunId) {
          const importRun = (await tx.get(db().doc(paths.metaCatalogImportRun(tenantId, state.activeRunId)))).data() as
            | { status?: string }
            | undefined;
          if (importRun?.status === 'running') throw new AuthorityApplyError('import_run_in_flight');
        }

        antes = {
          authority: run!.current?.authority ?? 'vendeyapy',
          relationship: run!.current?.relationship ?? 'none',
          declared: run!.current?.declared === true,
        };
        modelChange = run!.modelChange === true && !!run!.proposal;

        // CONSUMO antes que nada: si algo fallara después, el preview ya no es reutilizable —
        // lo correcto es previsualizar de nuevo, jamás repetir a ciegas. El `status` queda en
        // 'planned' + `consumedAt` sellado — MISMO contrato que el preview de sync: así el
        // replay del mismo runId responde `consumed` (y no un `not_usable` genérico).
        const now = Timestamp.now();
        tx.update(runRef, { consumedAt: now, consumedByUid: actor.uid });

        // UPDATE MASK ESTRICTO del campo ANIDADO: jamás se reemplaza el mapa `catalogSync`
        // entero (pisar enabled/mode/catalogId apagaría — o dejaría a medias— la sync, ADR-0015).
        if (!cfgSnap.exists) {
          // Tenant local puro sin doc de config (credipower declarando A): merge profundo crea
          // SOLO catalogSync.relationship sin inventar nada más.
          tx.set(cfgRef, { catalogSync: { relationship: target.relationship } }, { merge: true });
        } else if (modelChange) {
          tx.update(cfgRef, 'catalogSync.relationship', target.relationship, 'catalogSync.ownership', run!.proposal);
        } else {
          tx.update(cfgRef, 'catalogSync.relationship', target.relationship);
        }
        despues = run!.estadoEsperado
          ? { authority: run!.estadoEsperado.authority ?? target.authority, relationship: run!.estadoEsperado.relationship ?? target.relationship }
          : { authority: target.authority, relationship: target.relationship };
      });
    } catch (e) {
      if (e instanceof AuthorityApplyError) {
        throw new HttpsError('failed-precondition', APPLY_BLOCK_MESSAGES[e.reason], { reason: e.reason });
      }
      throw e;
    }

    await recordAudit({
      tenantId,
      action: 'meta.catalog_authority_changed',
      actorUid: actor.uid,
      actorRole: actor.role,
      targetType: 'metaCatalogAuthorityRun',
      targetId: runId,
      summary: `Autoridad de catálogo: ${antes!.authority}/${antes!.relationship} → ${despues!.authority}/${despues!.relationship}`,
      metadata: { runId, antes, despues, modelChange },
    });
    logger.info('Autoridad de catálogo: transición aplicada', { tenantId, runId, antes, despues, modelChange });

    return { ok: true, runId, antes, despues, cambiaModelo: modelChange };
  },
);

// Re-export para tests del contrato (la derivación vive en meta/catalogAuthority.ts).
export { deriveCatalogAuthority };
