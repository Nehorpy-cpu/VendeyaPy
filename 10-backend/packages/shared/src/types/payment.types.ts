/**
 * Transacciones de pago.
 * Ver ARCHITECTURE.md §4 (esquema implícito en §4.6 y §6).
 */

import type { PaymentMethod, PaymentStatus, Currency } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface PaymentGatewayData {
  /** ID de la transacción en la pasarela (Bancard, Stripe, etc.) */
  externalId: string;
  /** Link de pago si aplica (Bancard process_id, Stripe checkout URL) */
  paymentUrl: string | null;
  /** Payload raw de respuesta de la pasarela (para debugging) */
  rawResponse: Record<string, unknown>;
}

export interface Payment {
  id: string;
  tenantId: string;
  orderId: string;
  customerId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amount: number;
  currency: Currency;
  gateway: PaymentGatewayData;
  attemptCount: number;
  failureReason: string | null;
  approvedAt: Timestamp | null;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
