/**
 * Clientes (usuarios finales que compran por WhatsApp).
 * Ver ARCHITECTURE.md §4.4.
 */

import type { Address, Timestamp } from './common.types.js';
import type { CustomerConversationMeta } from './message.types.js';

export interface CustomerStats {
  totalOrders: number;
  totalSpent: number;
  lastOrderAt: Timestamp | null;
  firstOrderAt: Timestamp | null;
}

export interface Customer {
  id: string;
  tenantId: string;
  whatsappPhone: string;
  name: string;
  address: Address | null;
  stats: CustomerStats;
  tags: string[];
  notes: string;
  /** Resumen de la última conversación (denormalizado por el motor del bot). */
  conversation?: CustomerConversationMeta;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
