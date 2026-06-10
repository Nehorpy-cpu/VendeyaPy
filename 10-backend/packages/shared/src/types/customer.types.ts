/**
 * Clientes (usuarios finales que compran por WhatsApp).
 * Ver ARCHITECTURE.md §4.4.
 */

import type { Address, Timestamp } from './common.types.js';

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
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
