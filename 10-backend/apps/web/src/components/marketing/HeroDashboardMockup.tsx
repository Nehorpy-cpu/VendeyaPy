/**
 * Composición de "dashboard vivo" para el hero: ventana de producto con chat
 * de WhatsApp, métricas, gráfica de ganancia y chips flotantes (pedido +
 * campaña atribuida). Profundidad por capas, glass controlado, movimiento sutil.
 */
import { cn } from '@/lib/cn';
import { AnimatedChart } from './AnimatedChart';
import { MetricCard } from './MetricCard';
import { WhatsappIcon, BagIcon, MegaphoneIcon, TrendingIcon, BotIcon, CheckIcon } from './icons';

function Bubble({ from, children }: { from: 'in' | 'bot'; children: React.ReactNode }) {
  return (
    <div className={cn('flex', from === 'bot' ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[82%] rounded-2xl px-3 py-2 text-[0.8rem] leading-snug shadow-sm',
          from === 'bot'
            ? 'rounded-br-md bg-mint-brand text-white'
            : 'rounded-bl-md bg-ink-50 text-ink-700',
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function HeroDashboardMockup({ className }: { className?: string }) {
  return (
    <div className={cn('relative', className)}>
      {/* Resplandor de fondo */}
      <div
        className="absolute -inset-6 -z-10 rounded-[2.5rem] bg-mint-brand opacity-20 blur-3xl"
        aria-hidden
      />

      {/* Ventana de producto */}
      <div className="relative overflow-hidden rounded-3xl border border-ink-100 bg-white shadow-float">
        {/* Barra superior */}
        <div className="flex items-center gap-2 border-b border-ink-100 bg-ink-50/60 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-coral-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-mint-300" />
          <span className="ml-2 text-xs font-medium text-ink-400">AI_AFG · Panel comercial</span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-mint-50 px-2 py-0.5 text-[0.65rem] font-semibold text-mint-700">
            <span className="h-1.5 w-1.5 rounded-full bg-mint-500" />
            Vista de ejemplo
          </span>
        </div>

        {/* Cuerpo */}
        <div className="grid gap-4 p-4 sm:grid-cols-5">
          {/* Chat */}
          <div className="rounded-2xl border border-ink-100 bg-white p-3 sm:col-span-2">
            <div className="mb-3 flex items-center gap-2 border-b border-ink-50 pb-2">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-[#25D366]/15 text-[#1ab358]">
                <WhatsappIcon className="h-4 w-4" />
              </span>
              <div className="leading-tight">
                <div className="text-xs font-semibold text-ink-800">Sofía · WhatsApp</div>
                <div className="text-[0.65rem] text-ink-400">Lead de Meta Ads</div>
              </div>
            </div>
            <div className="space-y-2">
              <Bubble from="in">Hola! Vi el anuncio del perfume 💛 ¿tenés stock?</Bubble>
              <Bubble from="bot">
                <span className="mb-1 flex items-center gap-1 text-[0.62rem] font-semibold text-white/80">
                  <BotIcon className="h-3 w-3" /> Bot AI_AFG
                </span>
                Sí! Llega hoy. Te armo el pedido y coordinamos el pago 👇
              </Bubble>
              <div className="flex justify-end">
                <span className="inline-flex items-center gap-1 rounded-full bg-mint-50 px-2 py-1 text-[0.65rem] font-semibold text-mint-700">
                  <CheckIcon className="h-3 w-3" /> Pedido #1042 creado
                </span>
              </div>
            </div>
          </div>

          {/* Métricas + gráfica */}
          <div className="space-y-4 sm:col-span-3">
            <div className="grid grid-cols-2 gap-3">
              <MetricCard
                label="ROAS"
                value="4.7x"
                delta="+18%"
                trend="up"
                icon={<TrendingIcon className="h-4 w-4" />}
                sublabel="vs. mes ant."
              />
              <MetricCard
                label="Ganancia"
                value="₲ 3.6M"
                delta="+9%"
                trend="up"
                accent="mint"
                icon={<BagIcon className="h-4 w-4" />}
                sublabel="margen real"
              />
            </div>
            <div className="rounded-2xl border border-ink-100 bg-white p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-semibold text-ink-700">Ganancia por semana</span>
                <span className="text-[0.65rem] font-medium text-mint-600">+24% este mes</span>
              </div>
              <div className="h-28">
                <AnimatedChart
                  id="hero"
                  tone="light"
                  data={[12, 18, 15, 24, 22, 31, 29, 38]}
                  bars={[8, 12, 10, 16, 15, 20, 18, 24]}
                  labels={['L', 'M', 'M', 'J', 'V', 'S', 'D', 'L']}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Chips flotantes (depth) — ocultos en pantallas chicas para no encimar */}
      <div className="absolute -left-5 top-24 hidden animate-float rounded-2xl border border-ink-100 bg-white px-3 py-2 shadow-float md:flex">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-mint-50 text-mint-600">
            <BagIcon className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <div className="text-[0.65rem] text-ink-400">Pedido cobrado</div>
            <div className="text-sm font-bold text-ink-900">₲ 120.000</div>
          </div>
        </div>
      </div>

      <div className="absolute -right-5 bottom-10 hidden animate-float-slow rounded-2xl border border-ink-100 bg-white px-3 py-2 shadow-float md:flex">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-ink-900 text-mint-300">
            <MegaphoneIcon className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <div className="text-[0.65rem] text-ink-400">Campaña atribuida</div>
            <div className="text-sm font-bold text-ink-900">Perfumes · Meta</div>
          </div>
        </div>
      </div>
    </div>
  );
}
