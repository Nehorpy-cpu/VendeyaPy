/**
 * stats/computeStats.ts — Recálculo de agregados para dashboards baratos (P7)
 * ===========================================================================
 * Lee pedidos + orderFinancials + productos y escribe documentos YA LISTOS:
 *   tenants/{t}/stats/public   (sin dinero sensible → lo ve el vendedor)
 *   tenants/{t}/stats/private  (ganancia/margen → solo Owner/Manager)
 *   tenants/{t}/statsDaily/{yyyymmdd}  (snapshot diario, privado)
 * Así la UI solo LEE 1-2 docs en vez de recorrer todos los pedidos (ADR-0006).
 */

import { Timestamp } from 'firebase-admin/firestore';
import type {
  Order,
  OrderFinancials,
  Product,
  TenantStatsPublic,
  TenantStatsPrivate,
  TenantStatsDaily,
  PlatformStats,
} from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { PAID_ORDER_STATUSES } from '../orders/lifecycle.js';

const PAID = PAID_ORDER_STATUSES; // fuente única (ORDER-1): orders/lifecycle.ts
const PENDING = ['PENDING_PAYMENT', 'PENDING_VERIFICATION'];

function dayKey(ts: unknown): string {
  const d = (ts as { toDate?: () => Date } | null)?.toDate?.() ?? new Date(0);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** Recalcula y persiste los agregados de un tenant. */
export async function recomputeTenantStats(tenantId: string): Promise<void> {
  const [ordersSnap, finsSnap, prodsSnap] = await Promise.all([
    db().collection(paths.orders(tenantId)).get(),
    db().collection(paths.orderFinancials(tenantId)).get(),
    db().collection(paths.products(tenantId)).get(),
  ]);

  const fins = new Map<string, OrderFinancials>();
  finsSnap.docs.forEach((d) => fins.set(d.id, d.data() as OrderFinancials));
  const orders = ordersSnap.docs.map((d) => d.data() as Order);
  const products = prodsSnap.docs.map((d) => d.data() as Product);
  const finOf = (o: Order) => fins.get(o.id);

  const vendidos = orders.filter((o) => PAID.includes(o.status));
  const ingresos = vendidos.reduce((s, o) => s + o.totals.total, 0);
  const pendingOrders = orders.filter((o) => PENDING.includes(o.status)).length;

  const conCosto = vendidos.filter((o) => finOf(o)?.grossProfit != null);
  const costoIncompleto = vendidos.some((o) => !finOf(o) || finOf(o)!.grossProfit == null);
  const ganancia = conCosto.length ? conCosto.reduce((s, o) => s + (finOf(o)!.grossProfit ?? 0), 0) : null;
  const costos = conCosto.length ? conCosto.reduce((s, o) => s + (finOf(o)!.totalCost ?? 0), 0) : null;
  const margen = ganancia != null && ingresos > 0 ? (ganancia / ingresos) * 100 : null;

  // Agregado por producto (unidades + ganancia)
  const byProduct = new Map<string, { productId: string; name: string; units: number; profit: number | null }>();
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
  const topVendidos = [...aggs].sort((a, b) => b.units - a.units).slice(0, 5).map((a) => ({ productId: a.productId, name: a.name, units: a.units }));
  const topRentables = [...aggs].sort((a, b) => (b.profit ?? -1) - (a.profit ?? -1)).slice(0, 5).map((a) => ({ productId: a.productId, name: a.name, profit: a.profit }));

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

  // Snapshots diarios (agrupar pedidos vendidos por día)
  const daily = new Map<string, { orders: number; revenue: number; cost: number | null; profit: number | null }>();
  for (const o of vendidos) {
    const key = dayKey(o.createdAt);
    const e = daily.get(key) ?? { orders: 0, revenue: 0, cost: 0, profit: 0 };
    e.orders += 1;
    e.revenue += o.totals.total;
    const fin = finOf(o);
    e.cost = e.cost == null || fin?.totalCost == null ? null : e.cost + fin.totalCost;
    e.profit = e.profit == null || fin?.grossProfit == null ? null : e.profit + fin.grossProfit;
    daily.set(key, e);
  }

  const now = Timestamp.now();
  const pub: TenantStatsPublic = {
    tenantId,
    ventas: vendidos.length,
    ingresos,
    ticketPromedio: vendidos.length ? ingresos / vendidos.length : 0,
    pendingOrders,
    topVendidos,
    bajoStock,
    updatedAt: now,
  };
  const priv: TenantStatsPrivate = {
    tenantId,
    costos,
    ganancia,
    margen,
    costoIncompleto,
    topRentables,
    ventasPorVendedor: [...bySeller.values()].sort((a, b) => b.ingresos - a.ingresos),
    updatedAt: now,
  };

  const batch = db().batch();
  batch.set(db().doc(paths.statsPublic(tenantId)), pub);
  batch.set(db().doc(paths.statsPrivate(tenantId)), priv);
  for (const [date, e] of daily) {
    const dd: TenantStatsDaily = {
      date,
      tenantId,
      orders: e.orders,
      revenue: e.revenue,
      productCost: e.cost,
      grossProfit: e.profit,
      margin: e.profit != null && e.revenue > 0 ? (e.profit / e.revenue) * 100 : null,
      updatedAt: now,
    };
    batch.set(db().doc(paths.statsDailyDoc(tenantId, date)), dd);
  }
  await batch.commit();
  logger.info('Stats recalculadas', { tenantId, ventas: vendidos.length });
}

/** Recalcula las métricas globales del Super Admin (suma de tenants). */
export async function recomputePlatformStats(): Promise<void> {
  const tenantsSnap = await db().collection(paths.tenants()).get();
  let ventas = 0;
  let ingresos = 0;
  let ganancia = 0;
  let gananciaKnown = false;
  for (const t of tenantsSnap.docs) {
    const pub = (await db().doc(paths.statsPublic(t.id)).get()).data() as TenantStatsPublic | undefined;
    const priv = (await db().doc(paths.statsPrivate(t.id)).get()).data() as TenantStatsPrivate | undefined;
    if (pub) {
      ventas += pub.ventas;
      ingresos += pub.ingresos;
    }
    if (priv?.ganancia != null) {
      ganancia += priv.ganancia;
      gananciaKnown = true;
    }
  }
  const stats: PlatformStats = {
    tenants: tenantsSnap.size,
    ventas,
    ingresos,
    ganancia: gananciaKnown ? ganancia : null,
    updatedAt: Timestamp.now(),
  };
  await db().doc(paths.platformStats()).set(stats);
  logger.info('PlatformStats recalculadas', { tenants: tenantsSnap.size });
}
