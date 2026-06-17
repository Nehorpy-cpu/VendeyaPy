'use client';

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth-context';
import { ROLE_LABELS } from '@/lib/roles';
import { useActiveCompany } from '@/lib/active-company';
import { listOrders, computeMetrics } from '@/lib/orders';
import { listProducts } from '@/lib/catalog';

const gs = (n: number | null | undefined) => (n == null ? '—' : '₲ ' + Math.round(n).toLocaleString('es-PY'));

export default function DashboardPage() {
  const { user, claims } = useAuth();
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const isSeller = claims.role === 'SELLER';

  const ordersQ = useQuery({ queryKey: ['orders', tenantId], queryFn: () => listOrders(tenantId!), enabled: !!tenantId });
  const productsQ = useQuery({ queryKey: ['products', tenantId], queryFn: () => listProducts(tenantId!), enabled: !!tenantId });

  const ready = ordersQ.isSuccess && productsQ.isSuccess;
  const m = ready ? computeMetrics(ordersQ.data, productsQ.data) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500">
          {user?.email} · {claims.role ? ROLE_LABELS[claims.role] : '—'}
          {claims.tenantId ? ` · ${claims.tenantId}` : tenantId ? ` · ${tenantId}` : ' · Plataforma'}
        </p>
      </div>

      {(companyLoading || (!!tenantId && !ready)) && <div className="text-gray-400">Cargando métricas…</div>}
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
