'use client';

import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MetaCampaign } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { listCampaigns, syncAds, computeAttribution } from '@/lib/ads';

const gs = (n: number) => '₲ ' + Math.round(n).toLocaleString('es-PY');
const num = (n: number) => n.toLocaleString('es-PY');

export default function AdsPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const qc = useQueryClient();

  const campaignsQ = useQuery({ queryKey: ['metaCampaigns', tenantId], queryFn: () => listCampaigns(tenantId!), enabled: !!tenantId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['metaCampaigns', tenantId] });
  const syncMut = useMutation({ mutationFn: () => syncAds(tenantId!), onSuccess: invalidate });
  const attrMut = useMutation({ mutationFn: () => computeAttribution(tenantId!), onSuccess: invalidate });

  const campaigns = campaignsQ.data ?? [];
  const totals = useMemo(() => {
    const t = campaigns.reduce(
      (a, c) => ({
        spend: a.spend + c.latestMetrics.spend,
        convs: a.convs + c.latestMetrics.conversations,
        orders: a.orders + (c.attribution?.orders ?? 0),
        revenue: a.revenue + (c.attribution?.revenue ?? 0),
        profit: a.profit + (c.attribution?.grossProfit ?? 0),
      }),
      { spend: 0, convs: 0, orders: 0, revenue: 0, profit: 0 },
    );
    return { ...t, roas: t.spend > 0 ? t.revenue / t.spend : 0, net: t.profit - t.spend };
  }, [campaigns]);

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Seleccioná una empresa.</div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Anuncios y ganancia</h1>
          <p className="text-sm text-gray-500">Qué campaña deja plata de verdad: gasto vs. ventas, ingresos y ganancia reales.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => attrMut.mutate()} disabled={attrMut.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{attrMut.isPending ? 'Calculando…' : '🎯 Calcular atribución'}</button>
          <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending} className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60">{syncMut.isPending ? 'Sincronizando…' : '🔄 Sincronizar (demo)'}</button>
        </div>
      </div>

      <div className="rounded-lg bg-amber-50 px-4 py-2 text-xs text-amber-800">
        ℹ️ Datos de demostración (Meta aún no conectado). La <strong>atribución</strong> conecta cada venta con la campaña que la trajo; con Meta conectado, estos números son reales.
      </div>

      {campaignsQ.isLoading && <div className="text-gray-400">Cargando…</div>}
      {campaignsQ.isSuccess && campaigns.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Sin campañas todavía. Tocá “Sincronizar (demo)”.</div>
      )}

      {campaigns.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Card label="Gasto" value={gs(totals.spend)} />
            <Card label="Ventas" value={num(totals.orders)} />
            <Card label="Ingresos" value={gs(totals.revenue)} />
            <Card label="Ganancia neta" value={gs(totals.net)} accent={totals.net >= 0 ? 'text-brand-700' : 'text-red-600'} hint="ganancia de las ventas − gasto en ads" />
            <Card label="ROAS" value={totals.roas ? totals.roas.toFixed(1) + '×' : '—'} hint="ingresos ÷ gasto" />
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3">Campaña</th>
                  <th className="px-4 py-3">Gasto</th>
                  <th className="px-4 py-3">Conv.</th>
                  <th className="px-4 py-3">Ventas</th>
                  <th className="px-4 py-3">Ingresos</th>
                  <th className="px-4 py-3">Ganancia</th>
                  <th className="px-4 py-3">ROAS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {campaigns.map((c: MetaCampaign) => {
                  const a = c.attribution;
                  return (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3"><div className="font-medium text-gray-900">{c.name}</div><div className="text-xs text-gray-400">{c.objective}</div></td>
                      <td className="px-4 py-3 font-medium">{gs(c.latestMetrics.spend)}</td>
                      <td className="px-4 py-3">{num(c.latestMetrics.conversations)}</td>
                      <td className="px-4 py-3">{a ? num(a.orders) : '—'}</td>
                      <td className="px-4 py-3">{a ? gs(a.revenue) : '—'}</td>
                      <td className="px-4 py-3">{a?.grossProfit != null ? gs(a.grossProfit) : '—'}</td>
                      <td className="px-4 py-3 font-semibold">{a?.roas != null ? a.roas.toFixed(1) + '×' : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Card({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className={'mt-1 text-2xl font-bold ' + (accent ?? 'text-gray-900')}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-gray-400">{hint}</div>}
    </div>
  );
}
