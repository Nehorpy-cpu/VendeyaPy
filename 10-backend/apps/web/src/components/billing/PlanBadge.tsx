/**
 * Badge del tier de plan. Reutilizable en header, billing y gates.
 */
import type { PlanTier } from '@vpw/shared';
import { cn } from '@/lib/cn';

const TIER_STYLE: Record<PlanTier, { label: string; cls: string }> = {
  FREE: { label: 'Free', cls: 'bg-ink-100 text-ink-600' },
  STARTER: { label: 'Starter', cls: 'bg-mint-50 text-mint-700 ring-1 ring-inset ring-mint-200' },
  GROWTH: { label: 'Growth', cls: 'bg-mint-brand text-white' },
  PRO: { label: 'Pro', cls: 'bg-ink-900 text-white' },
  ENTERPRISE: { label: 'Enterprise', cls: 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200' },
};

export function PlanBadge({ tier, className }: { tier: PlanTier; className?: string }) {
  const s = TIER_STYLE[tier];
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold', s.cls, className)}>
      {s.label}
    </span>
  );
}
