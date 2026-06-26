'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Insight, InsightType, InsightStatus } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { listPendingInsights, setInsightStatus, generateInsights } from '@/lib/insights';
import { isDevToolingAllowed } from '@/lib/integrations';
import { SectionHeader, EmptyState, SkeletonList } from '@/components/ui';

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
const PRIO_DOT: Record<string, string> = { HIGH: 'bg-coral-500', MEDIUM: 'bg-amber-500', LOW: 'bg-ink-300' };

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
  // "Actualizar acciones" usa un endpoint dev (404 en prod). Solo en local/emulador; el refresco
  // real (job programado/autenticado) llega en GROWTH-JOBS-WIRING.
  const devTools = isDevToolingAllowed();

  const grouped = useMemo(() => {
    const list = insightsQ.data ?? [];
    const by: Record<string, Insight[]> = {};
    for (const i of list) (by[i.type] ??= []).push(i);
    return by;
  }, [insightsQ.data]);

  const total = insightsQ.data?.length ?? 0;

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) return <EmptyState title="Seleccioná una empresa" text="Elegí una empresa en la barra superior para ver sus acciones recomendadas." />;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Acciones de hoy"
        subtitle={total === 0 ? 'Sin acciones pendientes.' : `Tenés ${total} acción(es) recomendada(s).`}
        actions={
          devTools ? (
            <button onClick={() => genMut.mutate()} disabled={genMut.isPending} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60">
              {genMut.isPending ? 'Buscando…' : 'Actualizar acciones'}
            </button>
          ) : undefined
        }
      />

      {insightsQ.isLoading && <SkeletonList rows={4} />}
      {insightsQ.isSuccess && total === 0 && (
        <EmptyState title="¡Todo al día! 🎉" text={devTools ? 'No hay acciones pendientes. Tocá “Actualizar acciones” para volver a revisar.' : 'No hay acciones pendientes por ahora.'} />
      )}

      {TYPE_ORDER.filter((t) => grouped[t]?.length).map((t) => (
        <section key={t}>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">{TYPE_LABEL[t] ?? t} ({grouped[t]!.length})</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {grouped[t]!.map((i) => (
              <div key={i.id} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
                <div className="flex items-start gap-2">
                  <span className={'mt-1.5 h-2 w-2 shrink-0 rounded-full ' + (PRIO_DOT[i.priority] ?? 'bg-ink-300')} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-ink-900">{i.title}</div>
                    <p className="mt-0.5 text-xs text-ink-600">{i.description}</p>
                    {i.estimatedImpact && <p className="mt-1 text-xs text-ink-500">📈 {i.estimatedImpact}</p>}
                    {i.recommendedAction && <p className="mt-1 text-xs text-mint-700">👉 {i.recommendedAction}</p>}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {i.relatedEntityType === 'customer' && i.relatedEntityId && (
                        <Link href={`/conversations?c=${encodeURIComponent(i.relatedEntityId)}`} className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50">Ver chat</Link>
                      )}
                      <button onClick={() => statusMut.mutate({ id: i.id, status: 'RESOLVED' })} className="rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700">Hecho</button>
                      <button onClick={() => statusMut.mutate({ id: i.id, status: 'DISMISSED' })} className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 transition-colors hover:bg-ink-50">Descartar</button>
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
