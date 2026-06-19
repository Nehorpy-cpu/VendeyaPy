/**
 * CTA de upgrade reutilizable. Por defecto lleva a /billing (donde está la
 * comparativa de planes). Visual sobrio para usar dentro de gates o banners.
 */
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { SparkIcon, ArrowRightIcon } from '@/components/marketing/icons';

export function UpgradeCTA({
  title = 'Desbloqueá más con un plan superior',
  description,
  ctaLabel = 'Ver planes',
  href = '/billing',
  tone = 'soft',
  className,
}: {
  title?: string;
  description?: string;
  ctaLabel?: string;
  href?: string;
  tone?: 'soft' | 'solid';
  className?: string;
}) {
  const solid = tone === 'solid';
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-3 rounded-2xl p-4 sm:flex-row sm:items-center sm:justify-between',
        solid ? 'bg-ink-deep text-white' : 'border border-mint-200 bg-mint-50/60',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', solid ? 'bg-white/10 text-mint-300' : 'bg-mint-100 text-mint-700')}>
          <SparkIcon className="h-5 w-5" />
        </span>
        <div>
          <div className={cn('text-sm font-semibold', solid ? 'text-white' : 'text-ink-900')}>{title}</div>
          {description && <div className={cn('text-sm', solid ? 'text-ink-200' : 'text-ink-500')}>{description}</div>}
        </div>
      </div>
      <Link
        href={href}
        className={cn(
          'group inline-flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-all',
          solid ? 'bg-mint-brand text-white hover:brightness-105' : 'bg-mint-brand text-white shadow-glow hover:-translate-y-0.5',
        )}
      >
        {ctaLabel}
        <ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}
