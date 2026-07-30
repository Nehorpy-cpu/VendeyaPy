/**
 * meta/catalogOwnershipMigration.ts — Migración de la propiedad por campos (ADR-0015 §9)
 * =======================================================================================
 * Operación administrativa EXPLÍCITA preview/apply que lleva un tenant del contrato viejo
 * (`sourceOfTruth`, un literal decorativo) al contrato de PROPIEDAD POR CAMPOS. Espejo exacto
 * del mantenimiento de catálogo (ADR-0014 §4c): preview por defecto sin una sola escritura,
 * apply con confirmación explícita, paginada por cursor local, reanudable, idempotente y
 * tenant-scoped, con precondiciones REVALIDADAS dentro de la transacción del apply.
 *
 * Qué escribe el apply, y nada más:
 *   1. `catalogSync.ownership` en `tenants/{t}/config/meta` — con updateMask del campo
 *      ANIDADO, jamás reemplazando el mapa `catalogSync` (perder `enabled`/`mode`/`catalogId`
 *      apagaría la sync entera o, peor, la dejaría a medias).
 *   2. `metaSyncState` de los productos con identidad remota que todavía no lo tienen.
 *
 * Por qué el estado sembrado es `unverifiable` y no `verified`: la auditoría del 2026-07-30
 * encontró 181 artículos gobernados por un feed diario y un producto con `metaSyncStatus:
 * 'synced'` mientras Meta mostraba otro precio. Ese `synced` era una afirmación sobre el
 * pasado que nada caducaba. La migración NO lee Meta: no puede afirmar nada del presente, así
 * que dice exactamente eso — `unverifiable` — y deja que la reconciliación (ADR-0015 §6), que
 * sí lee, escriba `verified`/`drifted_external` con evidencia.
 *
 * NUNCA escribe en Meta, nunca desactiva un feed, nunca elige el modelo por su cuenta cuando
 * hay ambigüedad y nunca persiste URL firmada, query string, token ni CSV crudo: de la fuente
 * externa solo viaja metadata SANEADA (ADR-0015 §4).
 *
 * ⚠️ NO se ejecuta contra producción durante el desarrollo: es un paso del release auditado.
 */

import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import type {
  CatalogExternalSourceView,
  CatalogOwnershipView,
  MetaCatalogDetectedSource,
  MetaCatalogOwnershipMigrationBlocker,
  MetaCatalogOwnershipMigrationCounters,
  MetaCatalogOwnershipMigrationPlan,
  MetaSyncState,
  Product,
} from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import {
  CATALOG_OWNERSHIP_MODELS,
  WRITABLE_FIELDS,
  effectiveMode,
  normalizeCatalogOwnership,
  type CatalogOwnership,
  type CatalogOwnershipModel,
  type EffectiveOwnership,
  type ExternalSourceKind,
  type WritableField,
} from './catalogOwnership.js';
import { catalogSourceSetFingerprint } from './catalogSourceDetection.js';
import { normalizeCatalogSyncConfig, type MetaCatalogSyncConfig } from './catalogSyncConfig.js';

export const emptyOwnershipMigrationCounters = (): MetaCatalogOwnershipMigrationCounters => ({
  examinados: 0,
  estadoSembrado: 0,
  estadoVigente: 0,
  syncedNoVerificados: 0,
  sinMapeo: 0,
  errores: 0,
});

/** Estado que siembra la migración: honesto por construcción (no leímos Meta). */
export const MIGRATION_SEED_STATE: MetaSyncState = 'unverifiable';

/** Tope defensivo de la huella persistida (metadata saneada, nunca un documento). */
const MAX_FINGERPRINT = 240;

// ---------------------------------------------------------------------------
// Costura del detector de fuentes externas (ADR-0015 §4)
// ---------------------------------------------------------------------------

export interface ExternalSourceDetection {
  /** false ⇒ no se pudo mirar (detector no instalado o lectura fallida): NUNCA se asume "no hay". */
  available: boolean;
  sources: MetaCatalogDetectedSource[];
}

export type ExternalSourceDetector = (tenantId: string) => Promise<ExternalSourceDetection>;

