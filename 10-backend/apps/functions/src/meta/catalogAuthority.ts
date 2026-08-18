/**
 * meta/catalogAuthority.ts — Autoridad de catálogo autoservicio (ADR-0022)
 * ========================================================================
 * Deriva el contrato tipado `{authority, relationship, declared, reasons, botCatalog}` del
 * campo `catalogSync` CRUDO del doc de config, y define el gating por relación y el plan de
 * transición preview→apply. TODO lo de este módulo es ADITIVO sobre ADR-0015 (desplegado):
 * no altera `normalizeCatalogSyncConfig` ni `normalizeCatalogOwnership` — los CONSUME.
 *
 * Dos ejes que acá se mapean, sin renombrar nada:
 *  · AUTORIDAD (quién administra) sale de `catalogSync.ownership` (ADR-0015, ya desplegado);
 *  · RELACIÓN (qué hacemos con Meta) es el eje NUEVO `catalogSync.relationship`, declarado.
 *
 * La derivación es PURA, determinística, cero I/O y cero escrituras. `relationship` se lee
 * CRUDO (mismo patrón que `declaredCatalogId`/`declaredExternalFields`): no pasa por el
 * interruptor de sync, porque describe una intención declarada, no un permiso de ejecución.
 * De acá no sale permiso de escritura: `writable`/`effectiveMode` siguen mandando (ADR-0015).
 *
 * FAIL-CLOSED de la declaración: un `relationship` declarado que contradice la propiedad
 * normalizada NUNCA se cree — manda el derivado y queda el motivo (`relationship_conflict`).
 * Jamás se «cree» la declaración por sobre la normalización de nivel 2.
 */

import { HttpsError } from 'firebase-functions/v2/https';
import type {
  CatalogAuthority,
  CatalogAuthorityBlock,
  CatalogAuthorityDerived,
  CatalogAuthorityReason,
  CatalogAuthorityStaleness,
  CatalogAuthorityStatus,
  CatalogAuthorityTarget,
  CatalogAuthorityWarning,
  CatalogRelationship,
} from '@vpw/shared';
import { CATALOG_RELATIONSHIPS } from '@vpw/shared';
import { db } from '../lib/firebase.js';
import {
  normalizeCatalogOwnership,
  type CatalogOwnership,
  type EffectiveOwnership,
  type ExternalSourceKind,
} from './catalogOwnership.js';
import { stableHash } from './catalogOutbox.js';
import { declaredCatalogId } from './catalogSyncConfig.js';

// ---------------------------------------------------------------------------
// Derivación pura (ADR-0022 §1)
// ---------------------------------------------------------------------------

const esObjeto = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** `relationship` declarado, leído CRUDO. `invalid` ⇒ había algo y no es del vocabulario. */
export function declaredRelationship(raw: unknown): { value: CatalogRelationship | null; invalid: boolean } {
  if (!esObjeto(raw)) return { value: null, invalid: false };
  const r = raw.relationship;
  if (r === undefined || r === null) return { value: null, invalid: false };
  if (typeof r === 'string' && (CATALOG_RELATIONSHIPS as readonly string[]).includes(r)) {
    return { value: r as CatalogRelationship, invalid: false };
  }
  return { value: null, invalid: true };
}

/** ¿Hay «plomería» Meta declarada? (catalogId o interruptor). Sin ella, la config es local pura. */
const tienePlomeria = (raw: Record<string, unknown>): boolean => raw.enabled === true || !!declaredCatalogId(raw);

/**
 * Gates que exige `managed` (ADR-0022 §1): `enabled && catalogId && writable>0` — EXACTAMENTE
 * la tabla del ADR. `mode` NO participa a propósito: es el interruptor de EJECUCIÓN (nivel 1,
 * ADR-0015) y decide si HOY se envía, no cuál es la relación. Un tenant con `enabled:true` y
 * `mode:'off'` es un tenant `managed` con el envío apagado: sus rieles existen y el run de
 * sync le sigue respondiendo `disabled` (contrato fail-closed de siempre) — derivarlo `none`
 * lo expulsaría del ciclo entero por apagar el envío, que es otra pregunta.
 * `enabled` truthy no-booleano (`'true'`) NO habilita nada: mismo fail-closed de forma que
 * `normalizeCatalogSyncConfig`.
 */
