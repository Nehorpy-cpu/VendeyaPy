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
  /**
   * ADR-0021: nombre de perfil de WhatsApp reportado por el webhook (`contacts[].profile.name`).
   * Es dato del proveedor, NO dato CRM confirmado (`name`). Prioridad de display:
   * name || profileName || teléfono.
   */
  profileName?: string | null;
  /**
   * ADR-0021: vínculo a la ficha canónica de cliente (otro doc de `customers` del MISMO tenant,
   * p. ej. `crm_<autoid>` o el doc de otro número de la misma persona). Sin cadenas: la ficha
   * destino no puede estar a su vez vinculada.
   */
  linkedClientId?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
