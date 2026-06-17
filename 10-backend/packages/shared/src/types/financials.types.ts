/**
 * Datos financieros PRIVADOS (costo / ganancia), separados de los documentos
 * visibles para que el rol vendedor no pueda leerlos ni desde la base.
 * Ver ADR-0008. Reglas: solo Owner/Manager/PlatformAdmin pueden leerlos.
 *
 * Subcolecciones (mismo id que el documento padre, relación 1:1):
 *   tenants/{t}/productFinancials/{productId}
 *   tenants/{t}/orderFinancials/{orderId}
 */

import type { Timestamp } from './common.types.js';

/** Costo de un producto (y, a futuro, márgenes/descuentos — Track C P15). */
export interface ProductFinancials {
  productId: string;
  tenantId: string;
  /** Precio de COSTO. null si no se cargó → la ganancia queda incompleta. */
  costPrice: number | null;
  updatedAt: Timestamp;
}

/** Costo "congelado" de un ítem al momento de la venta (snapshot histórico). */
export interface OrderFinancialsItem {
  productId: string;
  quantity: number;
  unitCostSnapshot: number | null;
  totalCostSnapshot: number | null;
}

/** Costo y ganancia de un pedido. Lo escribe solo Cloud Functions (Admin SDK). */
export interface OrderFinancials {
  orderId: string;
  tenantId: string;
  subtotal: number;
  /** null si algún ítem no tenía costo cargado (ganancia incompleta). */
  totalCost: number | null;
  grossProfit: number | null;
  grossMarginPercentage: number | null;
  items: OrderFinancialsItem[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
