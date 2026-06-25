/**
 * Notificaciones INTERNAS del panel (TRIAL-NOTIFICATIONS-1).
 * Subcolección: `tenants/{t}/notifications/{id}`. Las genera Cloud Functions (Admin SDK); el cliente NO las
 * crea/borra (rules `write: if false`). NO contienen mensajes externos (WhatsApp/email), tokens ni PII
 * innecesaria — solo un aviso interno para owner/admin. Idempotentes: el id es determinístico (`dedupeKey`).
 */
import type { Timestamp } from './common.types.js';

export type TrialNotificationType = 'trial_ending_soon' | 'trial_ending_today' | 'trial_expired';

export interface Notification {
  id: string;
  tenantId: string;
  /** Categoría (por ahora solo `trial`; extensible a futuro). */
  category: 'trial';
  type: TrialNotificationType;
  title: string;
  body: string;
  /** Clave determinística de idempotencia (= id del doc). 1 por (tenant, tipo) por trial. */
  dedupeKey: string;
  read: boolean;
  readAt: Timestamp | null;
  createdAt: Timestamp;
}
