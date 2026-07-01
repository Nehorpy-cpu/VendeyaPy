'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listPendingWhatsappRequests, cancelWhatsappActivation, type WhatsappActivationRequestView } from '@/lib/whatsapp-activation';

/**
 * Bandeja del PLATFORM_ADMIN: solicitudes de activación de WhatsApp PENDIENTES de todas las empresas
 * (collectionGroup). "Cargar conexión" prellena el form de abajo con la empresa + requestId; "Cancelar"
 * usa cancelWhatsappActivationRequest. SOLO se renderiza para PLATFORM_ADMIN (gate en la page).
 */
const card = 'rounded-2xl border border-ink-100 bg-white p-5 shadow-soft';

export function WhatsappActivationQueue({
  onLoad,
}: {
  onLoad: (r: { tenantId: string; requestId: string; businessName: string | null }) => void;
}) {
  const qc = useQueryClient();
  const listQ = useQuery({ queryKey: ['pendingWhatsappActivations'], queryFn: listPendingWhatsappRequests });
  const items = listQ.data ?? [];

  const cancelMut = useMutation({
    mutationFn: (r: WhatsappActivationRequestView) => cancelWhatsappActivation({ tenantId: r.tenantId, requestId: r.id, reason: 'Cancelada por el administrador' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pendingWhatsappActivations'] }),
  });

  const fmt = (r: WhatsappActivationRequestView) => {
    const d = r.requestedAt?.toDate?.();
    return d ? d.toLocaleString('es-PY') : '—';
  };

  return (
    <section className={card}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-ink-900">Solicitudes de activación de WhatsApp <span className="text-ink-400">(admin)</span></h2>
        <button onClick={() => listQ.refetch()} className="text-xs font-semibold text-mint-700 hover:underline">Actualizar</button>
      </div>

      {listQ.isError && <p className="mt-3 text-sm text-coral-700">No se pudieron cargar las solicitudes.</p>}
      {listQ.isSuccess && items.length === 0 && <p className="mt-3 text-sm text-ink-500">No hay solicitudes pendientes.</p>}

      <div className="mt-3 space-y-3">
        {items.map((r) => {
          const busy = cancelMut.isPending && cancelMut.variables?.id === r.id;
          return (
            <div key={`${r.tenantId}/${r.id}`} className="rounded-xl border border-ink-100 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div>
                  <span className="font-semibold text-ink-900">{r.businessName || r.tenantId}</span>
                  <span className="mx-2 text-ink-300">·</span>
                  <span className="text-ink-500">{r.tenantId}</span>
                </div>
                <div className="text-xs text-ink-400">{fmt(r)}</div>
              </div>
              {r.contactPhone && <p className="mt-1 text-xs text-ink-500">Contacto: {r.contactPhone}</p>}
              {r.note && <p className="mt-1 text-xs text-ink-500">Nota: {r.note}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => onLoad({ tenantId: r.tenantId, requestId: r.id, businessName: r.businessName })}
                  className="rounded-full bg-mint-600 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-mint-700"
                >
                  Cargar conexión
                </button>
                <button
                  onClick={() => cancelMut.mutate(r)}
                  disabled={busy}
                  className="rounded-full border border-ink-200 px-4 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-60"
                >
                  {busy ? 'Cancelando…' : 'Cancelar'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
