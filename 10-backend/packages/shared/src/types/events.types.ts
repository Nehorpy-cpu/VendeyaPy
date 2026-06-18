/**
 * Capa de eventos del negocio (D6) y eventos enviados a la Conversions API de Meta.
 * businessEvents: lo que pasa (vio producto, inició checkout, compró…), agnóstico de
 * canal. metaConversionEvents: el envío server-side a Meta (sin depender de cookies).
 * Ver ADR-0009. Subcolecciones: tenants/{t}/businessEvents · tenants/{t}/metaConversionEvents.
 */

import type { BusinessEventName, EventSource, ConversionSendStatus } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface BusinessEvent {
  id: string;
  tenantId: string;
  eventName: BusinessEventName;
  eventSource: EventSource;
  customerId: string | null;
  conversationId: string | null;
  orderId: string | null;
  productId: string | null;
  /** Monto del evento (ej: Purchase). */
  value: number | null;
  currency: string | null;
  /** Campaña atribuida (D5), para que Meta optimice. */
  campaignId: string | null;
  occurredAt: Timestamp;
  createdAt: Timestamp;
}

export interface MetaConversionEvent {
  id: string;
  tenantId: string;
  businessEventId: string;
  metaPixelId: string | null;
  eventName: string;
  sendStatus: ConversionSendStatus;
  metaResponse: string;
  errorMessage: string;
  sentAt: Timestamp | null;
  createdAt: Timestamp;
}
