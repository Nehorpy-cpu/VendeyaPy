/**
 * Flujo de atribución: de un anuncio de Meta hasta la ganancia real.
 * Horizontal en desktop, vertical en mobile. Tono claro u oscuro.
 */
import { Fragment } from 'react';
import { cn } from '@/lib/cn';
import {
  MegaphoneIcon,
  ChatIcon,
  BagIcon,
  CardIcon,
  TrendingIcon,
  ArrowRightIcon,
} from './icons';

export interface FlowStep {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}

const DEFAULT_STEPS: FlowStep[] = [
  { icon: <MegaphoneIcon className="h-5 w-5" />, label: 'Meta Ad', value: '₲ 1.250.000', hint: 'Inversión campaña' },
  { icon: <ChatIcon className="h-5 w-5" />, label: 'Conversación', value: '312 chats', hint: 'WhatsApp + IG' },
  { icon: <BagIcon className="h-5 w-5" />, label: 'Pedido', value: '88 pedidos', hint: 'Armados por el bot' },
  { icon: <CardIcon className="h-5 w-5" />, label: 'Pago', value: '₲ 9.4M', hint: 'Ingresos cobrados' },
  { icon: <TrendingIcon className="h-5 w-5" />, label: 'Ganancia', value: '₲ 3.6M', hint: 'Margen real', },
];

export function AttributionFlow({
  steps = DEFAULT_STEPS,
  tone = 'dark',
  className,
}: {
  steps?: FlowStep[];
  tone?: 'light' | 'dark';
  className?: string;
}) {
  const dark = tone === 'dark';
  return (
    <div
      className={cn(
        'flex flex-col gap-3 lg:flex-row lg:items-stretch lg:gap-0',
        className,
      )}
    >
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        return (
          <Fragment key={step.label}>
            <div
              className={cn(
                'flex flex-1 items-center gap-3 rounded-2xl border p-4 lg:flex-col lg:items-start lg:gap-2',
                dark ? 'border-white/10 bg-white/[0.05]' : 'border-ink-100 bg-white shadow-soft',
                isLast && (dark ? 'ring-1 ring-mint-400/40' : 'ring-1 ring-mint-200'),
              )}
            >
              <span
                className={cn(
                  'grid h-10 w-10 shrink-0 place-items-center rounded-xl',
                  isLast
                    ? 'bg-mint-brand text-white shadow-glow'
                    : dark
                      ? 'bg-white/10 text-mint-300'
                      : 'bg-mint-50 text-mint-600',
                )}
              >
                {step.icon}
              </span>
              <div className="min-w-0">
                <div className={cn('text-xs font-medium', dark ? 'text-ink-200' : 'text-ink-400')}>
                  {step.label}
                </div>
                <div className={cn('truncate text-base font-bold', dark ? 'text-white' : 'text-ink-900')}>
                  {step.value}
                </div>
                <div className={cn('text-xs', dark ? 'text-ink-300' : 'text-ink-400')}>{step.hint}</div>
              </div>
            </div>

            {!isLast && (
              <div className="flex items-center justify-center px-1 py-0.5 lg:px-1.5">
                <ArrowRightIcon
                  className={cn(
                    'h-5 w-5 rotate-90 lg:rotate-0',
                    dark ? 'text-ink-300' : 'text-ink-300',
                  )}
                />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
