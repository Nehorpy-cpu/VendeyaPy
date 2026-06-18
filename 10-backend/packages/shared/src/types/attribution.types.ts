/**
 * Atribución (D5): de qué anuncio/campaña vino un cliente/pedido, para medir la
 * GANANCIA REAL que deja cada campaña (no solo las métricas de Meta). Ver ADR-0009.
 */

import type { AttributionType } from '../enums.js';
import type { Timestamp } from './common.types.js';

/** Atribución de un cliente o pedido a una campaña de Meta. */
export interface Attribution {
  campaignId: string | null;
  adId: string | null;
  type: AttributionType;
  confidence: number; // 0-1
  platform: string | null; // whatsapp | instagram | messenger
}

/** Rollup de atribución por campaña (lo calcula computeAttribution). */
export interface CampaignAttribution {
  orders: number;
  revenue: number;
  grossProfit: number | null;
  /** Ingresos / gasto. */
  roas: number | null;
  margin: number | null;
  updatedAt: Timestamp;
}
