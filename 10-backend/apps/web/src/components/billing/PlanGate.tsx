/**
 * Estado "bloqueado por plan". Envuelve una feature: si el entitlement no la
 * habilita (o el billing está en pausa), muestra un bloqueo claro + CTA de upgrade.
 *
 * NOTA: esto es solo UX. La seguridad real la valida el backend (rol + plan +
 * billing + cuota). El frontend nunca decide seguridad (doc 5A).
 */
import { cn } from '@/lib/cn';
import { UpgradeCTA } from './UpgradeCTA';

function LockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PlanGate({
  allowed,
  title,
  description,
  requiredPlanLabel,
  ctaLabel = 'Mejorar plan',
  mode = 'block',
  children,
  className,
}: {
  allowed: boolean;
  title: string;
  description?: string;
  requiredPlanLabel?: string;
  ctaLabel?: string;
  mode?: 'block' | 'overlay';
  children: React.ReactNode;
  className?: string;
}) {
  if (allowed) return <>{children}</>;

  const reason =
    description ?? (requiredPlanLabel ? `Disponible desde el plan ${requiredPlanLabel}.` : 'No está incluido en tu plan actual.');

  if (mode === 'overlay') {
    return (
      <div className={cn('relative overflow-hidden rounded-2xl', className)}>
        <div className="pointer-events-none select-none opacity-40 blur-[2px]" aria-hidden>
          {children}
        </div>
        <div className="absolute inset-0 grid place-items-center bg-white/55 p-4 backdrop-blur-[1px]">
          <LockedCard title={title} reason={reason} ctaLabel={ctaLabel} />
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <LockedCard title={title} reason={reason} ctaLabel={ctaLabel} />
    </div>
  );
}

function LockedCard({ title, reason, ctaLabel }: { title: string; reason: string; ctaLabel: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-ink-200 bg-white p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink-50 text-ink-400">
          <LockIcon className="h-5 w-5" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
          <p className="mt-0.5 text-sm text-ink-500">{reason}</p>
        </div>
      </div>
      <UpgradeCTA title="Desbloquealo con un plan superior" ctaLabel={ctaLabel} />
    </div>
  );
}