function managedGateReasons(raw: Record<string, unknown>, own: EffectiveOwnership): CatalogAuthorityReason[] {
  const reasons: CatalogAuthorityReason[] = [];
  if (raw.enabled !== true) reasons.push('sync_disabled');
  if (!declaredCatalogId(raw)) reasons.push('catalog_id_missing');
  if (!own.writable.length) reasons.push('no_writable_fields');
  return reasons;
}

/**
 * Derivación EXACTA de la tabla del ADR-0022 §1. Pura y determinística: mismo `raw` ⇒ mismo
 * resultado; el input no se muta y no se toca ni Firestore ni la red.
 *
 *  · sin `catalogSync` (o config sin plomería ni propiedad) ⇒ `vendeyapy + none`;
 *  · `external_managed` ⇒ `mirror`, con authority según `external.kind`
 *    (`commerce_manager` ⇒ `meta`; `meta_feed`/`other_api` ⇒ `external`);
 *  · `vendeyapy_managed`/`hybrid` con enabled + catalogId + writable>0 ⇒ `managed`;
 *    si falta algo ⇒ `none` con el motivo;
 *  · propiedad DEGRADADA (nivel 2) con plomería Meta ⇒ `external + mirror` +
 *    `ownership_degraded`: es el supuesto seguro de `OWNERSHIP_DEGRADED` («si no sabemos
 *    quién manda, no somos nosotros») y CONSERVA lo que un tenant nivel-2 puede hacer hoy
 *    (leer y diagnosticar: import/verify siguen; escribir ya estaba bloqueado por writable=0);
 *  · `relationship` declarado incoherente con la propiedad ⇒ fail-closed al derivado + reason.
 */
export function deriveCatalogAuthority(raw: unknown): CatalogAuthorityDerived {
  const base = { botCatalog: 'local_mirror' as const };
  if (!esObjeto(raw)) {
    return { authority: 'vendeyapy', relationship: 'none', declared: false, reasons: [], ...base };
  }

  const decl = declaredRelationship(raw);
  const reasons: CatalogAuthorityReason[] = [];
  if (decl.invalid) reasons.push('relationship_invalid');
  const own = normalizeCatalogOwnership(raw.ownership);

  // ── Autoridad remota: external_managed sano, o propiedad degradada con plomería Meta ──
  const degradadaConPlomeria = own.degraded && tienePlomeria(raw);
  if ((!own.degraded && own.model === 'external_managed') || degradadaConPlomeria) {
    const authority: CatalogAuthority =
      !own.degraded && own.externalSource?.kind === 'commerce_manager' ? 'meta' : 'external';
    if (degradadaConPlomeria) reasons.push('ownership_degraded');
    // Única relación coherente con gobierno externo: mirror. Cualquier otra declaración es
    // incoherente y NO se cree (fail-closed al derivado).
    if (decl.value && decl.value !== 'mirror') reasons.push('relationship_conflict');
    return { authority, relationship: 'mirror', declared: decl.value === 'mirror', reasons, ...base };
  }

  // ── Autoridad propia: vendeyapy_managed / hybrid sanos, o config local pura ──
  const gates = managedGateReasons(raw, own);
  const derivada: CatalogRelationship = own.degraded ? 'none' : gates.length ? 'none' : 'managed';
  // `mirror` declarado bajo autoridad propia es incoherente (el espejo lo alimenta una fuente
  // externa que acá no existe): manda el derivado.
  if (decl.value === 'mirror') reasons.push('relationship_conflict');
  const candidata: CatalogRelationship = decl.value && decl.value !== 'mirror' ? decl.value : derivada;

  if (candidata === 'managed' && (own.degraded || gates.length)) {
    // Se pidió (o se derivó) `managed` y los gates no están: fail-closed a `none` CON motivo.
    reasons.push(...(own.degraded ? (['ownership_degraded'] as const) : []), ...(own.degraded ? [] : gates));
    if (own.degraded && !own.writable.length) reasons.push('no_writable_fields');
    return { authority: 'vendeyapy', relationship: 'none', declared: decl.value === 'none', reasons, ...base };
  }
  if (candidata === 'managed') {
    return { authority: 'vendeyapy', relationship: 'managed', declared: decl.value === 'managed', reasons, ...base };
  }
  // `none`: estado A. Si fue derivado por gates faltantes sobre una propiedad VÁLIDA, el motivo
  // viaja (ADR: «si falta algo ⇒ none con reason»); una config local pura no es una degradación.
  if (!decl.value && !own.degraded && gates.length) reasons.push(...gates);
  return { authority: 'vendeyapy', relationship: 'none', declared: decl.value === 'none', reasons, ...base };
}

