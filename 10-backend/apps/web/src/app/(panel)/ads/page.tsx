'use client';

import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MetaCampaign } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { listCampaigns, syncAds, computeAttribution } from '@/lib/ads';
import { isDemoIntegrationsAllowed as isDemoAllowed } from '@/lib/integrations';
import { SectionHeader, EmptyState, SkeletonList } from '@/components/ui';

const gs = (n: number) => '₲ ' + Math.round(n).toLocaleString('es-PY');
const num = (n: number) => n.toLocaleString('es-PY');

export default function AdsPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const qc = useQueryClient();

  const campaignsQ = useQuery({ queryKey: ['metaCampaigns', tenantId], queryFn: () => listCampaigns(tenantId!), enabled: !!tenantId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['metaCampaigns', tenantId] });
  const syncMut = useMutation({ mutationFn: () => syncAds(tenantId!), onSuccess: invalidate });
  const attrMut = useMutation({ mutationFn: () => computeAttribution(tenantId!), onSuccess: invalidate });
  // Acciones demo (sync/atribución por endpoints dev) SOLO en emulador/demo; en staging/prod se ocultan
  // y la pantalla muestra estado honesto. Mismo criterio que Integraciones (isDemoIntegrationsAllowed).
  const demoAllowed = isDemoAllowed();

  const campaigns = useMemo(() => campaignsQ.data ?? [], [campaignsQ.data]);
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

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) return <EmptyState title="Seleccioná una empresa" text="Elegí una empresa en la barra superior para ver sus anuncios y atribución." />;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Anuncios y ganancia"
        subtitle="Qué campaña deja plata de verdad: gasto vs. ventas, ingresos y ganancia reales."
        actions={
          demoAllowed ? (
            <>
              <button onClick={() => attrMut.mutate()} disabled={attrMut.isPending} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60">{attrMut.isPending ? 'Calculando…' : '🎯 Calcular atribución'}</button>
              <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending} className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-60">{syncMut.isPending ? 'Sincronizando…' : '🔄 Sincronizar (demo)'}</button>
            </>
          ) : undefined
        }
      />

      {demoAllowed && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          ℹ️ Datos de demostración (Meta aún no conectado). La <strong>atribución</strong> conecta cada venta con la campaña que la trajo; con Meta conectado, estos números son reales.
        </div>
      )}

      {campaignsQ.isLoading && <SkeletonList rows={3} />}
      {campaignsQ.isSuccess && campaigns.length === 0 && (
        <EmptyState
          title="Sin campañas todavía"
          text={
            demoAllowed
              ? 'Tocá “Sincronizar (demo)” para ver cómo se conecta cada campaña con sus ventas y ganancia.'
              : 'Conectá Meta para ver tus campañas y métricas reales (gasto, ventas, ingresos y ganancia por campaña).'
          }
        />
      )}

      {campaigns.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Card label="Gasto" value={gs(totals.spend)} />
            <Card label="Ventas" value={num(totals.orders)} />
            <Card label="Ingresos" value={gs(totals.revenue)} />
            <Card label="Ganancia neta" value={gs(totals.net)} accent={totals.net >= 0 ? 'text-mint-700' : 'text-coral-600'} hint="ganancia de las ventas − gasto en ads" />
            <Card label="ROAS" value={totals.roas ? totals.roas.toFixed(1) + '×' : '—'} hint="ingresos ÷ gasto" />
          </div>

          <div className="overflow-x-auto rounded-2xl border border-ink-100 bg-white shadow-soft">
            <table className="min-w-full text-sm">
              <thead className="border-b border-ink-100 bg-ink-50/60 text-left text-xs uppercase tracking-wide text-ink-400">
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
              <tbody className="divide-y divide-ink-50">
                {campaigns.map((c: MetaCampaign) => {
                  const a = c.attribution;
                  return (
                    <tr key={c.id} className="hover:bg-ink-50/50">
                      <td className="px-4 py-3"><div className="font-medium text-ink-900">{c.name}</div><div className="text-xs text-ink-400">{c.objective}</div></td>
                      <td className="px-4 py-3 font-medium text-ink-900">{gs(c.latestMetrics.spend)}</td>
                      <td className="px-4 py-3 text-ink-700">{num(c.latestMetrics.conversations)}</td>
                      <td className="px-4 py-3 text-ink-700">{a ? num(a.orders) : '—'}</td>
                      <td className="px-4 py-3 text-ink-700">{a ? gs(a.revenue) : '—'}</td>
                      <td className="px-4 py-3 text-ink-700">{a?.grossProfit != null ? gs(a.grossProfit) : '—'}</td>
                      <td className="px-4 py-3 font-semibold text-ink-900">{a?.roas != null ? a.roas.toFixed(1) + '×' : '—'}</td>
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
    <div className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className={'mt-1 text-2xl font-bold ' + (accent ?? 'text-ink-900')}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-ink-400">{hint}</div>}
    </div>
  );
}
