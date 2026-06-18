/**
 * Tarjeta de métrica reutilizable (KPI). Soporta tono claro y oscuro, delta
 * con dirección, icono y un sublabel opcional. Sin estado.
 */
import { cn } from '@/lib/cn';
import { TrendingIcon } from './icons';

type Trend = 'up' | 'down' | 'neutral';

interface MetricCardProps {
  label: string;
  value: string;
  delta?: string;
  trend?: Trend;
  icon?: React.ReactNode;
  sublabel?: string;
  tone?: 'light' | 'dark';
  accent?: 'mint' | 'ink' | 'coral' | 'amber';
  className?: string;
}

const ACCENTS = {
  mint: { chip: 'bg-mint-50 text-mint-700', dot: 'text-mint-500' },
  ink: { chip: 'bg-ink-50 text-ink-700', dot: 'text-ink-500' },
  coral: { chip: 'bg-coral-50 text-coral-600', dot: 'text-coral-500' },
  amber: { chip: 'bg-amber-50 text-amber-700', dot: 'text-amber-500' },
} as const;

export function MetricCard({
  label,
  value,
  delta,
  trend = 'up',
  icon,
  sublabel,
  tone = 'light',
  accent = 'mint',
  className,
}: MetricCardProps) {
  const dark = tone === 'dark';
  const trendColor =
    trend === 'up'
      ? dark
        ? 'text-mint-300'
        : 'text-mint-600'
      : trend === 'down'
        ? dark
          ? 'text-coral-300'
          : 'text-coral-600'
        : dark
          ? 'text-ink-200'
          : 'text-ink-400';

  return (
    <div
      className={cn(
        'rounded-2xl border p-4 transition-shadow',
        dark
          ? 'border-white/10 bg-white/[0.05] hover:bg-white/[0.07]'
          : 'border-ink-100 bg-white shadow-soft hover:shadow-card',
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <span className={cn('text-xs font-medium', dark ? 'text-ink-200' : 'text-ink-400')}>
          {label}
        </span>
        {icon && (
          <span
            className={cn(
              'grid h-7 w-7 place-items-center rounded-lg',
              dark ? 'bg-white/10 text-mint-300' : ACCENTS[accent].chip,
            )}
          >
            {icon}
          </span>
        )}
      </div>
      <div className={cn('mt-2 text-2xl font-bold tracking-tight', dark ? 'text-white' : 'text-ink-900')}>
        {value}
      </div>
      <div className="mt-1 flex items-center gap-2">
        {delta && (
          <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', trendColor)}>
            <TrendingIcon className={cn('h-3.5 w-3.5', trend === 'down' && 'rotate-90')} />
            {delta}
          </span>
        )}
        {sublabel && (
          <span className={cn('text-xs', dark ? 'text-ink-300' : 'text-ink-400')}>{sublabel}</span>
        )}
      </div>
    </div>
  );
}
