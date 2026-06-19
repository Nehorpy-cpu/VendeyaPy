/**
 * Medidor de uso vs límite (barra de progreso accesible). Maneja "ilimitado",
 * y colorea según cercanía al tope (mint → ámbar → coral).
 */
import { cn } from '@/lib/cn';
import { isUnlimited } from '@/lib/entitlements';

function fmt(n: number) {
  return n.toLocaleString('es-PY');
}

export function UsageMeter({
  label,
  used,
  limit,
  hint,
  className,
}: {
  label: string;
  used: number;
  limit: number;
  hint?: string;
  className?: string;
}) {
  const unlimited = isUnlimited(limit);
  // limit <= 0 = la métrica no está incluida en el plan (p.ej. ad syncs/IA en FREE),
  // NO un tope alcanzado.
  const notIncluded = !unlimited && limit <= 0;
  const pct = unlimited || notIncluded ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const over = !unlimited && !notIncluded && used >= limit;
  const near = !unlimited && !notIncluded && !over && pct >= 80;

  const barColor = over ? 'bg-coral-500' : near ? 'bg-amber-400' : 'bg-mint-500';
  const valueColor = over ? 'text-coral-600' : near ? 'text-amber-700' : 'text-ink-900';
  const ariaNow = unlimited || notIncluded ? undefined : Math.min(used, limit);

  return (
    <div className={cn('rounded-2xl border border-ink-100 bg-white p-4 shadow-soft', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-ink-600">{label}</span>
        <span className={cn('text-sm font-semibold tabular-nums', notIncluded ? 'text-ink-300' : valueColor)}>
          {notIncluded ? (
            '—'
          ) : (
            <>
              {fmt(used)}
              <span className="font-normal text-ink-400"> / {unlimited ? '∞' : fmt(limit)}</span>
            </>
          )}
        </span>
      </div>
      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-ink-50"
        role="progressbar"
        aria-valuenow={ariaNow}
        aria-valuemin={0}
        aria-valuemax={unlimited || notIncluded ? undefined : limit}
        aria-label={label}
      >
        {unlimited ? (
          <div className="h-full w-1/3 rounded-full bg-mint-300/70" />
        ) : notIncluded ? null : (
          <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${Math.max(2, pct)}%` }} />
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-xs text-ink-400">
          {hint ?? (notIncluded ? 'No incluido en tu plan' : unlimited ? 'Sin límite' : `${pct}% usado`)}
        </span>
        {over && <span className="text-xs font-semibold text-coral-600">Límite alcanzado</span>}
        {near && <span className="text-xs font-semibold text-amber-700">Cerca del tope</span>}
      </div>
    </div>
  );
}
