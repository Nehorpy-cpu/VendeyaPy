'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import {
  PLAN_CATALOG,
  isUnlimited,
  tierRank,
  planById,
  requestPlanChange,
  formatPlanPrice,
  type PlanView,
} from '@/lib/entitlements';
import { CheckIcon } from '@/components/marketing/icons';

function lim(n: number) {
  return isUnlimited(n) ? '∞' : n.toLocaleString('es-PY');
}

const KEY_FEATURES: { key: keyof PlanView['features']; label: string }[] = [
  { key: 'multiChannel', label: 'Multicanal IG/Messenger' },
  { key: 'marketingAutomation', label: 'Marketing y automatización' },
  { key: 'electronicInvoicing', label: 'Facturación electrónica' },
  { key: 'prioritySupport', label: 'Soporte prioritario' },
];

export function PlanComparison({ currentPlanId }: { currentPlanId: string }) {
  const [note, setNote] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const current = planById(currentPlanId);

  const onSelect = async (id: string) => {
    setPendingId(id);
    const res = await requestPlanChange(id); // mock: NO escribe a Firestore
    setPendingId(null);
    setNote(res.message);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {PLAN_CATALOG.map((p) => {
          const isCurrent = p.id === currentPlanId;
          const isDowngrade = current ? tierRank(p.tier) < tierRank(current.tier) : false;
          return (
            <div
              key={p.id}
              className={cn(
                'flex flex-col rounded-2xl border p-4',
                isCurrent ? 'border-mint-300 bg-mint-50/40 ring-1 ring-mint-200' : 'border-ink-100 bg-white shadow-soft',
              )}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-ink-900">{p.name}</h3>
                {p.popular && !isCurrent && (
                  <span className="rounded-full bg-mint-brand px-2 py-0.5 text-[0.6rem] font-bold uppercase text-white">Popular</span>
                )}
                {isCurrent && (
                  <span className="rounded-full bg-mint-600 px-2 py-0.5 text-[0.6rem] font-bold uppercase text-white">Actual</span>
                )}
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-2xl font-bold tracking-tight text-ink-900">{formatPlanPrice(p)}</span>
              </div>
              <p className="mt-1 min-h-[2rem] text-xs leading-snug text-ink-500">{p.description}</p>

              <dl className="mt-3 space-y-1 border-t border-ink-100 pt-3 text-xs">
                {[
                  ['Productos', lim(p.limits.maxProducts)],
                  ['Pedidos/mes', lim(p.limits.maxOrdersPerMonth)],
                  ['Mensajes WA/mes', lim(p.limits.maxWhatsappMessagesPerMonth)],
                  ['Usuarios', lim(p.limits.maxUsers)],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <dt className="text-ink-500">{k}</dt>
                    <dd className="font-semibold tabular-nums text-ink-800">{v}</dd>
                  </div>
                ))}
              </dl>

              <ul className="mt-3 space-y-1.5 border-t border-ink-100 pt-3">
                {KEY_FEATURES.map((f) => {
                  const on = p.features[f.key];
                  return (
                    <li key={f.key} className={cn('flex items-center gap-1.5 text-xs', on ? 'text-ink-700' : 'text-ink-300')}>
                      {on ? <CheckIcon className="h-3.5 w-3.5 text-mint-600" /> : <span className="grid h-3.5 w-3.5 place-items-center text-ink-300">–</span>}
                      {f.label}
                    </li>
                  );
                })}
              </ul>

              <button
                onClick={() => onSelect(p.id)}
                disabled={isCurrent || pendingId === p.id}
                className={cn(
                  'mt-4 rounded-full px-3 py-2 text-xs font-semibold transition-all disabled:cursor-default',
                  isCurrent
                    ? 'cursor-default bg-ink-50 text-ink-400'
                    : isDowngrade
                      ? 'border border-ink-200 text-ink-700 hover:bg-ink-50'
                      : 'bg-mint-brand text-white shadow-glow hover:-translate-y-0.5',
                )}
              >
                {isCurrent ? 'Plan actual' : pendingId === p.id ? 'Procesando…' : isDowngrade ? 'Cambiar a este' : p.customPrice ? 'Contactar ventas' : 'Mejorar a ' + p.name}
              </button>
            </div>
          );
        })}
      </div>

      {note && (
        <p aria-live="polite" className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
          {note}
        </p>
      )}
    </div>
  );
}
