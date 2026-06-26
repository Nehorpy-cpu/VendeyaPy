import { cn } from '@/lib/cn';

/** Placeholder de carga: N filas con pulso, consistente con las cards del panel. */
export function SkeletonList({
  rows = 4,
  className,
  rowClassName,
}: {
  rows?: number;
  className?: string;
  rowClassName?: string;
}) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={cn('h-14 animate-pulse rounded-xl border border-ink-100 bg-ink-50/60', rowClassName)} />
      ))}
    </div>
  );
}
