'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  PLAN_CATALOG,
  planById,
  MANUAL_METHODS,
  getMyActivationRequest,
  requestManualActivation,
  buildWhatsappUrl,
  cancelActivation,
} from '@/lib/entitlements';

/**
 * Panel del cliente (owner/admin) para SOLICITAR la activación de un plan por WhatsApp.
 * El owner NUNCA activa: solo crea la solicitud (pending) y abre WhatsApp. La activación la
 * confirma el PLATFORM_ADMIN tras el pago. Muestra el estado de la última solicitud.
 */
export function ManualActivationPanel({ tenantId, currentPlanId }: { tenantId: string; currentPlanId: string }) {
  const qc = useQueryClient();
  const reqQ = useQuery({ queryKey: ['manualActivation', tenantId], queryFn: () => getMyActivationRequest(tenantId), enabled: !!tenantId });
  const req = reqQ.data ?? null;

  const choices = PLAN_CATALOG.filter((p) => p.id !== 'free' && p.id !== currentPlanId);
  const [planId, setPlanId] = useState('');
  const [method, setMethod] = useState(MANUAL_METHODS[0]!.id);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['manualActivation', tenantId] });

  const requestMut = useMutation({
    mutationFn: () => {
      const target = planId || choices[0]?.id;
      if (!target) throw new Error('Elegí un plan.');
      return requestManualActivation(tenantId, target, method, note.trim() || undefined);
    },
    onSuccess: (res) => {
      const url = buildWhatsappUrl(res.whatsappText);
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
        setMsg('Abrimos WhatsApp con tu solicitud. Cuando confirmemos el pago, activamos el plan.');
      } else {
        setMsg('Tu solicitud quedó registrada, pero falta configurar el número de soporte (NEXT_PUBLIC_SUPPORT_WHATSAPP). Escribinos para coordinar el pago.');
      }
      invalidate();
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'No se pudo crear la solicitud.'),
  });

  const cancelMut = useMutation({
    mutationFn: () => cancelActivation(tenantId, req!.id, 'Cancelada por el solicitante'),
    onSuccess: () => { setMsg('Solicitud cancelada.'); invalidate(); },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'No se pudo cancelar.'),
  });

  const card = 'rounded-2xl border border-ink-100 bg-white p-5 shadow-soft';
  const field = 'w-full rounded-xl border border-ink-200 px-3 py-2 text-sm focus:border-mint-400 focus:outline-none';

  // Estado: solicitud pendiente → no permitir duplicar.
  if (req?.status === 'pending') {
    const plan = planById(req.planId);
    return (
      <div className={card}>
        <h2 className="text-base font-bold text-ink-900">Activación por WhatsApp</h2>
        <div className="mt-3 rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
          <strong>Solicitud enviada.</strong> Pediste activar <strong>{plan?.name ?? req.planId}</strong> (pago por {req.method}).
          Esperando que confirmemos el pago para activar el plan.
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={() => cancelMut.mutate()}
            disabled={cancelMut.isPending}
            className="rounded-full border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-60"
          >
            {cancelMut.isPending ? 'Cancelando…' : 'Cancelar solicitud'}
          </button>
        </div>
        {msg && <p aria-live="polite" className="mt-3 text-xs text-ink-500">{msg}</p>}
      </div>
    );
  }

  // Sin pendiente: formulario para solicitar (mostrando aviso si la última fue cancelada).
  return (
    <div className={card}>
      <h2 className="text-base font-bold text-ink-900">Cambiar de plan</h2>
      <p className="mt-0.5 text-sm text-ink-500">
        Elegí un plan y solicitá la activación por WhatsApp. Coordinamos el pago (transferencia, depósito o giro) y activamos tu plan.
      </p>
      {req?.status === 'cancelled' && (
        <p className="mt-2 text-xs text-ink-400">Tu solicitud anterior fue cancelada. Podés enviar una nueva.</p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">Plan</label>
          <select className={field} value={planId || choices[0]?.id || ''} onChange={(e) => setPlanId(e.target.value)}>
            {choices.length === 0 && <option value="">Sin planes disponibles</option>}
            {choices.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.customPrice ? ' (a medida)' : ` — USD ${p.priceUsdPerMonth}/mes`}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">Método de pago</label>
          <select className={field} value={method} onChange={(e) => setMethod(e.target.value)}>
            {MANUAL_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-ink-600">Nota (opcional)</label>
          <input className={field} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Algún detalle para el equipo…" />
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => { setMsg(null); requestMut.mutate(); }}
          disabled={requestMut.isPending || choices.length === 0}
          className="rounded-full bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
        >
          {requestMut.isPending ? 'Enviando…' : '📲 Solicitar por WhatsApp'}
        </button>
      </div>
      {msg && <p aria-live="polite" className="mt-3 text-xs text-ink-500">{msg}</p>}
    </div>
  );
}
