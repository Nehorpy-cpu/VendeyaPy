import type { Metadata } from 'next';
import { MarketingHeader } from '@/components/marketing/MarketingHeader';
import { MarketingFooter } from '@/components/marketing/MarketingFooter';
import { HeroDashboardMockup } from '@/components/marketing/HeroDashboardMockup';
import { HeroBackground } from '@/components/marketing/HeroBackground';
import { AttributionFlow } from '@/components/marketing/AttributionFlow';
import { AnimatedChart } from '@/components/marketing/AnimatedChart';
import { MetricCard } from '@/components/marketing/MetricCard';
import { FeatureSection, type Feature } from '@/components/marketing/FeatureSection';
import { PricingSection } from '@/components/marketing/PricingSection';
import { CTASection } from '@/components/marketing/CTASection';
import { Reveal } from '@/components/marketing/Reveal';
import { Button, Eyebrow, SectionHeading } from '@/components/marketing/ui';
import {
  WhatsappIcon,
  InstagramIcon,
  MessengerIcon,
  BotIcon,
  ChartIcon,
  TargetIcon,
  SparkIcon,
  UsersIcon,
  ShieldIcon,
  CompassIcon,
  MegaphoneIcon,
  ChatIcon,
  BagIcon,
  TrendingIcon,
  CheckIcon,
} from '@/components/marketing/icons';

export const metadata: Metadata = {
  title: 'AI_AFG — Vendé por WhatsApp y medí la ganancia real',
  description:
    'AI_AFG conecta catálogo, bot, vendedores, pedidos y campañas para saber qué deja ganancia real. Ventas por WhatsApp con atribución de tus anuncios de Meta.',
};

/* ------------------------------ data estática ----------------------------- */

const PROBLEMS = [
  {
    icon: <ChatIcon className="h-5 w-5" />,
    title: 'Chats dispersos',
    description: 'Mensajes repartidos entre celulares y vendedores. Pedidos que se pierden y clientes sin respuesta.',
    accent: 'coral' as const,
  },
  {
    icon: <UsersIcon className="h-5 w-5" />,
    title: 'Vendedores sin trazabilidad',
    description: 'No sabés quién atendió, qué prometió ni en qué quedó cada conversación. Cero historial.',
    accent: 'amber' as const,
  },
  {
    icon: <MegaphoneIcon className="h-5 w-5" />,
    title: 'Campañas a ciegas',
    description: 'Pagás anuncios en Meta y ves clics, pero no sabés qué campaña terminó en una venta con ganancia.',
    accent: 'coral' as const,
  },
];

const PILLARS: Feature[] = [
  {
    icon: <BotIcon className="h-5 w-5" />,
    title: 'Bot que vende',
    description: 'Responde al instante, arma el pedido y coordina el pago por WhatsApp.',
    accent: 'mint',
  },
  {
    icon: <ChartIcon className="h-5 w-5" />,
    title: 'Panel unificado',
    description: 'Catálogo, pedidos, clientes y conversaciones en un solo lugar, con historial por vendedor.',
    accent: 'ink',
  },
  {
    icon: <TargetIcon className="h-5 w-5" />,
    title: 'Atribución real',
    description: 'Conecta cada anuncio con sus pedidos y su ganancia. Sabés qué campaña deja plata, no solo clics.',
    accent: 'mint',
  },
  {
    icon: <SparkIcon className="h-5 w-5" />,
    title: 'Growth Copilot',
    description: 'Sugiere seguimientos, detecta oportunidades y te arma las tareas de hoy para vender más.',
    accent: 'amber',
  },
];

