'use client';

import { useQuery } from '@tanstack/react-query';
import type { TenantStatsPublic, TenantStatsPrivate } from '@vpw/shared';
import { useAuth } from '@/lib/auth-context';
import { ROLE_LABELS } from '@/lib/roles';
import { useActiveCompany } from '@/lib/active-company';
import { listOrders, listOrderFinancials, computeMetrics, type DashboardMetrics } from '@/lib/orders';
import { listProducts } from '@/lib/catalog';
import { getStatsPublic, getStatsPrivate } from '@/lib/stats';

const gs = (n: number | null | undefined) => (n == null ? '—' : '₲ ' + Math.round(n).toLocaleString('es-PY'));

export default function DashboardPage() {
  const { user, claims } = useAuth();
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const isSeller = claims.role === 'SELLER';

  // Camino barato (P7): leer agregados ya calculados (1-2 docs), no todos los pedidos.
  const statsPubQ = useQuery({ queryKey: ['statsPublic', tenantId], queryFn: () => getStatsPublic(tenantId!), enabled: !!tenantId });
  const statsPrivQ = useQuery({ queryKey: ['statsPrivate', tenantId], queryFn: () => getStatsPrivate(tenantId!), enabled: !!tenantId && !isSeller });

  // Fallback (cálculo en el cliente) SOLO si todavía no existen los agregados.
  const aggMissing = statsPubQ.isSuccess && !statsPubQ.data;
  const ordersQ = useQuery({ queryKey: ['orders', tenantId], queryFn: () => listOrders(tenantId!), enabled: !!tenantId && aggMissing });
  const productsQ = useQuery({ queryKey: ['products', tenantId], queryFn: () => listProducts(tenantId!), enabled: !!tenantId && aggMissing });
  const financialsQ = useQuery({ queryKey: ['orderFinancials', tenantId], queryFn: () => listOrderFinancials(tenantId!), enabled: !!tenantId && aggMissing && !isSeller });

  const fromAgg = statsPubQ.data ? metricsFromStats(statsPubQ.data, statsPrivQ.data ?? null) : null;
  const fallbackReady = aggMissing && ordersQ.isSuccess && productsQ.isSuccess;
  const m: DashboardMetrics | null = fromAgg ?? (fallbackReady ? computeMetrics(ordersQ.data, productsQ.data, financialsQ.data ?? {}) : null);
  const updatedAt = statsPubQ.data?.updatedAt;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500">
          {user?.email} · {claims.role ? ROLE_LABELS[claims.role] : '—'}
          {claims.tenantId ? ` · ${claims.tenantId}` : tenantId ? ` · ${tenantId}` : ' · Plataforma'}
        </p>
        {updatedAt && <p className="mt-0.5 text-xs text-gray-400">📊 Métricas precalculadas · actualizado {fmtWhen(updatedAt)}</p>}
      </div>

      {(companyLoading || (!!tenantId && !m)) && <div className="text-gray-400">Cargando métricas…</div>}
      {!tenantId && !companyLoading && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          Seleccioná una empresa para ver sus métricas.
        </div>
      )}

      {m && (
        <>
          {/* Tarjetas */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Card label="Ventas" value={String(m.ventas)} />
            <Card label="Ingresos" value={gs(m.ingresos)} />
            {!isSeller && <Card label="Ganancia" value={gs(m.ganancia)} warn={m.costoIncompleto} />}
            {!isSeller && <Card label="Margen" value={m.margen == null ? '—' : Math.round(m.margen) + '%'} />}
            <Card label="Ticket promedio" value={gs(m.ticketPromedio)} />
            {!isSeller && <Card label="Costos" value={gs(m.costos)} />}
          </div>

          {m.costoIncompleto && !isSeller && (
            <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              ⚠️ Hay productos vendidos sin precio de costo cargado: la ganancia mostrada puede estar incompleta.
            </div>
          )}

          {m.ventas === 0 && (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
              Todavía no hay ventas registradas. Cuando el bot cierre pedidos, las métricas aparecen acá.
            </div>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Panel title="Productos más vendidos">
              {m.topVendidos.length === 0 ? (
                <Empty />
              ) : (
                m.topVendidos.map((p) => (
                  <Row key={p.productId} left={p.name} right={`${p.units} u.`} />
                ))
              )}
            </Panel>

            {!isSeller && (
              <Panel title="Productos más rentables">
                {m.topRentables.length === 0 ? <Empty /> : m.topRentables.map((p) => (
                  <Row key={p.productId} left={p.name} right={gs(p.profit)} />
                ))}
              </Panel>
            )}

            <Panel title="Bajo stock">
              {m.bajoStock.length === 0 ? <Empty text="Sin alertas de stock" /> : m.bajoStock.map((p) => (
                <Row key={p.id} left={p.name} right={<span className="text-red-600">{p.stock} u.</span>} />
              ))}
            </Panel>

            {!isSeller && (
              <Panel title="Ventas por vendedor">
                {m.ventasPorVendedor.length === 0 ? <Empty /> : m.ventasPorVendedor.map((s) => (
                  <Row key={s.sellerId} left={s.sellerId} right={`${s.ventas} · ${gs(s.ingresos)}`} />
                ))}
              </Panel>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Card({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="mt-1 text-2xl font-bold text-gray-900">
        {value} {warn && <span title="Ganancia incompleta">⚠️</span>}
      </div>
    </div>
  );
}
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
function Row({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-gray-50 pb-2 text-sm last:border-0">
      <span className="text-gray-700">{left}</span>
      <span className="font-medium text-gray-900">{right}</span>
    </div>
  );
}
function Empty({ text = 'Sin datos todavía' }: { text?: string }) {
  return <div className="text-sm text-gray-400">{text}</div>;
}

/** Mapea los agregados precalculados al formato que ya usa el dashboard. */
function metricsFromStats(pub: TenantStatsPublic, priv: TenantStatsPrivate | null): DashboardMetrics {
  return {
    ventas: pub.ventas,
    ingresos: pub.ingresos,
    ticketPromedio: pub.ticketPromedio,
    costos: priv?.costos ?? null,
    ganancia: priv?.ganancia ?? null,
    margen: priv?.margen ?? null,
    costoIncompleto: priv?.costoIncompleto ?? false,
    topVendidos: pub.topVendidos.map((p) => ({ productId: p.productId, name: p.name, units: p.units, profit: 0 })),
    topRentables: (priv?.topRentables ?? []).map((p) => ({ productId: p.productId, name: p.name, units: 0, profit: p.profit })),
    bajoStock: pub.bajoStock,
    ventasPorVendedor: priv?.ventasPorVendedor ?? [],
  };
}

function fmtWhen(ts: unknown): string {
  try {
    const d = (ts as { toDate?: () => Date } | null)?.toDate?.();
    return d ? d.toLocaleString('es-PY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  } catch {
    return '';
  }
}
