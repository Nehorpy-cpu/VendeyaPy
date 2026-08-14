/**
 * Notificaciones INTERNAS del panel (TRIAL-NOTIFICATIONS-1).
 * Subcolección: `tenants/{t}/notifications/{id}`. Las genera Cloud Functions (Admin SDK); el cliente NO las
 * crea/borra (rules `write: if false`). NO contienen mensajes externos (WhatsApp/email), tokens ni PII
 * innecesaria — solo un aviso interno para owner/admin. Idempotentes: el id es determinístico (`dedupeKey`).
 */
import type { Timestamp } from './common.types.js';

export type TrialNotificationType = 'trial_ending_soon' | 'trial_ending_today' | 'trial_expired';

/**
 * HANDOFF-2 / AI-FALLBACK-HONESTO-1 / COVERAGE-1B: avisos de atención humana.
 * HARDEN-1 agrega `handoff_coverage_stale`: la reanudación de una decisión quedó cancelada por
 * cambio de activación y el chat necesita atención manual.
 * ADR-0015 §8 agrega `handoff_catalog_drift`: el dato público de un producto lo gobierna una
 * fuente externa que hoy publica otra cosa — se corrige EN EL ORIGEN, no escribiendo en Meta.
 */
export type HandoffNotificationType =
  | 'handoff_customer_requested'
  | 'handoff_ai_unavailable'
  | 'handoff_coverage_review'
  | 'handoff_coverage_stale'
  | 'handoff_catalog_drift';

/**
 * META-CATALOG-GENERIC-ONBOARDING-QUALITY-1: aviso AGREGADO del centro de calidad del
 * catálogo. UNA sola notificación viva por tenant (id determinístico), que el backend
 * actualiza (contador) y AUTOCIERRA cuando los pendientes llegan a 0 — jamás una por producto.
 */
export type CatalogQualityNotificationType = 'catalog_quality_summary';

/**
 * ADR-0015 §4: aviso AGREGADO de GOBIERNO del catálogo. Apareció una fuente externa que nadie
 * reconoció, o la reconocida cambió de forma, así que las escrituras hacia Meta quedaron
 * detenidas. UNA sola notificación viva por tenant (id determinístico), que se autocierra
 * cuando lo observado vuelve a coincidir con lo declarado. Solo lleva ids NO secretos del feed:
 * jamás su URL, su query string ni su token.
 */
export type CatalogSourceNotificationType = 'catalog_source_changed';

/**
 * ADR-0015 §6: la reconciliación NO puede correr y eso bloquea la venta. Config CONTRADICTORIA:
 * una persona declaró que un sistema externo gobierna los campos publicados (el guard del bot
 * queda activo) y no hay catálogo de Meta que leer, así que nada puede refrescar la evidencia y
 * los productos vinculados caducan sin salida. UNA sola notificación viva por tenant, que se
 * autocierra cuando se configura el catálogo o se retira la declaración externa. NO se degrada la
 * propiedad sola para destrabar: cambiar el modelo es decisión humana (§4).
 */
export type CatalogVerificationNotificationType = 'catalog_verification_blocked';

/**
 * ADR-0018: alertas AGREGADAS del cupo mensual de IA. Una por tenant × período × umbral
 * (id determinístico `ai-quota-{AAAAMM}-{umbral}` + create()): 70/85/95% al cruzar liquidando,
 * `agotada` al bloquear una reserva o llegar al 100%. Solo números (tokens/límite) — sin PII,
 * sin prompts, sin proveedor.
 */
export type AiQuotaNotificationType = 'ai_quota_70' | 'ai_quota_85' | 'ai_quota_95' | 'ai_quota_agotada';

export interface Notification {
  id: string;
  tenantId: string;
  /** Categoría (`trial` | `handoff` | `catalog_quality` | `catalog_source` | `catalog_verification` | `ai_quota`). */
  category: 'trial' | 'handoff' | 'catalog_quality' | 'catalog_source' | 'catalog_verification' | 'ai_quota';
  type:
    | TrialNotificationType
    | HandoffNotificationType
    | CatalogQualityNotificationType
    | CatalogSourceNotificationType
    | CatalogVerificationNotificationType
    | AiQuotaNotificationType;
  title: string;
  body: string;
  /** Clave determinística de idempotencia (= id del doc). 1 por (tenant, tipo) por trial. */
  dedupeKey: string;
  read: boolean;
  readAt: Timestamp | null;
  createdAt: Timestamp;
  /** HANDOFF-2: cliente al que refiere el aviso (para abrir /conversations). Solo category 'handoff'. */
  customerId?: string;
  /** COVERAGE-1C: uid del SELLER destinatario (server-controlled). Las rules le permiten leer
   * SOLO los avisos handoff dirigidos a su uid; owner/manager no lo necesitan. */
  targetUid?: string | null;
  // --- Solo category 'catalog_quality' (server-set) ---
  /** Productos con bloqueos activos al momento del último recompute. */
  blockingCount?: number;
  /** Productos con advertencias activas al momento del último recompute. */
  warningCount?: number;
  /** AUTOCIERRE: estampado por el backend cuando blocking+warning llegan a 0. */
  resolvedAt?: Timestamp | null;
  // --- Solo category 'catalog_source' (server-set, ADR-0015 §4) ---
  /** Ids NO SECRETOS de los data sources afectados (jamás URL, query string ni token). */
  sourceIds?: string[];
  /** Doc de `metaCatalogSourceChecks` con la evidencia saneada del hallazgo. */
  sourceCheckId?: string;
}