/**
 * Costura INYECTABLE: el detector real (lectura por la API oficial, solo GET) se registra acá
 * desde su propio módulo. Mientras no exista, la migración reporta `detection_unavailable` y
 * jamás propone `external_managed` a ciegas — reconocer una fuente que nadie vio sería firmar
 * en blanco, exactamente el error que este programa vino a cerrar.
 */
let detectorRegistrado: ExternalSourceDetector | null = null;

export function setExternalSourceDetector(fn: ExternalSourceDetector | null): void {
  detectorRegistrado = fn;
}

export async function detectExternalSources(tenantId: string): Promise<ExternalSourceDetection> {
  if (!detectorRegistrado) return { available: false, sources: [] };
  try {
    return await detectorRegistrado(tenantId);
  } catch (e) {
    // Una detección que falla NO es "no hay fuentes": es no saber, y no saber bloquea.
    logger.warn('Migración de propiedad: la detección de fuentes externas falló', {
      tenantId,
      error: e instanceof Error ? e.message.slice(0, 200) : 'desconocido',
    });
    return { available: false, sources: [] };
  }
}

// ---------------------------------------------------------------------------
// Vistas SANEADAS para el panel
// ---------------------------------------------------------------------------

/** Milisegundos de un Timestamp de Firestore, tolerante a docs viejos. `unknown` ⇒ null. */
function aMillis(v: unknown): number | null {
  const ts = v as { toMillis?: () => number; seconds?: number } | null | undefined;
  if (ts && typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts && typeof ts.seconds === 'number') return ts.seconds * 1000;
  return null;
}

/**
 * Recorta la huella y le saca cualquier query string: aunque el detector ya entrega metadata
 * saneada, esto es lo ÚLTIMO que se persiste y una URL firmada acá quedaría guardada para
 * siempre. Defensa en profundidad, no desconfianza del detector.
 */
export function sanitizeFingerprint(raw: string): string {
  return raw.split('?')[0]!.trim().slice(0, MAX_FINGERPRINT);
}

/** Texto corto sin query string: lo mismo que la huella, para nombre y host de la fuente. */
const textoSaneado = (v: unknown, max: number): string => (typeof v === 'string' ? v.split('?')[0]!.trim().slice(0, max) : '');

/**
 * Saneado DEFENSIVO de la metadata que entrega el detector, justo antes de persistirla en el
 * run y de devolverla al panel. El detector ya la entrega saneada; esto es defensa en
 * profundidad: si un día el nombre de la fuente llega con la URL firmada del feed adentro, no
 * queda guardada para siempre en un documento que nadie vuelve a mirar.
 */
export function sanitizeDetectedSource(s: MetaCatalogDetectedSource): MetaCatalogDetectedSource {
  return {
    ...s,
    name: textoSaneado(s.name, 120),
    host: textoSaneado(s.host, 120),
    sourceId: textoSaneado(s.sourceId, 64),
    schedule: s.schedule ? textoSaneado(s.schedule, 32) : null,
    timezone: s.timezone ? textoSaneado(s.timezone, 64) : null,
    detectedFields: canonicalFields(Array.isArray(s.detectedFields) ? s.detectedFields : []),
    fingerprint: sanitizeFingerprint(typeof s.fingerprint === 'string' ? s.fingerprint : ''),
  };
}

export function externalSourceView(src: EffectiveOwnership['externalSource']): CatalogExternalSourceView | null {
  if (!src) return null;
  return {
    kind: src.kind,
    acknowledgedSourceIds: [...src.acknowledgedSourceIds],
    declaredFields: [...src.declaredFields],
    fingerprint: src.fingerprint,
    acknowledgedAtMs: aMillis(src.acknowledgedAt),
    acknowledgedByUid: src.acknowledgedByUid,
  };
}

/** Propiedad efectiva → vista del panel. Solo formas saneadas cruzan el callable. */
export function ownershipView(own: EffectiveOwnership): CatalogOwnershipView {
  return {
    model: own.model,
    writable: [...own.writable],
    external: [...own.external],
    externalSource: externalSourceView(own.externalSource),
    modeCeiling: own.modeCeiling,
    degraded: own.degraded,
    reasons: [...own.reasons],
  };
}

