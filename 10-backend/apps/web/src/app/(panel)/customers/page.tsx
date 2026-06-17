'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { Customer, CustomerType } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { listCustomers } from '@/lib/conversations';

const SEGMENT_LABEL: Record<CustomerType, string> = {
  NEW: 'Nuevo', HOT: 'Caliente', BUYER: 'Comprador', RECURRING: 'Recurrente',
  PREMIUM: 'Premium', DORMANT: 'Dormido', LOST: 'Perdido',
};
const SEGMENT_STYLE: Record<CustomerType, string> = {
  NEW: 'bg-gray-100 text-gray-600', HOT: 'bg-red-100 text-red-700', BUYER: 'bg-blue-100 text-blue-700',
  RECURRING: 'bg-brand-100 text-brand-700', PREMIUM: 'bg-purple-100 text-purple-700',
  DORMANT: 'bg-amber-100 text-amber-700', LOST: 'bg-gray-100 text-gray-400',
};

const gs = (n: number | null | undefined) =>
  n == null ? '—' : '₲ ' + Math.round(n).toLocaleString('es-PY');

function when(ts: unknown): string {
  try {
    const d = (ts as { toDate?: () => Date } | null)?.toDate?.();
    if (!d) return '—';
    return d.toLocaleDateString('es-PY', { day: '2-digit', month: '2-digit' }) +
      ' ' + d.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

function displayName(c: Customer): string {
  return c.name?.trim() || c.whatsappPhone || c.id;
}

function EstadoBadge({ c }: { c: Customer }) {
  const conv = c.conversation;
  if (!conv) return <span className="text-gray-400">—</span>;
  return conv.humanTakeover ? (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">🧑‍💼 Vendedor</span>
  ) : (
    <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">🤖 Bot</span>
  );
}

function SegmentBadge({ c }: { c: Customer }) {
  if (!c.customerType) return <span className="text-gray-400">—</span>;
  return (
    <span className={'rounded-full px-2 py-0.5 text-xs font-medium ' + SEGMENT_STYLE[c.customerType]}>
      {SEGMENT_LABEL[c.customerType]}
    </span>
  );
}

export default function CustomersPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState<CustomerType | 'ALL'>('ALL');

  const customersQ = useQuery({
    queryKey: ['customers', tenantId],
    queryFn: () => listCustomers(tenantId!),
    enabled: !!tenantId,
  });

  const filtered = useMemo(() => {
    const list = customersQ.data ?? [];
    const needle = q.trim().toLowerCase();
    return list.filter((c) => {
      if (segment !== 'ALL' && c.customerType !== segment) return false;
      if (!needle) return true;
      return displayName(c).toLowerCase().includes(needle) || (c.whatsappPhone ?? '').toLowerCase().includes(needle);
    });
  }, [customersQ.data, q, segment]);

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
        Seleccioná una empresa para ver sus clientes.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Clientes</h1>
        <div className="flex gap-2">
          <select
            value={segment}
            onChange={(e) => setSegment(e.target.value as CustomerType | 'ALL')}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          >
            <option value="ALL">Todos los segmentos</option>
            {Object.entries(SEGMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre o teléfono…"
            className="w-56 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
        </div>
      </div>

      {customersQ.isLoading && <div className="text-gray-400">Cargando clientes…</div>}
      {customersQ.isError && (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
          No se pudieron cargar los clientes.
        </div>
      )}
      {customersQ.isSuccess && filtered.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          {q ? 'Ningún cliente coincide con la búsqueda.' : 'Todavía no hay clientes. Aparecerán cuando alguien escriba al bot.'}
        </div>
      )}

      {customersQ.isSuccess && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Último mensaje</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Segmento</th>
                <th className="px-4 py-3">Pedidos</th>
                <th className="px-4 py-3">Gastado</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{displayName(c)}</div>
                    <div className="font-mono text-xs text-gray-400">{c.whatsappPhone || c.id}</div>
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    <div className="truncate text-gray-700">{c.conversation?.lastMessagePreview ?? '—'}</div>
                    <div className="text-xs text-gray-400">{when(c.conversation?.lastMessageAt)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <EstadoBadge c={c} />
                      {!!c.conversation?.unreadForSeller && (
                        <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                          {c.conversation.unreadForSeller}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <SegmentBadge c={c} />
                      {c.customerScore != null && <span className="text-xs text-gray-400">{c.customerScore}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3">{c.stats?.totalOrders ?? 0}</td>
                  <td className="px-4 py-3">{gs(c.stats?.totalSpent)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/conversations?c=${encodeURIComponent(c.id)}`} className="text-brand-700 hover:underline">
                      Ver chat
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
