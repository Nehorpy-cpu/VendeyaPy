/**
 * Átomos visuales reutilizables del sistema de marketing.
 * Sin estado: se pueden usar en server components.
 */
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { ArrowRightIcon } from './icons';

/* ---------------------------------- Logo --------------------------------- */

export function Logo({
  tone = 'dark',
  className,
  href = '/',
}: {
  tone?: 'dark' | 'light';
  className?: string;
  href?: string | null;
}) {
  const content = (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/isotype.png" alt="" width={36} height={36} className="h-9 w-9 shrink-0 rounded-xl shadow-glow" />
      <span
        className={cn(
          'text-lg font-bold tracking-tight',
          tone === 'dark' ? 'text-ink-900' : 'text-white',
        )}
      >
        Vende<span className={tone === 'dark' ? 'text-mint-600' : 'text-mint-300'}>Ya</span>Py
      </span>
    </span>
  );
  if (href === null) return content;
  return (
    <Link href={href} className="inline-flex" aria-label="VendeYaPy — inicio">
      {content}
    </Link>
  );
}

/* --------------------------------- Button -------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'white';
type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-mint-brand text-white shadow-glow hover:brightness-[1.05] hover:-translate-y-0.5 focus-visible:ring-mint-500',
  secondary:
    'border border-ink-200 bg-white text-ink-800 hover:border-ink-300 hover:bg-ink-50 focus-visible:ring-ink-300',
  ghost:
    'text-ink-700 hover:bg-ink-100 focus-visible:ring-ink-300',
  white:
    'bg-white text-ink-900 shadow-card hover:-translate-y-0.5 hover:bg-white/90 focus-visible:ring-white/60',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-4 text-sm',
  md: 'h-11 px-5 text-sm',
  lg: 'h-12 px-6 text-[0.95rem]',
};

export function Button({
  children,
  href,
  variant = 'primary',
  size = 'md',
  className,
  withArrow = false,
  target,
  rel,
}: {
  children: React.ReactNode;
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  withArrow?: boolean;
  target?: string;
  rel?: string;
}) {
  const isExternal = href.startsWith('http') || href.startsWith('mailto') || href.startsWith('#');
  const classes = cn(
    'group inline-flex select-none items-center justify-center gap-2 rounded-full font-semibold outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-offset-2',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
  const inner = (
    <>
      {children}
      {withArrow && (
        <ArrowRightIcon className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
      )}
    </>
  );
  if (isExternal) {
    return (
      <a href={href} className={classes} target={target} rel={rel}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {inner}
    </Link>
  );
}

/* ------------------------------ Section atoms ---------------------------- */

export function Eyebrow({
  children,
  tone = 'light',
  className,
}: {
  children: React.ReactNode;
  tone?: 'light' | 'dark';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider',
        tone === 'light'
          ? 'bg-mint-50 text-mint-700 ring-1 ring-inset ring-mint-200'
          : 'bg-white/10 text-mint-200 ring-1 ring-inset ring-white/15',
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  tone = 'light',
  align = 'center',
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  tone?: 'light' | 'dark';
  align?: 'center' | 'left';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-4',
        align === 'center' ? 'items-center text-center' : 'items-start text-left',
        className,
      )}
    >
      {eyebrow && <Eyebrow tone={tone}>{eyebrow}</Eyebrow>}
      <h2
        className={cn(
          'max-w-2xl text-balance text-3xl font-bold tracking-tight sm:text-4xl',
          tone === 'light' ? 'text-ink-900' : 'text-white',
        )}
      >
        {title}
      </h2>
      {description && (
        <p
          className={cn(
            'max-w-2xl text-base leading-relaxed sm:text-lg',
            tone === 'light' ? 'text-ink-500' : 'text-ink-200',
          )}
        >
          {description}
        </p>
      )}
    </div>
  );
}

export function Pill({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-600 ring-1 ring-inset ring-ink-100',
        className,
      )}
    >
      {children}
    </span>
  );
}
