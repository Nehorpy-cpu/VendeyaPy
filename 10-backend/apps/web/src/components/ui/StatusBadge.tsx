import { cn } from '@/lib/cn';

export type BadgeTone = 'mint' | 'ink' | 'coral' | 'amber';

const TONE: Record<BadgeTone, string> = {
  mint: 'bg-mint-50 text-mint-700',
  ink: 'bg-ink-50 text-ink-600',
  coral: 'bg-coral-50 text-coral-700',
  amber: 'bg-amber-50 text-amber-700',
};

/** Badge de estado consistente (pill con tono de marca). */
export function StatusBadge({
  tone = 'ink',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', TONE[tone], className)}>
      {children}
    </span>
  );
}
