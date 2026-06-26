import { cn } from '@/lib/cn';

/** Estado vacío honesto y útil: ícono opcional + título + explicación + acción opcional. */
export function EmptyState({
  icon,
  title,
  text,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  text?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 rounded-2xl border border-dashed border-ink-200 bg-white px-6 py-12 text-center', className)}>
      {icon && <span className="grid h-12 w-12 place-items-center rounded-2xl bg-ink-50 text-ink-400">{icon}</span>}
      <div>
        <h3 className="text-sm font-semibold text-ink-800">{title}</h3>
        {text && <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">{text}</p>}
      </div>
      {action}
    </div>
  );
}
