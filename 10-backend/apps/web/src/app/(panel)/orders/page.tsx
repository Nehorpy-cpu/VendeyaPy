'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Order, OrderStatus } from '@vpw/shared';
import { useAuth } from '@/lib/auth-context';
import { useActiveCompany } from '@/lib/active-company';
import { listOrders } from '@/lib/orders';

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

  const filtered = useMemo(() => {
    const list = ordersQ.data ?? [];
    return status === 'ALL' ? list : list.filter((o) => o.status === status);
  }, [ordersQ.data, status]);

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
        Seleccioná una empresa para ver sus pedidos.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold text-gray-900">Pedidos</h1>

      <select
        value={status}
        onChange={(e) => setStatus(e.target.value as OrderStatus | 'ALL')}
        className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
      >
        <option value="ALL">Todos los estados</option>
        {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>

      {ordersQ.isLoading && <div className="text-gray-400">Cargando pedidos…</div>}
      {ordersQ.isError && <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">No se pudieron cargar los pedidos.</div>}
      {ordersQ.isSuccess && filtered.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          No hay pedidos {status !== 'ALL' ? 'en este estado' : 'todavía'}.
        </div>
      )}

      {ordersQ.isSuccess && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
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
            <tbody className="divide-y divide-gray-100">
              {filtered.map((o) => (
                <tr key={o.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{o.id.slice(0, 12)}…</td>
                  <td className="px-4 py-3">{fecha(o)}</td>
                  <td className="px-4 py-3">{o.customerId}</td>
                  <td className="px-4 py-3 font-medium">{gs(o.totals.total)}</td>
                  {!isSeller && (
                    <td className="px-4 py-3">{o.totals.grossProfit == null ? <span className="text-amber-600">⚠️</span> : gs(o.totals.grossProfit)}</td>
                  )}
                  <td className="px-4 py-3">{STATUS_LABEL[o.status] ?? o.status}</td>
                  <td className="px-4 py-3 text-gray-500">{o.source ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => setDetail(o)} className="text-brand-700 hover:underline">Ver</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
          <div className="my-8 w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900">Pedido {detail.id.slice(0, 12)}…</h2>
              <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-700">✕</button>
            </div>
            <div className="space-y-1 text-sm text-gray-600">
              <p>Cliente: <span className="text-gray-900">{detail.customerId}</span></p>
              <p>Estado: <span className="text-gray-900">{STATUS_LABEL[detail.status] ?? detail.status}</span></p>
              <p>Origen: <span className="text-gray-900">{detail.source ?? '—'}</span> · Canal: {detail.channel}</p>
            </div>
            <table className="mt-4 w-full text-sm">
              <thead className="text-left text-xs uppercase text-gray-400">
                <tr><th className="py-1">Producto</th><th>Cant.</th><th>Subtotal</th>{!isSeller && <th>Ganancia</th>}</tr>
              </thead>
              <tbody>
                {detail.items.map((it) => (
                  <tr key={it.itemId} className="border-t border-gray-100">
                    <td className="py-1">{it.productName}</td>
                    <td>{it.quantity}</td>
                    <td>{gs(it.subtotal)}</td>
                    {!isSeller && <td>{it.grossProfit == null ? '⚠️' : gs(it.grossProfit)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 border-t border-gray-200 pt-3 text-right text-sm">
              <div>Total: <span className="font-bold">{gs(detail.totals.total)}</span></div>
              {!isSeller && <div className="text-gray-500">Ganancia: {detail.totals.grossProfit == null ? '⚠️ incompleta' : gs(detail.totals.grossProfit)}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
