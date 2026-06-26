'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { FollowUpTask, FollowUpType, FollowUpStatus } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { useAuth } from '@/lib/auth-context';
import { listFollowUpTasks, setTaskStatus, generateFollowups } from '@/lib/followups';
import { canRunPanelJobs, friendlyJobError } from '@/lib/entitlements';
import { SectionHeader, EmptyState, SkeletonList } from '@/components/ui';

const TYPE_LABEL: Record<FollowUpType, string> = {
  PAYMENT_PENDING: '💳 Pago pendiente',
  VERIFY_RECEIPT: '🧾 Verificar comprobante',
  ENGAGE: '👋 Preguntó y no compró',
  REPURCHASE: '🔁 Recompra',
  GENERAL: '📌 Seguimiento',
};
const PRIO_DOT: Record<string, string> = { HIGH: 'bg-coral-500', MEDIUM: 'bg-amber-500', LOW: 'bg-ink-300' };

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* no clipboard */ } }}
      className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50"
    >
      {done ? '✓ Copiado' : 'Copiar mensaje'}
    </button>
  );
}

export default function FollowupsPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const { user, claims } = useAuth();
  const qc = useQueryClient();
  const [onlyMine, setOnlyMine] = useState(false);

  const tasksQ = useQuery({ queryKey: ['followups', tenantId], queryFn: () => listFollowUpTasks(tenantId!), enabled: !!tenantId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['followups', tenantId] });
  const statusMut = useMutation({ mutationFn: ({ id, status }: { id: string; status: FollowUpStatus }) => setTaskStatus(tenantId!, id, status), onSuccess: invalidate });
  const genMut = useMutation({ mutationFn: () => generateFollowups(tenantId!), onSuccess: invalidate });
  // "Actualizar tareas" llama al callable real runTenantJob('generateFollowups'). Visible para roles
  // que pueden ejecutar jobs (owner/manager/admin); los vendedores ven la lista pero no el botón.
  const canJobs = canRunPanelJobs(claims.role);

  const visible = useMemo(() => {
    const list = tasksQ.data ?? [];
    const filtered = onlyMine && user ? list.filter((t) => t.sellerId === user.uid) : list;
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 } as Record<string, number>;
    return [...filtered].sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3));
  }, [tasksQ.data, onlyMine, user]);

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) return <EmptyState title="Seleccioná una empresa" text="Elegí una empresa en la barra superior para ver sus seguimientos." />;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Seguimientos"
        subtitle={visible.length === 0 ? 'Sin tareas pendientes.' : `${visible.length} tarea(s) de seguimiento.`}
        actions={
          <>
            <label className="flex items-center gap-2 text-xs text-ink-600">
              <input type="checkbox" className="accent-mint-600" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Mis tareas
            </label>
            {canJobs && (
              <button onClick={() => genMut.mutate()} disabled={genMut.isPending} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60">
                {genMut.isPending ? 'Buscando…' : 'Actualizar tareas'}
              </button>
            )}
          </>
        }
      />

      {genMut.isError && (
        <p className="rounded-xl bg-coral-50 px-3.5 py-2.5 text-sm text-coral-700 ring-1 ring-inset ring-coral-100">{friendlyJobError(genMut.error)}</p>
      )}

      {tasksQ.isLoading && <SkeletonList rows={4} />}
      {tasksQ.isSuccess && visible.length === 0 && (
        <EmptyState title="¡Sin pendientes! ✅" text={onlyMine ? 'No tenés tareas asignadas.' : (canJobs ? 'Tocá “Actualizar tareas” para revisar si hay seguimientos nuevos.' : 'No hay seguimientos pendientes por ahora.')} />
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {visible.map((t: FollowUpTask) => (
          <div key={t.id} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
            <div className="flex items-start gap-2">
              <span className={'mt-1.5 h-2 w-2 shrink-0 rounded-full ' + (PRIO_DOT[t.priority] ?? 'bg-ink-300')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink-900">{t.title}</span>
                  <span className="shrink-0 text-[11px] text-ink-400">{TYPE_LABEL[t.type] ?? t.type}</span>
                </div>
                <div className="mt-2 rounded-lg bg-ink-50/60 p-2 text-xs text-ink-700">{t.suggestedMessage}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <CopyButton text={t.suggestedMessage} />
                  {t.customerId && (
                    <Link href={`/conversations?c=${encodeURIComponent(t.customerId)}`} className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50">Ver chat</Link>
                  )}
                  <button onClick={() => statusMut.mutate({ id: t.id, status: 'COMPLETED' })} className="rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700">Hecho</button>
                  <button onClick={() => statusMut.mutate({ id: t.id, status: 'DISMISSED' })} className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 transition-colors hover:bg-ink-50">Descartar</button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