/** Bloque `authority` de `metaCatalogOwnershipStatus` (ADR-0022 §5): derivado + frescura. */
export function buildCatalogAuthorityStatus(raw: unknown, staleness: CatalogAuthorityStaleness): CatalogAuthorityStatus {
  return { ...deriveCatalogAuthority(raw), staleness };
}

// ---------------------------------------------------------------------------
// Gating por relación (ADR-0022 §4) — el server manda; la UI espeja
// ---------------------------------------------------------------------------

/**
 * Corta con `failed-precondition {kind:'authority_relationship_blocked', relationship}` si la
 * relación efectiva del tenant no está entre las permitidas para la acción. Devuelve el
 * derivado para que el llamador no re-derive.
 */
export function assertCatalogRelationship(
  derived: CatalogAuthorityDerived,
  ...allowed: CatalogRelationship[]
): CatalogAuthorityDerived {
  if (allowed.includes(derived.relationship)) return derived;
  const message =
    derived.relationship === 'none'
      ? 'El catálogo de esta empresa no tiene relación con Meta: las acciones de catálogo contra Meta están bloqueadas. Cambiá la relación desde la configuración del catálogo.'
      : 'El catálogo de Meta de esta empresa funciona como espejo (lo administra otra fuente): esta acción implicaría escribir hacia Meta y está bloqueada.';
  throw new HttpsError('failed-precondition', message, {
    kind: 'authority_relationship_blocked',
    relationship: derived.relationship,
  });
}

/** Lee el `catalogSync` CRUDO del tenant y devuelve el derivado (una sola lectura). */
export async function loadTenantCatalogAuthority(tenantId: string): Promise<{ raw: unknown; derived: CatalogAuthorityDerived }> {
  const snap = await db().doc(`tenants/${tenantId}/config/meta`).get();
  const raw = (snap.data() as { catalogSync?: unknown } | undefined)?.catalogSync;
  return { raw, derived: deriveCatalogAuthority(raw) };
}

/** Gate de conveniencia para callables/jobs: lee, deriva y corta si no está permitido. */
export async function requireCatalogRelationship(
  tenantId: string,
  ...allowed: CatalogRelationship[]
): Promise<CatalogAuthorityDerived> {
  const { derived } = await loadTenantCatalogAuthority(tenantId);
  return assertCatalogRelationship(derived, ...allowed);
}

// ---------------------------------------------------------------------------
// Transición de modo (ADR-0022 §3): plan PURO del preview
// ---------------------------------------------------------------------------

/** Las únicas CUATRO combinaciones válidas (§2). `external+managed` es inválida por diseño. */
export const VALID_AUTHORITY_TARGETS: ReadonlyArray<CatalogAuthorityTarget> = [
  { authority: 'vendeyapy', relationship: 'none' }, // A
  { authority: 'vendeyapy', relationship: 'managed' }, // B
  { authority: 'meta', relationship: 'mirror' }, // C
  { authority: 'external', relationship: 'mirror' }, // D
];

export function isValidAuthorityTarget(t: CatalogAuthorityTarget): boolean {
  return VALID_AUTHORITY_TARGETS.some((v) => v.authority === t.authority && v.relationship === t.relationship);
}

/** Señales YA LEÍDAS por el callable (el plan es puro: acá no se toca Firestore ni la red). */
export interface AuthorityTransitionSignals {
  /** `metaConnections/main` con token utilizable. */
  connectionOk: boolean;
  /** Jobs del outbox en estado NO terminal (queued/processing/submitted/held/needs_*). */
  outboxNotTerminal: number;
  /** Importación paginada con run activo (status running). */
  importRunInFlight: boolean;
  /** Preview de sync (`mcs_*`) vigente: planned, con planHash, sin consumir, dentro del TTL. */
  syncRunInFlight: boolean;
  /** Locks con invariantes rotas (tenantId ajeno o dos locks del mismo producto). */
  mappingAmbiguous: boolean;
}

