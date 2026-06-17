/**
 * Capa de acceso a pedidos + cálculo de métricas del dashboard.
 * Métricas calculadas en el cliente sobre los pedidos leídos (volumen moderado).
 * A futuro (Track C) se precalculan con jobs para escalar barato.
 */

import { collection, getDocs, query, orderBy, limit as fbLimit } from 'firebase/firestore';
import type { Order, OrderStatus, Product, OrderFinancials } from '@vpw/shared';
import { firebaseDb } from './firebase';

const ordersCol = (tenantId: string) => collection(firebaseDb(), 'tenants', tenantId, 'orders');
const orderFinancialsCol = (tenantId: string) =>
  collection(firebaseDb(), 'tenants', tenantId, 'orderFinancials');

/** Estados que cuentan como venta concretada (pago confirmado en adelante). */
const PAID_STATUSES: OrderStatus[] = ['PAID', 'PREPARING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED'];
export const isPaidStatus = (s: OrderStatus) => PAID_STATUSES.includes(s);

export async function listOrders(tenantId: string, max = 200): Promise<Order[]> {
  const snap = await getDocs(query(ordersCol(tenantId), orderBy('createdAt', 'desc'), fbLimit(max)));
  return snap.docs.map((d) => d.data() as Order);
}

/**
 * Finanzas privadas de pedidos (costo/ganancia), mapeadas por orderId.
 * Solo Owner/Manager pueden leerlas (reglas). El vendedor NO debe llamar esto.
 */
export async function listOrderFinancials(
  tenantId: string,
  max = 500,
): Promise<Record<string, OrderFinancials>> {
  const snap = await getDocs(query(orderFinancialsCol(tenantId), fbLimit(max)));
  const map: Record<string, OrderFinancials> = {};
  snap.docs.forEach((d) => {
    map[d.id] = d.data() as OrderFinancials;
  });
  return map;
}

export interface ProductAgg {
  productId: string;
  name: string;
  units: number;
  profit: number | null;
}

export interface DashboardMetrics {
  ventas: number;
  ingresos: number;
  costos: number | null;
  ganancia: number | null;
  margen: number | null;
  ticketPromedio: number;
  costoIncompleto: boolean; // algún pedido vendido sin costo cargado
  topVendidos: ProductAgg[];
  topRentables: ProductAgg[];
  bajoStock: { id: string; name: string; stock: number }[];
  ventasPorVendedor: { sellerId: string; ventas: number; ingresos: number }[];
}

export function computeMetrics(
  orders: Order[],
  products: Product[],
  financials: Record<string, OrderFinancials> = {},
): DashboardMetrics {
  const vendidos = orders.filter((o) => isPaidStatus(o.status));
  const ingresos = vendidos.reduce((s, o) => s + o.totals.total, 0);

  const finOf = (o: Order) => financials[o.id];
  const conCosto = vendidos.filter((o) => finOf(o)?.grossProfit != null);
  const costoIncompleto = vendidos.some((o) => !finOf(o) || finOf(o)!.grossProfit == null);
  const ganancia = conCosto.length ? conCosto.reduce((s, o) => s + (finOf(o)!.grossProfit ?? 0), 0) : null;
  const costos = conCosto.length ? conCosto.reduce((s, o) => s + (finOf(o)!.totalCost ?? 0), 0) : null;
  const margen = ganancia != null && ingresos > 0 ? (ganancia / ingresos) * 100 : null;

  // Agregar por producto: unidades (de la orden) + ganancia (cruzando con orderFinancials)
  const byProduct = new Map<string, ProductAgg>();
  for (const o of vendidos) {
    const fin = finOf(o);
    for (const it of o.items) {
      const agg = byProduct.get(it.productId) ?? { productId: it.productId, name: it.productName, units: 0, profit: 0 };
      agg.units += it.quantity;
      const lineCost = fin?.items.find((fi) => fi.productId === it.productId)?.totalCostSnapshot ?? null;
      agg.profit = agg.profit == null || lineCost == null ? null : agg.profit + (it.subtotal - lineCost);
      byProduct.set(it.productId, agg);
    }
  }
  const aggs = [...byProduct.values()];
  const topVendidos = [...aggs].sort((a, b) => b.units - a.units).slice(0, 5);
  const topRentables = [...aggs].sort((a, b) => (b.profit ?? -1) - (a.profit ?? -1)).slice(0, 5);

  const bajoStock = products
    .filter((p) => (p.inventory?.stock ?? 0) <= (p.inventory?.lowStockThreshold ?? 3))
    .map((p) => ({ id: p.id, name: p.name, stock: p.inventory?.stock ?? 0 }))
    .slice(0, 10);

  const bySeller = new Map<string, { sellerId: string; ventas: number; ingresos: number }>();
  for (const o of vendidos) {
    const key = o.sellerId ?? '(sin asignar)';
    const e = bySeller.get(key) ?? { sellerId: key, ventas: 0, ingresos: 0 };
    e.ventas += 1;
    e.ingresos += o.totals.total;
    bySeller.set(key, e);
  }

  return {
    ventas: vendidos.length,
    ingresos,
    costos,
    ganancia,
    margen,
    ticketPromedio: vendidos.length ? ingresos / vendidos.length : 0,
    costoIncompleto,
    topVendidos,
    topRentables,
    bajoStock,
    ventasPorVendedor: [...bySeller.values()].sort((a, b) => b.ingresos - a.ingresos),
  };
}
