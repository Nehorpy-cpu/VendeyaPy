/**
 * Métricas PRECALCULADAS (agregados) para dashboards baratos (P7).
 * Un job/trigger las recalcula y las escribe; la UI solo LEE estos documentos
 * (lecturas baratas) en vez de recorrer todos los pedidos. Ver ADR-0006.
 *
 * Se separan en PÚBLICAS (sin dinero sensible, las ve el vendedor) y PRIVADAS
 * (ganancia/margen, solo Owner/Manager), igual que en P6 (ADR-0008):
 *   tenants/{t}/stats/public      tenants/{t}/stats/private
 *   tenants/{t}/statsDaily/{yyyymmdd}      (privado: incluye ganancia)
 *   platformStats/current                  (solo Super Admin)
 */

import type { Timestamp } from './common.types.js';

export interface ProductUnitsAgg {
  productId: string;
  name: string;
  units: number;
}

export interface ProductProfitAgg {
  productId: string;
  name: string;
  profit: number | null;
}

export interface SellerAgg {
  sellerId: string;
  ventas: number;
  ingresos: number;
}

export interface LowStockItem {
  id: string;
  name: string;
  stock: number;
}

/** Resumen NO sensible (lo puede ver el vendedor). */
export interface TenantStatsPublic {
  tenantId: string;
  ventas: number;
  ingresos: number;
  ticketPromedio: number;
  pendingOrders: number;
  topVendidos: ProductUnitsAgg[];
  bajoStock: LowStockItem[];
  updatedAt: Timestamp;
}

/** Resumen SENSIBLE (solo Owner/Manager). */
export interface TenantStatsPrivate {
  tenantId: string;
  costos: number | null;
  ganancia: number | null;
  margen: number | null;
  costoIncompleto: boolean;
  topRentables: ProductProfitAgg[];
  ventasPorVendedor: SellerAgg[];
  updatedAt: Timestamp;
}

/** Snapshot diario (incluye ganancia → privado). id del doc = yyyymmdd. */
export interface TenantStatsDaily {
  date: string;
  tenantId: string;
  orders: number;
  revenue: number;
  productCost: number | null;
  grossProfit: number | null;
  margin: number | null;
  updatedAt: Timestamp;
}

/** Métricas globales de la plataforma (solo Super Admin). */
export interface PlatformStats {
  tenants: number;
  ventas: number;
  ingresos: number;
  ganancia: number | null;
  updatedAt: Timestamp;
}