export interface AuthorityTransitionInput {
  target: CatalogAuthorityTarget;
  rawCatalogSync: unknown;
  signals: AuthorityTransitionSignals;
}

export interface AuthorityTransitionPlan {
  current: CatalogAuthorityDerived;
  bloqueos: CatalogAuthorityBlock[];
  advertencias: CatalogAuthorityWarning[];
  /** Derivación del estado POST-apply (simulada en memoria). null ⇔ hay bloqueos. */
  estadoEsperado: CatalogAuthorityDerived | null;
  /** true ⇒ el apply además escribe `catalogSync.ownership` con `proposal`. */
  modelChange: boolean;
  /** Propuesta normalizable (misma validación que la migración ADR-0015 §9). */
  proposal: CatalogOwnership | null;
}

const KINDS_POR_AUTORIDAD: Record<'meta' | 'external', readonly ExternalSourceKind[]> = {
  meta: ['commerce_manager'],
  external: ['meta_feed', 'other_api'],
};

/**
 * Plan PURO de la transición: qué bloquea, qué avisa y qué escribiría el apply. Fail-closed:
 * cualquier bloqueo deja el plan SIN estado esperado y el preview no emite planHash utilizable.
 *
 * Decisiones no obvias, documentadas acá porque el código solo no las cuenta:
 *  · El cambio de modelo SOLO se construye desde una fuente externa YA RECONOCIDA (hybrid →
 *    C/D). Reconocer una fuente NUEVA exige la migración de propiedad (ADR-0015 §9), que corre
 *    la detección real: este camino jamás «firma en blanco» una fuente que nadie vio.
 *  · D no exige conexión (la fuente ya fue reconocida vía Meta — ADR-0022 §3 pide conexión
 *    para B/C), pero SÍ `catalogId`: un espejo sin catálogo que leer es exactamente la config
 *    contradictoria que ADR-0015 §6 alerta (`external_without_catalog`).
 *  · B con el interruptor apagado NO bloquea: la relación queda declarada y el preview muestra
 *    el estado esperado HONESTO (`none` + `sync_disabled`) — encender la sync es el paso
 *    siguiente y sigue siendo una decisión aparte (la config se siembra a mano, deuda ADR-0022).
 */
