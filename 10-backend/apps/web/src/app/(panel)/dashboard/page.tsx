'use client';

import { useQuery } from '@tanstack/react-query';
import type { TenantStatsPublic, TenantStatsPrivate } from '@vpw/shared';
import { useAuth } from '@/lib/auth-context';
import { ROLE_LABELS } from '@/lib/roles';
import { useActiveCompany } from '@/lib/active-company';
import { listOrders, listOrderFinancials, computeMetrics, type DashboardMetrics } from '@/lib/orders';
import { listProducts } from '@/lib/catalog';
import { getStatsPublic, getStatsPrivate } from '@/lib/stats';
import { MetricCard } from '@/components/marketing/MetricCard';
import {
  BagIcon,
  ChartIcon,
  TrendingIcon,
  TargetIcon,
  CardIcon,
  UsersIcon,
  ClockIcon,
} from '@/components/marketing/icons';

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
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Dashboard</h1>
          <p className="mt-1 text-sm text-ink-500">
            {user?.email} · {claims.role ? ROLE_LABELS[claims.role] : '—'}
            {claims.tenantId ? ` · ${claims.tenantId}` : tenantId ? ` · ${tenantId}` : ' · Plataforma'}
          </p>
        </div>
        {updatedAt && (
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-mint-50 px-3 py-1 text-xs font-medium text-mint-700 ring-1 ring-inset ring-mint-100">
            <ClockIcon className="h-3.5 w-3.5" />
            Métricas precalculadas · {fmtWhen(updatedAt)}
          </span>
        )}
      </div>

      {(companyLoading || (!!tenantId && !m)) && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[104px] animate-pulse rounded-2xl border border-ink-100 bg-ink-50/60" />
          ))}
        </div>
      )}

      {!tenantId && !companyLoading && (
        <EmptyState
          icon={<ChartIcon className="h-6 w-6" />}
          title="Seleccioná una empresa"
          text="Elegí una empresa en la barra superior para ver sus métricas de ventas y ganancia."
        />
      )}

      {m && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <MetricCard label="Ventas" value={String(m.ventas)} icon={<BagIcon className="h-4 w-4" />} accent="ink" />
            <MetricCard label="Ingresos" value={gs(m.ingresos)} icon={<ChartIcon className="h-4 w-4" />} accent="mint" />
            {!isSeller && (
              <MetricCard
                label="Ganancia"
                value={gs(m.ganancia)}
                icon={<TrendingIcon className="h-4 w-4" />}
                accent={m.costoIncompleto ? 'amber' : 'mint'}
                sublabel={m.costoIncompleto ? 'incompleta' : undefined}
              />
            )}
            {!isSeller && (
              <MetricCard label="Margen" value={m.margen == null ? '—' : Math.round(m.margen) + '%'} icon={<TargetIcon className="h-4 w-4" />} accent="ink" />
            )}
            <MetricCard label="Ticket promedio" value={gs(m.ticketPromedio)} icon={<CardIcon className="h-4 w-4" />} accent="ink" />
            {!isSeller && <MetricCard label="Costos" value={gs(m.costos)} icon={<CardIcon className="h-4 w-4" />} accent="coral" />}
          </div>

          {m.costoIncompleto && !isSeller && (
            <div className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <span aria-hidden>⚠️</span>
              <span>Hay productos vendidos sin precio de costo cargado: la ganancia mostrada puede estar incompleta.</span>
            </div>
          )}

          {m.ventas === 0 && (
            <EmptyState
              icon={<BagIcon className="h-6 w-6" />}
              title="Todavía no hay ventas"
              text="Cuando el bot cierre pedidos, las métricas y los rankings aparecen acá automáticamente."
            />
          )}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Panel title="Productos más vendidos" icon={<BagIcon className="h-4 w-4" />}>
              <BarList
                rows={m.topVendidos.map((p) => ({ id: p.productId, label: p.name, value: p.units, display: `${p.units} u.` }))}
                emptyText="Sin ventas todavía"
              />
            </Panel>

            {!isSeller && (
              <Panel title="Productos más rentables" icon={<TrendingIcon className="h-4 w-4" />} accent="mint">
                <BarList
                  rows={m.topRentables.map((p) => ({ id: p.productId, label: p.name, value: p.profit, display: gs(p.profit) }))}
                  emptyText="Sin datos de ganancia todavía"
                  accent="mint"
                />
              </Panel>
            )}

            <Panel title="Bajo stock" icon={<TargetIcon className="h-4 w-4" />} accent="coral">
              {m.bajoStock.length === 0 ? (
                <RowEmpty text="Sin alertas de stock" />
              ) : (
                <div className="space-y-2">
                  {m.bajoStock.map((p) => (
                    <div key={p.id} className="flex items-center justify-between border-b border-ink-50 pb-2 text-sm last:border-0">
                      <span className="text-ink-700">{p.name}</span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-coral-50 px-2 py-0.5 text-xs font-semibold text-coral-600">
                        {p.stock} u.
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            {!isSeller && (
              <Panel title="Ventas por vendedor" icon={<UsersIcon className="h-4 w-4" />}>
                <BarList
                  rows={m.ventasPorVendedor.map((s) => ({ id: s.sellerId, label: s.sellerId, value: s.ingresos, display: `${s.ventas} · ${gs(s.ingresos)}` }))}
                  emptyText="Sin ventas asignadas"
                />
              </Panel>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------- UI helpers ------------------------------ */

const ACCENT_ICON = {
  mint: 'bg-mint-50 text-mint-600',
  ink: 'bg-ink-50 text-ink-600',
  coral: 'bg-coral-50 text-coral-600',
} as const;

const ACCENT_BAR = {
  mint: 'bg-mint-400',
  ink: 'bg-ink-300',
  coral: 'bg-coral-300',
} as const;

function Panel({
  title,
  icon,
  accent = 'ink',
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  accent?: 'mint' | 'ink' | 'coral';
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-ink-100 bg-white p-5 shadow-soft">
      <div className="mb-4 flex items-center gap-2">
        {icon && <span className={'grid h-7 w-7 place-items-center rounded-lg ' + ACCENT_ICON[accent]}>{icon}</span>}
        <h2 className="text-sm font-semibold text-ink-700">{title}</h2>
      </div>
      {children}
    </div>
  );
}

interface BarRow {
  id: string;
  label: string;
  value: number | null;
  display: React.ReactNode;
}

function BarList({
  rows,
  emptyText,
  accent = 'ink',
}: {
  rows: BarRow[];
  emptyText: string;
  accent?: 'mint' | 'ink' | 'coral';
}) {
  if (rows.length === 0) return <RowEmpty text={emptyText} />;
  const max = Math.max(...rows.map((r) => Math.abs(r.value ?? 0)), 1);
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.id} className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="truncate pr-3 text-ink-700">{r.label}</span>
            <span className="shrink-0 font-medium text-ink-900">{r.display}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-50">
            <div
              className={'h-full rounded-full ' + ACCENT_BAR[accent]}
              style={{ width: `${Math.max(4, (Math.abs(r.value ?? 0) / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function RowEmpty({ text }: { text: string }) {
  return <div className="py-2 text-sm text-ink-400">{text}</div>;
}

function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-ink-200 bg-white px-6 py-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-ink-50 text-ink-400">{icon}</span>
      <div>
        <h3 className="text-sm font-semibold text-ink-800">{title}</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">{text}</p>
      </div>
    </div>
  );
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