// ---------------------------------------------------------------------------
// Plan (PURO): qué se propone, con qué evidencia y qué lo bloquea
// ---------------------------------------------------------------------------

export interface OwnershipMigrationPlanArgs {
  tenantId: string;
  /** Config YA normalizada (fail-closed de nivel 1). */
  config: MetaCatalogSyncConfig;
  detection: ExternalSourceDetection;
  /**
   * Declaración EXPLÍCITA del owner. Manda sobre la derivación: `hybrid` y `vendeyapy_managed`
   * SOLO existen si una persona los pide — la propiedad jamás se infiere a nuestro favor.
   */
  requested?: { model?: unknown; ownedFields?: unknown } | null;
  actorUid: string | null;
  now: Timestamp;
}

export interface OwnershipMigrationPlanResult {
  plan: MetaCatalogOwnershipMigrationPlan;
  /** Propiedad a escribir. null ⇒ hay bloqueos: no se escribe nada. */
  proposal: CatalogOwnership | null;
  /** true ⇒ la propiedad vigente YA es la propuesta: el apply no reescribe (idempotencia). */
  alreadyMigrated: boolean;
}

/** Prioridad de reconocimiento: un feed gobierna más que una edición manual o una API suelta. */
const KIND_PRIORITY: ExternalSourceKind[] = ['meta_feed', 'commerce_manager', 'other_api'];

const canonicalFields = (raw: readonly string[]): WritableField[] =>
  WRITABLE_FIELDS.filter((f) => raw.includes(f));

/**
 * Huella combinada y estable de las fuentes reconocidas (orden independiente del detector).
 * Delega en `catalogSourceSetFingerprint`, la MISMA definición que usa la verificación previa
 * a un POST: lo que el apply reconoce y lo que el gate observa tienen que ser comparables, o
 * cada verificación reportaría `fingerprint_cambiado` sobre un feed que nadie tocó.
 */
export function combinedFingerprint(sources: readonly MetaCatalogDetectedSource[]): string {
  const partes = sources
    .map((s) => ({ sourceId: textoSaneado(s.sourceId, 64), fingerprint: typeof s.fingerprint === 'string' ? sanitizeFingerprint(s.fingerprint) : '' }))
    .filter((p) => !!p.fingerprint);
  return sanitizeFingerprint(catalogSourceSetFingerprint(partes));
}

