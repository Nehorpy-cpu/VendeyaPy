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
  NEW: 'bg-ink-50 text-ink-600', HOT: 'bg-coral-50 text-coral-700', BUYER: 'bg-mint-50 text-mint-700',
  RECURRING: 'bg-mint-100 text-mint-800', PREMIUM: 'bg-ink-900 text-white',
  DORMANT: 'bg-amber-50 text-amber-700', LOST: 'bg-ink-50 text-ink-400',
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
  if (!conv) return <span className="text-ink-400">—</span>;
  return conv.humanTakeover ? (
    <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">Vendedor</span>
  ) : (
    <span className="inline-flex rounded-full bg-mint-50 px-2 py-0.5 text-xs font-semibold text-mint-700">Bot</span>
  );
}

function SegmentBadge({ c }: { c: Customer }) {
  if (!c.customerType) return <span className="text-ink-400">—</span>;
  return (
    <span className={'inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ' + SEGMENT_STYLE[c.customerType]}>
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

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) {
    return (
      <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center text-sm text-ink-500">
        Seleccioná una empresa para ver sus clientes.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Clientes</h1>
          <p className="mt-1 text-sm text-ink-500">Quién te escribe por WhatsApp, su segmento e historial de compras.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={segment}
            onChange={(e) => setSegment(e.target.value as CustomerType | 'ALL')}
            className="rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
          >
            <option value="ALL">Todos los segmentos</option>
            {Object.entries(SEGMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre o teléfono…"
            className="w-56 rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
          />
        </div>
      </div>

      {customersQ.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-xl border border-ink-100 bg-ink-50/60" />)}
        </div>
      )}
      {customersQ.isError && (
        <div className="rounded-2xl border border-coral-200 bg-coral-50 px-4 py-3 text-sm text-coral-700">
          No se pudieron cargar los clientes.
        </div>
      )}
      {customersQ.isSuccess && filtered.length === 0 && (
        <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center">
          <h3 className="text-sm font-semibold text-ink-800">{q || segment !== 'ALL' ? 'Sin coincidencias' : 'Todavía no hay clientes'}</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">
            {q || segment !== 'ALL' ? 'Ningún cliente coincide con el filtro.' : 'Aparecerán acá cuando alguien le escriba al bot por WhatsApp.'}
          </p>
        </div>
      )}

      {customersQ.isSuccess && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-ink-100 bg-white shadow-soft">
          <table className="min-w-full text-sm">
            <thead className="border-b border-ink-100 bg-ink-50/60 text-left text-xs uppercase tracking-wide text-ink-400">
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
            <tbody className="divide-y divide-ink-50">
              {filtered.map((c) => (
                <tr key={c.id} className="hover:bg-ink-50/50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-ink-900">{displayName(c)}</div>
                    <div className="font-mono text-xs text-ink-400">{c.whatsappPhone || c.id}</div>
                  </td>
                  <td className="max-w-xs px-4 py-3">
                    <div className="truncate text-ink-700">{c.conversation?.lastMessagePreview ?? '—'}</div>
                    <div className="text-xs text-ink-400">{when(c.conversation?.lastMessageAt)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <EstadoBadge c={c} />
                      {!!c.conversation?.unreadForSeller && (
                        <span className="grid h-4 min-w-[1rem] place-items-center rounded-full bg-coral-500 px-1 text-[10px] font-bold text-white">
                          {c.conversation.unreadForSeller}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <SegmentBadge c={c} />
                      {c.customerScore != null && <span className="text-xs text-ink-400">{c.customerScore}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-ink-700">{c.stats?.totalOrders ?? 0}</td>
                  <td className="px-4 py-3 font-medium text-ink-900">{gs(c.stats?.totalSpent)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/conversations?c=${encodeURIComponent(c.id)}`} className="font-medium text-mint-700 hover:text-mint-600">
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
