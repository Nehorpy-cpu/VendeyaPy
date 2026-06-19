'use client';

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth-context';
import { useActiveCompany } from '@/lib/active-company';
import {
  resolveEntitlements,
  getUsage,
  getSubscription,
  planById,
  hasFeature,
  FEATURE_LABELS,
  type PlanFeatureKey,
  type ResolvedEntitlements,
} from '@/lib/entitlements';
import { SubscriptionCard } from '@/components/billing/SubscriptionCard';
import { UsageMeter } from '@/components/billing/UsageMeter';
import { PlanComparison } from '@/components/billing/PlanComparison';
import { UpgradeCTA } from '@/components/billing/UpgradeCTA';
import { PlanGate } from '@/components/billing/PlanGate';
import { PlanBadge } from '@/components/billing/PlanBadge';
import { ManualActivationPanel } from '@/components/billing/ManualActivationPanel';
import { AdminActivationQueue } from '@/components/billing/AdminActivationQueue';
import { CheckIcon } from '@/components/marketing/icons';

const FEATURE_ORDER: PlanFeatureKey[] = [
  'multiChannel',
  'marketingAutomation',
  'electronicInvoicing',
  'aiAssistant',
  'bancard',
  'prioritySupport',
];

export default function BillingPage() {
  const { claims } = useAuth();
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const canSee = claims.role === 'TENANT_OWNER' || claims.role === 'PLATFORM_ADMIN';

  const entQ = useQuery({
    queryKey: ['entitlements', tenantId],
    queryFn: () => resolveEntitlements(tenantId!),
    enabled: !!tenantId && canSee,
  });
  const ent = entQ.data ?? null;

  const usageQ = useQuery({
    queryKey: ['usage', tenantId],
    queryFn: () => getUsage(tenantId!, ent!),
    enabled: !!tenantId && canSee && !!ent,
  });
  const subQ = useQuery({
    queryKey: ['subscription', tenantId],
    queryFn: () => getSubscription(tenantId!),
    enabled: !!tenantId && canSee,
  });

  const plan = ent ? planById(ent.planId) : undefined;

  const entLoading = !!tenantId && canSee && entQ.isPending;
  const entError = !!tenantId && canSee && entQ.isError;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Plan y facturación</h1>
          {plan && <PlanBadge tier={plan.tier} />}
        </div>
        <p className="text-sm text-ink-500">Tu plan, consumo del mes, estado de la suscripción y opciones para crecer.</p>
      </div>

      {/* Bandeja del Super Admin: solicitudes de activación manual de todas las empresas. */}
      {claims.role === 'PLATFORM_ADMIN' && <AdminActivationQueue />}

      {!canSee && (
        <EmptyCard
          title="Sección solo para dueños"
          text="El plan y la facturación los administra el dueño de la empresa (o el administrador de plataforma)."
        />
      )}

      {canSee && companyLoading && <SkeletonGrid />}

      {canSee && !companyLoading && !tenantId && (
        <EmptyCard title="Seleccioná una empresa" text="Elegí una empresa en la barra superior para ver su plan y consumo." />
      )}

      {canSee && !companyLoading && tenantId && entError && (
        <ErrorCard text="No se pudo cargar tu plan y facturación." onRetry={() => { entQ.refetch(); subQ.refetch(); }} />
      )}

      {canSee && !companyLoading && tenantId && entLoading && <SkeletonGrid />}

      {canSee && tenantId && ent && plan && (
        <>
          {/* Alerta de postura si premium está en pausa/suspendido */}
          {!ent.posture.premiumAllowed && (
            <div className="rounded-xl border border-coral-200 bg-coral-50 px-4 py-3 text-sm text-coral-700">
              <strong>{ent.posture.label}.</strong> {ent.posture.description}
            </div>
          )}

          {subQ.data && <SubscriptionCard subscription={subQ.data} posture={ent.posture} plan={plan} />}

          {/* Solicitar cambio/activación de plan por WhatsApp (activación manual la confirma el admin). */}
          <ManualActivationPanel tenantId={tenantId} currentPlanId={ent.planId} />

          {/* Uso del mes */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Uso del período</h2>
            {usageQ.isError ? (
              <ErrorCard text="No se pudo cargar el consumo del período." onRetry={() => usageQ.refetch()} />
            ) : usageQ.data ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {usageQ.data.items.map((u) => (
                  <UsageMeter key={u.metric} label={u.label} used={u.used} limit={u.limit} />
                ))}
              </div>
            ) : (
              <SkeletonGrid rows={6} />
            )}
          </section>

          {/* Features del plan */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Incluido en tu plan</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {FEATURE_ORDER.map((f) => (
                <FeatureRow key={f} label={FEATURE_LABELS[f]} on={ent.features[f]} />
              ))}
            </div>
          </section>

          {/* Ejemplo de estado bloqueado por plan (área "estados bloqueados") */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Funciones premium</h2>
            <PlanGate
              allowed={hasFeature(ent, 'electronicInvoicing')}
              title="Facturación electrónica"
              requiredPlanLabel="Growth"
              mode="block"
            >
              <PremiumPanelDemo ent={ent} />
            </PlanGate>
          </section>

          {/* Upgrade + comparativa */}
          {plan.tier !== 'PRO' && plan.tier !== 'ENTERPRISE' && (
            <UpgradeCTA
              tone="solid"
              title="¿Llegando al tope de tu plan?"
              description="Pasá a un plan superior y desbloqueá más mensajes, usuarios y funciones."
            />
          )}

          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Comparar planes</h2>
            <PlanComparison currentPlanId={ent.planId} />
          </section>
        </>
      )}
    </div>
  );
}

/* -------------------------------- helpers -------------------------------- */

function FeatureRow({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-ink-100 bg-white px-3.5 py-2.5 text-sm">
      <span
        className={
          'grid h-6 w-6 shrink-0 place-items-center rounded-lg ' +
          (on ? 'bg-mint-50 text-mint-600' : 'bg-ink-50 text-ink-300')
        }
      >
        {on ? <CheckIcon className="h-3.5 w-3.5" /> : <span className="text-xs">–</span>}
      </span>
      <span className={on ? 'text-ink-700' : 'text-ink-400'}>{label}</span>
    </div>
  );
}

function PremiumPanelDemo({ ent }: { ent: ResolvedEntitlements }) {
  return (
    <div className="rounded-2xl border border-ink-100 bg-white p-5 shadow-soft">
      <h3 className="text-sm font-semibold text-ink-900">Facturación electrónica</h3>
      <p className="mt-1 text-sm text-ink-500">
        Emití comprobantes fiscales automáticos por cada venta. Disponible en tu plan ({ent.tier}).
      </p>
    </div>
  );
}

function EmptyCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-ink-200 bg-white px-6 py-12 text-center">
      <h3 className="text-sm font-semibold text-ink-800">{title}</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">{text}</p>
    </div>
  );
}

function ErrorCard({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-coral-200 bg-coral-50 px-6 py-8 text-center">
      <p className="text-sm font-medium text-coral-700">{text}</p>
      <button
        onClick={onRetry}
        className="rounded-full border border-coral-300 bg-white px-4 py-2 text-sm font-semibold text-coral-700 transition-colors hover:bg-coral-100"
      >
        Reintentar
      </button>
    </div>
  );
}

function SkeletonGrid({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-24 animate-pulse rounded-2xl border border-ink-100 bg-ink-50/60" />
      ))}
    </div>
  );
}