const BENEFITS: Feature[] = [
  {
    icon: <WhatsappIcon className="h-5 w-5" />,
    title: 'Vendé por WhatsApp sin perder el control',
    description: 'El bot atiende 24/7 y vos seguís cada conversación desde el panel, con reglas por rol.',
    accent: 'mint',
  },
  {
    icon: <UsersIcon className="h-5 w-5" />,
    title: 'Vendedores que atienden con historial',
    description: 'Cada cliente llega con su contexto: qué compró, qué preguntó y en qué quedó la última charla.',
    accent: 'ink',
  },
  {
    icon: <TrendingIcon className="h-5 w-5" />,
    title: 'El dueño ve costo, ganancia y margen',
    description: 'No solo ingresos: el costo real de cada pedido y el margen, listo para decidir.',
    accent: 'mint',
  },
  {
    icon: <TargetIcon className="h-5 w-5" />,
    title: 'Campañas conectadas a pedidos reales',
    description: 'Atribución de Meta y tracking propio (cupones, QR) para saber qué inversión rinde.',
    accent: 'amber',
  },
  {
    icon: <CompassIcon className="h-5 w-5" />,
    title: 'Seguimiento y tareas inteligentes',
    description: 'El copiloto prioriza a quién escribir hoy para no dejar ventas enfriándose.',
    accent: 'mint',
  },
  {
    icon: <ShieldIcon className="h-5 w-5" />,
    title: 'Multiempresa y por roles',
    description: 'Pensado para crecer: varias marcas, usuarios con permisos y datos aislados por empresa.',
    accent: 'ink',
  },
];

const PROCESS_STEPS = [
  { icon: <WhatsappIcon className="h-6 w-6" />, title: 'Cliente escribe por WhatsApp', description: 'Te escribe desde tu número o desde un anuncio de Meta, y todo queda en un solo flujo.' },
  { icon: <BotIcon className="h-6 w-6" />, title: 'El bot responde con tu catálogo', description: 'Contesta al instante con tus precios y stock reales, sin hacer esperar al cliente.' },
  { icon: <BagIcon className="h-6 w-6" />, title: 'Recomienda, reserva o toma el pedido', description: 'Sugiere productos, arma el pedido y coordina el pago por WhatsApp.' },
  { icon: <ChartIcon className="h-6 w-6" />, title: 'Vos revisás ventas y próximos pasos', description: 'Desde el panel ves ventas, ganancia y a quién seguir hoy para no perder ninguna.' },
];

/* --------------------------------- página -------------------------------- */

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white text-ink-900">
      <MarketingHeader />
      <main>
        <Hero />
        <TrustStrip />
        <ProcessSection />
        <ProductSection />
        <DifferentialShowcase />

        <section className="mk-container scroll-mt-24 py-20 sm:py-24">
          <FeatureSection
            eyebrow="Lo que ganás"
            title="Más ventas, menos caos, números claros"
            description="Beneficios concretos para el dueño y para el equipo que atiende todos los días."
            features={BENEFITS}
            columns={3}
          />
        </section>

        <section id="pricing" className="mk-container scroll-mt-24 py-20 sm:py-24">
          <PricingSection />
        </section>

        <div className="pb-20 sm:pb-24">
          <CTASection />
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}

/* --------------------------------- Hero ---------------------------------- */

