'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { TenantStatsPublic, TenantStatsPrivate } from '@vpw/shared';
import { useAuth } from '@/lib/auth-context';
import { ROLE_LABELS } from '@/lib/roles';
import { useActiveCompany } from '@/lib/active-company';
import { listOrders, listOrderFinancials, computeMetrics, type DashboardMetrics } from '@/lib/orders';
import { listProducts } from '@/lib/catalog';
import { getStatsPublic, getStatsPrivate } from '@/lib/stats';
import { listConversations } from '@/lib/conversations';
import { listPendingInsights } from '@/lib/insights';
import { getAgentConfig } from '@/lib/agent-config';
import { getChannelConfig } from '@/lib/channels';
import { getMetaConnection } from '@/lib/integrations';
import { MetricCard } from '@/components/marketing/MetricCard';
import {
  BagIcon,
  ChartIcon,
  TrendingIcon,
  TargetIcon,
  CardIcon,
  UsersIcon,
  ClockIcon,
  ChatIcon,
  BotIcon,
  PlugIcon,
  ShieldIcon,
  WhatsappIcon,
  ArrowRightIcon,
} from '@/components/marketing/icons';

const gs = (n: number | null | undefined) => (n == null ? '—' : '₲ ' + Math.round(n).toLocaleString('es-PY'));

/** Estados de pedido que ya NO requieren atención (cerrados). El resto cuenta como "pendiente". */
const CLOSED_STATUSES = new Set(['DELIVERED', 'CANCELLED', 'REFUNDED']);
const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Esperando pago',
  PENDING_VERIFICATION: 'Verificando',
  PAID: 'Pagado',
  PREPARING: 'Preparando',
  ASSIGNED: 'Asignado',
  IN_TRANSIT: 'En camino',
};
const STATUS_TONE: Record<string, string> = {
  PENDING_PAYMENT: 'bg-amber-50 text-amber-700',
  PENDING_VERIFICATION: 'bg-amber-50 text-amber-700',
  PAID: 'bg-mint-50 text-mint-700',
  PREPARING: 'bg-ink-50 text-ink-600',
  ASSIGNED: 'bg-ink-50 text-ink-600',
  IN_TRANSIT: 'bg-ink-50 text-ink-600',
};

