/**
 * Insights = recomendaciones del sistema ("qué hacer para vender/ganar más").
 * Generadas por REGLAS + jobs (IA solo redacta, a futuro). Ver ADR-0006.
 * Subcolección: tenants/{t}/insights/{insightId}.
 *
 * P8 genera las de tipo PROMO_SUGGESTION; el Centro de Decisiones (P13) y los
 * follow-ups (P14) reutilizan esta misma estructura.
 */

import type { InsightType, InsightStatus, InsightPriority } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface Insight {
  id: string;
  tenantId: string;
  type: InsightType;
  title: string;
  description: string;
  priority: InsightPriority;
  status: InsightStatus;
  /** A qué se refiere: 'product' | 'customer' | 'campaign' | 'conversation' | null. */
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  /** Impacto estimado, en texto (ej: "rotar ~12 unidades / liberar capital"). */
  estimatedImpact: string;
  /** Acción recomendada concreta. */
  recommendedAction: string;
  generatedBy: 'rules' | 'ai' | 'manual';
  createdAt: Timestamp;
  resolvedAt: Timestamp | null;
}
