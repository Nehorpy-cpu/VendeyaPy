'use client';

import { useState } from 'react';
import type { SubscriptionStatus } from '@vpw/shared';
import { cn } from '@/lib/cn';
import {
  type BillingPosture,
  type PlanView,
  type SubscriptionView,
  openBillingPortal,
} from '@/lib/entitlements';
import { PlanBadge } from './PlanBadge';
import { CardIcon, ClockIcon } from '@/components/marketing/icons';

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  none: 'Sin suscripción',
  trialing: 'En prueba',
  active: 'Activa',
  past_due: 'Pago pendiente',
  canceled: 'Cancelada',
  incomplete: 'Incompleta',
};

const POSTURE_TONE: Record<BillingPosture['level'], string> = {
  ok: 'bg-mint-50 text-mint-700 ring-mint-200',
  demo: 'bg-ink-50 text-ink-600 ring-ink-200',
  grace: 'bg-amber-50 text-amber-800 ring-amber-200',
  premium_suspended: 'bg-coral-50 text-coral-700 ring-coral-200',
};

export function SubscriptionCard({
  subscription,
  posture,
  plan,
}: {
  subscription: SubscriptionView;
  posture: BillingPosture;
  plan: PlanView;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onManage = async () => {
    setBusy(true);
    const res = await openBillingPortal(); // mock: NO escribe a Firestore
    setBusy(false);
    setNote(res.message);
  };

  return (
    <div className="rounded-2xl border border-ink-100 bg-white p-5 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-mint-50 text-mint-600">
            <CardIcon className="h-5 w-5" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-ink-900">Suscripción</h2>
              <PlanBadge tier={plan.tier} />
            </div>
            <p className="mt-0.5 text-sm text-ink-500">
              Estado: <span className="font-medium text-ink-700">{STATUS_LABEL[subscription.status]}</span>
            </p>
            {subscription.currentPeriodEndLabel && (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-400">
                <ClockIcon className="h-3.5 w-3.5" />
                Próxima renovación: {subscription.currentPeriodEndLabel}
              </p>
            )}
          </div>
        </div>

        <button
          onClick={onManage}
          disabled={busy}
          className="rounded-full border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-60"
        >
          {busy ? 'Abriendo…' : 'Gestionar facturación'}
        </button>
      </div>

      <div className={cn('mt-4 rounded-xl px-3.5 py-2.5 text-sm ring-1 ring-inset', POSTURE_TONE[posture.level])}>
        <span className="font-semibold">{posture.label}.</span> {posture.description}
      </div>

      {note && (
        <p aria-live="polite" className="mt-3 rounded-xl border border-ink-100 bg-ink-50/60 px-3.5 py-2.5 text-xs text-ink-500">
          {note}
        </p>
      )}
    </div>
  );
}
