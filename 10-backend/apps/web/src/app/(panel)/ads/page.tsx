'use client';

import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MetaCampaign } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { listCampaigns, syncAds } from '@/lib/ads';

const gs = (n: number) => '₲ ' + Math.round(n).toLocaleString('es-PY');
const num = (n: number) => n.toLocaleString('es-PY');

export default function AdsPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const qc = useQueryClient();

  const campaignsQ = useQuery({ queryKey: ['metaCampaigns', tenantId], queryFn: () => listCampaigns(tenantId!), enabled: !!tenantId });
  const syncMut = useMutation({ mutationFn: () => syncAds(tenantId!), onSuccess: () => qc.invalidateQueries({ queryKey: ['metaCampaigns', tenantId] }) });

  const campaigns = campaignsQ.data ?? [];
  const totals = useMemo(() => campaigns.reduce((t, c) => ({ spend: t.spend + c.latestMetrics.spend, convs: t.convs + c.latestMetrics.conversations, clicks: t.clicks + c.latestMetrics.clicks, impr: t.impr + c.latestMetrics.impressions }), { spend: 0, convs: 0, clicks: 0, impr: 0 }), [campaigns]);

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Seleccioná una empresa.</div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Anuncios (Meta)</h1>
          <p className="text-sm text-gray-500">Rendimiento de tus campañas. Se sincroniza por día (no consulta Meta en cada carga).</p>
        </div>
        <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
          {syncMut.isPending ? 'Sincronizando…' : '🔄 Sincronizar (demo)'}
        </button>
      </div>

      <div className="rounded-lg bg-amber-50 px-4 py-2 text-xs text-amber-800">
        ℹ️ Datos de demostración (Meta aún no conectado). La <strong>atribución a ventas y ganancia real</strong> de cada campaña llega en la próxima fase.
      </div>

      {campaignsQ.isLoading && <div className="text-gray-400">Cargando…</div>}
      {campaignsQ.isSuccess && campaigns.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          Sin campañas todavía. Tocá “Sincronizar (demo)”.
        </div>
      )}

      {campaigns.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Card label="Gasto" value={gs(totals.spend)} />
            <Card label="Conversaciones" value={num(totals.convs)} />
            <Card label="Clics" value={num(totals.clicks)} />
            <Card label="Impresiones" value={num(totals.impr)} />
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3">Campaña</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Gasto</th>
                  <th className="px-4 py-3">Impresiones</th>
                  <th className="px-4 py-3">Clics</th>
                  <th className="px-4 py-3">CTR</th>
                  <th className="px-4 py-3">Conversaciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {campaigns.map((c: MetaCampaign) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3"><div className="font-medium text-gray-900">{c.name}</div><div className="text-xs text-gray-400">{c.objective}</div></td>
                    <td className="px-4 py-3"><span className={'rounded-full px-2 py-0.5 text-xs font-medium ' + (c.status === 'ACTIVE' ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-500')}>{c.status === 'ACTIVE' ? 'Activa' : c.status}</span></td>
                    <td className="px-4 py-3 font-medium">{gs(c.latestMetrics.spend)}</td>
                    <td className="px-4 py-3">{num(c.latestMetrics.impressions)}</td>
                    <td className="px-4 py-3">{num(c.latestMetrics.clicks)}</td>
                    <td className="px-4 py-3">{c.latestMetrics.ctr}%</td>
                    <td className="px-4 py-3">{num(c.latestMetrics.conversations)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="mt-1 text-2xl font-bold text-gray-900">{value}</div>
    </div>
  );
}
