/**
 * Promociones de una empresa (P8). Descuentos, combos, 2x1, envío gratis, con
 * fecha de inicio/fin y estado. El agente de IA (a futuro) las puede ofrecer.
 * Subcolección: tenants/{t}/promotions/{promotionId}.
 */

import type { PromotionType, PromotionStatus } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface Promotion {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  type: PromotionType;
  /** % si PERCENTAGE, monto si FIXED_AMOUNT; 0 para BUNDLE/2x1/envío gratis. */
  discountValue: number;
  /** Objetivo comercial (texto libre: "rotar stock", "subir ticket"...). */
  objective: string;
  productIds: string[];
  categoryIds: string[];
  startDate: Timestamp | null;
  endDate: Timestamp | null;
  status: PromotionStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
