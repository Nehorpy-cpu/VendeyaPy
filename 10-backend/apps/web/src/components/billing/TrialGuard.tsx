'use client';

/**
 * TrialGuard — UX del free trial de 7 días (TRIAL-ENFORCEMENT-1B).
 * Envuelve el contenido del panel: muestra un banner con los días restantes / vencimiento y, cuando la
 * prueba venció, reemplaza el contenido de las rutas de USO por un estado bloqueado con CTA de activación.
 * Las rutas de billing/activación quedan accesibles (no se redirige → sin loops). El backend sigue siendo
 * la fuente de verdad del enforcement (TRIAL-ENFORCEMENT-1A); esto es solo UX para el OWNER.
 */
import { useQuery } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useActiveCompany } from '@/lib/active-company';
import { resolveEntitlements } from '@/lib/entitlements';
import { getTrialState, formatTrialStatus } from '@/lib/trial';
import { cn } from '@/lib/cn';

// Rutas accesibles aún con la prueba VENCIDA: billing/planes (activación por WhatsApp ya existente).
const ALLOWED_WHEN_EXPIRED = ['/billing'];

function LockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function TrialGuard({ children }: { children: React.ReactNode }) {
  const { tenantId } = useActiveCompany();
  const pathname = usePathname() ?? '';
  const { data: ent } = useQuery({
    queryKey: ['entitlements', tenantId],
    queryFn: () => resolveEntitlements(tenantId!),
    enabled: !!tenantId,
  });

  const src = ent ? { planId: ent.planId, isDemo: ent.isDemo, trialEndsAt: ent.trial?.endsAt } : null;
  const state = getTrialState(src);
  const text = formatTrialStatus(src);

  // Pago / suscripción activa / demo / legacy sin trial → sin banner ni bloqueo.
  if (!state.isTrial || !text) return <>{children}</>;

  const onAllowedRoute = ALLOWED_WHEN_EXPIRED.some((r) => pathname.startsWith(r));
  const blocked = state.expired && !onAllowedRoute;

  return (
    <div className="flex flex-col gap-4">
      <TrialBanner expired={state.expired} text={text} />
      {blocked ? <TrialExpiredBlock /> : children}
    </div>
  );
}

function TrialBanner({ expired, text }: { expired: boolean; text: string }) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-start gap-2 rounded-2xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between',
        expired ? 'border-coral-200 bg-coral-50 text-coral-800' : 'border-mint-200 bg-mint-50/70 text-ink-800',
      )}
    >
      <span className="text-sm font-medium">{text}</span>
      <Link
        href="/billing"
        className={cn(
          'shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all',
          expired ? 'bg-coral-600 text-white hover:brightness-105' : 'bg-mint-brand text-white shadow-glow hover:-translate-y-0.5',
        )}
      >
        {expired ? 'Activar un plan' : 'Ver planes'}
      </Link>
    </div>
  );
}

function TrialExpiredBlock() {
  return (
    <div className="grid place-items-center py-12">
      <div className="flex max-w-md flex-col items-center gap-4 rounded-3xl border border-dashed border-ink-200 bg-white px-6 py-10 text-center shadow-soft">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-ink-50 text-ink-400">
          <LockIcon className="h-6 w-6" />
        </span>
        <div>
          <h2 className="text-base font-semibold text-ink-900">Tu prueba gratis terminó</h2>
          <p className="mt-1 text-sm text-ink-500">
            Activá un plan para volver a usar la plataforma. Podés elegir y solicitar tu plan por WhatsApp en un minuto.
          </p>
        </div>
        <Link
          href="/billing"
          className="inline-flex items-center gap-1.5 rounded-full bg-mint-brand px-5 py-2.5 text-sm font-semibold text-white shadow-glow transition-all hover:-translate-y-0.5"
        >
          Ver planes y activar
        </Link>
      </div>
    </div>
  );
}
