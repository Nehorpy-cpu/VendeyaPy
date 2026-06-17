'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Insight, InsightType, InsightStatus } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { listPendingInsights, setInsightStatus, generateInsights } from '@/lib/insights';

const TYPE_LABEL: Record<string, string> = {
  PENDING_REPLY: '💬 Conversaciones sin responder',
  CUSTOMER_REACTIVATION: '🔁 Reactivar clientes',
  PROMO_SUGGESTION: '🏷️ Promociones',
  FOLLOW_UP: '📌 Seguimientos',
  CAMPAIGN_REVIEW: '📣 Campañas',
  AGENT_ISSUE: '🤖 Agente',
};
// Orden de aparición (lo más urgente primero)
const TYPE_ORDER: InsightType[] = ['PENDING_REPLY', 'CUSTOMER_REACTIVATION', 'PROMO_SUGGESTION', 'FOLLOW_UP', 'CAMPAIGN_REVIEW', 'AGENT_ISSUE'];
const PRIO_DOT: Record<string, string> = { HIGH: 'bg-red-500', MEDIUM: 'bg-amber-500', LOW: 'bg-gray-400' };

export default function DecisionsPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const qc = useQueryClient();

  const insightsQ = useQuery({ queryKey: ['pendingInsights', tenantId], queryFn: () => listPendingInsights(tenantId!), enabled: !!tenantId });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['pendingInsights', tenantId] });
    qc.invalidateQueries({ queryKey: ['promoSuggestions', tenantId] });
  };
  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: InsightStatus }) => setInsightStatus(tenantId!, id, status),
    onSuccess: invalidate,
  });
  const genMut = useMutation({ mutationFn: () => generateInsights(tenantId!), onSuccess: invalidate });

  const grouped = useMemo(() => {
    const list = insightsQ.data ?? [];
    const by: Record<string, Insight[]> = {};
    for (const i of list) (by[i.type] ??= []).push(i);
    return by;
  }, [insightsQ.data]);

  const total = insightsQ.data?.length ?? 0;

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) {
    return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Seleccioná una empresa.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Acciones de hoy</h1>
          <p className="text-sm text-gray-500">{total === 0 ? 'Sin acciones pendientes.' : `Tenés ${total} acción(es) recomendada(s).`}</p>
        </div>
        <button onClick={() => genMut.mutate()} disabled={genMut.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
          {genMut.isPending ? 'Buscando…' : 'Actualizar acciones'}
        </button>
      </div>

      {insightsQ.isLoading && <div className="text-gray-400">Cargando…</div>}
      {insightsQ.isSuccess && total === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center">
          <div className="text-3xl">🎉</div>
          <p className="mt-2 text-sm text-gray-600">¡Todo al día! No hay acciones pendientes. Tocá “Actualizar acciones” para volver a revisar.</p>
        </div>
      )}

      {TYPE_ORDER.filter((t) => grouped[t]?.length).map((t) => (
        <section key={t}>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">{TYPE_LABEL[t] ?? t} ({grouped[t]!.length})</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {grouped[t]!.map((i) => (
              <div key={i.id} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex items-start gap-2">
                  <span className={'mt-1.5 h-2 w-2 shrink-0 rounded-full ' + (PRIO_DOT[i.priority] ?? 'bg-gray-400')} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-gray-900">{i.title}</div>
                    <p className="mt-0.5 text-xs text-gray-600">{i.description}</p>
                    {i.estimatedImpact && <p className="mt-1 text-xs text-gray-500">📈 {i.estimatedImpact}</p>}
                    {i.recommendedAction && <p className="mt-1 text-xs text-brand-700">👉 {i.recommendedAction}</p>}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {i.relatedEntityType === 'customer' && i.relatedEntityId && (
                        <Link href={`/conversations?c=${encodeURIComponent(i.relatedEntityId)}`} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">Ver chat</Link>
                      )}
                      <button onClick={() => statusMut.mutate({ id: i.id, status: 'RESOLVED' })} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">Hecho</button>
                      <button onClick={() => statusMut.mutate({ id: i.id, status: 'DISMISSED' })} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Descartar</button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
