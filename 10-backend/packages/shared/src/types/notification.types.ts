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
 */
export type HandoffNotificationType = 'handoff_customer_requested' | 'handoff_ai_unavailable' | 'handoff_coverage_review' | 'handoff_coverage_stale';

/**
 * META-CATALOG-GENERIC-ONBOARDING-QUALITY-1: aviso AGREGADO del centro de calidad del
 * catálogo. UNA sola notificación viva por tenant (id determinístico), que el backend
 * actualiza (contador) y AUTOCIERRA cuando los pendientes llegan a 0 — jamás una por producto.
 */
export type CatalogQualityNotificationType = 'catalog_quality_summary';

export interface Notification {
  id: string;
  tenantId: string;
  /** Categoría (`trial` | `handoff` | `catalog_quality`; extensible a futuro). */
  category: 'trial' | 'handoff' | 'catalog_quality';
  type: TrialNotificationType | HandoffNotificationType | CatalogQualityNotificationType;
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
}
