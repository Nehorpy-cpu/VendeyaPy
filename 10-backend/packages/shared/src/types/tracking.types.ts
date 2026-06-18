/**
 * Tracking propio sin Meta (P11): "campañas" propias identificadas por un código
 * (cupón, QR, link). Cuando el cliente menciona el código, la venta se atribuye a
 * esta fuente — complementa la atribución de Meta (D5). Subcolección:
 * tenants/{t}/trackingSources/{id}.
 */

import type { TrackingType } from '../enums.js';
import type { Timestamp } from './common.types.js';
import type { CampaignAttribution } from './attribution.types.js';

export interface TrackingSource {
  id: string;
  tenantId: string;
  name: string;
  /** Código que el cliente menciona (ej: VERANO20). */
  code: string;
  type: TrackingType;
  active: boolean;
  /** Rollup de ventas atribuidas a este código (lo calcula computeTrackingAttribution). */
  attribution?: CampaignAttribution;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
