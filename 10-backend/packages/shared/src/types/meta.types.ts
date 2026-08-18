/**
 * Integración con Meta (Track D / D1). La conexión guarda solo una REFERENCIA al
 * token (en Secret Manager) — nunca el token en claro (ADR-0009). Los assets son
 * las cuentas/activos de Meta vinculados (WhatsApp, IG, página, ad account, etc.).
 * Subcolecciones: tenants/{t}/metaConnections/{id} · tenants/{t}/metaAssets/{id}.
 */

import { WEBHOOK_EVENT_KIND } from '../enums.js';
import type { MetaConnectionStatus, MetaConnectionSource, MetaAssetType, WebhookStatus, WebhookEventKind, WhatsappActivationStatus } from '../enums.js';
import type { Timestamp } from './common.types.js';
import type { CampaignAttribution } from './attribution.types.js';

export interface MetaConnection {
  id: string;
  tenantId: string;
  metaBusinessId: string;
  metaBusinessName: string;
  connectedUserId: string;
  /** Referencia al token en Secret Manager. NUNCA el token en claro (ADR-0009). */
  tokenSecretRef: string;
  tokenType: string;
  tokenExpiresAt: Timestamp | null;
  scopes: string[];
  status: MetaConnectionStatus;
  /** Origen de la conexión. Opcional/aditivo: ausente = legacy/Embedded Signup. */
  source?: MetaConnectionSource;
  lastVerifiedAt: Timestamp | null;
  errorMessage: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface MetaAsset {
  id: string;
  tenantId: string;
  connectionId: string;
  assetType: MetaAssetType;
  externalId: string;
  name: string;
  status: string;
  selected: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /**
   * Coexistence (ADR-0017 §6). Último `account_update` que Meta mandó sobre este número
   * (`ACCOUNT_OFFBOARDED`, `PARTNER_REMOVED`, `ACCOUNT_RECONNECTED`). Es EVIDENCIA, no permiso: el
   * permiso vive en `automationMode` y quien lo lee es `resolveAutomationMode`.
   *
   * ADITIVOS Y OPCIONALES a propósito: conviven con los assets escritos antes de que existieran, y
   * el lector del permiso ya trata la ausencia como fail-closed.
   */
  coexistenceLastAccountEvent?: string;
  coexistenceLastAccountEventAt?: Timestamp | null;
}

/**
 * Evento crudo de webhook de Meta (colección GLOBAL metaWebhookInbox). Se guarda
 * rápido, se responde a Meta, y se procesa en segundo plano (D2 · ADR-0009).
 * `expiresAt` permite TTL para limpieza automática.
 */
export interface WebhookInboxEvent {
  id: string;
  platform: string; // whatsapp | instagram | messenger
  objectType: string;
  eventType: string;
  externalId: string; // id externo del destinatario/asset (para resolver la empresa)
  tenantId: string | null;
  processingStatus: WebhookStatus;
  payload: unknown; // payload crudo
  errorMessage: string;
  receivedAt: Timestamp;
  /**
   * Cuándo una corrida TOMÓ el evento (pasó a `processing`). Es lo que permite distinguir «se está
   * procesando ahora» de «la corrida que lo tomó murió y lo dejó clavado»: sin esta marca, un
   * evento con adjunto podía quedar en `processing` para siempre y el archivo del cliente perderse.
   * Opcional porque los eventos anteriores no la tienen (ahí manda `receivedAt`).
   */
  processingStartedAt?: Timestamp | null;
  processedAt: Timestamp | null;
  expiresAt: Timestamp | null;
  /**
   * Coexistence (ADR-0017 §12): qué TIPO de evento es, ya resuelto por `change.field`.
   *
   * OPCIONAL a propósito. Cuando esto se despliega hay eventos ya escritos en la bandeja que no
   * tienen el campo, y perderlos sería exactamente la clase de defecto que este programa arregla.
   * El lector canónico es `readWebhookEventKind()`: ausente ⇒ `'message'` (que es lo que esos
   * eventos SON), valor desconocido ⇒ `'unknown'`.
   */
  kind?: WebhookEventKind;
  /**
   * true SOLO en los chunks de `history`. Un registro histórico no es una bandeja de entrada: no
   * alimenta el prompt de la IA, no dispara campanas y no se mezcla con los mensajes vivos.
   */
  historical?: boolean;
  /**
   * false en todo lo que no sea un `messages` vivo. NO es un permiso: el gate por PNID
   * (`automationMode`) manda igual. Es una marca legible que hace evidente, mirando el documento,
   * que ese evento jamás debió disparar negocio.
   */
  automationEligible?: boolean;
  /** false en historial: no cuenta para contadores de no-leídos ni notificaciones. */
  unread?: boolean;
}

/**
 * Lector canónico de `kind`. Existe como función —y no como un `ev.kind ?? 'message'` repetido en
 * cada borde— por la misma razón que `isRolloutFlagEnabled` en `attachmentRollout.ts`: dos lecturas
 * del mismo campo terminan divergiendo, y la laxa es la que deja pasar cosas.
 *
 * Las dos ramas NO son la misma decisión:
 *  - AUSENTE ⇒ `'message'`. Es retrocompatibilidad, no laxitud: los eventos escritos antes de este
 *    cambio son todos mensajes vivos, y tratarlos de otra forma los rompería.
 *  - PRESENTE PERO DESCONOCIDO ⇒ `'unknown'`. Un valor que este despliegue no entiende (una versión
 *    futura, un dato corrupto) cae al tipo MÁS RESTRICTIVO. Nunca se degrada a `'message'`.
 */
export function readWebhookEventKind(ev: { kind?: unknown } | null | undefined): WebhookEventKind {
  const raw = ev?.kind;
  if (raw === undefined || raw === null) return 'message';
  return (WEBHOOK_EVENT_KIND as readonly string[]).includes(raw as string) ? (raw as WebhookEventKind) : 'unknown';
}

/**
 * Onboarding manual de WhatsApp (WM-2). El TENANT_OWNER solicita activación asistida
 * (status='pending'); el PLATFORM_ADMIN carga la conexión manual (WM-1) y la marca 'completed',
 * o la 'cancelled'. Vive en tenants/{tenantId}/whatsappActivationRequests/{requestId}.
 * ESCRITURA SOLO por callable (Admin SDK; rules write:false). NUNCA contiene el token de acceso.
 */
export interface WhatsappActivationRequest {
  id: string;
  tenantId: string;
  status: WhatsappActivationStatus;
  /** Quién creó la solicitud (uid del owner/admin) y su rol al momento de crearla. */
  requestedByUid: string;
  requestedByRole: string;
  requestedAt: Timestamp;
  /** Nombre de la empresa al momento de solicitar (snapshot informativo). */
  businessName: string | null;
  /** Teléfono/WhatsApp de contacto para coordinar la activación (informativo, no sensible). */
  contactPhone: string | null;
  /** Nota opcional del owner. */
  note: string | null;
  /** Quién revisó (completó/canceló) y cuándo. */
  reviewedByUid: string | null;
  reviewedAt: Timestamp | null;
  /** Al completar (WM-1): estado resultante de la conexión + phone id. NO incluye token. */
  connectionStatus: string | null;
  phoneNumberId: string | null;
  /** Motivo de cancelación (si status='cancelled'). */
  cancelReason: string | null;
}

/**
 * Índice GLOBAL para resolver a qué empresa pertenece un id externo de Meta
 * (ej: whatsapp_123…, instagram_178…). id = `${platform}_${externalId}`.
 */
export interface MetaExternalIndexEntry {
  id: string;
  tenantId: string;
  connectionId: string;
  assetType: string;
  platform: string;
  externalId: string;
  status: string;
  updatedAt: Timestamp;
}

// ----- Meta Ads (solo lectura, D3). Snapshots sincronizados por job (ADR-0009) -----

export interface MetaAdMetrics {
  impressions: number;
  reach: number;
  clicks: number;
  spend: number; // gasto en la moneda de la cuenta
  ctr: number; // %
  cpc: number;
  cpm: number;
  conversations: number; // conversaciones iniciadas desde el anuncio
}

export interface MetaCampaign {
  id: string;
  tenantId: string;
  externalCampaignId: string;
  name: string;
  status: string;
  objective: string;
  adAccountId: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  spendCap: number | null;
  latestMetrics: MetaAdMetrics;
  /** Atribución calculada (D5): ventas/ingresos/ganancia/ROAS reales de la campaña. */
  attribution?: CampaignAttribution;
  lastSyncedAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface MetaAdset {
  id: string;
  tenantId: string;
  externalAdsetId: string;
  externalCampaignId: string;
  name: string;
  status: string;
  budget: number | null;
  optimizationGoal: string;
  latestMetrics: MetaAdMetrics;
  lastSyncedAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface MetaAd {
  id: string;
  tenantId: string;
  externalAdId: string;
  externalAdsetId: string;
  externalCampaignId: string;
  name: string;
  status: string;
  creativeSummary: string;
  previewUrl: string;
  latestMetrics: MetaAdMetrics;
  lastSyncedAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Registro de cada envío de un producto al Meta Catalog (D4). */
export interface MetaCatalogSyncLog {
  id: string;
  tenantId: string;
  productId: string;
  metaCatalogId: string | null;
  metaProductItemId: string | null;
  action: string; // create | update | disable | delete
  status: string; // pending | success | failed
  errorMessage: string;
  createdAt: Timestamp;
}

/** Snapshot diario por anuncio. id = `${yyyymmdd}_${externalAdId}`. */
export interface MetaAdInsightDaily {
  id: string;
  date: string; // yyyymmdd
  tenantId: string;
  externalCampaignId: string;
  externalAdsetId: string;
  externalAdId: string;
  campaignName: string;
  adName: string;
  impressions: number;
  reach: number;
  clicks: number;
  spend: number;
  ctr: number;
  cpc: number;
  cpm: number;
  conversations: number;
  /** Atribución (la completa D5): pedidos/ingresos/ganancia que dejó el anuncio. */
  orders: number;
  revenue: number;
  productCost: number | null;
  grossProfit: number | null;
  roas: number | null;
  margin: number | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Importación PAGINADA del catálogo de Meta (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1)
// ---------------------------------------------------------------------------

export type MetaCatalogImportRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Contadores acumulados de un run de importación. `unclassified` es un SUBCONJUNTO de
 * `imported` (importados como borrador sin categoría); `cursorResets` cuenta cuántas veces
 * el cursor de Graph venció y el barrido reinició desde cero (idempotente por docId).
 */
export interface MetaCatalogImportCounters {
  imported: number;
  alreadyLinked: number;
  alreadyImported: number;
  ambiguous: number;
  conflicted: number;
  skipped: number;
  unclassified: number;
  cursorResets: number;
}

/** Vista SANEADA del run para el panel (la devuelven los callables; el doc está cerrado por rules). */
export interface MetaCatalogImportRunSummary {
  runId: string;
  status: MetaCatalogImportRunStatus;
  pagesDone: number;
  /** Items remotos procesados (clasificados) hasta ahora. */
  processed: number;
  counters: MetaCatalogImportCounters;
  blockedByReason: Record<string, number>;
  /** true si el run quedó a mitad de catálogo (hay cursor persistido para reanudar). */
  hasCursor: boolean;
  startedAtMs: number | null;
  updatedAtMs: number | null;
  finishedAtMs: number | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Mantenimiento del catálogo: backfill de locks + quality (HARDEN-1, ADR-0014 §4c)
// ---------------------------------------------------------------------------

export type MetaCatalogMaintenanceMode = 'preview' | 'apply';
export type MetaCatalogMaintenanceStatus = 'running' | 'completed' | 'failed';

/**
 * Contadores HONESTOS de una corrida de mantenimiento. En `preview` cuentan lo que SE HARÍA
 * (nada se escribe); en `apply` cuentan lo efectivamente hecho. `conflictos` jamás elige
 * ganador: los casos ambiguos se reportan para resolución humana y no se toca nada.
 * `archivadosSalteados` cuenta los ARCHIVED sin quality que el backfill SALTEA a propósito
 * (ADR-0014 §4c: evaluarlos generaría bloqueos permanentes e inaccionables); `erroresQuality`
 * cuenta los backfills que fallaron por error de transacción (≠ producto inexistente) — un
 * run con errores jamás se presenta limpio.
 */
export interface MetaCatalogMaintenanceCounters {
  examinados: number;
  locksCreados: number;
  locksExistentes: number;
  conflictos: number;
  qualityCalculada: number;
  qualityVigente: number;
  archivadosSalteados: number;
  erroresQuality: number;
}

/** Conflicto de identidad remota: dos (o más) productos reclamando el mismo retailer_id. */
export interface MetaCatalogMaintenanceConflict {
  retailerId: string;
  productIds: string[];
}

/** Vista SANEADA de la corrida para el panel (el doc está cerrado al cliente por rules). */
export interface MetaCatalogMaintenanceRunSummary {
  runId: string;
  mode: MetaCatalogMaintenanceMode;
  status: MetaCatalogMaintenanceStatus;
  pagesDone: number;
  counters: MetaCatalogMaintenanceCounters;
  conflicts: MetaCatalogMaintenanceConflict[];
  /** true si hubo más conflictos que el tope almacenado: la lista es un piso, no el total. */
  conflictsTruncated: boolean;
  /** true si la corrida quedó a mitad de catálogo (cursor persistido para reanudar). */
  hasCursor: boolean;
  startedAtMs: number | null;
  updatedAtMs: number | null;
  finishedAtMs: number | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Propiedad por campos del catálogo (META-CATALOG-OWNERSHIP-MODEL-1, ADR-0015)
// ---------------------------------------------------------------------------
// VOCABULARIO PÚBLICO para el panel. La LÓGICA (normalización fail-closed de nivel 2, gates
// outbound) vive en `apps/functions/src/meta/catalogOwnership.ts` y NO se duplica acá: estas
// son las formas SANEADAS que viajan por callable. Un test de paridad en functions
// (`catalogOwnership.test.ts`) falla si alguno de los dos lados agrega un valor que el otro no
// conoce — sin él, el panel podría mostrar un modelo que el normalizador rechaza.

/**
 * Campos PÚBLICOS del contrato de escritura que pueden tener dueño. Deliberadamente NO incluye
 * costo, márgenes, `productFinancials`, `aiFicha` ni notas internas: son locales, jamás
 * publicables ni delegables (ADR-0015 §1).
 */
export const CATALOG_WRITABLE_FIELDS = [
  'title',
  'description',
  'price',
  'currency',
  'availability',
  'inventory',
  'brand',
  'category',
  'image',
  'url',
] as const;
export type WritableField = (typeof CATALOG_WRITABLE_FIELDS)[number];

export const CATALOG_OWNERSHIP_MODELS = ['vendeyapy_managed', 'external_managed', 'hybrid'] as const;
export type CatalogOwnershipModel = (typeof CATALOG_OWNERSHIP_MODELS)[number];

export const CATALOG_EXTERNAL_SOURCE_KINDS = ['meta_feed', 'commerce_manager', 'other_api'] as const;
export type CatalogExternalSourceKind = (typeof CATALOG_EXTERNAL_SOURCE_KINDS)[number];

/** Modo de ejecución de la sync (espejo de `CATALOG_SYNC_MODES` en functions). */
export type MetaCatalogSyncMode = 'off' | 'dry_run' | 'live';

/** Por qué la propiedad quedó degradada (fail-closed de nivel 2). Se le muestra al owner. */
export type CatalogOwnershipDegradedReason =
  | 'ownership_missing'
  | 'ownership_malformed'
  | 'ownership_conflict'
  | 'ownership_never_publishable'
  | 'external_declaration_invalid'
  | 'external_required'
  | 'owned_fields_required'
  | 'hybrid_partition_missing';

/**
 * Fuente externa RECONOCIDA por una persona, en su forma SANEADA para el panel. `fingerprint`
 * se calcula sobre datos NO secretos (identificador, host sin query, horario, columnas): jamás
 * viaja ni se persiste la URL firmada, su query string ni el token (ADR-0015 §4).
 */
export interface CatalogExternalSourceView {
  kind: CatalogExternalSourceKind;
  acknowledgedSourceIds: string[];
  declaredFields: WritableField[];
  fingerprint: string;
  acknowledgedAtMs: number | null;
  acknowledgedByUid: string;
}

/**
 * Propiedad EFECTIVA (ya normalizada) tal como la ve el panel. `writable` vacío ⇒ no existe
 * patch posible: con `external_managed` el loop diario es inalcanzable por construcción.
 */
export interface CatalogOwnershipView {
  model: CatalogOwnershipModel;
  writable: WritableField[];
  external: WritableField[];
  externalSource: CatalogExternalSourceView | null;
  /** Techo de ejecución: 'dry_run' impide escribir aunque la config diga `live`. */
  modeCeiling: 'dry_run' | 'live';
  degraded: boolean;
  reasons: CatalogOwnershipDegradedReason[];
}

/**
 * Fuente externa DETECTADA por la lectura de la API oficial (solo GET) — metadata SANEADA.
 * Contrato de datos entre el detector y la migración/panel. NUNCA incluye la URL firmada, su
 * query string, el token ni el archivo crudo del feed (ADR-0015 §4).
 */
export interface MetaCatalogDetectedSource {
  kind: CatalogExternalSourceKind;
  /** Identificador NO secreto del feed/data source (el id que devuelve Graph). */
  sourceId: string;
  /** Nombre saneado que muestra Meta. Sin URLs ni credenciales. */
  name: string;
  /** Host de la fuente SIN esquema de credenciales ni query string. '' si no se conoce. */
  host: string;
  /** Horario declarado del feed (p. ej. '03:33') y su zona, si Meta los informa. */
  schedule: string | null;
  timezone: string | null;
  /** true si la fuente BORRA los artículos que no aparecen en su archivo. */
  deletesMissingItems: boolean | null;
  /** Campos públicos que la fuente publica, según lo detectado. */
  detectedFields: WritableField[];
  /** Artículos que gobierna, si Meta lo informa. */
  itemCount: number | null;
  /** Huella SANEADA (identificador + host sin query + horario + columnas declaradas). */
  fingerprint: string;
  lastSeenAtMs: number | null;
}

// ---------------------------------------------------------------------------
// Migración de propiedad: operación administrativa preview/apply (ADR-0015 §9)
// ---------------------------------------------------------------------------

export type MetaCatalogOwnershipMigrationMode = 'preview' | 'apply';
export type MetaCatalogOwnershipMigrationStatus = 'running' | 'completed' | 'failed';

/**
 * Motivos que IMPIDEN el apply. Un bloqueo jamás se resuelve solo: la migración no desactiva
 * feeds, no cambia el modelo por su cuenta y no reconoce una fuente que nadie vio.
 */
export type MetaCatalogOwnershipMigrationBlocker =
  /** Nivel 1: la sync está apagada o mal configurada — no hay nada que migrar (p. ej. un tenant sin config). */
  | 'sync_disabled'
  /** El detector de fuentes externas todavía no está disponible en este despliegue. */
  | 'detection_unavailable'
  /** No se detectó ninguna fuente externa y nadie declaró explícitamente el modelo. */
  | 'external_source_unknown'
  /** La huella de la fuente reconocida cambió: hace falta un reconocimiento humano nuevo. */
  | 'external_fingerprint_changed'
  /** La propuesta no sobrevive al normalizador (escribiríamos una propiedad que degrada). */
  | 'proposal_invalid'
  /** Ya hay una propiedad vigente DISTINTA: cambiarla es una decisión humana explícita. */
  | 'ownership_already_declared';

/**
 * Contadores HONESTOS de la migración. En `preview` cuentan lo que SE HARÍA; en `apply`, lo
 * hecho. `syncedNoVerificados` es el hallazgo central de la auditoría: productos que afirmaban
 * `synced` sin que nadie hubiera leído Meta nunca.
 */
export interface MetaCatalogOwnershipMigrationCounters {
  examinados: number;
  /** Productos cuyo `metaSyncState` se sembraría/sembró. */
  estadoSembrado: number;
  /** Productos que ya tenían un `metaSyncState` coherente: no se tocan. */
  estadoVigente: number;
  /** Subconjunto de `estadoSembrado`: los `synced` que pasan a `unverifiable`. */
  syncedNoVerificados: number;
  /** Productos sin identidad remota (ni retailer_id ni item id): quedan `not_synced`. */
  sinMapeo: number;
  errores: number;
}

/** Plan SANEADO de la migración: lo que el owner tiene que poder leer ANTES de confirmar. */
export interface MetaCatalogOwnershipMigrationPlan {
  tenantId: string;
  /** Modo configurado hoy y modo EFECTIVO que quedaría con la propuesta aplicada. */
  configMode: MetaCatalogSyncMode;
  effectiveModeAfter: MetaCatalogSyncMode;
  /** Propiedad vigente (degradada mientras nadie la haya declarado). */
  current: CatalogOwnershipView;
  /** Modelo propuesto + partición de campos. null si la migración está bloqueada. */
  proposedModel: CatalogOwnershipModel | null;
  proposedOwnedFields: WritableField[];
  proposedExternalFields: WritableField[];
  /** Fuentes detectadas (metadata saneada) y si el detector pudo correr. */
  detectionAvailable: boolean;
  detectedSources: MetaCatalogDetectedSource[];
  blockers: MetaCatalogOwnershipMigrationBlocker[];
}

/** Vista SANEADA de la corrida para el panel (el doc está cerrado al cliente por rules). */
export interface MetaCatalogOwnershipMigrationRunSummary {
  runId: string;
  mode: MetaCatalogOwnershipMigrationMode;
  status: MetaCatalogOwnershipMigrationStatus;
  pagesDone: number;
  counters: MetaCatalogOwnershipMigrationCounters;
  /** Cuántos productos quedarían/quedaron en cada estado (solo los que cambian). */
  porEstado: Record<string, number>;
  plan: MetaCatalogOwnershipMigrationPlan;
  /** true si el apply ya escribió `catalogSync.ownership` (idempotente: una sola vez). */
  ownershipWritten: boolean;
  hasCursor: boolean;
  startedAtMs: number | null;
  updatedAtMs: number | null;
  finishedAtMs: number | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Reconciliación PERIÓDICA del estado actual (ADR-0015 §6)
// ---------------------------------------------------------------------------

export type MetaCatalogVerificationStatus = 'running' | 'completed' | 'failed';
/**
 * Fases de la corrida. `remote`: barrido paginado del catálogo remoto (solo GET) que verifica
 * los productos mapeados que Meta devuelve. `missing`: barrido LOCAL de los mapeados que el
 * barrido remoto no tocó (artículos que el feed borró). `done`: terminada.
 */
export type MetaCatalogVerificationPhase = 'remote' | 'missing' | 'done';

/**
 * Contadores HONESTOS de una corrida de verificación. `verified` cuenta SOLO productos con
 * lectura remota real y todos sus campos observables coincidentes. `unchanged` es el
 * subconjunto cuyo estado ya era el mismo (la corrida diaria no re-alerta). `errors` cuenta
 * escrituras de estado que fallaron: una corrida con errores jamás se presenta limpia.
 */
export interface MetaCatalogVerificationCounters {
  remoteItems: number;
  matched: number;
  /** Artículos remotos sin producto local mapeado: se CUENTAN, no se tocan. */
  remoteOnly: number;
  verified: number;
  drifted: number;
  driftedExternal: number;
  remoteMissing: number;
  unverifiable: number;
  unchanged: number;
  cursorResets: number;
  errors: number;
}

/** Vista SANEADA de la corrida para el panel (el doc está cerrado al cliente por rules). */
export interface MetaCatalogVerificationRunSummary {
  runId: string;
  status: MetaCatalogVerificationStatus;
  phase: MetaCatalogVerificationPhase;
  pagesDone: number;
  counters: MetaCatalogVerificationCounters;
  /** true si la corrida quedó a mitad (hay cursor persistido para reanudar). */
  hasCursor: boolean;
  /**
   * true si la detección de artículos borrados se SALTEÓ por evidencia incompleta (errores de
   * escritura durante el barrido remoto): jamás se declara `remote_missing` a ciegas.
   */
  missingDetectionSkipped: boolean;
  startedAtMs: number | null;
  updatedAtMs: number | null;
  finishedAtMs: number | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Autoridad de catálogo autoservicio (ADR-0022) — contrato DERIVADO tipado
// ---------------------------------------------------------------------------

/**
 * QUIÉN administra el catálogo (eje derivado de `catalogSync.ownership`, ADR-0015):
 *  · 'vendeyapy' ⟺ `vendeyapy_managed` (o `hybrid`, avanzado);
 *  · 'meta'      ⟺ `external_managed` con `external.kind = 'commerce_manager'`;
 *  · 'external'  ⟺ `external_managed` con `kind = 'meta_feed' | 'other_api'`.
 */
export const CATALOG_AUTHORITIES = ['vendeyapy', 'meta', 'external'] as const;
export type CatalogAuthority = (typeof CATALOG_AUTHORITIES)[number];

/**
 * RELACIÓN declarada del tenant con Meta (`catalogSync.relationship`, eje NUEVO):
 *  · 'none'    — local puro: ninguna acción de catálogo contra Meta;
 *  · 'mirror'  — Meta/fuente externa alimenta el espejo local (import/reconcile/verify);
 *                CERO escrituras hacia Meta;
 *  · 'managed' — VendeYaPy publica (rails vigentes: preview→apply, outbox, dry_run/live).
 */
export const CATALOG_RELATIONSHIPS = ['none', 'mirror', 'managed'] as const;
export type CatalogRelationship = (typeof CATALOG_RELATIONSHIPS)[number];

/** Por qué la derivación degradó (o corrigió) lo declarado. Vocabulario CERRADO. */
export const CATALOG_AUTHORITY_REASONS = [
  /**
   * `enabled` no es `true`: `managed` es inalcanzable hoy. `mode` NO participa de la
   * derivación (es el interruptor de EJECUCIÓN, nivel 1): un tenant con `mode:'off'` y
   * `enabled:true` sigue siendo `managed` con el envío apagado. Como ADVERTENCIA del preview
   * de transición, `sync_disabled` sí cubre también `mode` fuera de dry_run/live.
   */
  'sync_disabled',
  /** No hay `catalogId` válido declarado: no existe catálogo remoto que mirar/escribir. */
  'catalog_id_missing',
  /** La propiedad no deja ningún campo escribible: no existe patch posible. */
  'no_writable_fields',
  /** Propiedad degradada por el fail-closed de nivel 2 (ADR-0015). */
  'ownership_degraded',
  /** `relationship` declarado fuera del vocabulario: se ignora (manda el derivado). */
  'relationship_invalid',
  /** `relationship` declarado incoherente con la propiedad: manda el derivado (fail-closed). */
  'relationship_conflict',
] as const;
export type CatalogAuthorityReason = (typeof CATALOG_AUTHORITY_REASONS)[number];

/**
 * Contrato derivado tipado (ADR-0022 §1). Sale de `deriveCatalogAuthority(raw)` — derivación
 * PURA y determinística sobre el campo `catalogSync` CRUDO: cero I/O, cero escrituras.
 */
export interface CatalogAuthorityDerived {
  authority: CatalogAuthority;
  relationship: CatalogRelationship;
  /** true ⟺ hay `relationship` declarado explícito Y coincide con el efectivo. */
  declared: boolean;
  /** Por qué se degradó, si se degradó (vacío en los estados sanos). */
  reasons: CatalogAuthorityReason[];
  /** INVARIANTE: el bot solo consume el catálogo local de Firestore. */
  botCatalog: 'local_mirror';
}

/** Frescura de la evidencia remota (ADR-0022 §5). Milisegundos epoch; ausente ⇒ nunca. */
export interface CatalogAuthorityStaleness {
  /** Última verificación REAL contra Meta (corrida de reconciliación completada). */
  metaVerifiedAt?: number | null;
  /** Última verificación de fuentes externas (ownership.lastSourceCheckAt). */
  lastSourceCheckAt?: number | null;
  /** Fin del último run de importación paginada. */
  lastImportFinishedAt?: number | null;
}

/** Bloque `authority` que suma `metaCatalogOwnershipStatus` (aditivo — el panel lo consume). */
export interface CatalogAuthorityStatus extends CatalogAuthorityDerived {
  staleness: CatalogAuthorityStaleness;
}

/** Combinación objetivo de una transición (§2: solo A/B/C/D son válidas). */
export interface CatalogAuthorityTarget {
  authority: CatalogAuthority;
  relationship: CatalogRelationship;
}

/** Ids CERRADOS de los bloqueos del preview de transición (ADR-0022 §3, fail-closed). */
export const CATALOG_AUTHORITY_BLOCKERS = [
  /** La combinación objetivo no es A/B/C/D (p. ej. external+managed). */
  'invalid_target',
  /** La propiedad vigente no permite el destino (trae `reasons` de detalle). */
  'ownership_incompatible',
  /** Una fuente externa RECONOCIDA gobierna los campos: no se puede reclamar autoridad propia. */
  'external_conflict',
  /** Outbox con jobs NO terminales (trae `count`): no se cambia de modo con envíos en vuelo. */
  'outbox_not_terminal',
  /** Importación paginada en curso (claim activo). */
  'import_run_in_flight',
  /** Preview de sync vigente sin consumir (evidencia `mcs_*` viva). */
  'sync_run_in_flight',
  /** No hay conexión Meta utilizable (`metaConnections/main` sin token). */
  'connection_missing',
  /** El destino exige un `catalogId` válido y no hay (deuda del selector — se siembra a mano). */
  'catalog_id_missing',
  /** Locks/mappings con invariantes rotas (cross-tenant o dos locks del mismo producto). */
  'mapping_ambiguous',
] as const;
export type CatalogAuthorityBlocker = (typeof CATALOG_AUTHORITY_BLOCKERS)[number];

/** Bloqueo con su detalle (SANEADO: ids y conteos, jamás tokens/URLs/PII). */
export interface CatalogAuthorityBlock {
  id: CatalogAuthorityBlocker;
  /** Solo `ownership_incompatible`: motivos de detalle (nivel 2 de ADR-0015 o incompatibilidad). */
  reasons?: string[];
  /** Solo `outbox_not_terminal`: cuántos jobs siguen vivos. */
  count?: number;
}

/** Advertencias del preview (no bloquean, pero el owner tiene que verlas). */
export const CATALOG_AUTHORITY_WARNINGS = [
  /** El destino ya es el estado vigente: el apply solo DECLARA la relación. */
  'already_in_target',
  /** El interruptor de sync está apagado: `managed` queda declarado pero inerte hasta encender. */
  'sync_disabled',
] as const;
export type CatalogAuthorityWarning = (typeof CATALOG_AUTHORITY_WARNINGS)[number];
