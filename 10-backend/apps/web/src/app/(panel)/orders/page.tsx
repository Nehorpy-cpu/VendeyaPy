'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Order, OrderStatus } from '@vpw/shared';
import { useAuth } from '@/lib/auth-context';
import { useActiveCompany } from '@/lib/active-company';
import { listOrders, listOrderFinancials } from '@/lib/orders';

const gs = (n: number | null | undefined) => (n == null ? '—' : '₲ ' + Math.round(n).toLocaleString('es-PY'));

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Esperando pago',
  PENDING_VERIFICATION: 'Verificando',
  PAID: 'Pagado',
  PREPARING: 'Preparando',
  ASSIGNED: 'Asignado',
  IN_TRANSIT: 'En camino',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Reembolsado',
};
const STATUS_TONE: Record<string, string> = {
  PENDING_PAYMENT: 'bg-amber-50 text-amber-700',
  PENDING_VERIFICATION: 'bg-amber-50 text-amber-700',
  PAID: 'bg-mint-50 text-mint-700',
  PREPARING: 'bg-ink-50 text-ink-600',
  ASSIGNED: 'bg-ink-50 text-ink-600',
  IN_TRANSIT: 'bg-ink-50 text-ink-600',
  DELIVERED: 'bg-mint-50 text-mint-700',
  CANCELLED: 'bg-coral-50 text-coral-700',
  REFUNDED: 'bg-coral-50 text-coral-700',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={'inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ' + (STATUS_TONE[status] ?? 'bg-ink-50 text-ink-600')}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function fecha(o: Order): string {
  try {
    const d = (o.createdAt as unknown as { toDate?: () => Date }).toDate?.();
    return d ? d.toLocaleDateString('es-PY') : '—';
  } catch {
    return '—';
  }
}

export default function OrdersPage() {
  const { claims } = useAuth();
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const isSeller = claims.role === 'SELLER';
  const [status, setStatus] = useState<OrderStatus | 'ALL'>('ALL');
  const [detail, setDetail] = useState<Order | null>(null);

  const ordersQ = useQuery({ queryKey: ['orders', tenantId], queryFn: () => listOrders(tenantId!), enabled: !!tenantId });
  // Finanzas privadas: el vendedor no puede leerlas (reglas) → no se consultan para su rol.
  const financialsQ = useQuery({
    queryKey: ['orderFinancials', tenantId],
    queryFn: () => listOrderFinancials(tenantId!),
    enabled: !!tenantId && !isSeller,
  });
  const finMap = financialsQ.data ?? {};
  const orderProfit = (orderId: string) => finMap[orderId]?.grossProfit ?? null;
  const itemProfit = (orderId: string, productId: string, subtotal: number): number | null => {
    const fi = finMap[orderId]?.items.find((x) => x.productId === productId);
    return fi?.totalCostSnapshot == null ? null : subtotal - fi.totalCostSnapshot;
  };

  const filtered = useMemo(() => {
    const list = ordersQ.data ?? [];
    return status === 'ALL' ? list : list.filter((o) => o.status === status);
  }, [ordersQ.data, status]);

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) {
    return (
      <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center text-sm text-ink-500">
        Seleccioná una empresa para ver sus pedidos.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Pedidos</h1>
          <p className="mt-1 text-sm text-ink-500">Seguí el estado de cada pedido{!isSeller ? ' y su ganancia' : ''}.</p>
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as OrderStatus | 'ALL')}
          className="rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
        >
          <option value="ALL">Todos los estados</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {ordersQ.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-xl border border-ink-100 bg-ink-50/60" />)}
        </div>
      )}
      {ordersQ.isError && <div className="rounded-2xl border border-coral-200 bg-coral-50 px-4 py-3 text-sm text-coral-700">No se pudieron cargar los pedidos.</div>}
      {ordersQ.isSuccess && filtered.length === 0 && (
        <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center">
          <h3 className="text-sm font-semibold text-ink-800">No hay pedidos {status !== 'ALL' ? 'en este estado' : 'todavía'}</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">
            {status !== 'ALL' ? 'Probá con otro filtro de estado.' : 'Cuando el bot cierre una venta, el pedido aparece acá automáticamente.'}
          </p>
        </div>
      )}

      {ordersQ.isSuccess && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-ink-100 bg-white shadow-soft">
          <table className="min-w-full text-sm">
            <thead className="border-b border-ink-100 bg-ink-50/60 text-left text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th className="px-4 py-3">Pedido</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Total</th>
                {!isSeller && <th className="px-4 py-3">Ganancia</th>}
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Origen</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-50">
              {filtered.map((o) => (
                <tr key={o.id} className="hover:bg-ink-50/50">
                  <td className="px-4 py-3 font-mono text-xs text-ink-500">{o.id.slice(0, 12)}…</td>
                  <td className="px-4 py-3 text-ink-600">{fecha(o)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-500">{o.customerId.slice(0, 10)}…</td>
                  <td className="px-4 py-3 font-medium text-ink-900">{gs(o.totals.total)}</td>
                  {!isSeller && (
                    <td className="px-4 py-3">{orderProfit(o.id) == null ? <span className="text-amber-600" title="Falta costo">⚠️</span> : <span className="text-ink-700">{gs(orderProfit(o.id))}</span>}</td>
                  )}
                  <td className="px-4 py-3"><StatusBadge status={o.status} /></td>
                  <td className="px-4 py-3 text-ink-500">{o.source ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => setDetail(o)} className="font-medium text-mint-700 hover:text-mint-600">Ver</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={() => setDetail(null)}>
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-ink-100 bg-white p-6 shadow-float" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-ink-900">Pedido <span className="font-mono text-sm text-ink-500">{detail.id.slice(0, 12)}…</span></h2>
              <button onClick={() => setDetail(null)} className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-700" aria-label="Cerrar">✕</button>
            </div>
            <div className="space-y-1.5 text-sm text-ink-500">
              <p>Cliente: <span className="font-mono text-xs text-ink-700">{detail.customerId}</span></p>
              <p className="flex items-center gap-2">Estado: <StatusBadge status={detail.status} /></p>
              <p>Origen: <span className="text-ink-700">{detail.source ?? '—'}</span> · Canal: <span className="text-ink-700">{detail.channel}</span></p>
            </div>
            <table className="mt-4 w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-ink-400">
                <tr><th className="py-1">Producto</th><th>Cant.</th><th>Subtotal</th>{!isSeller && <th>Ganancia</th>}</tr>
              </thead>
              <tbody>
                {detail.items.map((it) => (
                  <tr key={it.itemId} className="border-t border-ink-50">
                    <td className="py-1.5 text-ink-800">{it.productName}</td>
                    <td className="text-ink-600">{it.quantity}</td>
                    <td className="text-ink-600">{gs(it.subtotal)}</td>
                    {!isSeller && <td className="text-ink-600">{itemProfit(detail.id, it.productId, it.subtotal) == null ? '⚠️' : gs(itemProfit(detail.id, it.productId, it.subtotal))}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 border-t border-ink-100 pt-3 text-right text-sm">
              <div className="text-ink-900">Total: <span className="font-bold">{gs(detail.totals.total)}</span></div>
              {!isSeller && <div className="text-ink-500">Ganancia: {orderProfit(detail.id) == null ? '⚠️ incompleta' : gs(orderProfit(detail.id))}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