export function planAuthorityTransition(input: AuthorityTransitionInput): AuthorityTransitionPlan {
  const { target, rawCatalogSync: raw, signals } = input;
  const current = deriveCatalogAuthority(raw);
  const bloqueos: CatalogAuthorityBlock[] = [];
  const advertencias: CatalogAuthorityWarning[] = [];

  // Rechazo INMEDIATO de combinaciones fuera de §2 (external+managed incluida): no se evalúa
  // nada más — un objetivo inválido no tiene bloqueos «que resolver».
  if (!isValidAuthorityTarget(target)) {
    return { current, bloqueos: [{ id: 'invalid_target' }], advertencias, estadoEsperado: null, modelChange: false, proposal: null };
  }

  const rawObj = esObjeto(raw) ? raw : {};
  const own = normalizeCatalogOwnership(rawObj.ownership);
  const catalogId = declaredCatalogId(raw);

  // ── Bloqueos por trabajo EN VUELO (siempre: no se cambia de modo con envíos vivos) ──
  if (signals.outboxNotTerminal > 0) bloqueos.push({ id: 'outbox_not_terminal', count: signals.outboxNotTerminal });
  if (signals.importRunInFlight) bloqueos.push({ id: 'import_run_in_flight' });
  if (signals.syncRunInFlight) bloqueos.push({ id: 'sync_run_in_flight' });
  if (signals.mappingAmbiguous) bloqueos.push({ id: 'mapping_ambiguous' });

  let modelChange = false;
  let proposal: CatalogOwnership | null = null;

  if (target.authority === 'vendeyapy') {
    // A/B: reclamar autoridad propia. Una fuente externa RECONOCIDA que gobierna los campos lo
    // contradice de plano: primero se resuelve en el origen (o vía la migración de propiedad),
    // jamás borrándola acá.
    if (!own.degraded && own.model === 'external_managed') {
      bloqueos.push({ id: 'external_conflict' });
    } else if (!own.degraded && own.externalSource && target.relationship === 'none') {
      // hybrid → A sería una trampa: la fuente reconocida mantiene el guard de deriva ACTIVO,
      // pero `none` apaga la verificación que refresca su evidencia — a las 24 h el catálogo
      // mapeado caería a `stale` y la venta automática se apagaría en silencio (el modo de
      // falla que ADR-0015 §6 prohíbe). hybrid → B sigue permitido: es el modelo funcionando.
      bloqueos.push({ id: 'external_conflict' });
    } else if (own.degraded && tienePlomeria(rawObj)) {
      // Nivel 2 con plomería Meta: no sabemos quién manda ⇒ no se reclama autoridad. La salida
      // es la migración de propiedad (ADR-0015 §9), que sí declara con evidencia.
      bloqueos.push({ id: 'ownership_incompatible', reasons: [...own.reasons] });
    } else if (target.relationship === 'managed') {
      // B exige propiedad escribible + conexión + catálogo (gates vigentes).
      if (own.degraded) bloqueos.push({ id: 'ownership_incompatible', reasons: [...own.reasons] });
      else if (!own.writable.length) bloqueos.push({ id: 'ownership_incompatible', reasons: ['no_writable_fields'] });
      if (!signals.connectionOk) bloqueos.push({ id: 'connection_missing' });
      if (!catalogId) bloqueos.push({ id: 'catalog_id_missing' });
      if (rawObj.enabled !== true || (rawObj.mode !== 'dry_run' && rawObj.mode !== 'live')) advertencias.push('sync_disabled');
    }
  } else {
    // C/D: espejo con autoridad remota. La propiedad debe ser (o poder volverse) external_managed
    // con el kind del destino.
    const kinds = KINDS_POR_AUTORIDAD[target.authority];
    if (own.degraded) {
      bloqueos.push({ id: 'ownership_incompatible', reasons: [...own.reasons] });
    } else if (own.model === 'external_managed') {
      if (!own.externalSource || !kinds.includes(own.externalSource.kind)) {
        bloqueos.push({ id: 'ownership_incompatible', reasons: ['external_kind_mismatch'] });
      }
    } else if (!own.externalSource) {
      // vendeyapy_managed sano no tiene fuente reconocida: reconocer una nueva es trabajo de la
      // migración de propiedad (con detección real), no de esta transición.
      bloqueos.push({ id: 'ownership_incompatible', reasons: ['external_required'] });
    } else if (!kinds.includes(own.externalSource.kind)) {
      bloqueos.push({ id: 'ownership_incompatible', reasons: ['external_kind_mismatch'] });
    } else {
      // hybrid → C/D: cambio de modelo construido desde la fuente YA reconocida, con la MISMA
      // validación que la migración (la propuesta debe sobrevivir al normalizador que la leerá).
      const src = own.externalSource;
      proposal = {
        model: 'external_managed',
        ownedFields: [],
        external: {
          kind: src.kind,
          acknowledgedSourceIds: [...src.acknowledgedSourceIds],
          declaredFields: [...src.declaredFields],
          fingerprint: src.fingerprint,
          // Se CONSERVA el reconocimiento original: esta transición no re-verifica la fuente,
          // así que no puede re-sellar quién/cuándo la reconoció.
          acknowledgedAt: src.acknowledgedAt ?? null,
          acknowledgedByUid: src.acknowledgedByUid,
        },
        lastSourceCheckAt: (rawObj.ownership as { lastSourceCheckAt?: unknown } | undefined)?.lastSourceCheckAt ?? null,
      };
      const normalizada = normalizeCatalogOwnership(proposal);
      if (normalizada.degraded || normalizada.model !== 'external_managed') {
        bloqueos.push({ id: 'ownership_incompatible', reasons: ['proposal_invalid'] });
        proposal = null;
      } else {
        modelChange = true;
      }
    }
    if (target.authority === 'meta' && !signals.connectionOk) bloqueos.push({ id: 'connection_missing' });
    if (!catalogId) bloqueos.push({ id: 'catalog_id_missing' });
  }

  if (bloqueos.length) {
    return { current, bloqueos, advertencias, estadoEsperado: null, modelChange: false, proposal: null };
  }

  // Estado esperado: derivación REAL sobre la config simulada post-apply (relationship +
  // ownership propuesto si cambia el modelo). Es la misma función pura: no puede mentir.
  const simulado: Record<string, unknown> = { ...rawObj, relationship: target.relationship };
  if (modelChange && proposal) simulado.ownership = proposal;
  const estadoEsperado = deriveCatalogAuthority(simulado);
  if (current.authority === target.authority && current.relationship === target.relationship) {
    advertencias.push('already_in_target');
  }
  return { current, bloqueos, advertencias, estadoEsperado, modelChange, proposal };
}

