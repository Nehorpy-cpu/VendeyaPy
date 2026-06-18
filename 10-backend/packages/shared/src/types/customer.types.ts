/**
 * Clientes (usuarios finales que compran por WhatsApp).
 * Ver ARCHITECTURE.md §4.4.
 */

import type { CustomerType } from '../enums.js';
import type { Address, Timestamp } from './common.types.js';
import type { CustomerConversationMeta } from './message.types.js';
import type { Attribution } from './attribution.types.js';

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
  /** Vendedor (uid de Auth) que tomó/atiende la conversación. null = sin asignar. */
  assignedSellerId?: string | null;
  /** Nombre legible del vendedor asignado (para mostrar sin un join). */
  assignedSellerName?: string | null;
  /** Segmento + puntaje calculados por reglas (P12). */
  customerType?: CustomerType | null;
  customerScore?: number | null;
  /** De qué anuncio/campaña vino (atribución, D5). */
  attribution?: Attribution;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