export default function DashboardPage() {
  const { user, claims } = useAuth();
  const { tenantId, companyName, loading: companyLoading } = useActiveCompany();
  const isSeller = claims.role === 'SELLER';

  // --- KPIs: camino barato (agregados precalculados); fallback a cálculo en cliente. ---
  const statsPubQ = useQuery({ queryKey: ['statsPublic', tenantId], queryFn: () => getStatsPublic(tenantId!), enabled: !!tenantId });
  const statsPrivQ = useQuery({ queryKey: ['statsPrivate', tenantId], queryFn: () => getStatsPrivate(tenantId!), enabled: !!tenantId && !isSeller });
  const aggMissing = statsPubQ.isSuccess && !statsPubQ.data;

  // Pedidos: se usan para "pedidos pendientes" (lista) y, si faltan agregados, para el fallback de KPIs.
  const ordersQ = useQuery({ queryKey: ['orders', tenantId], queryFn: () => listOrders(tenantId!), enabled: !!tenantId });
  const productsQ = useQuery({ queryKey: ['products', tenantId], queryFn: () => listProducts(tenantId!), enabled: !!tenantId && aggMissing });
  const financialsQ = useQuery({ queryKey: ['orderFinancials', tenantId], queryFn: () => listOrderFinancials(tenantId!), enabled: !!tenantId && aggMissing && !isSeller });

  // Conversaciones recientes (canal real = WhatsApp). También resuelve nombres de cliente para los pedidos.
  const convQ = useQuery({ queryKey: ['conversations', tenantId], queryFn: () => listConversations(tenantId!, 25), enabled: !!tenantId });
  // Acciones sugeridas (insights) y estado del bot: lectura de gestión → no para vendedor.
  const insightsQ = useQuery({ queryKey: ['insights', tenantId], queryFn: () => listPendingInsights(tenantId!), enabled: !!tenantId && !isSeller });
  const agentQ = useQuery({ queryKey: ['agentConfig', tenantId], queryFn: () => getAgentConfig(tenantId!), enabled: !!tenantId && !isSeller });
  const channelQ = useQuery({ queryKey: ['channelConfig', tenantId], queryFn: () => getChannelConfig(tenantId!), enabled: !!tenantId && !isSeller });
  const metaQ = useQuery({ queryKey: ['metaConnection', tenantId], queryFn: () => getMetaConnection(tenantId!), enabled: !!tenantId && !isSeller });

  const fromAgg = statsPubQ.data ? metricsFromStats(statsPubQ.data, statsPrivQ.data ?? null) : null;
  const fallbackReady = aggMissing && ordersQ.isSuccess && productsQ.isSuccess;
  const m: DashboardMetrics | null = fromAgg ?? (fallbackReady ? computeMetrics(ordersQ.data, productsQ.data, financialsQ.data ?? {}) : null);
  const updatedAt = statsPubQ.data?.updatedAt;

  // Nombre legible de cliente a partir de las conversaciones cargadas (sin pedir datos extra).
  const custName = new Map((convQ.data ?? []).map((c) => [c.id, c.name?.trim() || c.whatsappPhone || c.id.slice(0, 6)]));
  const pendingOrders = (ordersQ.data ?? []).filter((o) => !CLOSED_STATUSES.has(o.status)).slice(0, 5);
  const recentConvs = (convQ.data ?? []).filter((c) => c.conversation?.lastMessageAt).slice(0, 5);
  const insights = (insightsQ.data ?? []).slice(0, 4);

  const empresa = companyName ?? claims.tenantId ?? tenantId ?? 'Plataforma';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Encabezado */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Resumen de tu negocio</h1>
          <p className="mt-1 text-sm text-ink-500">
            {empresa} · {claims.role ? ROLE_LABELS[claims.role] : '—'}
          </p>
        </div>
        {updatedAt && (
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-mint-50 px-3 py-1 text-xs font-medium text-mint-700 ring-1 ring-inset ring-mint-100">
            <ClockIcon className="h-3.5 w-3.5" />
            Métricas al {fmtWhen(updatedAt)}
          </span>
        )}
      </div>

      {!tenantId && !companyLoading && (
        <EmptyState
          icon={<ChartIcon className="h-6 w-6" />}
          title="Seleccioná una empresa"
          text="Elegí una empresa en la barra superior para ver su resumen de ventas, pedidos y conversaciones."
        />
      )}

      {tenantId && (
        <>
          {/* 1) ¿Está activo mi bot? */}
          {!isSeller && <BotStatusCard agent={agentQ.data} channel={channelQ.data} meta={metaQ.data} loading={agentQ.isLoading} ready={agentQ.isSuccess} />}

          {/* 2) ¿Cómo está mi negocio hoy? */}
          {!m && (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-[104px] animate-pulse rounded-2xl border border-ink-100 bg-ink-50/60" />
              ))}
            </div>
          )}
          {m && (
            <>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                <MetricCard label="Ventas" value={String(m.ventas)} icon={<BagIcon className="h-4 w-4" />} accent="ink" />
                <MetricCard label="Ingresos" value={gs(m.ingresos)} icon={<ChartIcon className="h-4 w-4" />} accent="mint" />
                {!isSeller && (
                  <MetricCard
                    label="Ganancia"
                    value={gs(m.ganancia)}
                    icon={<TrendingIcon className="h-4 w-4" />}
                    accent={m.costoIncompleto ? 'amber' : 'mint'}
                    sublabel={m.costoIncompleto ? 'incompleta' : undefined}
                  />
                )}
                {!isSeller && (
                  <MetricCard label="Margen" value={m.margen == null ? '—' : Math.round(m.margen) + '%'} icon={<TargetIcon className="h-4 w-4" />} accent="ink" />
                )}
                <MetricCard label="Ticket promedio" value={gs(m.ticketPromedio)} icon={<CardIcon className="h-4 w-4" />} accent="ink" />
                {!isSeller && <MetricCard label="Costos" value={gs(m.costos)} icon={<CardIcon className="h-4 w-4" />} accent="coral" />}
              </div>

              {m.costoIncompleto && !isSeller && (
                <div className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  <span aria-hidden>⚠️</span>
                  <span>Hay productos vendidos sin precio de costo cargado: la ganancia mostrada puede estar incompleta.</span>
                </div>
              )}
            </>
          )}

          {/* 3) ¿Tengo conversaciones / pedidos pendientes? */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <SectionCard title="Pedidos pendientes" icon={<CardIcon className="h-4 w-4" />} accent="amber" href="/orders" hrefLabel="Ver pedidos">
              {ordersQ.isError ? (
                <RowEmpty text="No se pudieron cargar los pedidos." />
              ) : !ordersQ.data ? (
                <ListSkeleton />
              ) : pendingOrders.length === 0 ? (
                <RowEmpty text="No tenés pedidos pendientes. ✅" />
              ) : (
                <ul className="divide-y divide-ink-50">
                  {pendingOrders.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink-800">{custName.get(o.customerId) ?? 'Cliente'}</div>
                        <div className="text-xs text-ink-400">{gs(o.totals.total)}</div>
                      </div>
                      <span className={'shrink-0 rounded-full px-2 py-0.5 text-[0.7rem] font-semibold ' + (STATUS_TONE[o.status] ?? 'bg-ink-50 text-ink-600')}>
                        {STATUS_LABEL[o.status] ?? o.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Conversaciones recientes" icon={<WhatsappIcon className="h-4 w-4" />} accent="mint" href="/conversations" hrefLabel="Ver conversaciones">
              {convQ.isError ? (
                <RowEmpty text="No se pudieron cargar las conversaciones." />
              ) : !convQ.data ? (
                <ListSkeleton />
              ) : recentConvs.length === 0 ? (
                <RowEmpty text="Todavía no hay conversaciones." />
              ) : (
                <ul className="divide-y divide-ink-50">
                  {recentConvs.map((c) => (
                    <li key={c.id} className="flex items-center gap-3 py-2.5">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#25D366]/15 text-[#1ab358]">
                        <WhatsappIcon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-ink-800">{c.name?.trim() || c.whatsappPhone || 'Cliente'}</div>
                        <div className="truncate text-xs text-ink-400">{c.conversation?.lastMessagePreview || '—'}</div>
                      </div>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {(c.conversation?.unreadForSeller ?? 0) > 0 && (
                          <span className="grid h-4 min-w-[1rem] place-items-center rounded-full bg-coral-500 px-1 text-[0.6rem] font-bold text-white">
                            {c.conversation!.unreadForSeller}
                          </span>
                        )}
                        <span
                          title={c.conversation?.humanTakeover ? 'Lo atiende un vendedor' : 'Lo atiende el bot'}
                          className={'rounded-full px-1.5 py-0.5 text-[0.6rem] font-semibold ' + (c.conversation?.humanTakeover ? 'bg-ink-50 text-ink-500' : 'bg-mint-50 text-mint-700')}
                        >
                          {c.conversation?.humanTakeover ? 'vendedor' : 'bot'}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>

          {/* 4) ¿Qué debería hacer ahora? (acciones sugeridas) */}
          {!isSeller && (
            <SectionCard title="Acciones sugeridas para hoy" icon={<TargetIcon className="h-4 w-4" />} accent="mint" href="/decisions" hrefLabel="Ver todas">
              {insightsQ.isError ? (
                <RowEmpty text="No se pudieron cargar las acciones." />
              ) : !insightsQ.data ? (
                <ListSkeleton />
              ) : insights.length === 0 ? (
                <RowEmpty text="Sin acciones pendientes. Tu copiloto avisará cuando haya algo para hacer." />
              ) : (
                <ul className="space-y-2.5">
                  {insights.map((it) => (
                    <li key={it.id} className="flex items-start gap-3 rounded-xl border border-ink-100 bg-ink-50/40 p-3">
                      <span className={'mt-1.5 h-2 w-2 shrink-0 rounded-full ' + PRIORITY_DOT[it.priority]} aria-hidden />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-ink-800">{it.title}</div>
                        {it.description && <p className="mt-0.5 text-xs leading-snug text-ink-500">{it.description}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          )}

          {/* 5) Análisis del negocio (paneles existentes, capacidades intactas) */}
          {m && (m.ventas > 0 ? (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <Panel title="Productos destacados" icon={<BagIcon className="h-4 w-4" />}>
                <BarList rows={m.topVendidos.map((p) => ({ id: p.productId, label: p.name, value: p.units, display: `${p.units} u.` }))} emptyText="Sin ventas todavía" />
              </Panel>
              {!isSeller && (
                <Panel title="Productos más rentables" icon={<TrendingIcon className="h-4 w-4" />} accent="mint">
                  <BarList rows={m.topRentables.map((p) => ({ id: p.productId, label: p.name, value: p.profit, display: gs(p.profit) }))} emptyText="Sin datos de ganancia todavía" accent="mint" />
                </Panel>
              )}
              <Panel title="Bajo stock" icon={<TargetIcon className="h-4 w-4" />} accent="coral">
                {m.bajoStock.length === 0 ? (
                  <RowEmpty text="Sin alertas de stock" />
                ) : (
                  <div className="space-y-2">
                    {m.bajoStock.map((p) => (
                      <div key={p.id} className="flex items-center justify-between border-b border-ink-50 pb-2 text-sm last:border-0">
                        <span className="text-ink-700">{p.name}</span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-coral-50 px-2 py-0.5 text-xs font-semibold text-coral-600">{p.stock} u.</span>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
              {!isSeller && (
                <Panel title="Ventas por vendedor" icon={<UsersIcon className="h-4 w-4" />}>
                  <BarList rows={m.ventasPorVendedor.map((s) => ({ id: s.sellerId, label: custName.get(s.sellerId) ?? s.sellerId, value: s.ingresos, display: `${s.ventas} · ${gs(s.ingresos)}` }))} emptyText="Sin ventas asignadas" />
                </Panel>
              )}
            </div>
          ) : (
            <EmptyState
              icon={<BagIcon className="h-6 w-6" />}
              title="Todavía no hay ventas"
              text="Cuando el bot cierre pedidos, las métricas y los rankings aparecen acá automáticamente."
            />
          ))}

          {/* 6) ¿A dónde entro para gestionar cada cosa? */}
          <QuickAccess role={claims.role} />
        </>
      )}
    </div>
  );
}

/* ------------------------------- Estado bot ------------------------------ */

function BotStatusCard({
  agent,
  channel,
  meta,
  loading,
  ready,
}: {
  agent: { botEnabled?: boolean } | undefined;
  channel: { whatsappSendMode?: 'mock' | 'live' } | undefined;
  meta: { status?: string } | null | undefined;
  loading: boolean;
  ready: boolean;
}) {
  if (loading) return <div className="h-[84px] animate-pulse rounded-2xl border border-ink-100 bg-ink-50/60" />;
  if (!ready) return null; // si falló la lectura de config, no mostramos un estado engañoso

  const botEnabled = agent?.botEnabled ?? false;
  const mode = channel?.whatsappSendMode ?? 'mock';
  const metaActive = meta?.status === 'active';

  let s: { tone: 'mint' | 'amber' | 'coral'; title: string; text: string; href: string; cta: string };
  if (!botEnabled) {
    s = { tone: 'coral', title: 'Bot apagado', text: 'El bot no está respondiendo a tus clientes. Encendelo desde la configuración del agente.', href: '/agent', cta: 'Configurar agente' };
  } else if (mode === 'live' && metaActive) {
    s = { tone: 'mint', title: 'Bot activo en WhatsApp', text: 'Tu bot está conectado y respondiendo a tus clientes por WhatsApp.', href: '/conversations', cta: 'Ver conversaciones' };
  } else if (mode === 'live' && !metaActive) {
    s = { tone: 'amber', title: 'Reconectá WhatsApp', text: 'El bot está en modo real pero la conexión con Meta/WhatsApp no está activa.', href: '/integrations', cta: 'Revisar conexión' };
  } else {
    s = { tone: 'amber', title: 'Bot en modo demo', text: 'El bot responde en modo de prueba: todavía no envía mensajes reales por WhatsApp. Conectá Meta para activarlo.', href: '/integrations', cta: 'Activar WhatsApp' };
  }

  const TONE = {
    mint: { box: 'border-mint-200 bg-mint-50/60', icon: 'bg-mint-brand text-white', title: 'text-mint-800', cta: 'text-mint-700 hover:text-mint-600' },
    amber: { box: 'border-amber-200 bg-amber-50/70', icon: 'bg-amber-500 text-white', title: 'text-amber-900', cta: 'text-amber-800 hover:text-amber-900' },
    coral: { box: 'border-coral-200 bg-coral-50/70', icon: 'bg-coral-500 text-white', title: 'text-coral-700', cta: 'text-coral-700 hover:text-coral-600' },
  }[s.tone];

  return (
    <div className={'flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between ' + TONE.box}>
      <div className="flex items-center gap-3">
        <span className={'grid h-10 w-10 shrink-0 place-items-center rounded-xl ' + TONE.icon}>
          <BotIcon className="h-5 w-5" />
        </span>
        <div>
          <div className={'text-sm font-bold ' + TONE.title}>{s.title}</div>
          <p className="mt-0.5 text-xs leading-snug text-ink-600">{s.text}</p>
        </div>
      </div>
      <Link href={s.href} className={'inline-flex shrink-0 items-center gap-1 text-sm font-semibold ' + TONE.cta}>
        {s.cta} <ArrowRightIcon className="h-4 w-4" />
      </Link>
    </div>
  );
}

/* ------------------------------ Accesos rápidos --------------------------- */

const QUICK_LINKS: { href: string; label: string; icon: React.ReactNode; roles: string[] }[] = [
  { href: '/conversations', label: 'Conversaciones', icon: <ChatIcon className="h-5 w-5" />, roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'SELLER'] },
  { href: '/orders', label: 'Pedidos', icon: <CardIcon className="h-5 w-5" />, roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'SELLER'] },
  { href: '/catalog', label: 'Catálogo', icon: <BagIcon className="h-5 w-5" />, roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  { href: '/agent', label: 'Config. del agente', icon: <BotIcon className="h-5 w-5" />, roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  { href: '/integrations', label: 'Integración Meta', icon: <PlugIcon className="h-5 w-5" />, roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  { href: '/billing', label: 'Plan y facturación', icon: <ShieldIcon className="h-5 w-5" />, roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
];

function QuickAccess({ role }: { role: string | null }) {
  const links = QUICK_LINKS.filter((l) => role && l.roles.includes(role));
  if (links.length === 0) return null;
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-ink-700">Accesos rápidos</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="group flex flex-col items-center gap-2 rounded-2xl border border-ink-100 bg-white p-4 text-center shadow-soft transition-all hover:-translate-y-0.5 hover:border-mint-200 hover:shadow-card"
          >
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-mint-50 text-mint-600 transition-colors group-hover:bg-mint-brand group-hover:text-white">
              {l.icon}
            </span>
            <span className="text-xs font-medium text-ink-700">{l.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------- UI helpers ------------------------------ */

const PRIORITY_DOT: Record<string, string> = {
  HIGH: 'bg-coral-500',
  MEDIUM: 'bg-amber-500',
  LOW: 'bg-mint-500',
};

const ACCENT_ICON = {
  mint: 'bg-mint-50 text-mint-600',
  ink: 'bg-ink-50 text-ink-600',
  coral: 'bg-coral-50 text-coral-600',
  amber: 'bg-amber-50 text-amber-700',
} as const;

const ACCENT_BAR = {
  mint: 'bg-mint-400',
  ink: 'bg-ink-300',
  coral: 'bg-coral-300',
} as const;

/** Tarjeta de sección con título, ícono y link de "ver todo". */
function SectionCard({
  title,
  icon,
  accent = 'ink',
  href,
  hrefLabel,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  accent?: keyof typeof ACCENT_ICON;
  href?: string;
  hrefLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-ink-100 bg-white p-5 shadow-soft">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon && <span className={'grid h-7 w-7 place-items-center rounded-lg ' + ACCENT_ICON[accent]}>{icon}</span>}
          <h2 className="text-sm font-semibold text-ink-700">{title}</h2>
        </div>
        {href && hrefLabel && (
          <Link href={href} className="inline-flex items-center gap-1 text-xs font-semibold text-mint-700 hover:text-mint-600">
            {hrefLabel} <ArrowRightIcon className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Panel({
  title,
  icon,
  accent = 'ink',
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  accent?: 'mint' | 'ink' | 'coral';
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-ink-100 bg-white p-5 shadow-soft">
      <div className="mb-4 flex items-center gap-2">
        {icon && <span className={'grid h-7 w-7 place-items-center rounded-lg ' + ACCENT_ICON[accent]}>{icon}</span>}
        <h2 className="text-sm font-semibold text-ink-700">{title}</h2>
      </div>
      {children}
    </div>
  );
}

interface BarRow {
  id: string;
  label: string;
  value: number | null;
  display: React.ReactNode;
}

function BarList({ rows, emptyText, accent = 'ink' }: { rows: BarRow[]; emptyText: string; accent?: 'mint' | 'ink' | 'coral' }) {
  if (rows.length === 0) return <RowEmpty text={emptyText} />;
  const max = Math.max(...rows.map((r) => Math.abs(r.value ?? 0)), 1);
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.id} className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="truncate pr-3 text-ink-700">{r.label}</span>
            <span className="shrink-0 font-medium text-ink-900">{r.display}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-50">
            <div className={'h-full rounded-full ' + ACCENT_BAR[accent]} style={{ width: `${Math.max(4, (Math.abs(r.value ?? 0) / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-lg bg-ink-50/70" />
      ))}
    </div>
  );
}

function RowEmpty({ text }: { text: string }) {
  return <div className="py-2 text-sm text-ink-400">{text}</div>;
}

function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-ink-200 bg-white px-6 py-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-ink-50 text-ink-400">{icon}</span>
      <div>
        <h3 className="text-sm font-semibold text-ink-800">{title}</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">{text}</p>
      </div>
    </div>
  );
}

/** Mapea los agregados precalculados al formato que ya usa el dashboard. */
function metricsFromStats(pub: TenantStatsPublic, priv: TenantStatsPrivate | null): DashboardMetrics {
  return {
    ventas: pub.ventas,
    ingresos: pub.ingresos,
    ticketPromedio: pub.ticketPromedio,
    costos: priv?.costos ?? null,
    ganancia: priv?.ganancia ?? null,
    margen: priv?.margen ?? null,
    costoIncompleto: priv?.costoIncompleto ?? false,
    topVendidos: pub.topVendidos.map((p) => ({ productId: p.productId, name: p.name, units: p.units, profit: 0 })),
    topRentables: (priv?.topRentables ?? []).map((p) => ({ productId: p.productId, name: p.name, units: 0, profit: p.profit })),
    bajoStock: pub.bajoStock,
    ventasPorVendedor: priv?.ventasPorVendedor ?? [],
  };
}

function fmtWhen(ts: unknown): string {
  try {
    const d = (ts as { toDate?: () => Date } | null)?.toDate?.();
    return d ? d.toLocaleString('es-PY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  } catch {
    return '';
  }
}
