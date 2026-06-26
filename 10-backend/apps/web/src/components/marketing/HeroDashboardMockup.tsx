/**
 * "Vista de ejemplo" del panel para el hero: una ventana de producto con resumen (KPIs),
 * conversaciones, pedidos, productos destacados y una recomendación del copiloto.
 * Todo es DEMO (badge "Vista de ejemplo" en la barra superior + "ejemplo" en las tarjetas flotantes).
 * Solo WhatsApp como canal (no se insinúa IG/Messenger). Sin librerías ni datos reales.
 */
import { cn } from '@/lib/cn';
import { AnimatedChart } from './AnimatedChart';
import { WhatsappIcon, BagIcon, MegaphoneIcon, TrendingIcon, BotIcon, SparkIcon } from './icons';

/* KPI compacto del resumen. */
function Kpi({ label, value, delta, icon }: { label: string; value: string; delta: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink-100 bg-white p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[0.65rem] font-medium text-ink-400">{label}</span>
        <span className="grid h-5 w-5 place-items-center rounded-md bg-mint-50 text-mint-600">{icon}</span>
      </div>
      <div className="mt-1 text-base font-bold tracking-tight text-ink-900">{value}</div>
      <div className="mt-0.5 inline-flex items-center gap-0.5 text-[0.6rem] font-semibold text-mint-600">
        <TrendingIcon className="h-3 w-3" />
        {delta}
      </div>
    </div>
  );
}

/* Cabecera de mini-tarjeta interna. */
function CardHead({ title, tag }: { title: string; tag?: string }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <span className="text-[0.72rem] font-semibold text-ink-700">{title}</span>
      {tag && <span className="text-[0.6rem] font-medium text-ink-400">{tag}</span>}
    </div>
  );
}

const CONVERSATIONS = [
  { name: 'Sofía', preview: 'Vi el anuncio del perfume 💛', by: 'bot' as const, unread: 0 },
  { name: 'Diego', preview: '¿Hacen envío hoy?', by: 'vos' as const, unread: 2 },
];

const ORDERS = [
  { id: '#1042', item: 'Perfume Floral 50ml', amount: '₲ 220.000', status: 'Pagado', tone: 'mint' as const },
  { id: '#1041', item: 'Set Regalo Premium', amount: '₲ 480.000', status: 'Armando', tone: 'amber' as const },
];

const PRODUCTS = [
  { name: 'Perfume Floral 50ml', sold: 32, pct: 92 },
  { name: 'Set Regalo Premium', sold: 21, pct: 64 },
];

