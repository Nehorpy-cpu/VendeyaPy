'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  planById,
  listPendingActivations,
  approveActivation,
  cancelActivation,
  type ManualActivationRequestView,
} from '@/lib/entitlements';

/**
 * Bandeja del PLATFORM_ADMIN: solicitudes de activación manual PENDIENTES de todas las empresas.
 * Aprobar exige `paymentReference` (referencia del pago) y activa el plan vía manualBillingActivate.
 * Cancelar vía manualBillingCancelRequest. SOLO se renderiza para PLATFORM_ADMIN (gate en la page).
 */
export function AdminActivationQueue() {
  const qc = useQueryClient();
  const listQ = useQuery({ queryKey: ['pendingActivations'], queryFn: listPendingActivations });
  const items = listQ.data ?? [];
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['pendingActivations'] });
    qc.invalidateQueries({ queryKey: ['subscription'] });
    qc.invalidateQueries({ queryKey: ['entitlements'] });
    qc.invalidateQueries({ queryKey: ['usage'] });
    qc.invalidateQueries({ queryKey: ['manualActivation'] });
  };

  const approveMut = useMutation({
    mutationFn: (r: ManualActivationRequestView) => {
      const paymentReference = (refs[r.id] ?? '').trim();
      if (!paymentReference) throw new Error('Ingresá la referencia de pago para aprobar.');
      return approveActivation(r.tenantId, r.id, paymentReference);
    },
    onSuccess: refreshAll,
    onError: (e) => setErr(e instanceof Error ? e.message : 'No se pudo aprobar.'),
  });

  const cancelMut = useMutation({
    mutationFn: (r: ManualActivationRequestView) => cancelActivation(r.tenantId, r.id, 'Cancelada por el administrador'),
    onSuccess: refreshAll,
    onError: (e) => setErr(e instanceof Error ? e.message : 'No se pudo cancelar.'),
  });

  const card = 'rounded-2xl border border-ink-100 bg-white p-5 shadow-soft';
  const fmt = (r: ManualActivationRequestView) => {
    const d = r.requestedAt?.toDate?.();
    return d ? d.toLocaleString('es-PY') : '—';
  };

  return (
    <section className={card}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-ink-900">Solicitudes de activación manual <span className="text-ink-400">(admin)</span></h2>
        <button onClick={() => listQ.refetch()} className="text-xs font-semibold text-mint-700 hover:underline">Actualizar</button>
      </div>

      {listQ.isError && <p className="mt-3 text-sm text-coral-700">No se pudieron cargar las solicitudes.</p>}
      {listQ.isSuccess && items.length === 0 && <p className="mt-3 text-sm text-ink-500">No hay solicitudes pendientes.</p>}
      {err && <p aria-live="polite" className="mt-3 text-xs text-coral-700">{err}</p>}

      <div className="mt-3 space-y-3">
        {items.map((r) => {
          const plan = planById(r.planId);
          const busy = (approveMut.isPending && approveMut.variables?.id === r.id) || (cancelMut.isPending && cancelMut.variables?.id === r.id);
          return (
            <div key={`${r.tenantId}/${r.id}`} className="rounded-xl border border-ink-100 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div>
                  <span className="font-semibold text-ink-900">{r.tenantId}</span>
                  <span className="mx-2 text-ink-300">·</span>
                  <span className="text-ink-700">{plan?.name ?? r.planId}</span>
                  {plan && !plan.customPrice && <span className="text-ink-400"> (USD {plan.priceUsdPerMonth}/mes)</span>}
                </div>
                <div className="text-xs text-ink-400">{r.method} · {fmt(r)}</div>
              </div>
              {r.note && <p className="mt-1 text-xs text-ink-500">Nota: {r.note}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={refs[r.id] ?? ''}
                  onChange={(e) => setRefs((s) => ({ ...s, [r.id]: e.target.value }))}
                  placeholder="Referencia de pago *"
                  className="min-w-[12rem] flex-1 rounded-xl border border-ink-200 px-3 py-1.5 text-sm focus:border-mint-400 focus:outline-none"
                />
                <button
                  onClick={() => { setErr(null); approveMut.mutate(r); }}
                  disabled={busy}
                  className="rounded-full bg-mint-600 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
                >
                  Aprobar
                </button>
                <button
                  onClick={() => { setErr(null); cancelMut.mutate(r); }}
                  disabled={busy}
                  className="rounded-full border border-ink-200 px-4 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-60"
                >
                  Cancelar
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
