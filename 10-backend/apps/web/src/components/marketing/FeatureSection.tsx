/**
 * Sección de features/beneficios reutilizable: encabezado + grilla de tarjetas.
 * Una sola capa de tarjeta (sin cards dentro de cards). Tono claro u oscuro.
 */
import { cn } from '@/lib/cn';
import { Reveal } from './Reveal';
import { SectionHeading } from './ui';

export interface Feature {
  icon: React.ReactNode;
  title: string;
  description: string;
  accent?: 'mint' | 'ink' | 'coral' | 'amber';
}

const ICON_ACCENTS = {
  mint: 'bg-mint-50 text-mint-600',
  ink: 'bg-ink-50 text-ink-700',
  coral: 'bg-coral-50 text-coral-600',
  amber: 'bg-amber-50 text-amber-700',
} as const;

const ICON_ACCENTS_DARK = {
  mint: 'bg-mint-400/15 text-mint-300',
  ink: 'bg-white/10 text-ink-100',
  coral: 'bg-coral-400/15 text-coral-300',
  amber: 'bg-amber-400/15 text-amber-300',
} as const;

export function FeatureSection({
  eyebrow,
  title,
  description,
  features,
  columns = 3,
  tone = 'light',
  align = 'center',
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  features: Feature[];
  columns?: 2 | 3 | 4;
  tone?: 'light' | 'dark';
  align?: 'center' | 'left';
  className?: string;
}) {
  const dark = tone === 'dark';
  const gridCols =
    columns === 2
      ? 'sm:grid-cols-2'
      : columns === 4
        ? 'sm:grid-cols-2 lg:grid-cols-4'
        : 'sm:grid-cols-2 lg:grid-cols-3';

  return (
    <div className={cn('flex flex-col gap-12', className)}>
      <SectionHeading
        eyebrow={eyebrow}
        title={title}
        description={description}
        tone={tone}
        align={align}
        className={align === 'center' ? 'mx-auto' : ''}
      />
      <div className={cn('grid grid-cols-1 gap-4 sm:gap-5', gridCols)}>
        {features.map((f, i) => (
          <Reveal key={f.title} delay={i * 70}>
            <div
              className={cn(
                'flex h-full flex-col gap-3 rounded-2xl border p-5 transition-all duration-200',
                dark
                  ? 'border-white/10 bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.06]'
                  : 'border-ink-100 bg-white shadow-soft hover:-translate-y-0.5 hover:shadow-card',
              )}
            >
              <span
                className={cn(
                  'grid h-11 w-11 place-items-center rounded-xl',
                  dark
                    ? ICON_ACCENTS_DARK[f.accent ?? 'mint']
                    : ICON_ACCENTS[f.accent ?? 'mint'],
                )}
              >
                {f.icon}
              </span>
              <h3 className={cn('text-base font-semibold', dark ? 'text-white' : 'text-ink-900')}>
                {f.title}
              </h3>
              <p className={cn('text-sm leading-relaxed', dark ? 'text-ink-200' : 'text-ink-500')}>
                {f.description}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}