// ---------------------------------------------------------------------------
// Huellas y evidencia (mismo contrato que META-CATALOG-PREVIEW-BINDING-1)
// ---------------------------------------------------------------------------

/** TTL de un preview de transición: el MISMO de los previews de sync (10 minutos). */
export const AUTHORITY_PREVIEW_TTL_MS = 10 * 60_000;

/** Timestamps → millis en todo el árbol, para que la huella detecte cualquier mutación real. */
function canonizable(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  const conMillis = v as { toMillis?: () => number };
  if (typeof conMillis.toMillis === 'function') return conMillis.toMillis();
  if (Array.isArray(v)) return v.map(canonizable);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = canonizable(val);
  return out;
}

/** Huella del `catalogSync` CRUDO: la precondición fresca del apply (cambió ⇒ concurrent_change). */
export function authorityConfigFingerprint(rawCatalogSync: unknown): string {
  return stableHash({ v: 1, catalogSync: canonizable(rawCatalogSync) ?? null });
}

/** Huella del PLAN: config + objetivo + señales + propuesta. Es la evidencia del apply. */
export function authorityPlanHash(args: {
  tenantId: string;
  target: CatalogAuthorityTarget;
  rawCatalogSync: unknown;
  signals: AuthorityTransitionSignals;
  proposal: CatalogOwnership | null;
  modelChange: boolean;
}): string {
  return stableHash({
    v: 1,
    tenantId: args.tenantId,
    target: args.target,
    config: canonizable(args.rawCatalogSync) ?? null,
    signals: args.signals,
    proposal: canonizable(args.proposal),
    modelChange: args.modelChange,
  });
}

/**
 * Motivos por los que un apply queda bloqueado por su evidencia. MISMA semántica que
 * `evaluatePreviewBinding` (meta/catalog.ts): todos terminan en `failed-precondition` con el
 * run intacto y CERO escrituras. `wrong_catalog` no existe acá: cualquier cambio de config
 * (catálogo incluido) lo corta la precondición fresca como `concurrent_change`.
 */
export type AuthorityApplyBlockReason =
  | 'preview_required'
  | 'not_found'
  | 'not_usable'
  | 'mismatch'
  | 'actor_mismatch'
  | 'expired'
  | 'consumed';

/** Subset del run doc que la validación necesita (el doc completo lo escribe el preview). */
export interface AuthorityRunDocData {
  kind?: string;
  status?: string;
  planHash?: string | null;
  actorUid?: string | null;
  consumedAt?: unknown;
  expiresAtMs?: number;
}

/**
 * Validación PURA de la evidencia contra el run del preview. Se corre dos veces: fail-fast
 * antes de la transacción y DE NUEVO adentro (única autoridad anti-replay). `null` = utilizable.
 */
export function evaluateAuthorityRunBinding(
  doc: AuthorityRunDocData | null,
  ctx: { evidence: { runId: string; planHash: string }; actorUid: string | null; nowMs: number },
): AuthorityApplyBlockReason | null {
  if (!doc) return 'not_found';
  if (doc.kind !== 'authority' || doc.status !== 'planned' || typeof doc.planHash !== 'string' || !doc.planHash) {
    return 'not_usable';
  }
  if (doc.planHash !== ctx.evidence.planHash) return 'mismatch';
  // Ligado al actor: aplica quien previsualizó. Sin uid de ambos lados no hay binding posible.
  if (!ctx.actorUid || (doc.actorUid ?? null) !== ctx.actorUid) return 'actor_mismatch';
  if (doc.consumedAt) return 'consumed';
  if (typeof doc.expiresAtMs !== 'number') return 'not_usable';
  if (ctx.nowMs > doc.expiresAtMs) return 'expired';
  return null;
}