function Hero() {
  return (
    <section className="relative overflow-hidden bg-white">
      {/* Fondo claro: wash sutil + grilla muy tenue + red de nodos (sin orbs/blobs). */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute inset-0 bg-gradient-to-b from-mint-50/50 via-white to-white" />
        <div className="bg-grid absolute inset-0 opacity-[0.18]" />
        <HeroBackground className="absolute inset-0 opacity-70" />
        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-white" />
      </div>

      <div className="mk-container relative grid items-center gap-12 py-16 lg:grid-cols-[0.92fr_1.08fr] lg:gap-14 lg:py-24">
        <div className="flex flex-col items-start animate-fade-up">
          <Eyebrow>Ventas por WhatsApp · Atribución de Meta Ads</Eyebrow>
          <h1 className="mt-5 text-balance text-4xl font-bold leading-[1.08] tracking-tight text-ink-900 sm:text-5xl lg:text-[3.4rem]">
            Vendé más por WhatsApp con tu{' '}
            <span className="text-gradient">copiloto comercial</span>
          </h1>
          <p className="mt-5 max-w-xl text-pretty text-lg leading-relaxed text-ink-500">
            AI_AFG conecta catálogo, bot, vendedores, pedidos y campañas para saber qué canal vende y
            qué deja ganancia real.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button href="/register" variant="primary" size="lg" withArrow>
              Probar gratis
            </Button>
            <Button href="#demo" variant="secondary" size="lg">
              Agendar demo
            </Button>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink-500">
            {['Prueba gratis 7 días', 'Atribución real', 'Listo en días'].map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5">
                <CheckIcon className="h-4 w-4 text-mint-600" />
                {t}
              </span>
            ))}
          </div>
        </div>

        <div className="animate-fade-up [animation-delay:120ms]">
          <HeroDashboardMockup />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------- Trust strip ----------------------------- */

function TrustStrip() {
  const channels = [
    { icon: <WhatsappIcon className="h-5 w-5" />, label: 'WhatsApp Cloud API' },
    { icon: <MegaphoneIcon className="h-5 w-5" />, label: 'Meta Ads' },
    { icon: <InstagramIcon className="h-5 w-5" />, label: 'Instagram · próximamente' },
    { icon: <MessengerIcon className="h-5 w-5" />, label: 'Messenger · próximamente' },
  ];
  return (
    <section className="border-y border-ink-100 bg-ink-50/40">
      <div className="mk-container flex flex-col items-center gap-6 py-8 sm:flex-row sm:justify-between">
        <p className="text-sm font-medium text-ink-500">
          Vendé por WhatsApp y medí tus anuncios de Meta. Más canales en camino.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
          {channels.map((c) => (
            <span key={c.label} className="inline-flex items-center gap-2 text-sm font-semibold text-ink-700">
              <span className="text-ink-400">{c.icon}</span>
              {c.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ----------------------------- Producto (prob+sol) ------------------------ */

function ProductSection() {
  return (
    <section id="producto" className="mk-container scroll-mt-24 py-20 sm:py-24">
      <div className="flex flex-col gap-16">
        {/* Problema */}
        <div className="flex flex-col gap-10">
          <SectionHeading
            eyebrow="El problema"
            title="Vender por chat hoy es desordenado y caro"
            description="Las ventas llegan por mensaje, pero el control se pierde en el camino — y la inversión en anuncios queda sin medir."
          />
          <div className="grid grid-cols-1 gap-4 sm:gap-5 md:grid-cols-3">
            {PROBLEMS.map((p, i) => (
              <Reveal key={p.title} delay={i * 70}>
                <div className="flex h-full flex-col gap-3 rounded-2xl border border-ink-100 bg-white p-5 shadow-soft">
                  <span
                    className={
                      'grid h-11 w-11 place-items-center rounded-xl ' +
                      (p.accent === 'coral' ? 'bg-coral-50 text-coral-600' : 'bg-amber-50 text-amber-700')
                    }
                  >
                    {p.icon}
                  </span>
                  <h3 className="text-base font-semibold text-ink-900">{p.title}</h3>
                  <p className="text-sm leading-relaxed text-ink-500">{p.description}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        {/* Solución */}
        <FeatureSection
          eyebrow="La solución"
          title={<>Todo tu canal de venta, <span className="text-gradient">en un solo panel</span></>}
          description="Bot, panel, atribución y copiloto trabajando juntos: desde el primer mensaje hasta la ganancia."
          features={PILLARS}
          columns={4}
        />
      </div>
    </section>
  );
}

/* ---------------------- Diferencial: anuncio → ganancia ------------------- */

function DifferentialShowcase() {
  const metrics = [
    { label: 'ROAS', value: '4.7x', delta: '+18%', trend: 'up' as const, icon: <TrendingIcon className="h-4 w-4" /> },
    { label: 'Ventas', value: '412', delta: '+12%', trend: 'up' as const, icon: <BagIcon className="h-4 w-4" /> },
    { label: 'Ingresos', value: '₲ 47.8M', delta: '+15%', trend: 'up' as const, icon: <ChartIcon className="h-4 w-4" /> },
    { label: 'Ganancia', value: '₲ 18.3M', delta: '+9%', trend: 'up' as const, icon: <SparkIcon className="h-4 w-4" /> },
    { label: 'Conversaciones', value: '1.284', delta: '+22%', trend: 'up' as const, icon: <ChatIcon className="h-4 w-4" /> },
  ];

  return (
    <section id="diferencial" className="scroll-mt-24 py-20 sm:py-24">
      <div className="mk-container">
        <div className="relative overflow-hidden rounded-[2rem] bg-ink-deep p-6 sm:p-10 lg:p-14">
          <div className="bg-grid-dark absolute inset-0 opacity-50" aria-hidden />
          <div
            className="absolute -left-20 top-10 h-72 w-72 rounded-full bg-mint-brand opacity-20 blur-3xl"
            aria-hidden
          />
          <div className="relative flex flex-col gap-10">
            <div className="flex flex-col gap-5 lg:max-w-2xl">
              <div className="flex flex-wrap items-center gap-3">
                <Eyebrow tone="dark">De anuncio a ganancia real</Eyebrow>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-ink-200 ring-1 ring-inset ring-white/15">
                  Datos de ejemplo
                </span>
              </div>
              <h2 className="text-balance text-3xl font-bold tracking-tight text-white sm:text-4xl">
                Meta te muestra gasto.{' '}
                <span className="text-gradient">AI_AFG te muestra ganancia.</span>
              </h2>
              <p className="text-base leading-relaxed text-ink-200 sm:text-lg">
                Seguimos el recorrido completo: del anuncio a la conversación, al pedido, al pago y a la
                ganancia. Cada guaraní invertido, atribuido a lo que realmente vendió.
              </p>
            </div>

            <Reveal>
              <AttributionFlow tone="dark" />
            </Reveal>

            <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr] lg:items-stretch">
              <Reveal className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-white">Ganancia por campaña</div>
                    <div className="text-xs text-ink-300">Últimas 8 semanas · datos demo</div>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-mint-400/15 px-2.5 py-1 text-xs font-semibold text-mint-300">
                    <TrendingIcon className="h-3.5 w-3.5" /> +24%
                  </span>
                </div>
                <div className="h-56">
                  <AnimatedChart
                    id="showcase"
                    tone="dark"
                    data={[14, 19, 17, 26, 23, 33, 30, 41]}
                    bars={[9, 13, 11, 18, 16, 22, 20, 27]}
                    labels={['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']}
                  />
                </div>
              </Reveal>

              <Reveal delay={80} className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-2">
                {metrics.map((m) => (
                  <MetricCard
                    key={m.label}
                    tone="dark"
                    label={m.label}
                    value={m.value}
                    delta={m.delta}
                    trend={m.trend}
                    icon={m.icon}
                  />
                ))}
                <div className="col-span-2 flex items-center gap-3 rounded-2xl border border-mint-400/30 bg-mint-400/[0.08] p-4 sm:col-span-1 lg:col-span-2">
                  <SparkIcon className="h-5 w-5 shrink-0 text-mint-300" />
                  <p className="text-sm font-medium text-mint-100">
                    No solo ves clics. Ves qué campaña deja plata.
                  </p>
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* --------------------- Proceso: de la charla a la venta ------------------- */

function ProcessSection() {
  return (
    <section id="como-funciona" className="mk-container scroll-mt-24 py-20 sm:py-24">
      <div className="flex flex-col gap-14">
        <SectionHeading
          eyebrow="Cómo funciona"
          title="De la primera charla a la venta, en 4 pasos"
          description="Más ventas, menos gasto, menos caos."
        />
        <div className="relative grid grid-cols-1 gap-y-10 sm:grid-cols-2 sm:gap-x-8 lg:grid-cols-4">
          {/* Línea conectora del timeline (solo desktop, detrás de los nodos). */}
          <div
            className="absolute left-[12.5%] right-[12.5%] top-9 hidden h-px -translate-y-1/2 bg-gradient-to-r from-mint-200/0 via-ink-200 to-mint-200/0 lg:block"
            aria-hidden
          />
          {PROCESS_STEPS.map((s, i) => (
            <Reveal key={s.title} delay={i * 90} className="relative flex flex-col items-center text-center">
              <div className="relative z-10 grid h-[4.5rem] w-[4.5rem] place-items-center rounded-2xl bg-white text-mint-600 shadow-card ring-1 ring-ink-100">
                {s.icon}
                <span className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full bg-mint-brand text-[0.7rem] font-bold text-white shadow-glow">
                  {i + 1}
                </span>
              </div>
              <h3 className="mt-5 text-base font-semibold text-ink-900">{s.title}</h3>
              <p className="mt-2 max-w-[16rem] text-sm leading-relaxed text-ink-500">{s.description}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