export function planOwnershipMigration(args: OwnershipMigrationPlanArgs): OwnershipMigrationPlanResult {
  const { config } = args;
  // Todo lo que viene del detector se sanea ACÁ, una sola vez: lo que se persiste en el run,
  // lo que va al panel y lo que se reconoce en la propiedad sale de esta lista.
  const detection: ExternalSourceDetection = {
    available: args.detection.available,
    sources: args.detection.sources.map(sanitizeDetectedSource),
  };
  const current = config.ownership;
  const blockers: MetaCatalogOwnershipMigrationBlocker[] = [];

  const vacio = (extra?: Partial<MetaCatalogOwnershipMigrationPlan>): OwnershipMigrationPlanResult => ({
    plan: {
      tenantId: args.tenantId,
      configMode: config.mode,
      effectiveModeAfter: effectiveMode(config.mode, current),
      current: ownershipView(current),
      proposedModel: null,
      proposedOwnedFields: [],
      proposedExternalFields: [],
      detectionAvailable: detection.available,
      detectedSources: detection.sources,
      blockers,
      ...extra,
    },
    proposal: null,
    alreadyMigrated: false,
  });

  // Nivel 1 primero: sin config válida no hay nada que migrar. Un tenant sin `catalogSync`
  // (credipower) sale por acá y jamás se le toca un documento.
  if (!config.enabled || config.mode === 'off' || !config.catalogId) {
    blockers.push('sync_disabled');
    return vacio();
  }

  if (!detection.available) blockers.push('detection_unavailable');

  // ---- Modelo propuesto ----
  const pedido = typeof args.requested?.model === 'string' ? args.requested.model : '';
  if (pedido && !(CATALOG_OWNERSHIP_MODELS as readonly string[]).includes(pedido)) {
    blockers.push('proposal_invalid');
    return vacio();
  }
  const pedidoCampos = Array.isArray(args.requested?.ownedFields)
    ? canonicalFields((args.requested!.ownedFields as unknown[]).filter((x): x is string => typeof x === 'string'))
    : [];

  // Fuentes reconocibles: las del kind de mayor prioridad presente. Las demás quedan visibles
  // en `detectedSources` para que una persona decida — no se mezclan tipos en una declaración.
  const kindElegido = KIND_PRIORITY.find((k) => detection.sources.some((s) => s.kind === k)) ?? null;
  const elegidas = kindElegido ? detection.sources.filter((s) => s.kind === kindElegido) : [];

  const modelo: CatalogOwnershipModel | null = pedido
    ? (pedido as CatalogOwnershipModel)
    : elegidas.length
      ? 'external_managed' // derivación SEGURA: si hay una fuente que publica, no mandamos nosotros
      : null;

  if (!modelo) {
    // Sin fuentes detectadas y sin declaración humana no hay propuesta posible: proponer
    // `vendeyapy_managed` por descarte sería regalarnos permiso de escritura sin evidencia.
    blockers.push('external_source_unknown');
    return vacio();
  }

  const necesitaExterna = modelo === 'external_managed' || modelo === 'hybrid';
  if (necesitaExterna && !elegidas.length) {
    blockers.push('external_source_unknown');
    return vacio();
  }

  const camposDetectados = canonicalFields([...new Set(elegidas.flatMap((s) => s.detectedFields))]);
  // Con `external_managed`, si el detector no informó columnas asumimos que la fuente publica
  // TODOS los campos públicos: es la dirección segura (nos quita autoridad, no nos la da) y es
  // lo que el feed diario de arfagi hace de hecho.
  const camposExternos =
    modelo === 'external_managed' ? (camposDetectados.length ? camposDetectados : [...WRITABLE_FIELDS]) : camposDetectados;
  // Lo pedido va TAL CUAL a la propuesta: si alguien pide `external_managed` con campos propios,
  // la contradicción la detecta el normalizador y sale como `proposal_invalid`. Vaciarla en
  // silencio escribiría algo distinto de lo que la persona declaró.
  const camposPropios = pedidoCampos;

  // La fuente detectada se DECLARA siempre que exista, incluso con `vendeyapy_managed`: el
  // normalizador ve entonces el conflicto que es (dos escritores = loop diario) en vez de
  // dejarlo invisible con `external: null`, y el plan sale con `proposal_invalid`. Es la
  // "ausencia de fuentes externas incompatibles" del ADR-0015 §3: pedir `vendeyapy_managed`
  // habiendo detectado un feed exige primero decidir a mano (hybrid, o desactivar el feed).
  const externa = elegidas.length
    ? {
        kind: kindElegido as ExternalSourceKind,
        acknowledgedSourceIds: [...new Set(elegidas.map((s) => s.sourceId).filter(Boolean))].sort(),
        declaredFields: camposExternos,
        fingerprint: combinedFingerprint(elegidas),
        // El apply es el acto humano de reconocimiento: queda sellado con quién y cuándo.
        acknowledgedAt: args.now,
        acknowledgedByUid: args.actorUid ?? '',
      }
    : null;

  const proposal: CatalogOwnership = {
    model: modelo,
    ownedFields: camposPropios,
    external: externa,
    lastSourceCheckAt: detection.available ? args.now : null,
  };

  // La propuesta tiene que sobrevivir al MISMO normalizador que la va a leer después: escribir
  // una propiedad que degrada sería dejar al tenant peor que antes, con una alerta permanente.
  const normalizada = normalizeCatalogOwnership(proposal);
  if (normalizada.degraded || normalizada.model !== modelo) {
    blockers.push('proposal_invalid');
    return vacio({
      proposedModel: modelo,
      proposedOwnedFields: camposPropios,
      proposedExternalFields: camposExternos,
    });
  }

  // ---- Propiedad ya declarada: cambiarla es una decisión humana, no un efecto secundario ----
  let alreadyMigrated = false;
  if (!current.degraded) {
    const ids = (o: EffectiveOwnership) => JSON.stringify(o.externalSource?.acknowledgedSourceIds ?? []);
    const huella = (o: EffectiveOwnership) => o.externalSource?.fingerprint ?? '';
    const mismaDeclaracion =
      current.model === normalizada.model &&
      JSON.stringify(current.writable) === JSON.stringify(normalizada.writable) &&
      JSON.stringify(current.external) === JSON.stringify(normalizada.external) &&
      ids(current) === ids(normalizada) &&
      huella(current) === huella(normalizada);
    if (mismaDeclaracion) {
      alreadyMigrated = true;
    } else if (current.externalSource && normalizada.externalSource && ids(current) === ids(normalizada)) {
      // Mismas fuentes, declaración distinta (típicamente la huella): el feed cambió de forma.
      // Hace falta un reconocimiento humano nuevo — jamás se re-reconoce solo (ADR-0015 §4).
      blockers.push('external_fingerprint_changed');
    } else {
      blockers.push('ownership_already_declared');
    }
  }

  const plan: MetaCatalogOwnershipMigrationPlan = {
    tenantId: args.tenantId,
    configMode: config.mode,
    // El techo de la propuesta manda: con `external_managed` el modo efectivo cae a dry_run
    // aunque la config diga `live`. El loop diario deja de ser alcanzable.
    effectiveModeAfter: blockers.length ? effectiveMode(config.mode, current) : effectiveMode(config.mode, normalizada),
    current: ownershipView(current),
    proposedModel: modelo,
    proposedOwnedFields: normalizada.writable,
    proposedExternalFields: normalizada.external,
    detectionAvailable: detection.available,
    detectedSources: detection.sources,
    blockers,
  };

  return { plan, proposal: blockers.length ? null : proposal, alreadyMigrated };
}