export function HeroDashboardMockup({ className }: { className?: string }) {
  return (
    <div className={cn('relative', className)}>
      {/* Halo de fondo (sutil, no orb) */}
      <div className="absolute -inset-5 -z-10 rounded-[2.75rem] bg-mint-brand opacity-[0.12] blur-3xl" aria-hidden />

      {/* Ventana de producto */}
      <div className="relative overflow-hidden rounded-3xl border border-ink-100 bg-white shadow-float">
        {/* Barra superior */}
        <div className="flex items-center gap-2 border-b border-ink-100 bg-ink-50/60 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-coral-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-mint-300" />
          <span className="ml-2 text-xs font-medium text-ink-400">VendeYaPy · Panel comercial</span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-mint-50 px-2 py-0.5 text-[0.65rem] font-semibold text-mint-700">
            <span className="h-1.5 w-1.5 rounded-full bg-mint-500" />
            Vista de ejemplo
          </span>
        </div>

        {/* Cuerpo */}
        <div className="space-y-3 bg-ink-50/30 p-3.5 sm:p-4">
          {/* Resumen */}
          <div className="grid grid-cols-3 gap-2.5">
            <Kpi label="Ventas hoy" value="18" delta="+12%" icon={<BagIcon className="h-3 w-3" />} />
            <Kpi label="Ganancia" value="₲ 3.6M" delta="+9%" icon={<SparkIcon className="h-3 w-3" />} />
            <Kpi label="ROAS" value="4.7x" delta="+18%" icon={<TrendingIcon className="h-3 w-3" />} />
          </div>

          {/* Conversaciones + Pedidos */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-ink-100 bg-white p-3">
              <CardHead title="Conversaciones" tag="WhatsApp" />
              <ul className="space-y-2">
                {CONVERSATIONS.map((c) => (
                  <li key={c.name} className="flex items-center gap-2">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#25D366]/15 text-[#1ab358]">
                      <WhatsappIcon className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.72rem] font-semibold text-ink-800">{c.name}</span>
                      <span className="block truncate text-[0.65rem] text-ink-400">{c.preview}</span>
                    </span>
                    {c.unread > 0 ? (
                      <span className="grid h-4 min-w-[1rem] place-items-center rounded-full bg-coral-500 px-1 text-[0.55rem] font-bold text-white">{c.unread}</span>
                    ) : (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-mint-50 px-1.5 py-0.5 text-[0.55rem] font-semibold text-mint-700">
                        <BotIcon className="h-2.5 w-2.5" /> bot
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-xl border border-ink-100 bg-white p-3">
              <CardHead title="Pedidos recientes" />
              <ul className="space-y-2">
                {ORDERS.map((o) => (
                  <li key={o.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.72rem] font-semibold text-ink-800">{o.item}</span>
                      <span className="block text-[0.65rem] text-ink-400">{o.id} · {o.amount}</span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-1.5 py-0.5 text-[0.55rem] font-semibold',
                        o.tone === 'mint' ? 'bg-mint-50 text-mint-700' : 'bg-amber-50 text-amber-700',
                      )}
                    >
                      {o.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Productos destacados + mini gráfica */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-ink-100 bg-white p-3">
              <CardHead title="Productos destacados" />
              <ul className="space-y-2.5">
                {PRODUCTS.map((p) => (
                  <li key={p.name}>
                    <div className="flex items-center justify-between text-[0.68rem]">
                      <span className="truncate text-ink-700">{p.name}</span>
                      <span className="shrink-0 pl-2 font-semibold text-ink-500">{p.sold} vend.</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
                      <div className="h-full rounded-full bg-mint-brand" style={{ width: `${p.pct}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-xl border border-ink-100 bg-white p-3">
              <CardHead title="Ganancia por semana" tag="+24%" />
              <div className="h-[4.5rem]">
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

          {/* Recomendación del copiloto */}
          <div className="flex items-center gap-2.5 rounded-xl border border-mint-200 bg-mint-50/70 p-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-mint-brand text-white shadow-glow">
              <SparkIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[0.6rem] font-semibold uppercase tracking-wide text-mint-700">Recomendación</div>
              <p className="text-[0.72rem] leading-snug text-ink-700">Seguí a 3 clientes que preguntaron y no compraron hoy.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Tarjetas flotantes (profundidad) — ocultas en pantallas chicas para no encimar. */}
      <div className="absolute -left-5 top-28 hidden animate-float rounded-2xl border border-ink-100 bg-white px-3 py-2 shadow-float md:flex">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-mint-50 text-mint-600">
            <BagIcon className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <div className="text-[0.6rem] text-ink-400">Pedido cobrado · ejemplo</div>
            <div className="text-sm font-bold text-ink-900">₲ 120.000</div>
          </div>
        </div>
      </div>

      <div className="absolute -right-5 bottom-12 hidden animate-float-slow rounded-2xl border border-ink-100 bg-white px-3 py-2 shadow-float md:flex">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-ink-900 text-mint-300">
            <MegaphoneIcon className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <div className="text-[0.6rem] text-ink-400">Campaña atribuida · ejemplo</div>
            <div className="text-sm font-bold text-ink-900">Perfumes · Meta</div>
          </div>
        </div>
      </div>
    </div>
  );
}
