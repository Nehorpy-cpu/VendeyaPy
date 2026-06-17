'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { FollowUpTask, FollowUpType, FollowUpStatus } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { useAuth } from '@/lib/auth-context';
import { listFollowUpTasks, setTaskStatus, generateFollowups } from '@/lib/followups';

const TYPE_LABEL: Record<FollowUpType, string> = {
  PAYMENT_PENDING: '💳 Pago pendiente',
  VERIFY_RECEIPT: '🧾 Verificar comprobante',
  ENGAGE: '👋 Preguntó y no compró',
  REPURCHASE: '🔁 Recompra',
  GENERAL: '📌 Seguimiento',
};
const PRIO_DOT: Record<string, string> = { HIGH: 'bg-red-500', MEDIUM: 'bg-amber-500', LOW: 'bg-gray-400' };

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* no clipboard */ } }}
      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
    >
      {done ? '✓ Copiado' : 'Copiar mensaje'}
    </button>
  );
}

export default function FollowupsPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [onlyMine, setOnlyMine] = useState(false);

  const tasksQ = useQuery({ queryKey: ['followups', tenantId], queryFn: () => listFollowUpTasks(tenantId!), enabled: !!tenantId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['followups', tenantId] });
  const statusMut = useMutation({ mutationFn: ({ id, status }: { id: string; status: FollowUpStatus }) => setTaskStatus(tenantId!, id, status), onSuccess: invalidate });
  const genMut = useMutation({ mutationFn: () => generateFollowups(tenantId!), onSuccess: invalidate });

  const visible = useMemo(() => {
    const list = tasksQ.data ?? [];
    const filtered = onlyMine && user ? list.filter((t) => t.sellerId === user.uid) : list;
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 } as Record<string, number>;
    return [...filtered].sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3));
  }, [tasksQ.data, onlyMine, user]);

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) {
    return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Seleccioná una empresa.</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Seguimientos</h1>
          <p className="text-sm text-gray-500">{visible.length === 0 ? 'Sin tareas pendientes.' : `${visible.length} tarea(s) de seguimiento.`}</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Mis tareas
          </label>
          <button onClick={() => genMut.mutate()} disabled={genMut.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
            {genMut.isPending ? 'Buscando…' : 'Actualizar tareas'}
          </button>
        </div>
      </div>

      {tasksQ.isLoading && <div className="text-gray-400">Cargando…</div>}
      {tasksQ.isSuccess && visible.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center">
          <div className="text-3xl">✅</div>
          <p className="mt-2 text-sm text-gray-600">{onlyMine ? 'No tenés tareas asignadas.' : '¡Sin pendientes! Tocá “Actualizar tareas” para revisar.'}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {visible.map((t: FollowUpTask) => (
          <div key={t.id} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-start gap-2">
              <span className={'mt-1.5 h-2 w-2 shrink-0 rounded-full ' + (PRIO_DOT[t.priority] ?? 'bg-gray-400')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-gray-900">{t.title}</span>
                  <span className="shrink-0 text-[11px] text-gray-400">{TYPE_LABEL[t.type] ?? t.type}</span>
                </div>
                <div className="mt-2 rounded-lg bg-gray-50 p-2 text-xs text-gray-700">{t.suggestedMessage}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <CopyButton text={t.suggestedMessage} />
                  {t.customerId && (
                    <Link href={`/conversations?c=${encodeURIComponent(t.customerId)}`} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">Ver chat</Link>
                  )}
                  <button onClick={() => statusMut.mutate({ id: t.id, status: 'COMPLETED' })} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">Hecho</button>
                  <button onClick={() => statusMut.mutate({ id: t.id, status: 'DISMISSED' })} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Descartar</button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