// ---------------------------------------------------------------------------
// Siembra del estado ACTUAL de cada producto (PURO)
// ---------------------------------------------------------------------------

export type SeedDecision =
  | { accion: 'sembrar'; estado: MetaSyncState; syncedNoVerificado: boolean }
  | { accion: 'vigente' }
  | { accion: 'sin_mapeo' };

/**
 * Qué hace la migración con UN producto. Reglas, y el porqué de cada una:
 *  · ya tiene `metaSyncState` ⇒ no se toca (la reconciliación, que sí lee Meta, sabe más);
 *  · sin identidad remota (ni retailer_id ni item id) ⇒ no hay nada que afirmar: no se escribe;
 *  · con identidad remota ⇒ `unverifiable`, incluidos los que decían `synced` sin que nadie
 *    hubiera leído Meta jamás. Ese es exactamente el verde falso que encontró la auditoría.
 */
export function ownershipMigrationDecision(p: Product): SeedDecision {
  if (p.metaSyncState) return { accion: 'vigente' };
  const mapeado = !!((p.metaRetailerId ?? '').trim() || (p.metaProductItemId ?? '').trim());
  if (!mapeado) return { accion: 'sin_mapeo' };
  return { accion: 'sembrar', estado: MIGRATION_SEED_STATE, syncedNoVerificado: p.metaSyncStatus === 'synced' };
}

// ---------------------------------------------------------------------------
// Persistencia (costura inyectable: los tests corren con un mundo en memoria)
// ---------------------------------------------------------------------------

export interface OwnershipMigrationProgressPatch {
  status: 'running' | 'completed';
  cursor: string | null;
  pagesDone: number;
  counters: MetaCatalogOwnershipMigrationCounters;
  porEstado: Record<string, number>;
  ownershipWritten: boolean;
  lastError?: string;
}

/** Desenlace de la escritura de `catalogSync.ownership` (transaccional, precondiciones frescas). */
export type OwnershipWriteOutcome = 'written' | 'already' | 'conflict' | 'precondition_failed';

/** Desenlace de la siembra de UN producto. `error` jamás se disfraza de `missing`. */
export interface SeedWriteResult {
  outcome: 'written' | 'already' | 'missing' | 'error';
  error?: string;
}

