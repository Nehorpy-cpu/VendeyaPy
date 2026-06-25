/**
 * Sección de planes. Tres etapas con el plan recomendado destacado.
 * CTA configurable (por defecto, agendar demo). Una sola capa de tarjeta.
 */
import { cn } from '@/lib/cn';
import { Reveal } from './Reveal';
import { SectionHeading, Button } from './ui';
import { CheckIcon } from './icons';

export interface PricingPlan {
  name: string;
  tagline: string;
  price: string;
  period?: string;
  features: string[];
  cta: string;
  href: string;
  featured?: boolean;
}

// Matriz comercial REAL (PLAN-LIMITS-2/2B). Solo features que existen hoy: WhatsApp, catálogo/pedidos,
// asistente IA, atribución de Meta Ads, y marketing/automatización (Pro+). No prometer pagos online,
// facturación electrónica, multicanal IG/Messenger ni soporte prioritario (en desarrollo).
const DEFAULT_PLANS: PricingPlan[] = [
  {
    name: 'Básico',
    tagline: 'Para empezar a vender por WhatsApp sin perder pedidos.',
    price: '₲ 150.000',
    period: '/mes',
    features: ['1 número de WhatsApp', 'Catálogo, pedidos y bot con asistente IA', 'Hasta 5 usuarios', 'Atribución de tus anuncios de Meta', 'Métricas de ventas y ganancia'],
    cta: 'Empezar',
    href: '#demo',
  },
  {
    name: 'Pro',
    tagline: 'Atribución real y automatización: qué campaña deja ganancia, no solo clics.',
    price: '₲ 350.000',
    period: '/mes',
    features: [
      'Todo lo de Básico',
      'Hasta 3 números de WhatsApp',
      'Marketing y automatización (seguimientos)',
      'Tracking propio (cupones / QR)',
      'Hasta 15 usuarios con historial',
    ],
    cta: 'Agendar demo',
    href: '#demo',
    featured: true,
  },
  {
    name: 'Max',
    tagline: 'Alto volumen para negocios consolidados.',
    price: '₲ 650.000',
    period: '/mes',
    features: ['Todo lo de Pro', 'Hasta 10 números de WhatsApp', 'Hasta 50 usuarios', 'Mayor volumen de mensajes y tokens de IA', 'Reportes de ganancia por campaña'],
    cta: 'Hablar con ventas',
    href: '#demo',
  },
];

export function PricingSection({
  plans = DEFAULT_PLANS,
  className,
}: {
  plans?: PricingPlan[];
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-12', className)}>
      <SectionHeading
        eyebrow="Planes para cada etapa"
        title="Empezá gratis, escalá cuando vendas más"
        description="Probá con el plan gratis. Sin permanencia, cambiás de plan cuando tu operación lo pide. Precios en guaraníes, facturación mensual."
      />
      <div className="grid grid-cols-1 items-stretch gap-5 md:grid-cols-3">
        {plans.map((plan, i) => (
          <Reveal key={plan.name} delay={i * 80} className="h-full">
            <div
              className={cn(
                'flex h-full flex-col rounded-3xl border p-6 transition-all duration-200',
                plan.featured
                  ? 'border-transparent bg-ink-deep text-white shadow-float ring-1 ring-mint-400/30 lg:-translate-y-2'
                  : 'border-ink-100 bg-white text-ink-900 shadow-soft hover:shadow-card',
              )}
            >
              <div className="flex items-center justify-between">
                <h3 className={cn('text-lg font-bold', plan.featured ? 'text-white' : 'text-ink-900')}>
                  {plan.name}
                </h3>
                {plan.featured && (
                  <span className="rounded-full bg-mint-brand px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wide text-white">
                    Recomendado
                  </span>
                )}
              </div>
              <p className={cn('mt-2 min-h-[2.5rem] text-sm leading-snug', plan.featured ? 'text-ink-100' : 'text-ink-500')}>
                {plan.tagline}
              </p>
              <div className="mt-5 flex items-end gap-1">
                <span className={cn('text-3xl font-bold tracking-tight', plan.featured ? 'text-white' : 'text-ink-900')}>
                  {plan.price}
                </span>
                {plan.period && (
                  <span className={cn('pb-1 text-sm', plan.featured ? 'text-ink-200' : 'text-ink-400')}>
                    {plan.period}
                  </span>
                )}
              </div>
              <ul className="mt-6 flex flex-1 flex-col gap-3">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm">
                    <span
                      className={cn(
                        'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full',
                        plan.featured ? 'bg-mint-400/20 text-mint-300' : 'bg-mint-50 text-mint-600',
                      )}
                    >
                      <CheckIcon className="h-3 w-3" />
                    </span>
                    <span className={plan.featured ? 'text-ink-100' : 'text-ink-600'}>{f}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-7">
                <Button
                  href={plan.href}
                  variant={plan.featured ? 'primary' : 'secondary'}
                  size="md"
                  className="w-full"
                  withArrow={plan.featured}
                >
                  {plan.cta}
                </Button>
              </div>
            </div>
          </Reveal>
        ))}
      </div>

      {/* Prueba gratis + Enterprise: completan la matriz real sin sumar otra tarjeta. */}
      <div className="flex flex-col items-center justify-between gap-3 rounded-2xl border border-ink-100 bg-ink-50/40 p-5 text-center sm:flex-row sm:text-left">
        <p className="text-sm text-ink-600">
          <span className="font-semibold text-ink-900">Prueba gratis de 7 días</span> para arrancar ·{' '}
          <span className="font-semibold text-ink-900">Enterprise</span> a medida: multiempresa y límites por acuerdo.
        </p>
        <a href="#demo" className="shrink-0 text-sm font-semibold text-mint-700 hover:text-mint-600">
          Hablar con ventas →
        </a>
      </div>
    </div>
  );
}