export interface OwnershipMigrationStore {
  listProductsPage(cursor: string | null, pageSize: number): Promise<{ products: Product[]; nextCursor: string | null }>;
  /**
   * Escribe SOLO `catalogSync.ownership` revalidando precondiciones DENTRO de la transacción:
   * la config sigue habilitada, el catalogId es el mismo y nadie declaró otra propiedad entre
   * el preview y el apply.
   */
  writeOwnership(proposal: CatalogOwnership, expectedCatalogId: string): Promise<OwnershipWriteOutcome>;
  /** Escribe SOLO `metaSyncState` si el producto sigue sin estado actual (jamás pisa). */
  seedState(productId: string, estado: MetaSyncState): Promise<SeedWriteResult>;
  saveProgress(patch: OwnershipMigrationProgressPatch): Promise<void>;
}

/**
 * Guard monotónico del progreso (espejo de `maintenanceProgressRegression`): pagesDone y
 * contadores JAMÁS retroceden. Un llamador con estado viejo se descarta con constancia.
 */
export function ownershipProgressRegression(
  current: { pagesDone?: number; counters?: Partial<MetaCatalogOwnershipMigrationCounters> },
  patch: { pagesDone: number; counters: MetaCatalogOwnershipMigrationCounters },
): string | null {
  if (patch.pagesDone < (current.pagesDone ?? 0)) return `pagesDone ${patch.pagesDone} < ${current.pagesDone}`;
  for (const [k, v] of Object.entries(current.counters ?? {})) {
    const nuevo = patch.counters[k as keyof MetaCatalogOwnershipMigrationCounters];
    if (typeof v === 'number' && typeof nuevo === 'number' && nuevo < v) return `counters.${k} ${nuevo} < ${v}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Corrida paginada
// ---------------------------------------------------------------------------

export interface RunOwnershipMigrationArgs {
  tenantId: string;
  mode: 'preview' | 'apply';
  store: OwnershipMigrationStore;
  /** Propuesta FIJADA al run en su creación (las reanudaciones usan la del run). */
  proposal: CatalogOwnership | null;
  catalogId: string;
  /** Estado reanudado. */
  cursor: string | null;
  counters: MetaCatalogOwnershipMigrationCounters;
  porEstado: Record<string, number>;
  pagesDone: number;
  ownershipWritten: boolean;
  lastError?: string;
  maxPages: number;
  pageSize?: number;
}

export interface RunOwnershipMigrationResult {
  status: 'running' | 'completed';
  cursor: string | null;
  pagesDone: number;
  counters: MetaCatalogOwnershipMigrationCounters;
  porEstado: Record<string, number>;
  ownershipWritten: boolean;
  stopReason?: 'pages_budget';
  lastError?: string;
}

const DEFAULT_PAGE_SIZE = 200;

/** Error de precondición del apply: el callable lo traduce a `failed-precondition`. */
export class OwnershipMigrationPreconditionError extends Error {
  constructor(readonly outcome: OwnershipWriteOutcome) {
    super(
      outcome === 'conflict'
        ? 'La propiedad del catálogo cambió desde el preview: volvé a correr el preview antes de aplicar.'
        : 'La configuración de sincronización cambió desde el preview: volvé a correr el preview antes de aplicar.',
    );
    this.name = 'OwnershipMigrationPreconditionError';
  }
}

export async function runOwnershipMigrationPages(args: RunOwnershipMigrationArgs): Promise<RunOwnershipMigrationResult> {
  const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
  const counters = { ...args.counters };
  const porEstado = { ...args.porEstado };
  let cursor = args.cursor;
  let pagesDone = args.pagesDone;
  let ownershipWritten = args.ownershipWritten;
  // El lastError del run se HEREDA: una reanudación sin errores nuevos no lo borra.
  let lastError = (args.lastError ?? '').trim();

  // ORDEN DELIBERADO: primero se cierra la puerta (la propiedad, que baja el techo a dry_run y
  // deja `writable` vacío) y recién después se sanean los estados. Al revés, una corrida que se
  // corta a la mitad dejaría estados nuevos con permisos viejos.
  if (args.mode === 'apply' && args.proposal && !ownershipWritten) {
    const r = await args.store.writeOwnership(args.proposal, args.catalogId);
    if (r === 'conflict' || r === 'precondition_failed') throw new OwnershipMigrationPreconditionError(r);
    ownershipWritten = true; // 'already' incluido: el estado deseado ya está en el documento
  }

  const resultado = (extra: Partial<RunOwnershipMigrationResult> & { status: 'running' | 'completed' }): RunOwnershipMigrationResult => ({
    cursor,
    pagesDone,
    counters,
    porEstado,
    ownershipWritten,
    ...(lastError ? { lastError } : {}),
    ...extra,
  });

  for (let intento = 0; intento < args.maxPages; intento++) {
    const page = await args.store.listProductsPage(cursor, pageSize);

    for (const p of page.products) {
      counters.examinados++;
      const d = ownershipMigrationDecision(p);
      if (d.accion === 'vigente') {
        counters.estadoVigente++;
        continue;
      }
      if (d.accion === 'sin_mapeo') {
        counters.sinMapeo++;
        continue;
      }
      if (args.mode === 'preview') {
        // Preview cuenta lo que SE HARÍA — cero escrituras.
        counters.estadoSembrado++;
        if (d.syncedNoVerificado) counters.syncedNoVerificados++;
        porEstado[d.estado] = (porEstado[d.estado] ?? 0) + 1;
        continue;
      }
      const r = await args.store.seedState(p.id, d.estado);
      if (r.outcome === 'written') {
        counters.estadoSembrado++;
        if (d.syncedNoVerificado) counters.syncedNoVerificados++;
        porEstado[d.estado] = (porEstado[d.estado] ?? 0) + 1;
      } else if (r.outcome === 'already') {
        // Otro camino (la reconciliación) escribió el estado entre la página y la escritura:
        // el suyo vale más que el nuestro — leyó Meta de verdad.
        counters.estadoVigente++;
      } else if (r.outcome === 'error') {
        counters.errores++;
        lastError = `No se pudo sembrar el estado de ${p.id}: ${r.error ?? 'error de transacción'}`.slice(0, 300);
      }
      // 'missing': el producto desapareció entre la página y la escritura — no se cuenta.
    }

    cursor = page.nextCursor;
    pagesDone++;
    const status = cursor === null ? 'completed' : 'running';
    await args.store.saveProgress({ status, cursor, pagesDone, counters, porEstado, ownershipWritten, lastError });
    if (status === 'completed') return resultado({ status: 'completed' });
  }

  return resultado({ status: 'running', stopReason: 'pages_budget' });
}

// ---------------------------------------------------------------------------
// Doc del run + store real (Firestore)
// ---------------------------------------------------------------------------

/** Doc de la corrida (`tenants/{t}/metaCatalogOwnershipRuns/{runId}`). Cerrado por rules. */
export interface MetaCatalogOwnershipMigrationRunDoc {
  runId: string;
  tenantId: string;
  mode: 'preview' | 'apply';
  status: 'running' | 'completed' | 'failed';
  cursor: string | null;
  pagesDone: number;
  counters: MetaCatalogOwnershipMigrationCounters;
  porEstado: Record<string, number>;
  /** Plan SANEADO fijado en la creación (las reanudaciones NO re-derivan la propuesta). */
  plan: MetaCatalogOwnershipMigrationPlan;
  /** Propuesta a escribir, fijada al run. null en preview o con bloqueos. */
  proposal: CatalogOwnership | null;
  catalogId: string;
  ownershipWritten: boolean;
  actorUid: string | null;
  lastError: string;
  startedAt: Timestamp;
  updatedAt: Timestamp;
  finishedAt: Timestamp | null;
}

export function firestoreOwnershipMigrationStore(args: { tenantId: string; runId: string }): OwnershipMigrationStore {
  const { tenantId, runId } = args;
  return {
    async listProductsPage(cursor, pageSize) {
      let q = db().collection(paths.products(tenantId)).orderBy(FieldPath.documentId()).limit(pageSize);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      const products = snap.docs.map((d) => ({ ...(d.data() as Product), id: d.id }));
      // Cursor = último id SOLO si la página vino llena (una página corta es la última).
      const nextCursor = snap.size === pageSize ? snap.docs[snap.size - 1]!.id : null;
      return { products, nextCursor };
    },

    async writeOwnership(proposal, expectedCatalogId) {
      const ref = db().doc(`tenants/${tenantId}/config/meta`);
      return db().runTransaction(async (tx) => {
        const raw = (await tx.get(ref)).data() as { catalogSync?: unknown } | undefined;
        const cfg = normalizeCatalogSyncConfig(raw?.catalogSync);
        // PRECONDICIONES FRESCAS: la sync sigue habilitada y sobre el MISMO catálogo. Si alguien
        // la apagó o la mudó entre el preview y el apply, no se escribe nada.
        if (!cfg.enabled || cfg.catalogId !== expectedCatalogId) return 'precondition_failed';
        const actual = cfg.ownership;
        const deseada = normalizeCatalogOwnership(proposal);
        if (!actual.degraded) {
          const igual =
            actual.model === deseada.model &&
            JSON.stringify(actual.writable) === JSON.stringify(deseada.writable) &&
            JSON.stringify(actual.external) === JSON.stringify(deseada.external) &&
            (actual.externalSource?.fingerprint ?? '') === (deseada.externalSource?.fingerprint ?? '');
          // Idempotente: la misma declaración no se reescribe (no re-sella el reconocimiento).
          if (igual) return 'already';
          // Otra propiedad vigente: NO se pisa. Cambiarla es una decisión humana explícita.
          return 'conflict';
        }
        // updateMask del campo ANIDADO: reemplazar el mapa `catalogSync` entero borraría
        // enabled/mode/catalogId y apagaría (o peor, dejaría a medias) la sincronización.
        tx.update(ref, 'catalogSync.ownership', proposal);
        return 'written';
      });
    },

    async seedState(productId, estado) {
      const ref = db().doc(paths.product(tenantId, productId));
      try {
        return await db().runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) return { outcome: 'missing' as const };
          const fresh = snap.data() as Product;
          // Si la reconciliación escribió el estado entre la página y acá, NO se pisa: ella
          // leyó Meta de verdad; nosotros solo estamos sembrando honestidad inicial.
          if (fresh.metaSyncState) return { outcome: 'already' as const };
          // `update` de UN solo campo: jamás toca nombre/precio/costo/stock/status/mapping/sync,
          // y no toca updatedAt — una migración no es una edición humana.
          tx.update(ref, { metaSyncState: estado });
          return { outcome: 'written' as const };
        });
      } catch (e) {
        const detalle = e instanceof Error ? e.message.slice(0, 200) : 'desconocido';
        logger.warn('Migración de propiedad: no se pudo sembrar el estado', { tenantId, runId, productId, error: detalle });
        return { outcome: 'error', error: detalle };
      }
    },

    async saveProgress(patch) {
      const now = Timestamp.now();
      const ref = db().doc(paths.metaCatalogOwnershipRun(tenantId, runId));
      await db().runTransaction(async (tx) => {
        const run = (await tx.get(ref)).data() as MetaCatalogOwnershipMigrationRunDoc | undefined;
        // Guard 1: jamás escribir sobre un run que ya no está 'running' (el worker lento de un
        // runId reanudado dos veces no pisa el cierre del rápido).
        if (!run || run.status !== 'running') {
          logger.warn('Migración de propiedad: escritura sobre un run no-running DESCARTADA', {
            tenantId,
            runId,
            status: run?.status ?? 'inexistente',
          });
          return;
        }
        // Guard 2: cursor/contadores jamás retroceden.
        const regresion = ownershipProgressRegression(run, patch);
        if (regresion) {
          logger.error('Migración de propiedad: escritura de progreso REGRESIVA descartada', { tenantId, runId, regresion });
          return;
        }
        tx.update(ref, {
          status: patch.status,
          cursor: patch.cursor,
          pagesDone: patch.pagesDone,
          counters: patch.counters,
          porEstado: patch.porEstado,
          ownershipWritten: patch.ownershipWritten,
          lastError: patch.lastError ?? '',
          updatedAt: now,
          ...(patch.status === 'completed' ? { finishedAt: now } : {}),
        });
      });
    },
  };
}
